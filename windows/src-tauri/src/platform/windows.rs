// Windows: Win32 for the island window and the cursor, %APPDATA% for files.

use std::collections::HashMap;
use std::os::windows::io::RawHandle;
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::Command;

use tauri::{AppHandle, Manager, WebviewWindow};

use ::windows::core::{BOOL, PWSTR};
use ::windows::Win32::Foundation::{CloseHandle, HANDLE, HLOCAL, HWND, LPARAM, LocalFree, POINT};
use ::windows::Win32::Security::Authorization::ConvertSidToStringSidW;
use ::windows::Win32::Security::{GetTokenInformation, TokenUser, TOKEN_QUERY, TOKEN_USER};
use ::windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use ::windows::Win32::System::Ole::RevokeDragDrop;
use ::windows::Win32::System::Pipes::GetNamedPipeClientProcessId;
use ::windows::Win32::System::SystemInformation::GetLocalTime;
use ::windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
use ::windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON, VK_RBUTTON};
use ::windows::Win32::UI::Shell::{
    SHQueryUserNotificationState, QUNS_BUSY, QUNS_PRESENTATION_MODE, QUNS_RUNNING_D3D_FULL_SCREEN,
};
use ::windows::Win32::UI::WindowsAndMessaging::{
    EnumChildWindows, EnumWindows, GetClassNameW, GetCursorPos, GetSystemMetrics, GetWindow,
    GetWindowLongPtrW, GetWindowTextW, GetWindowThreadProcessId, IsWindowVisible,
    SetWindowLongPtrW, GWL_EXSTYLE, GW_OWNER, SM_SWAPBUTTON, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
};

use super::LocalTime;
use crate::session_window::{self, Proc};

/// File name of the Claude Code relay.
pub const HOOK_EXE: &str = "buddybara-hook.exe";

/// Environment variable holding the home directory.
pub const HOME_VAR: &str = "USERPROFILE";

/// Keeps spawned helpers from flashing a console window.
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

// ── Files ─────────────────────────────────────────────────────────────────────

/// %APPDATA%\Buddybara — preferences.
pub fn config_dir() -> PathBuf {
    let base = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    base.join("Buddybara")
}

/// The preferences folder from before the rename (%APPDATA%\Coucou) becomes
/// config_dir(). %LOCALAPPDATA%\Coucou stays: hooks installed before the rename
/// still point at its relay until they are reinstalled.
// ponytail: delete once both PCs have run it.
pub fn adopt_legacy_config() {
    let old = config_dir().with_file_name("Coucou");
    if old.exists() && !config_dir().exists() {
        let _ = std::fs::rename(old, config_dir());
    }
}

/// %LOCALAPPDATA%\Buddybara — where buddybara-hook.exe, the inbox and the log live.
pub fn local_dir() -> PathBuf {
    let base = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    base.join("Buddybara")
}

/// %APPDATA% and %LOCALAPPDATA% are already private to the user.
pub fn ensure_private_dir(dir: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)
}

/// Nothing to set up before the webview starts.
pub fn prepare_environment() {}

pub fn local_time() -> LocalTime {
    let t = unsafe { GetLocalTime() };
    LocalTime {
        year: t.wYear.into(),
        month: t.wMonth.into(),
        day: t.wDay.into(),
        hour: t.wHour.into(),
        minute: t.wMinute.into(),
        second: t.wSecond.into(),
    }
}

// ── Processes ─────────────────────────────────────────────────────────────────

/// Spawned helpers must never flash a console window.
pub fn no_console(cmd: &mut Command) -> &mut Command {
    cmd.creation_flags(CREATE_NO_WINDOW)
}

/// To the Recycle Bin, whence it can be put back (a buddy session deleted).
pub fn move_to_trash(paths: &[PathBuf]) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use ::windows::Win32::UI::Shell::{
        SHFileOperationW, FOF_ALLOWUNDO, FOF_NOCONFIRMATION, FOF_NOERRORUI, FOF_SILENT, FO_DELETE, SHFILEOPSTRUCTW,
    };
    if paths.is_empty() {
        return Ok(());
    }
    // Every path ends in a NUL, and the list in one more.
    let mut from: Vec<u16> = Vec::new();
    for p in paths {
        from.extend(p.as_os_str().encode_wide());
        from.push(0);
    }
    from.push(0);
    let mut op = SHFILEOPSTRUCTW {
        wFunc: FO_DELETE,
        pFrom: ::windows::core::PCWSTR(from.as_ptr()),
        fFlags: (FOF_ALLOWUNDO.0 | FOF_NOCONFIRMATION.0 | FOF_NOERRORUI.0 | FOF_SILENT.0) as u16,
        ..Default::default()
    };
    let code = unsafe { SHFileOperationW(&mut op) };
    if code != 0 || op.fAnyOperationsAborted.as_bool() {
        return Err(format!("Could not move it to the Recycle Bin (error {code})."));
    }
    Ok(())
}

