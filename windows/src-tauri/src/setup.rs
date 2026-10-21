// The panel's first-run screen (buddy/setup.ts): what Buddybara needs before
// it can work (Claude Code installed and signed in, its hooks in place), and
// the two steps it starts itself. Each runs in a console window of its own,
// where the user sees what runs and answers what it asks; the screen only
// checks again afterwards.

use std::time::Duration;

use serde::Serialize;
use serde_json::Value;

/// Anthropic's Claude Code package in winget, Microsoft's own installer: no
/// script downloaded and run by this app.
#[cfg(windows)]
const WINGET_ARGS: &str =
    "install --id Anthropic.ClaudeCode --exact --source winget --accept-package-agreements --accept-source-agreements";
/// Where to install it by hand, without winget.
#[cfg(windows)]
const SETUP_PAGE: &str = "https://code.claude.com/docs/en/setup";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub claude: bool,
    pub signed_in: bool,
    pub hooks: bool,
    /// The folder the projects are listed from.
    pub root: String,
    /// Other folders listed because Claude Code has sessions for them.
    pub elsewhere: usize,
}

#[tauri::command]
pub async fn setup_status() -> Result<Status, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let claude = crate::code::claude_exe().is_some();
        let signed_in = claude
            && crate::mcp::claude(&["auth", "status", "--json"], Duration::from_secs(20))
                .ok()
                .and_then(|out| serde_json::from_str::<Value>(&out).ok())
                .and_then(|v| v.get("loggedIn").and_then(Value::as_bool))
                == Some(true);
        Status {
            claude,
            signed_in,
            hooks: crate::hooks::status().installed,
            root: crate::code::current_root().display().to_string(),
            elsewhere: crate::code::projects().iter().filter(|p| p.elsewhere).count(),
        }
    })
    .await
    .map_err(|e| e.to_string())
}

/// "install": Claude Code from winget (its setup page when there is no
/// winget). "login": Claude Code's own sign-in, which opens the browser.
/// "logout": its sign-out (the panel's /logout).
#[tauri::command]
pub fn setup_start(step: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let line = match step.as_str() {
            "install" => match crate::platform::find_on_path("winget") {
                Some(winget) => format!("\"{}\" {WINGET_ARGS}", winget.display()),
                None => {
                    crate::platform::open_url(SETUP_PAGE);
                    return Ok(());
                }
            },
            "login" | "logout" => {
                let exe = crate::code::claude_exe().ok_or_else(|| crate::i18n::t("Claude Code isn't installed: `claude` was not found."))?;
                format!("\"{}\" auth {step}", exe.display())
            }
            _ => return Err(format!("unknown step {step}")),
        };
        // `start` gives it a console of its own; cmd itself never shows.
        let mut cmd = std::process::Command::new("cmd");
        cmd.raw_arg(format!("/c start \"Buddybara\" {line}"));
        crate::platform::no_console(&mut cmd).spawn().map(drop).map_err(|e| e.to_string())
    }
    #[cfg(not(windows))]
    Err(format!("{step}: run it in a terminal (claude auth login)."))
}
