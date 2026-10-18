// Buddybara for Windows — app wiring and the commands the island calls.

mod agents;
mod chat;
mod claude;
mod code;
mod config_file;
mod desktop;
mod files;
mod github;
mod hooks;
mod i18n;
mod integrations;
mod island;
mod local_chat;
mod log;
mod mcp;
mod net;
mod openai_compat;
mod pipe;
mod platform;
mod secrets;
mod session_window;
mod settings;
mod sounds;
mod terminal;
mod tray;
#[cfg(windows)]
mod webview_drop;


use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_autostart::{ManagerExt, MacosLauncher};

use files::DroppedFile;
use hooks::{HookPreview, HookStatus};
use island::{PollGate, ScreenInfo};
use pipe::Pending;
use settings::Settings;

pub struct Shared {
    pub settings: Mutex<Settings>,
    pub gate: Arc<PollGate>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BootInfo {
    settings: Settings,
    screen: ScreenInfo,
    version: String,
    hook_path: String,
    /// False where the OS has no global cursor (Wayland): the page then reports
    /// the cursor from its own mouse events.
    cursor_poll: bool,
}

#[tauri::command]
fn boot(app: AppHandle, shared: State<Shared>) -> BootInfo {
    let mut settings = shared.settings.lock().unwrap().clone();
    // The real state of ~/.claude/settings.json wins over whatever we stored.
    let hooks_status = hooks::status();
    settings.hooks_installed = hooks_status.installed;
    settings.plan_relay_installed = hooks_status.plan_relay_installed;
    let screen = island::screen_info(&app, &settings.screen);
    BootInfo {
        settings,
        screen,
        version: env!("CARGO_PKG_VERSION").to_string(),
        hook_path: settings::hook_exe_path().to_string_lossy().to_string(),
        cursor_poll: platform::CURSOR_POLL,
    }
}

#[tauri::command]
fn save_settings(app: AppHandle, shared: State<Shared>, settings: Settings) {
    let autostart_changed = {
        let mut current = shared.settings.lock().unwrap();
        let autostart_changed = current.autostart != settings.autostart;
        // Where Buddybara sits on the desktop is desktop.rs's to say, not a webview's.
        let mut settings = settings.clone();
        settings.desktop_buddybara = current.desktop_buddybara.clone();
        // The Projects folder is the buddy's to set (code_pick_projects_folder).
        settings.projects_root = current.projects_root.clone();
        *current = settings;
        autostart_changed
    };
    let settings = shared.settings.lock().unwrap().clone();
    if let Err(err) = settings::save(&settings) {
        log::line(format!("could not save settings: {err}"));
    }
    if autostart_changed {
        let manager = app.autolaunch();
        let result = if settings.autostart { manager.enable() } else { manager.disable() };
        if let Err(err) = result {
            eprintln!("[buddybara] autostart: {err}");
        }
    }
    integrations::settings_saved(&app, &settings.active_integrations);
    if i18n::set_picked(&settings.language) {
        language_changed(&app);
    }
    // Keep the other window in step (island ⇄ settings window).
    let _ = app.emit("settings-changed", settings);
}

/// The island reports the system's languages at launch, for "System" in
/// Settings → Language (WebView2 and WebKitGTK know them best).
#[tauri::command]
fn set_system_languages(app: AppHandle, languages: Vec<String>) {
    if i18n::set_system(languages) {
        language_changed(&app);
    }
}

/// What Rust labels itself follows the new language: the tray menu and the
/// settings window's title. The webviews switch on their own.
fn language_changed(app: &AppHandle) {
    tray::retitle(app);
    if let Some(window) = app.get_webview_window("settings") {
        let _ = window.set_title(&i18n::t("Settings — Buddybara"));
    }
}

/// Hidden island → shrink the window to the invisible wake strip and park the
/// cursor poll; anything else → full panel and 60 Hz polling.
#[tauri::command]
fn set_collapsed(app: AppHandle, shared: State<Shared>, collapsed: bool) {
    shared.gate.collapsed.store(collapsed, Ordering::Relaxed);
    island::apply_geometry(&app, collapsed);
    // A resize invalidates the click-through flag.
    island::refresh_click_through(&app, &shared.gate);
    shared.gate.set_active(!collapsed);
    platform::set_pointer_watch(!collapsed);
}

/// The front end pushes the island shape; Rust decides click-through from it.
#[tauri::command]
fn set_island_rect(app: AppHandle, shared: State<Shared>, x: f64, y: f64, width: f64, height: f64) {
    shared.gate.set_rect(island::IslandRect { x, y, w: width, h: height });
    // Without the cursor poll the input region is the click-through: it follows the island.
    if !platform::CURSOR_POLL {
        island::refresh_click_through(&app, &shared.gate);
    }
}

#[tauri::command]
fn focus_window(app: AppHandle, focused: bool) {
    let Some(win) = island::window(&app) else { return };
    platform::set_activating(&win, focused);
    if focused {
        let _ = win.set_focus();
    }
}

#[tauri::command]
fn reposition(app: AppHandle, shared: State<Shared>) {
    let collapsed = shared.gate.collapsed.load(Ordering::Relaxed);
    island::apply_geometry(&app, collapsed);
}

#[tauri::command]
fn open_url(url: String) {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return;
    }
    platform::open_url(&url);
}

