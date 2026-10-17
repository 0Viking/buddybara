// The buddy's terminal: interactive Claude Code in a real console
// (platform::Pty), drawn by xterm.js in the panel (src/buddy/terminal.ts) —
// for what a `claude -p` run can't do: /mcp sign-ins, /login, anything that
// asks. One at a time; opened on a conversation, it resumes that session.
//
// Its screen goes to the panel as `terminal-output` events, its end as
// `terminal-exit`.

use std::collections::HashMap;
use std::io::Read;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, LazyLock, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::island::WINDOW_LABEL;
use crate::platform::{Pty, PtyReader};
use crate::{code, log};

struct Term {
    pty: Pty,
    /// False once its console is closed: its handles are gone, nothing may use them.
    live: Mutex<bool>,
}

static NEXT: AtomicU32 = AtomicU32::new(1);
static OPEN: LazyLock<Mutex<HashMap<u32, Arc<Term>>>> = LazyLock::new(Default::default);

#[derive(Serialize, Clone)]
struct Output {
    id: u32,
    data: String,
}

#[derive(Serialize, Clone)]
struct Ended {
    id: u32,
    code: u32,
}

/// Starts Claude Code in `project`, resuming `session` if given, in a console
/// of `cols`×`rows`. Any other terminal ends first.
#[tauri::command]
pub async fn terminal_open(app: AppHandle, project: String, session: Option<String>, cols: u16, rows: u16) -> Result<u32, String> {
    let cwd = code::allowed(&project)?;
    let mut args = Vec::new();
    if let Some(id) = session.as_deref() {
        if !code::is_session_id(id) {
            return Err(format!("{id} is not a session id"));
        }
        args.extend(["--resume".to_string(), id.to_string()]);
    }
    let exe = code::claude_exe().ok_or_else(|| "Claude Code isn't installed (no claude on PATH or in ~/.local/bin).".to_string())?;
    kill_all();
    // The keys of Settings → Integrations, as for a run of the panel (code.rs).
    let (pty, reader) = Pty::spawn(&exe, &args, &cwd, cols, rows, &code::key_env())?;
    let term = Arc::new(Term { pty, live: Mutex::new(true) });
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    OPEN.lock().unwrap().insert(id, term.clone());
    log::line(format!("terminal {id} started ({})", if session.is_some() { "resumed" } else { "new" }));

    let to = app.clone();
    let pump = std::thread::spawn(move || pump(&to, id, reader));
    std::thread::spawn(move || {
        let code = term.pty.wait();
        OPEN.lock().unwrap().remove(&id);
        {
            let mut live = term.live.lock().unwrap();
            *live = false;
            // Closing the console ends its screen: the pump reads its last.
            term.pty.finish();
        }
        let _ = pump.join();
        log::line(format!("terminal {id} ended ({code})"));
        let _ = app.emit_to(WINDOW_LABEL, "terminal-exit", Ended { id, code });
    });
    Ok(id)
}

/// What was typed (xterm.js `onData`: keys as VT text).
#[tauri::command]
pub async fn terminal_write(id: u32, data: String) {
    with(id, |pty| {
        let _ = pty.write(data.as_bytes());
    });
}

#[tauri::command]
pub async fn terminal_resize(id: u32, cols: u16, rows: u16) {
    with(id, |pty| pty.resize(cols, rows));
}

/// Ends it, as closing a terminal window would.
#[tauri::command]
pub async fn terminal_close(id: u32) {
    with(id, |pty| pty.kill());
}

/// Every terminal ends: another is opened, or Buddybara quits.
pub fn kill_all() {
    for term in OPEN.lock().unwrap().values() {
        if *term.live.lock().unwrap() {
            term.pty.kill();
        }
    }
}

fn with(id: u32, act: impl FnOnce(&Pty)) {
    let Some(term) = OPEN.lock().unwrap().get(&id).cloned() else { return };
    let live = term.live.lock().unwrap();
    if *live {
        act(&term.pty);
    }
}

fn pump(app: &AppHandle, id: u32, mut reader: PtyReader) {
    let mut buf = vec![0u8; 16 * 1024];
    let mut pending = Vec::new();
    loop {
        let n = match reader.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        pending.extend_from_slice(&buf[..n]);
        let data = take_text(&mut pending);
        if !data.is_empty() {
            let _ = app.emit_to(WINDOW_LABEL, "terminal-output", Output { id, data });
        }
    }
}

/// The whole characters at the start of `bytes`, taken out of it. A
/// character the read cut in two stays, for the next read to finish.
fn take_text(bytes: &mut Vec<u8>) -> String {
    match std::str::from_utf8(bytes) {
        Ok(text) => {
            let text = text.to_string();
            bytes.clear();
            text
        }
        Err(e) if e.error_len().is_none() => {
            let good = e.valid_up_to();
            let text = String::from_utf8_lossy(&bytes[..good]).into_owned();
            bytes.drain(..good);
            text
        }
        Err(_) => {
            let text = String::from_utf8_lossy(bytes).into_owned();
            bytes.clear();
            text
        }
    }
}

#[cfg(test)]
mod tests {
    use super::take_text;

    #[test]
    fn a_character_cut_between_two_reads_is_sent_whole() {
        let euro = "€".as_bytes();
        let mut pending = [b"a".as_slice(), &euro[..2]].concat();
        assert_eq!(take_text(&mut pending), "a");
        assert_eq!(pending, &euro[..2]);
        pending.extend_from_slice(&euro[2..]);
        assert_eq!(take_text(&mut pending), "€");
        assert!(pending.is_empty());
        let mut broken = vec![b'x', 0xff, b'y'];
        assert_eq!(take_text(&mut broken), "x\u{fffd}y");
    }
}
