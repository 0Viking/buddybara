// Chat with a model server the user runs: Ollama, LM Studio, or any other
// server that speaks the OpenAI API (vLLM, llama.cpp…), from Coucou's.
//
// The answer is streamed token by token: the text visible so far goes to
// `on_delta`, and the reply is the finished text. `<think>` blocks of reasoning
// models stay hidden while open and are dropped from the answer.
//
// Nothing leaves the machine unless the user pointed the server address
// somewhere else: that address is the only place this module talks to.

use std::time::{Duration, Instant};

use reqwest::Url;
use serde::Serialize;
use serde_json::{json, Value};

use crate::chat::ModelInfo;
use crate::i18n::{t, tf};
use crate::settings::Settings;
use crate::{net, secrets};

/// Credential Manager entry of the key of the user's own OpenAI-compatible server.
pub const CUSTOM_KEY: &str = "openai-compatible-key";

const MAX_TOKENS: u32 = 4096;
/// The panel is told about new text at most this often.
const DELTA_INTERVAL: Duration = Duration::from_millis(1000 / 15);
/// Ceilings for a streamed answer: one event line, and the whole answer.
const MAX_LINE: usize = 1024 * 1024;
const MAX_ANSWER: usize = 4 * 1024 * 1024;
/// Ollama and LM Studio ignore the key, but some clients insist on sending one.
const NO_KEY: &str = "ollama";
/// Models that embed or rank rather than chat are left out of the list.
const NOT_CHAT: &[&str] = &["embed", "bge-", "all-minilm", "clip", "rerank"];

// ── The custom server's key ───────────────────────────────────────────────────
//
// The key is stored together with the one address it was entered for, and is
// only ever sent there. The address in the settings can be changed from the
// page; the key cannot follow it. And a key never goes over plain http to
// another machine.

#[derive(Serialize, serde::Deserialize)]
struct BoundKey {
    url: String,
    key: String,
}

fn may_carry_key(url: &Url) -> bool {
    url.scheme() == "https" || net::is_loopback_url(url)
}

/// Settings → AI models: stores the key for the address typed next to it.
pub fn set_custom_key(typed_url: &str, key: &str) -> Result<(), String> {
    let url = net::normalise_server_url(typed_url)?;
    if !may_carry_key(&url) {
        return Err(t("A key is only sent over https, or to a server on this computer."));
    }
    let bound = BoundKey { url: url.as_str().trim_end_matches('/').to_string(), key: key.trim().to_string() };
    let value = serde_json::to_string(&bound).map_err(|e| e.to_string())?;
    secrets::set(CUSTOM_KEY, &value)
}

/// The key, if it was entered for exactly this address.
fn custom_key_for(url: &Url) -> Option<String> {
    let stored = secrets::get(CUSTOM_KEY)?;
    key_for(&stored, url)
}

fn key_for(stored: &str, url: &Url) -> Option<String> {
    let bound: BoundKey = serde_json::from_str(stored).ok()?;
    (may_carry_key(url) && bound.url == url.as_str().trim_end_matches('/') && !bound.key.is_empty())
        .then_some(bound.key)
}

/// A model server as the settings describe it.
pub struct Server {
    pub name: String,
    /// As stored: empty until the user connects it.
    pub url: String,
    pub key: Option<String>,
}

/// Ollama, LM Studio or "custom", from the settings; None for any other id.
pub fn server(settings: &Settings, id: &str) -> Option<Server> {
    let (name, url, key) = match id {
        "ollama" => ("Ollama".to_string(), &settings.ollama_url, None),
        "lmstudio" => ("LM Studio".to_string(), &settings.lmstudio_url, None),
        "custom" => {
            let key = net::normalise_server_url(&settings.custom_url).ok().and_then(|u| custom_key_for(&u));
            (t("OpenAI-compatible server"), &settings.custom_url, key)
        }
        _ => return None,
    };
    Some(Server { name, url: url.clone(), key })
}