// ── Claude Code hooks ─────────────────────────────────────────────────────────

#[tauri::command]
fn hooks_status() -> HookStatus {
    hooks::status()
}

/// Returns the diff the user has to look at before anything is written.
#[tauri::command]
fn hooks_preview(install: bool) -> Result<HookPreview, String> {
    hooks::preview(install)
}

/// Only ever called from an explicit click in the settings window.
#[tauri::command]
fn hooks_apply(
    app: AppHandle,
    shared: State<Shared>,
    install: bool,
    fingerprint: String,
) -> Result<String, String> {
    // The fingerprint comes from the preview the user actually looked at, so a
    // settings.json that changed in between is refused rather than overwritten.
    let backup = hooks::write(install, &fingerprint)?;
    let updated = {
        let mut current = shared.settings.lock().unwrap();
        current.hooks_installed = install;
        if let Err(err) = settings::save(&current) {
            log::line(format!("could not save settings: {err}"));
        }
        current.clone()
    };
    let _ = app.emit("settings-changed", updated);
    Ok(backup)
}

// ── Other agents' hooks and plugins ──────────────────────────────────────────

#[tauri::command]
fn agent_hooks_list() -> Vec<agents::AgentStatus> {
    agents::list()
}

/// The diff the user has to look at before anything is written.
#[tauri::command]
fn agent_hooks_preview(agent: String, install: bool) -> Result<config_file::Plan, String> {
    agents::preview(&agent, install)
}

/// Only ever called from an explicit click in the settings window, with the
/// fingerprint of the preview the user looked at.
#[tauri::command]
fn agent_hooks_apply(agent: String, install: bool, fingerprint: String) -> Result<String, String> {
    let backups = agents::apply(&agent, install, &fingerprint)?;
    let done = if install { "installed" } else { "removed" };
    log::line(format!("agent hooks {done} for {agent}"));
    Ok(backups)
}

// ── Plan usage ────────────────────────────────────────────────────────────────

/// The diff of putting the plan usage relay into (or taking it out of) the
/// status line, before anything is written.
#[tauri::command]
fn status_line_preview(install: bool) -> Result<HookPreview, String> {
    hooks::status_line_preview(install)
}

/// Only ever called from an explicit click in the settings window.
#[tauri::command]
fn status_line_apply(
    app: AppHandle,
    shared: State<Shared>,
    install: bool,
    fingerprint: String,
) -> Result<String, String> {
    let backup = hooks::status_line_write(install, &fingerprint)?;
    let updated = {
        let mut current = shared.settings.lock().unwrap();
        current.plan_relay_installed = install;
        // As on the Mac: taking the relay out turns the pill off with it.
        if !install {
            current.show_plan_in_notch = false;
        }
        if let Err(err) = settings::save(&current) {
            log::line(format!("could not save settings: {err}"));
        }
        current.clone()
    };
    let _ = app.emit("settings-changed", updated);
    Ok(backup)
}

/// Claude plan usage, asked of the account every few minutes while it shows on the mikan.
#[tauri::command]
async fn claude_plan_usage() -> Option<serde_json::Value> {
    claude::plan_usage().await
}

