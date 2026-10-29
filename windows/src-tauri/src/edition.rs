// What an edition may add (scripts/pack.mjs --edition): Settings pages kept
// outside the repository (src/edition, settings/main.ts), and, for them, a few
// MCP tools called through Claude Code. Which ones is decided when the edition
// is built, not by the page: BUDDYBARA_EDITION_MCP, a JSON object read at
// compile time —
//
//   { "servers": { "<name>": "<https URL>" }, "tools": ["mcp__<name>__<tool>", …] }
//
// The servers it may add for Claude Code and sign in to; the tools it may call.
// Built without it (the public builds), nothing can be called.
//
// A call is Claude Code's own (the Agent SDK's `mcp_call`, for a program, not a
// model): a headless Claude Code with hooks off and nothing saved connects the
// server with its own sign-in, calls the tool and answers. No model turn, and
// Buddybara never holds the server's token.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};
use std::sync::mpsc::channel;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::{code, log, mcp, platform};

/// How long a call may take: Claude Code connects the server first.
const CALL_WAIT: Duration = Duration::from_secs(90);
/// How long it may take to end once its input is closed, before it is stopped.
const EXIT_WAIT: Duration = Duration::from_secs(5);
/// No hooks for these runs: they are no one's session.
const NO_HOOKS: &str = r#"{"disableAllHooks":true}"#;

#[derive(Deserialize, Default, Debug, PartialEq)]
struct Allowed {
    #[serde(default)]
    servers: HashMap<String, String>,
    #[serde(default)]
    tools: Vec<String>,
}

fn allowed_from(text: Option<&str>) -> Allowed {
    text.and_then(|t| serde_json::from_str(t).ok()).unwrap_or_default()
}

fn allowed() -> Allowed {
    allowed_from(option_env!("BUDDYBARA_EDITION_MCP"))
}

/// The server a tool belongs to: `mcp__<server>__<tool>`.
fn server_of(tool: &str) -> Option<&str> {
    let rest = tool.strip_prefix("mcp__")?;
    let (server, name) = rest.split_once("__")?;
    (!server.is_empty() && !name.is_empty()).then_some(server)
}

/// A server's name as tool names write it: anything but [A-Za-z0-9_-] becomes `_`.
fn tool_name_of(server: &str) -> String {
    server.chars().map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' }).collect()
}

/// What a call came to, for the page.
#[derive(Serialize, Debug, PartialEq)]
pub struct Called {
    /// "connected" (the tool answered) | "needsAuth" | "failed" | "pending" | "disabled" | "missing" (not configured)
    state: &'static str,
    /// The tool's content blocks, as the server gave them.
    #[serde(skip_serializing_if = "Option::is_none")]
    content: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

/// Claude Code's status of a server (its `mcp_status`), as the page says it.
fn state_of(status: &str) -> &'static str {
    match status {
        "connected" => "connected",
        "needs-auth" => "needsAuth",
        "pending" => "pending",
        "disabled" => "disabled",
        _ => "failed",
    }
}

/// Why a call failed: the server's state in `status` (an `mcp_status` answer),
/// with the error the call gave.
fn failure(status: Option<&Value>, server: &str, error: String) -> Called {
    let entry = status
        .and_then(|s| s.pointer("/response/response/mcpServers"))
        .and_then(Value::as_array)
        .and_then(|list| list.iter().find(|e| e.get("name").and_then(Value::as_str).is_some_and(|n| tool_name_of(n) == server)));
    let state = match entry {
        None if status.is_some() => "missing",
        None => "failed",
        Some(e) => match state_of(e.get("status").and_then(Value::as_str).unwrap_or("")) {
            // Connected, yet the call failed: the call's own error says why.
            "connected" => "failed",
            other => other,
        },
    };
    let error = entry.and_then(|e| e.get("error").and_then(Value::as_str)).map(str::to_string).filter(|_| state == "failed").unwrap_or(error);
    Called { state, content: None, error: Some(error).filter(|e| !e.is_empty()) }
}