/// The shell's own way to open a link in the default browser.
pub fn open_url(url: &str) {
    shell_open(url);
}

/// A folder in File Explorer. Only ever a folder: ShellExecute's "open" runs
/// a file, which a link in an answer must never do.
pub fn open_folder(dir: &std::path::Path) {
    if dir.is_dir() {
        shell_open(&plain_path(dir));
    }
}

/// What a file link opens with.
#[derive(Debug, PartialEq)]
pub enum Opener {
    /// A picture or a PDF: its own viewer (Photos, the PDF reader).
    Viewer,
    /// Anything else: VS Code, at its line.
    Editor,
    /// No VS Code: the file selected in File Explorer.
    Explorer,
}

/// Pictures and PDFs, which their viewers show. ShellExecute's "open" runs
/// anything else it is given (a .bat, an .exe), which a link must never do.
const VIEWED: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "tif", "tiff", "pdf"];

fn opener(file: &std::path::Path, editor: bool) -> Opener {
    let ext = file.extension().map(|e| e.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
    if VIEWED.contains(&ext.as_str()) {
        Opener::Viewer
    } else if editor {
        Opener::Editor
    } else {
        Opener::Explorer
    }
}

/// A file a link in an answer points at: a picture or a PDF in its viewer,
/// anything else in VS Code at its line (its own `code` command: a vscode://
/// link makes VS Code ask first), or, without VS Code, selected in File
/// Explorer. Shown, never run (a .bat, an .exe).
pub fn show_file(file: &std::path::Path, line: Option<u32>) -> Opener {
    let path = plain_path(file);
    let code = find_on_path("code");
    let how = opener(file, code.is_some());
    match (&how, code) {
        (Opener::Viewer, _) => shell_open(&path),
        (Opener::Editor, Some(code)) => {
            let mut cmd = Command::new(code);
            match line {
                Some(n) => cmd.arg("-g").arg(format!("{path}:{n}")),
                None => cmd.arg(&path),
            };
            let _ = no_console(&mut cmd).spawn();
        }
        _ => {
            // Windows paths can't hold a quote: the quoting below is enough.
            let _ = no_console(Command::new("explorer.exe").raw_arg(format!("/select,\"{path}\""))).spawn();
        }
    }
    how
}

/// `\\?\C:\x` (what canonicalize gives) as `C:\x`, `\\?\UNC\s\x` as `\\s\x`.
fn plain_path(path: &std::path::Path) -> String {
    let s = path.to_string_lossy();
    if let Some(unc) = s.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{unc}")
    } else {
        s.strip_prefix(r"\\?\").unwrap_or(&s).to_string()
    }
}

fn shell_open(target: &str) {
    use ::windows::core::{w, PCWSTR};
    use ::windows::Win32::System::Com::{
        CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE,
    };
    use ::windows::Win32::UI::Shell::ShellExecuteW;
    use ::windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    let wide: Vec<u16> = target.encode_utf16().chain(std::iter::once(0)).collect();
    // ShellExecute may wait on the browser and wants a single-threaded COM
    // apartment, so it runs on a thread of its own, off the caller's.
    std::thread::spawn(move || unsafe {
        let inited = CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE).is_ok();
        ShellExecuteW(None, w!("open"), PCWSTR(wide.as_ptr()), PCWSTR::null(), PCWSTR::null(), SW_SHOWNORMAL);
        if inited {
            CoUninitialize();
        }
    });
}