#[tauri::command]
fn approval_decision(app: AppHandle, request_id: String, decision: String) {
    pipe::answer(&app, &request_id, &decision);
}

/// An option picked on the island for a question Claude Code asked.
#[tauri::command]
fn approval_answer(
    app: AppHandle,
    request_id: String,
    answers: std::collections::HashMap<String, serde_json::Value>,
) {
    pipe::answer_question(&app, &request_id, &answers);
}

/// The island has the card on screen, so the long wait for a human may begin.
/// Until this arrives the relay only waits a few hundred milliseconds, which is
/// what stops a paused or unresponsive island from freezing Claude Code.
#[tauri::command]
fn approval_ack(app: AppHandle, request_id: String) {
    pipe::acknowledge(&app, &request_id);
}

/// Nobody can act on this request — the island is paused, or another card is
/// already up. Claude Code falls back to asking in the terminal immediately.
#[tauri::command]
fn approval_decline(app: AppHandle, request_id: String) {
    pipe::decline(&app, &request_id);
}

// ── Claude Code projects and sessions (code.rs) ───────────────────────────────

/// The folders under the Projects root. Async: it reads a little of every session file.
#[tauri::command]
async fn code_projects() -> Vec<code::Project> {
    code::projects()
}

/// Opens the native folder picker; the chosen folder becomes the Projects root
/// (saved in settings), and its path is returned so the panel reloads its list.
/// `None` when the user cancels.
#[tauri::command]
async fn code_pick_projects_folder(app: AppHandle, shared: State<'_, Shared>) -> Result<Option<String>, String> {
    let owner = island::window(&app).and_then(|w| w.hwnd().ok()).map(|h| h.0 as isize);
    let start = code::current_root();
    // The dialog is modal and runs its own COM apartment: off the UI thread.
    let picked = tauri::async_runtime::spawn_blocking(move || platform::pick_folder(owner, Some(start)))
        .await
        .map_err(|e| e.to_string())?;
    let Some(dir) = picked else { return Ok(None) };
    if !dir.is_dir() {
        return Err(i18n::t("That folder is gone."));
    }
    let path = dir.to_string_lossy().into_owned();
    let snapshot = {
        let mut settings = shared.settings.lock().unwrap();
        settings.projects_root = Some(path.clone());
        settings.clone()
    };
    settings::save(&snapshot).map_err(|e| e.to_string())?;
    code::set_root(Some(dir));
    Ok(Some(path))
}

#[tauri::command]
async fn code_sessions(project: String) -> Result<Vec<code::Session>, String> {
    code::sessions(&project)
}

/// Creates a new project folder under the Projects root and returns it.
#[tauri::command]
async fn code_new_project(name: String) -> Result<code::Project, String> {
    code::new_project(&name)
}

#[tauri::command]
async fn code_messages(project: String, session: String) -> Result<Vec<code::Message>, String> {
    code::messages(&project, &session)
}

/// Sends a session to the Recycle Bin (code::delete_session).
#[tauri::command]
async fn code_delete_session(project: String, session: String) -> Result<(), String> {
    code::delete_session(&project, &session)
}

/// Gives a session a name of the user's (code::rename); returns it as kept.
#[tauri::command]
async fn code_rename_session(project: String, session: String, name: String) -> Result<String, String> {
    code::rename(&project, &session, &name)
}

/// Starts or continues a conversation; its progress comes as `code-run` events.
/// `attachments`: files of the inbox (dropped or pasted) the prompt comes with.
#[tauri::command]
fn code_send(
    app: AppHandle,
    project: String,
    session: Option<String>,
    prompt: String,
    options: code::Options,
    attachments: Option<Vec<String>>,
) -> Result<u64, String> {
    code::send(app, &project, session, &prompt, &options, &attachments.unwrap_or_default())
}

/// A file pasted into the buddy panel: its bytes are the request body, its name
/// (plain ASCII, the page makes it) the `x-file-name` header.
#[tauri::command]
async fn paste_file(request: tauri::ipc::Request<'_>) -> Result<DroppedFile, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err(i18n::t("Nothing to paste."));
    };
    let name = request.headers().get("x-file-name").and_then(|v| v.to_str().ok()).unwrap_or("pasted");
    files::save_pasted(name, bytes)
}

