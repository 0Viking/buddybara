// The Claude plan's usage, as Claude Code's own /usage reports it. It shows on
// the mikan (src/island/desktop.ts), above the panel's Settings button, and in
// Settings → Claude Code.

use std::time::Duration;

/// Claude Code answers `/usage` by itself: no model turn, no cost, a couple
/// of seconds.
const LIMIT: Duration = Duration::from_secs(30);

/// `claude -p /usage`, answered by Claude Code itself, which asks the account
/// with its own sign-in: Buddybara never reads it. Nothing is saved and the
/// run's hooks are off. The text ("Current session: 15% used · resets …",
/// core/plan.ts parseClaudeUsageText), or None: not installed, not signed in,
/// an API key (no plan), too slow.
pub async fn plan_usage() -> Option<String> {
    tauri::async_runtime::spawn_blocking(|| {
        let args = ["-p", "--no-session-persistence", "--settings", r#"{"disableAllHooks":true}"#, "/usage"];
        crate::mcp::claude(&args, LIMIT).ok()
    })
    .await
    .ok()
    .flatten()
}
