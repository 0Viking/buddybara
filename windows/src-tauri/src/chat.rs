// Chat with other models from the panel: OpenAI, Google AI and OpenRouter
// (openai_compat.rs), or a model server the user runs (local_chat.rs). The
// panel keeps the conversation and sends it whole each turn. These models only
// answer: no tools are sent, so they never read files or act on the computer.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::i18n::t;
use crate::island::WINDOW_LABEL;
use crate::{local_chat, openai_compat, secrets};

/// A model a provider offers.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ModelInfo {
    pub id: String,
    pub label: String,
}

/// One turn of the conversation as the panel keeps it.
#[derive(Deserialize)]
pub struct Turn {
    role: String,
    content: String,
}

/// What one send may carry, so a page can't make Rust hold or send too much.
const MAX_TURNS: usize = 200;
const MAX_CHARS: usize = 400_000;

const SYSTEM_PROMPT: &str = "You are Buddybara, a friendly capybara assistant living on the user's desktop. \
You can help with research, coding, recommendations and questions. You have no web access and no tools: you can't read \
files or act on the computer, so say so when something needs them. Respond in the user's language. Use light Markdown \
when it helps: short paragraphs, bullet lists, **bold**, `inline code` and fenced code blocks. Avoid tables and big \
headings: the chat is narrow.";

/// The panel's turns as the providers take them: user and assistant only, the
/// last one the user's.
fn conversation(turns: Vec<Turn>) -> Result<Vec<Value>, String> {
    let turns: Vec<Value> = turns
        .into_iter()
        .filter(|t| matches!(t.role.as_str(), "user" | "assistant") && !t.content.trim().is_empty())
        .map(|t| json!({ "role": t.role, "content": t.content }))
        .collect();
    if turns.last().and_then(|t| t["role"].as_str()) != Some("user") {
        return Err(t("No response text."));
    }
    let chars: usize = turns.iter().filter_map(|t| t["content"].as_str()).map(str::len).sum();
    if turns.len() > MAX_TURNS || chars > MAX_CHARS {
        return Err(t("This conversation is too long for the model. Start a new one."));
    }
    Ok(turns)
}

fn settings(app: &AppHandle) -> crate::settings::Settings {
    app.state::<crate::Shared>().settings.lock().unwrap().clone()
}

/// The text visible so far of a streamed answer, for run `run` of the panel.
#[derive(Serialize, Clone)]
struct Delta {
    run: u64,
    text: String,
}

/// The models `provider` offers: asked only once it has a key or an address.
#[tauri::command]
pub async fn chat_models(app: AppHandle, provider: String) -> Result<Vec<ModelInfo>, String> {
    if let Some(p) = openai_compat::provider(&provider) {
        let key = secrets::get(p.key).ok_or_else(|| t("No API key — add it in Settings."))?;
        return openai_compat::models(p, &key).await;
    }
    if let Some(server) = local_chat::server(&settings(&app), &provider) {
        return local_chat::models(&server).await;
    }
    Err(format!("Unknown chat provider: {provider}"))
}

/// One answer from `provider`'s `model` to the conversation `turns`. A model
/// server streams it: `chat-delta` events carry the text so far for `run`.
#[tauri::command]
pub async fn chat_send(app: AppHandle, provider: String, model: String, turns: Vec<Turn>, run: u64) -> Result<String, String> {
    let turns = conversation(turns)?;
    if let Some(p) = openai_compat::provider(&provider) {
        return openai_compat::send(p, &model, SYSTEM_PROMPT, &turns).await;
    }
    if let Some(server) = local_chat::server(&settings(&app), &provider) {
        return local_chat::send(&server, &model, SYSTEM_PROMPT, &turns, |text| {
            let _ = app.emit_to(WINDOW_LABEL, "chat-delta", Delta { run, text });
        })
        .await;
    }
    Err(format!("Unknown chat provider: {provider}"))
}

/// Settings → AI models → Connect.
#[tauri::command]
pub async fn local_connect(id: String, url: String) -> Result<local_chat::Connected, String> {
    local_chat::connect(&id, &url).await
}

/// The OpenAI-compatible server's key, bound to the address it was typed for.
#[tauri::command]
pub fn local_set_key(url: String, key: String) -> Result<(), String> {
    local_chat::set_custom_key(&url, &key)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn turn(role: &str, content: &str) -> Turn {
        Turn { role: role.into(), content: content.into() }
    }

    #[test]
    fn the_conversation_keeps_the_turns_and_ends_on_the_question() {
        let turns = conversation(vec![turn("user", "a"), turn("error", "x"), turn("assistant", "b"), turn("user", "c")]).unwrap();
        assert_eq!(turns, vec![json!({"role":"user","content":"a"}), json!({"role":"assistant","content":"b"}), json!({"role":"user","content":"c"})]);
        assert!(conversation(vec![turn("user", "a"), turn("assistant", "b")]).is_err());
        assert!(conversation(vec![turn("user", &"x".repeat(MAX_CHARS + 1))]).is_err());
        assert!(!SYSTEM_PROMPT.contains("web search access"));
    }
}