#[tauri::command]
fn code_stop(run: u64) {
    code::stop(run);
}

// ── Chat, files and secrets ───────────────────────────────────────────────────

/// Copies a dropped file into the inbox and reports its name back. Off the
/// main thread: a big file, or one on a share, would freeze every window for
/// as long as the copy takes.
#[tauri::command]
async fn ingest_file(path: String) -> Result<DroppedFile, String> {
    tauri::async_runtime::spawn_blocking(move || files::ingest(&path)).await.map_err(|e| e.to_string())?
}

/// The island may only ask whether a key exists — never read it.
#[tauri::command]
fn secret_present(key: String) -> bool {
    secrets::present(&key)
}

#[tauri::command]
fn secret_set(app: AppHandle, key: String, value: String) -> Result<(), String> {
    // Bound to its server's address: only local_set_key may store it (removing it is fine).
    if key == local_chat::CUSTOM_KEY && !value.is_empty() {
        return Err("use local_set_key".into());
    }
    let before = (key == "github-token").then(|| secrets::get(&key));
    secrets::set(&key, &value)?;
    // A new token answers for someone else: GitHub's card starts over.
    if before.is_some_and(|before| secrets::get(&key) != before) {
        integrations::github_token_changed(&app);
    }
    Ok(())
}

/// Opens the configured n8n instance — the URL lives in the Credential Manager.
#[tauri::command]
fn open_n8n() {
    if let Some(url) = secrets::get("n8n-url") {
        open_url(url);
    }
}

/// The Refresh button of a Services card.
#[tauri::command]
async fn refresh_integration(app: AppHandle, id: String) {
    integrations::poll_once(app, &id).await;
}

/// The GitHub card is on screen: refetch its `section` ("pulse" or "activity")
/// if it is stale. The pollers still decline while GitHub is off.
#[tauri::command]
fn github_refresh(section: String) {
    integrations::github_refresh_if_stale(&section);
}

/// Lets the island write to the same log as the Rust side.
#[tauri::command]
fn log_line(message: String) {
    log::line(format!("ui  {message}"));
}

// ── Global shortcuts ──────────────────────────────────────────────────────────

// ── Settings window ───────────────────────────────────────────────────────────

/// WebView2 allows exactly one browser environment per app, and its options are
/// fixed by whichever webview is created first. Every window must therefore ask
/// for the *same* arguments as the island (see `additionalBrowserArgs` in
/// tauri.conf.json) — a mismatch makes the second window come up blank, with no
/// error anywhere.
pub(crate) const BROWSER_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --autoplay-policy=no-user-gesture-required";

/// In a dev build the pages are served by Vite, so the second window needs the
/// absolute dev URL; a bundled build resolves it inside the app bundle.
fn settings_page_url(app: &AppHandle) -> WebviewUrl {
    #[cfg(dev)]
    if let Some(mut base) = app.config().build.dev_url.clone() {
        base.set_path("/settings.html");
        return WebviewUrl::External(base);
    }
    let _ = app;
    WebviewUrl::App("settings.html".into())
}

/// The settings window is created hidden at launch and only ever shown and
/// hidden afterwards. A WebView2 window created later — on the main thread or
/// not — silently comes up blank in this app, so the window that works is the
/// one that exists before the island's webview does.
fn create_settings_window(app: &AppHandle) {
    let url = settings_page_url(app);
    match WebviewWindowBuilder::new(app, "settings", url)
        .additional_browser_args(BROWSER_ARGS)
        .title(i18n::t("Settings — Buddybara"))
        .inner_size(1100.0, 740.0)
        .min_inner_size(900.0, 560.0)
        .resizable(true)
        .visible(false)
        .center()
        .build()
    {
        Ok(win) => {
            // Closing it must only hide it, or it could never be reopened.
            let hidden = win.clone();
            win.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = hidden.hide();
                }
            });
        }
        Err(err) => log::line(format!("settings window failed: {err}")),
    }
}

pub fn show_settings_window(app: &AppHandle) {
    let Some(win) = app.get_webview_window("settings") else {
        log::line("settings window missing");
        return;
    };
    let _ = win.unminimize();
    let _ = win.show();
    let _ = win.set_focus();
}

#[tauri::command]
fn open_settings_window(app: AppHandle) {
    show_settings_window(&app);
}