/// The usual address of a server on this machine; none for "custom". Ollama's
/// own OLLAMA_HOST wins when it is set, as the Ollama CLI does.
fn usual_address(id: &str) -> Option<String> {
    match id {
        "ollama" => Some(
            std::env::var("OLLAMA_HOST")
                .ok()
                .filter(|v| !v.trim().is_empty())
                .unwrap_or_else(|| "http://127.0.0.1:11434".into()),
        ),
        "lmstudio" => Some("http://127.0.0.1:1234".into()),
        _ => None,
    }
}

fn bearer(key: Option<&str>) -> String {
    format!("Bearer {}", key.filter(|k| !k.is_empty()).unwrap_or(NO_KEY))
}

fn unreachable(url: &Url) -> String {
    tf("Cannot reach {url}. Is the server running?", &[("url", url.as_str().trim_end_matches('/'))])
}

fn base_url(server: &Server) -> Result<Url, String> {
    if server.url.trim().is_empty() {
        return Err(tf("Connect {name} in Settings → AI models first.", &[("name", &server.name)]));
    }
    net::normalise_server_url(&server.url)
}

/// What the Connect button reports: the address as it will be stored, the
/// chat models the server has, and whether the address is this machine.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Connected {
    pub url: String,
    pub models: Vec<String>,
    pub loopback: bool,
}

/// Settings → AI models → Connect: does the server answer, and which models
/// does it have? An empty address means the usual one on this machine.
pub async fn connect(id: &str, typed: &str) -> Result<Connected, String> {
    let raw = if typed.trim().is_empty() { usual_address(id).unwrap_or_default() } else { typed.to_string() };
    let url = net::normalise_server_url(&raw)?;
    let key = if id == "custom" { custom_key_for(&url) } else { None };
    let models = list(&url, key.as_deref()).await?;
    Ok(Connected {
        url: url.as_str().trim_end_matches('/').to_string(),
        models,
        loopback: net::is_loopback_url(&url),
    })
}

/// The models of a connected server.
pub async fn models(server: &Server) -> Result<Vec<ModelInfo>, String> {
    let url = base_url(server)?;
    let models = list(&url, server.key.as_deref()).await?;
    if models.is_empty() {
        return Err(tf("No models yet. Download one in {name} first.", &[("name", &server.name)]));
    }
    Ok(models.into_iter().map(|id| ModelInfo { label: id.clone(), id }).collect())
}

/// `GET /v1/models`, chat models only, or why the server can't be reached.
async fn list(base: &Url, key: Option<&str>) -> Result<Vec<String>, String> {
    let response = net::client(base, Duration::from_secs(5))?
        .get(net::join(base, "v1/models"))
        .header("Authorization", bearer(key))
        .send()
        .await
        .map_err(|_| unreachable(base))?;
    if matches!(response.status().as_u16(), 401 | 403) {
        return Err(t("The server refused the key. Check it, then connect again."));
    }
    if !response.status().is_success() {
        return Err(unreachable(base));
    }
    let bytes = net::read_capped(response, net::MAX_BODY).await?;
    let body: Value = serde_json::from_slice(&bytes).map_err(|_| unreachable(base))?;
    parse_models(&body).ok_or_else(|| unreachable(base))
}

fn parse_models(body: &Value) -> Option<Vec<String>> {
    let items = body.get("data")?.as_array()?;
    Some(
        items
            .iter()
            .filter_map(|m| m.get("id").and_then(Value::as_str))
            .filter(|id| !NOT_CHAT.iter().any(|n| id.to_lowercase().contains(n)))
            .map(str::to_string)
            .collect(),
    )
}

fn request_body(model: &str, system: &str, turns: &[Value]) -> Value {
    let mut messages = vec![json!({ "role": "system", "content": system })];
    messages.extend(turns.iter().cloned());
    json!({ "model": model, "messages": messages, "stream": true, "max_tokens": MAX_TOKENS })
}

