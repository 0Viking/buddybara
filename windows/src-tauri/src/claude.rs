// The Claude plan's usage, read from the account (what Claude Code's /usage
// shows). It shows on the mikan (src/island/desktop.ts).

use std::time::Duration;

use reqwest::Url;
use serde_json::{json, Value};

use crate::net;

/// Where the account reports its plan usage.
const USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
const USAGE_BETA: &str = "oauth-2025-04-20";

/// The Claude plan's 5-hour and weekly windows, as `{ five_hour, seven_day }`
/// with `utilization` (0–100) and `resets_at` (ISO date). Claude Code's status
/// line only runs in its terminal UI, so the VS Code extension and the buddy's
/// own runs never report them; the account does. Asked with the sign-in Claude
/// Code keeps in ~/.claude/.credentials.json, sent to Anthropic only, never kept
/// or refreshed here: with an expired token there is nothing until Claude Code
/// renews it.
pub async fn plan_usage() -> Option<Value> {
    let path = crate::platform::home_dir().join(".claude").join(".credentials.json");
    let creds: Value = serde_json::from_slice(&std::fs::read(path).ok()?).ok()?;
    let oauth = creds.get("claudeAiOauth")?;
    let token = oauth.get("accessToken")?.as_str()?;
    let now_ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).ok()?.as_millis() as i64;
    if oauth.get("expiresAt").and_then(Value::as_i64).is_some_and(|at| at <= now_ms) {
        return None;
    }
    let url = Url::parse(USAGE_URL).ok()?;
    let response = net::client(&url, Duration::from_secs(15))
        .ok()?
        .get(url)
        .bearer_auth(token)
        .header("anthropic-beta", USAGE_BETA)
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let body: Value = serde_json::from_slice(&net::read_capped(response, 256 * 1024).await.ok()?).ok()?;
    Some(json!({ "five_hour": body.get("five_hour"), "seven_day": body.get("seven_day") }))
}