/// The native "choose folder" dialog (IFileOpenDialog with FOS_PICKFOLDERS),
/// opened at `start` when it still exists, owned by `owner` (an HWND as isize).
/// `None` when the user cancels or anything fails. Runs in its own COM
/// apartment, so it never disturbs the main thread's — call it off the UI
/// thread (lib.rs spawns it on the blocking pool).
pub fn pick_folder(owner: Option<isize>, start: Option<PathBuf>) -> Option<PathBuf> {
    use std::os::windows::ffi::OsStrExt;
    use ::windows::core::PCWSTR;
    use ::windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, IBindCtx,
        CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE,
    };
    use ::windows::Win32::UI::Shell::{
        FileOpenDialog, IFileOpenDialog, IShellItem, SHCreateItemFromParsingName,
        FOS_FORCEFILESYSTEM, FOS_PICKFOLDERS, SIGDN_FILESYSPATH,
    };

    unsafe {
        // S_FALSE means it was already initialised on this thread; either way a
        // successful init is balanced by one CoUninitialize below.
        let inited = CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE).is_ok();
        let picked = (|| {
            let dialog: IFileOpenDialog = CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER).ok()?;
            let options = dialog.GetOptions().ok()?;
            dialog.SetOptions(options | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM).ok()?;
            if let Some(dir) = start.filter(|p| p.is_dir()) {
                let wide: Vec<u16> = dir.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
                let item: ::windows::core::Result<IShellItem> =
                    SHCreateItemFromParsingName(PCWSTR(wide.as_ptr()), None::<&IBindCtx>);
                if let Ok(item) = item {
                    let _ = dialog.SetFolder(&item);
                }
            }
            dialog.Show(owner.map(|h| HWND(h as *mut _))).ok()?;
            let item: IShellItem = dialog.GetResult().ok()?;
            let name = item.GetDisplayName(SIGDN_FILESYSPATH).ok()?;
            let path = name.to_string().ok();
            CoTaskMemFree(Some(name.0 as *const _));
            path.map(PathBuf::from)
        })();
        if inited {
            CoUninitialize();
        }
        picked
    }
}

/// Our own `where`: walks %PATH% against %PATHEXT%, no shell involved.
/// Rust quotes arguments correctly for `.cmd`/`.bat` targets since 1.77, so
/// spawning `code.cmd` directly is safe.
pub fn find_on_path(stem: &str) -> Option<PathBuf> {
    let exts = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into());
    let dirs = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&dirs) {
        for ext in exts.split(';').filter(|e| !e.is_empty()) {
            let candidate = dir.join(format!("{stem}{}", ext.to_lowercase()));
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

// ── Who we are ────────────────────────────────────────────────────────────────
//
// Named pipes share one machine-wide namespace, so the SID in the name is what
// keeps two accounts on the same machine from ever meeting on `buddybara-*`.
// buddybara-hook computes the same string (hook/src/win.rs) and additionally checks
// that the process serving the pipe really is us.

/// The SID of the account this process runs as, as `S-1-5-21-…`.
pub fn current_user_sid() -> Option<String> {
    unsafe {
        let mut token = HANDLE::default();
        OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).ok()?;

        // First call sizes the buffer, second fills it.
        let mut needed = 0u32;
        let _ = GetTokenInformation(token, TokenUser, None, 0, &mut needed);
        if needed == 0 {
            let _ = CloseHandle(token);
            return None;
        }
        let mut buf = vec![0u8; needed as usize];
        let ok = GetTokenInformation(
            token,
            TokenUser,
            Some(buf.as_mut_ptr().cast()),
            needed,
            &mut needed,
        )
        .is_ok();
        let _ = CloseHandle(token);
        if !ok {
            return None;
        }

        let user = &*(buf.as_ptr() as *const TOKEN_USER);
        let mut text = PWSTR::null();
        ConvertSidToStringSidW(user.User.Sid, &mut text).ok()?;
        let sid = text.to_string().ok();
        let _ = LocalFree(Some(HLOCAL(text.0 as *mut _)));
        sid
    }
}

// ── Cursor ────────────────────────────────────────────────────────────────────

/// The 60 Hz poll reads the cursor and flips click-through from it.
pub const CURSOR_POLL: bool = true;

/// Cursor position in physical screen pixels.
pub fn cursor_physical() -> Option<(f64, f64)> {
    let mut p = POINT::default();
    unsafe { GetCursorPos(&mut p).ok()? };
    Some((p.x as f64, p.y as f64))
}

/// True while the primary mouse button is held — the only signal we get that a
/// drag might be in flight before it reaches the window. GetAsyncKeyState reads
/// the physical buttons: with them swapped (left-handed), the primary one, the
/// one that drags, is the right one.
pub fn left_button_down() -> bool {
    let primary = if unsafe { GetSystemMetrics(SM_SWAPBUTTON) } != 0 { VK_RBUTTON } else { VK_LBUTTON };
    unsafe { (GetAsyncKeyState(primary.0 as i32) as u16 & 0x8000) != 0 }
}

// ── Full screen ───────────────────────────────────────────────────────────────

/// True while a full-screen app is in front — a game (exclusive or borderless),
/// a video, a presentation. It is the shell's own answer, the one Windows uses
/// to hold back its notifications. Asked once per hook event, so nothing polls;
/// an error reads as "no", and the island behaves as usual.
pub fn fullscreen_busy() -> bool {
    matches!(
        unsafe { SHQueryUserNotificationState() },
        Ok(QUNS_BUSY | QUNS_RUNNING_D3D_FULL_SCREEN | QUNS_PRESENTATION_MODE)
    )
}

// ── Island window ─────────────────────────────────────────────────────────────

fn hwnd_of(win: &WebviewWindow) -> Option<HWND> {
    let raw = win.hwnd().ok()?.0 as isize;
    if raw == 0 {
        return None;
    }
    Some(HWND(raw as *mut _))
}

/// Keeps the settings window from showing the "no drop" cursor.
///
/// wry installs its drop target by walking the webview's child windows **once**,
/// when the webview is created. WebView2 creates `Chrome_RenderWidgetHostHWND`
/// later and registers its own target on it; being the innermost window, that one
/// wins, and since the page has no HTML5 drop handler it refuses everything.
/// Revoking it makes OLE fall through to wry's target. The island is the other
/// way round: it takes drops through WebView2's own target (see webview_drop.rs),
/// so its windows are left alone.
///
/// Cheap and idempotent, so it is simply re-run whenever a drag might be starting.
pub fn unblock_webview_drops(app: &AppHandle) {
    let Some(win) = app.get_webview_window("settings") else { return };
    let Some(hwnd) = hwnd_of(&win) else { return };
    unsafe {
        let _ = EnumChildWindows(Some(hwnd), Some(revoke_render_widget), LPARAM(0));
    }
}

unsafe extern "system" fn revoke_render_widget(hwnd: HWND, _: LPARAM) -> BOOL {
    let mut name = [0u16; 64];
    let len = unsafe { GetClassNameW(hwnd, &mut name) };
    if len > 0 {
        let class = String::from_utf16_lossy(&name[..len as usize]);
        if class == "Chrome_RenderWidgetHostHWND" {
            let _ = unsafe { RevokeDragDrop(hwnd) };
        }
    }
    true.into()
}

/// WS_EX_NOACTIVATE keeps clicks from stealing focus; WS_EX_TOOLWINDOW keeps the
/// island out of Alt-Tab.
pub fn make_non_activating(win: &WebviewWindow) {
    let Some(hwnd) = hwnd_of(win) else { return };
    unsafe {
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        let want = ex | WS_EX_NOACTIVATE.0 as isize | WS_EX_TOOLWINDOW.0 as isize;
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, want);
    }
}