/// One answer from a model server to the conversation `turns`; the text so far
/// goes to `on_delta` while it streams.
pub async fn send(
    server: &Server,
    model: &str,
    system: &str,
    turns: &[Value],
    on_delta: impl FnMut(String),
) -> Result<String, String> {
    let base = base_url(server)?;
    if model.is_empty() {
        return Err(t("Pick a model in Settings → AI models first."));
    }
    let answer = stream(&base, server.key.as_deref(), model, &request_body(model, system, turns), on_delta).await?;
    if answer.is_empty() {
        return Err(t("No response text."));
    }
    Ok(answer)
}

// ── Streaming ─────────────────────────────────────────────────────────────────

/// One server-sent event line: `Some(Ok(text))` for a content delta,
/// `Some(Err(message))` for an error event, None for anything else (other
/// lines, `[DONE]`, a delta without content, such as reasoning-only ones).
fn parse_sse_line(line: &str) -> Option<Result<String, String>> {
    let payload = line.strip_prefix("data:")?.trim_start();
    if payload == "[DONE]" {
        return None;
    }
    let json: Value = serde_json::from_str(payload).ok()?;
    if let Some(msg) = json.pointer("/error/message").and_then(Value::as_str) {
        return Some(Err(msg.to_string()));
    }
    json.pointer("/choices/0/delta/content")?.as_str().map(|s| Ok(s.to_string()))
}

/// Removes finished `<think>…</think>` blocks (reasoning models such as DeepSeek-R1).
fn filter_thinking_blocks(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find("<think>") {
        let Some(len) = rest[start..].find("</think>") else { break };
        out.push_str(&rest[..start]);
        rest = &rest[start + len + "</think>".len()..];
    }
    out.push_str(rest);
    out.trim().to_string()
}

/// For the text shown while streaming: finished blocks go, and so does
/// everything after a block that has not been closed yet.
fn progressive_filter(text: &str) -> String {
    let cleaned = filter_thinking_blocks(text);
    match cleaned.find("<think>") {
        Some(at) => cleaned[..at].trim().to_string(),
        None => cleaned,
    }
}