pub fn run() {
    platform::prepare_environment();
    #[cfg(windows)]
    platform::adopt_legacy_config();
    let loaded = settings::load();
    // The chosen Projects folder, before the panel asks for its list.
    code::set_root(loaded.projects_root.clone().map(std::path::PathBuf::from));
    i18n::set_picked(&loaded.language);
    let gate = Arc::new(PollGate::new());

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // Started again (its shortcut, while it already runs): the buddy
            // answers by coming out, above whatever covers him.
            if let Some(buddy) = desktop::window(app) {
                island::raise(&buddy);
            }
            let _ = app.emit_to(island::WINDOW_LABEL, "tray", "relaunch".to_string());
        }))
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None));

    builder
        .manage(Shared {
            settings: Mutex::new(loaded.clone()),
            gate: gate.clone(),
        })
        .manage(Pending::default())
        .invoke_handler(tauri::generate_handler![
            boot,
            save_settings,
            set_system_languages,
            set_collapsed,
            set_island_rect,
            focus_window,
            reposition,
            open_url,
            hooks_status,
            hooks_preview,
            hooks_apply,
            agent_hooks_list,
            agent_hooks_preview,
            agent_hooks_apply,
            status_line_preview,
            status_line_apply,
            claude_plan_usage,
            mcp::mcp_catalog,
            mcp::mcp_status,
            mcp::mcp_connect,
            mcp::mcp_cancel,
            approval_decision,
            approval_answer,
            approval_ack,
            approval_decline,
            code_projects,
            code_pick_projects_folder,
            code_sessions,
            code_new_project,
            code_messages,
            code_rename_session,
            code_delete_session,
            terminal::terminal_open,
            terminal::terminal_write,
            terminal::terminal_resize,
            terminal::terminal_close,
            code_send,
            code_stop,
            paste_file,
            log_line,
            ingest_file,
            secret_present,
            secret_set,
            open_n8n,
            refresh_integration,
            github_refresh,
            chat::chat_models,
            chat::chat_send,
            chat::local_connect,
            chat::local_set_key,
            open_settings_window,
            desktop::desktop_buddybara_info,
            desktop::desktop_buddybara_drag_begin,
            desktop::desktop_buddybara_drag_move,
            desktop::desktop_buddybara_drag_end,
            desktop::desktop_buddybara_fly_out,
            desktop::desktop_buddybara_set_asleep,
            desktop::desktop_buddybara_put_away,
            desktop::desktop_buddybara_anchor,
            sounds::custom_sounds,
            sounds::custom_sound,
            sounds::reveal_sounds_folder,
            sounds::reload_sounds,
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            tray::build(&handle)?;
            // Before the island: see create_settings_window.
            create_settings_window(&handle);
            // Same rule for Buddybara's desktop window.
            desktop::setup(&handle);

            if let Some(win) = island::window(&handle) {
                // Where Tauri takes the drop itself (Linux), its paths are the
                // ones ingest_file may copy (files.rs).
                win.on_window_event(|event| {
                    if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
                        files::allow_dropped(paths.iter().map(|p| p.to_string_lossy().to_string()));
                    }
                });
                platform::make_non_activating(&win);
                #[cfg(windows)]
                webview_drop::install(&handle);
                // A buddy's panel starts closed, one transparent pixel where
                // Buddybara lands: only a click on him opens it.
                island::apply_geometry(&handle, true);
                let _ = win.show();
            }
            gate.collapsed.store(true, Ordering::Relaxed);
            // Nothing drawn yet, so nothing takes the mouse until the page
            // reports the island's shape.
            if !platform::CURSOR_POLL {
                island::refresh_click_through(&handle, &gate);
            }
            gate.set_active(false);
            island::spawn_cursor_poll(handle.clone(), gate.clone());

            log::line(format!("--- Buddybara {} started ---", env!("CARGO_PKG_VERSION")));
            hooks::ensure_hook_exe(&handle);
            pipe::start(handle.clone());
            integrations::start(handle.clone());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Buddybara")
        .run(|_app, event| {
            if let tauri::RunEvent::Exit = event {
                // A buddy's terminal goes with it, as with a terminal window.
                terminal::kill_all();
            }
        });
}

#[cfg(test)]
mod tests {

}