/// Temporarily allow activation so a text field inside the island can be typed in.
pub fn set_activating(win: &WebviewWindow, activating: bool) {
    let Some(hwnd) = hwnd_of(win) else { return };
    unsafe {
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        let want = if activating {
            ex & !(WS_EX_NOACTIVATE.0 as isize)
        } else {
            ex | WS_EX_NOACTIVATE.0 as isize
        };
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, want);
    }
}

/// Click-through here is the poll's WS_EX_TRANSPARENT toggle, not a region.
pub fn set_input_region(_win: &WebviewWindow, _rect: Option<(f64, f64, f64, f64)>) {}

/// The cursor poll already parks itself with the island (island.rs): nothing to do.
pub fn set_pointer_watch(_active: bool) {}

// ── Session windows ("Open terminal") ─────────────────────────────────────────
//
// See session_window.rs: the relay's ancestors lead to the terminal or editor
// window a Claude Code session runs in.

/// The process on the other end of a relay connection.
pub fn pipe_client_pid(handle: RawHandle) -> Option<u32> {
    let mut pid = 0u32;
    unsafe { GetNamedPipeClientProcessId(HANDLE(handle), &mut pid).ok()? };
    (pid != 0).then_some(pid)
}

/// Every process, by ID: its parent and its executable's name.
fn process_table() -> HashMap<u32, Proc> {
    let mut out = HashMap::new();
    unsafe {
        let Ok(snapshot) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else { return out };
        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        let mut more = Process32FirstW(snapshot, &mut entry).is_ok();
        while more {
            let len = entry.szExeFile.iter().position(|c| *c == 0).unwrap_or(entry.szExeFile.len());
            out.insert(
                entry.th32ProcessID,
                Proc {
                    parent: entry.th32ParentProcessID,
                    exe: String::from_utf16_lossy(&entry.szExeFile[..len]),
                },
            );
            more = Process32NextW(snapshot, &mut entry).is_ok();
        }
        let _ = CloseHandle(snapshot);
    }
    out
}