/// Posts the request and reads the event stream. `on_delta` gets the visible
/// text at most 15 times a second, and once more at the end; the result is the
/// whole answer without its thinking.
async fn stream(
    base: &Url,
    key: Option<&str>,
    model: &str,
    body: &Value,
    mut on_delta: impl FnMut(String),
) -> Result<String, String> {
    let mut reply = net::client(base, Duration::from_secs(300))?
        .post(net::join(base, "v1/chat/completions"))
        .header("Authorization", bearer(key))
        .json(body)
        .send()
        .await
        .map_err(|_| unreachable(base))?;

    let status = reply.status();
    if status.as_u16() == 404 {
        return Err(tf("{model} isn't installed. Pick another one in Settings → AI models.", &[("model", model)]));
    }
    if !status.is_success() {
        let body = net::read_capped(reply, net::MAX_ERROR_BODY).await.unwrap_or_default();
        let detail = net::error_detail(&body);
        return Err(if detail.is_empty() { format!("HTTP {}", status.as_u16()) } else { detail });
    }

    let mut accumulated = String::new();
    let mut pending = Vec::<u8>::new();
    let mut last = Instant::now().checked_sub(DELTA_INTERVAL).unwrap_or_else(Instant::now);
    while let Some(chunk) = reply.chunk().await.map_err(|_| unreachable(base))? {
        pending.extend_from_slice(&chunk);
        // Whole lines only: a chunk may end in the middle of one, or of a character.
        while let Some(end) = pending.iter().position(|b| *b == b'\n') {
            let line: Vec<u8> = pending.drain(..=end).collect();
            let line = String::from_utf8_lossy(&line);
            match parse_sse_line(line.trim_end()) {
                Some(Ok(delta)) => accumulated.push_str(&delta),
                Some(Err(message)) => return Err(message),
                None => {}
            }
        }
        if pending.len() > MAX_LINE || accumulated.len() > MAX_ANSWER {
            return Err(t("The server's answer is too large."));
        }
        if last.elapsed() >= DELTA_INTERVAL {
            last = Instant::now();
            on_delta(progressive_filter(&accumulated));
        }
    }
    // A last line without its newline.
    if let Some(Ok(delta)) = parse_sse_line(String::from_utf8_lossy(&pending).trim_end()) {
        accumulated.push_str(&delta);
    }
    // The last state always goes out, whatever the throttle skipped.
    on_delta(progressive_filter(&accumulated));
    Ok(filter_thinking_blocks(&accumulated))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_content_deltas_are_taken_from_the_event_stream() {
        assert_eq!(parse_sse_line(r#"data: {"choices":[{"delta":{"content":"Hel"}}]}"#), Some(Ok("Hel".into())));
        assert_eq!(parse_sse_line(r#"data:{"choices":[{"delta":{"content":"lo"}}]}"#), Some(Ok("lo".into())));
        assert_eq!(parse_sse_line("data: [DONE]"), None);
        assert_eq!(parse_sse_line(": keep-alive"), None);
        assert_eq!(parse_sse_line(r#"data: {"choices":[{"delta":{"role":"assistant"}}]}"#), None);
        assert_eq!(parse_sse_line(r#"data: {"choices":[{"delta":{"content":null,"reasoning_content":"x"}}]}"#), None);
        assert_eq!(parse_sse_line(r#"data: {"error":{"message":"out of memory"}}"#), Some(Err("out of memory".into())));
    }

    #[test]
    fn finished_thinking_blocks_go_and_an_open_one_hides_what_follows() {
        assert_eq!(filter_thinking_blocks("<think>hmm</think>\n\nThe answer."), "The answer.");
        assert_eq!(filter_thinking_blocks("a<think>x</think>b<think>y</think>c"), "abc");
        assert_eq!(progressive_filter("Sure. <think>let me think"), "Sure.");
        assert_eq!(progressive_filter("<think>still thinking"), "");
        assert_eq!(progressive_filter("text <thi"), "text <thi");
    }

    #[test]
    fn the_request_streams_the_system_prompt_then_the_conversation() {
        let turns = vec![json!({"role":"user","content":"a"}), json!({"role":"assistant","content":"b"}), json!({"role":"user","content":"c"})];
        let body = request_body("llama3.2", "sys", &turns);
        assert_eq!(body["stream"], true);
        assert_eq!(body["model"], "llama3.2");
        assert_eq!(body["messages"].as_array().unwrap().len(), 4);
        assert_eq!(body["messages"][0]["role"], "system");
    }

    #[test]
    fn a_key_is_sent_as_the_bearer_and_without_one_the_placeholder_is() {
        assert_eq!(bearer(Some("sk-abc")), "Bearer sk-abc");
        assert_eq!(bearer(Some("")), "Bearer ollama");
        assert_eq!(bearer(None), "Bearer ollama");
    }

    #[test]
    fn a_server_that_is_not_connected_says_so() {
        let s = Settings::default();
        let ollama = server(&s, "ollama").unwrap();
        assert_eq!(base_url(&ollama).unwrap_err(), "Connect Ollama in Settings → AI models first.");
        assert!(server(&s, "openai").is_none());
        assert_eq!(usual_address("lmstudio").as_deref(), Some("http://127.0.0.1:1234"));
        assert_eq!(usual_address("custom"), None);
    }

    #[test]
    fn the_custom_key_only_goes_to_the_address_it_was_entered_for() {
        let url = |u: &str| net::normalise_server_url(u).unwrap();
        let stored = serde_json::to_string(&BoundKey { url: "https://llm.example.com".into(), key: "sk-1".into() }).unwrap();
        assert_eq!(key_for(&stored, &url("https://llm.example.com")).as_deref(), Some("sk-1"));
        assert_eq!(key_for(&stored, &url("https://attacker.example")), None);
        assert_eq!(key_for(&stored, &url("http://llm.example.com")), None);
        // A plain string binds nothing.
        assert_eq!(key_for("sk-raw", &url("https://llm.example.com")), None);
        let local = serde_json::to_string(&BoundKey { url: "http://127.0.0.1:8080".into(), key: "k".into() }).unwrap();
        assert_eq!(key_for(&local, &url("http://127.0.0.1:8080")).as_deref(), Some("k"));
        assert!(!may_carry_key(&url("http://192.168.1.20:8080")));
    }
}