/// The answer to a control request, as Claude Code wrote it: success or its error.
fn reply_error(reply: &Value) -> Option<String> {
    let response = reply.get("response")?;
    if response.get("subtype").and_then(Value::as_str) == Some("error") {
        return Some(response.get("error").and_then(Value::as_str).unwrap_or("error").to_string());
    }
    // A tool that answered with an error.
    let result = response.get("response")?;
    if result.get("isError").and_then(Value::as_bool) == Some(true) {
        let text = result.get("content").and_then(Value::as_array).into_iter().flatten().find_map(|c| c.get("text").and_then(Value::as_str));
        return Some(text.unwrap_or("The tool failed.").to_string());
    }
    None
}

/// Calls `tool` with `arguments` through a headless Claude Code; on a failure,
/// asks it how the server stands, so the page can tell "sign in" from "down".
fn call(tool: &str, arguments: Value) -> Result<Called, String> {
    let server = server_of(tool).ok_or_else(|| format!("{tool} is not an MCP tool name"))?.to_string();
    let exe = code::claude_exe().ok_or_else(|| "Claude Code isn't installed.".to_string())?;
    let mut cmd = Command::new(exe);
    cmd.env("CLAUDE_CODE_ENTRYPOINT", code::ENTRYPOINT);
    cmd.args(["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"])
        .args(["--no-session-persistence", "--settings", NO_HOOKS])
        .current_dir(platform::home_dir())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = platform::no_console(&mut cmd).spawn().map_err(|e| format!("Could not start Claude Code: {e}"))?;
    let tree = platform::Tree::hold(&child);
    let mut input = child.stdin.take();
    let mut ask = |id: &str, request: Value| {
        if let Some(stdin) = input.as_mut() {
            let _ = stdin.write_all(format!("{}\n", json!({ "type": "control_request", "request_id": id, "request": request })).as_bytes());
        }
    };
    let (found, answers) = channel::<(String, Value)>();
    if let Some(out) = child.stdout.take() {
        std::thread::spawn(move || {
            for line in BufReader::new(out).lines().map_while(Result::ok) {
                let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
                if v.get("type").and_then(Value::as_str) == Some("control_response") {
                    let id = v.pointer("/response/request_id").and_then(Value::as_str).unwrap_or("").to_string();
                    if found.send((id, v)).is_err() {
                        return;
                    }
                }
            }
        });
    }
    let wait = |want: &str, until: Instant| -> Option<Value> {
        loop {
            let left = until.checked_duration_since(Instant::now())?;
            match answers.recv_timeout(left) {
                Ok((id, v)) if id == want => return Some(v),
                Ok(_) => continue,
                Err(_) => return None,
            }
        }
    };
    let until = Instant::now() + CALL_WAIT;
    ask("init", json!({ "subtype": "initialize" }));
    ask("call", json!({ "subtype": "mcp_call", "tool": tool, "arguments": arguments, "result_not_for_model": true }));
    let reply = wait("call", until);
    let called = match &reply {
        Some(r) if reply_error(r).is_none() => Called {
            state: "connected",
            content: r.pointer("/response/response/content").cloned(),
            error: None,
        },
        _ => {
            let error = reply.as_ref().and_then(reply_error).unwrap_or_else(|| "Claude Code didn't answer in time.".to_string());
            ask("status", json!({ "subtype": "mcp_status" }));
            let status = wait("status", Instant::now() + Duration::from_secs(10));
            failure(status.as_ref(), &server, error)
        }
    };
    drop(ask);
    drop(input);
    std::thread::spawn(move || {
        let deadline = Instant::now() + EXIT_WAIT;
        while Instant::now() < deadline {
            if !matches!(child.try_wait(), Ok(None)) {
                return;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        tree.end();
        let _ = child.wait();
    });
    if called.state != "connected" {
        log::line(format!("edition: {tool}: {}", called.state));
    }
    Ok(called)
}

/// An edition's page calls one of the tools it was built with.
#[tauri::command]
pub async fn edition_mcp_call(tool: String, arguments: Option<Value>) -> Result<Called, String> {
    if !allowed().tools.contains(&tool) {
        return Err(format!("{tool} isn't one of this build's tools"));
    }
    let arguments = arguments.filter(Value::is_object).unwrap_or_else(|| json!({}));
    tauri::async_runtime::spawn_blocking(move || call(&tool, arguments)).await.map_err(|e| e.to_string())?
}

/// An edition's page signs Claude Code in to one of the servers it was built
/// with: added at user scope first if Claude Code doesn't have it, then
/// Claude Code's own sign-in (the browser opens). Returns once it is done.
#[tauri::command]
pub async fn edition_mcp_login(server: String) -> Result<(), String> {
    let allowed = allowed();
    let url = allowed.servers.get(&server).cloned().ok_or_else(|| format!("{server} isn't one of this build's servers"))?;
    if !url.starts_with("https://") {
        return Err(format!("{server}: not an https address"));
    }
    tauri::async_runtime::spawn_blocking(move || {
        if let Err(err) = mcp::claude(&["mcp", "add", "--transport", "http", "--scope", "user", &server, &url], Duration::from_secs(90)) {
            if !err.contains("already exists") {
                return Err(err);
            }
        }
        mcp::login(&server)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_what_the_build_names_may_be_called() {
        assert_eq!(allowed_from(None), Allowed::default());
        assert_eq!(allowed_from(Some("not json")), Allowed::default());
        let a = allowed_from(Some(r#"{ "servers": { "notes": "https://notes.example.com/mcp" }, "tools": ["mcp__notes__list"] }"#));
        assert_eq!(a.tools, vec!["mcp__notes__list".to_string()]);
        assert_eq!(a.servers.get("notes").map(String::as_str), Some("https://notes.example.com/mcp"));
        // A public build names none.
        assert!(allowed().tools.is_empty() || option_env!("BUDDYBARA_EDITION_MCP").is_some());
    }

    #[test]
    fn a_tool_names_its_server() {
        assert_eq!(server_of("mcp__notes__list_pages"), Some("notes"));
        assert_eq!(server_of("mcp__plugin_docs_docs__export"), Some("plugin_docs_docs"));
        assert_eq!(server_of("Bash"), None);
        assert_eq!(server_of("mcp__notes"), None);
        assert_eq!(tool_name_of("plugin:docs:docs"), "plugin_docs_docs");
    }

    #[test]
    fn a_failed_call_says_whether_to_sign_in() {
        let status = |list: Value| json!({ "type": "control_response", "response": { "subtype": "success", "request_id": "status", "response": { "mcpServers": list } } });
        let needs = status(json!([{ "name": "notes", "status": "needs-auth" }]));
        assert_eq!(failure(Some(&needs), "notes", "x".into()).state, "needsAuth");
        let down = status(json!([{ "name": "notes", "status": "failed", "error": "Request timed out" }]));
        assert_eq!(failure(Some(&down), "notes", "x".into()), Called { state: "failed", content: None, error: Some("Request timed out".into()) });
        assert_eq!(failure(Some(&status(json!([]))), "notes", "x".into()).state, "missing");
        assert_eq!(failure(None, "notes", "no answer".into()).error.as_deref(), Some("no answer"));
        // Connected, but the tool said no: its own words.
        let fine = status(json!([{ "name": "notes", "status": "connected" }]));
        assert_eq!(failure(Some(&fine), "notes", "bad argument".into()).error.as_deref(), Some("bad argument"));
        let tool_error = json!({ "response": { "subtype": "success", "response": { "isError": true, "content": [{ "type": "text", "text": "No such provider" }] } } });
        assert_eq!(reply_error(&tool_error).as_deref(), Some("No such provider"));
        let ok = json!({ "response": { "subtype": "success", "response": { "content": [{ "type": "text", "text": "{}" }] } } });
        assert_eq!(reply_error(&ok), None);
    }
}