/// The ancestors of a process, nearest first, below the desktop shell.
pub fn process_ancestors(pid: u32) -> Vec<u32> {
    session_window::ancestors(&process_table(), pid)
}

/// Visible top-level windows that are nobody's dialog and have a title:
/// (handle, process ID, title).
fn top_windows() -> Vec<(isize, u32, String)> {
    unsafe extern "system" fn collect(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let list = unsafe { &mut *(lparam.0 as *mut Vec<(isize, u32, String)>) };
        unsafe {
            if !IsWindowVisible(hwnd).as_bool() || GetWindow(hwnd, GW_OWNER).is_ok() {
                return true.into();
            }
            let mut pid = 0u32;
            GetWindowThreadProcessId(hwnd, Some(&mut pid as *mut u32));
            let mut text = [0u16; 512];
            let len = GetWindowTextW(hwnd, &mut text);
            if len > 0 {
                list.push((hwnd.0 as isize, pid, String::from_utf16_lossy(&text[..len as usize])));
            }
        }
        true.into()
    }
    let mut list: Vec<(isize, u32, String)> = Vec::new();
    unsafe {
        let _ = EnumWindows(Some(collect), LPARAM(&mut list as *mut _ as isize));
    }
    list
}

/// The first of `pids` that owns a window.
pub fn first_with_window(pids: &[u32]) -> Option<u32> {
    let windows = top_windows();
    pids.iter().copied().find(|pid| windows.iter().any(|(_, owner, _)| owner == pid))
}

/// What a session remembers: the ancestor that owns a window, or nothing.
pub fn window_owners(ancestors: &[u32]) -> Vec<u32> {
    first_with_window(ancestors).into_iter().collect()
}

// ── Global shortcuts ──────────────────────────────────────────────────────────

// ── Desktop Buddybara window ──────────────────────────────────────────────────────

/// Windows places a window wherever it is asked, and the cursor poll is there.
pub fn desktop_mode() -> super::DesktopMode {
    super::DesktopMode::Poll
}

/// Same window styles as the island: never takes focus, never in Alt-Tab (it
/// is created without a taskbar button).
pub fn prepare_desktop_window(win: &WebviewWindow, _mode: super::DesktopMode) -> bool {
    make_non_activating(win);
    true
}

/// The cursor poll toggles WS_EX_TRANSPARENT from the body hit test instead.
pub fn set_desktop_shape(_win: &WebviewWindow, _shape: super::MouseShape) {}

/// Layer-shell only (Linux).
pub fn set_layer_margins(_win: &WebviewWindow, _x: f64, _y: f64) {}

/// Layer-shell only (Linux).
pub fn set_layer_overlay(_win: &WebviewWindow, _on: bool) {}

/// Layer-shell only (Linux): the logical size of the display the island is on.
pub fn layer_display(_island: &WebviewWindow, _buddybara: &WebviewWindow) -> Option<(f64, f64)> {
    None
}

#[cfg(test)]
mod tests {
    use super::{opener, plain_path, Opener};
    use std::path::Path;

    #[test]
    fn pictures_open_in_their_viewer_the_rest_in_the_editor_and_nothing_runs() {
        assert_eq!(opener(Path::new(r"C:\d\shot.JPG"), true), Opener::Viewer);
        assert_eq!(opener(Path::new(r"C:\d\spec.pdf"), false), Opener::Viewer);
        assert_eq!(opener(Path::new(r"C:\d\main.ts"), true), Opener::Editor);
        for runs in [r"C:\d\clear.bat", r"C:\d\setup.exe", r"C:\d\x.ps1", r"C:\d\noext"] {
            assert_eq!(opener(Path::new(runs), true), Opener::Editor, "{runs}");
            assert_eq!(opener(Path::new(runs), false), Opener::Explorer, "{runs}");
        }
    }

    #[test]
    fn canonical_paths_lose_their_verbatim_prefix() {
        assert_eq!(plain_path(Path::new(r"\\?\C:\Users\me\x.txt")), r"C:\Users\me\x.txt");
        assert_eq!(plain_path(Path::new(r"\\?\UNC\server\share\x")), r"\\server\share\x");
        assert_eq!(plain_path(Path::new(r"C:\plain")), r"C:\plain");
    }
}
