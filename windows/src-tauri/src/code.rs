// Claude Code without an editor: the folders under ~/projects, the
// conversations Claude Code keeps for each one (~/.claude/projects), and
// `claude -p` runs that start or continue a conversation from Buddybara.
//
// A run is an ordinary Claude Code session. Its hooks fire like any other's,
// so the island shows its steps and permission cards, and the permission mode
// is the one the user picked (never a bypass). The prompt goes in on stdin, so
// nothing in it is ever read as an option, and so does a message sent while
// Claude works: Claude Code reads it at its next step, as in VS Code (`say`).
//
// Runs and reads stay inside two kinds of folder: a direct child of
// ~/projects, or a folder a session was already seen working in (its hooks
// said so). Anything else the webview asks for is refused.

use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, UNIX_EPOCH};

use serde::Serialize;
use serde_json::{json, Map, Value};
use tauri::{AppHandle, Emitter};

use crate::island::WINDOW_LABEL;
use crate::{log, platform};

/// Sessions listed per project, newest first.
const MAX_SESSIONS: usize = 60;
/// Turns shown when a conversation is opened (a prompt and all it led to),
/// newest last.
const MAX_TURNS: usize = 20;
/// Steps shown among them: enough to follow the work, never thousands of rows.
const MAX_STEPS: usize = 400;
/// Listing reads only the start (first prompt) and the end (newest title) of a
/// session file: the rest is megabytes of tool traffic.
const SLICE: u64 = 64 * 1024;
/// Longest prompt sent, in characters, attached files' list included (the page
/// checks the same before it sends: run.ts MAX_PROMPT).
const MAX_PROMPT: usize = 100_000;
/// Claude Code's own wrappers around text nobody typed.
const NOT_TYPED: &[&str] = &[
    "<command-", "<local-command-", "<system-reminder>", "<bash-", "<user-prompt-submit-hook>",
    "<ide_", "[Request interrupted", "Caveat: ",
];
/// The permission modes and effort levels a run may ask for (`claude --help`).
const MODES: &[&str] = &["default", "acceptEdits", "plan", "auto"];
const EFFORTS: &[&str] = &["low", "medium", "high", "xhigh", "max"];
/// The `--settings` layer of a run with Ultracode on.
const ULTRACODE_ON: &str = r#"{"ultracode":true}"#;
/// What a run's session file says started it (CLAUDE_CODE_ENTRYPOINT).
const ENTRYPOINT: &str = "buddybara";
/// Settings → Integrations: the keys Claude may use, and the environment names
/// the tools read them from (`gh` and the GitHub API, Obsidian's Local REST API).
/// A fixed list: nothing from the page decides what goes into a process.
const KEYS_FOR_CLAUDE: &[(&str, &[&str])] = &[
    ("github-token", &["GH_TOKEN", "GITHUB_TOKEN"]),
    ("obsidian-api-key", &["OBSIDIAN_API_KEY"]),
];

/// The saved keys as the environment of a Claude Code process: a run of the
/// panel, or its terminal.
pub(crate) fn key_env() -> Vec<(&'static str, String)> {
    KEYS_FOR_CLAUDE
        .iter()
        .filter_map(|(key, names)| crate::secrets::get(key).map(|value| (*names, value)))
        .flat_map(|(names, value)| names.iter().map(move |name| (*name, value.clone())))
        .collect()
}
/// The models of the picker, by their full names: an alias means whatever the
/// installed CLI's table says (2.1.209's `opus` was Opus 4.8). The newest ones
/// need a recent CLI: the API refuses Opus 5.5 to anything before 2.1.280.
const MODELS: &[&str] = &["claude-opus-5-5", "claude-fable-5-1", "claude-sonnet-5-5", "claude-haiku-4-5"];

// ── Where things are ──────────────────────────────────────────────────────────

/// The folder the user chose in the panel (settings `projectsRoot`), when set.
/// It wins over the env var and the default; loaded at launch and set by the
/// folder picker (lib.rs code_pick_projects_folder).
static ROOT: LazyLock<Mutex<Option<PathBuf>>> = LazyLock::new(Default::default);

/// Sets (or clears, with None) the chosen projects root.
pub fn set_root(path: Option<PathBuf>) {
    *ROOT.lock().unwrap() = path;
}

/// The folder whose subfolders the Projects list shows: the one the user chose,
/// else the BUDDYBARA_PROJECTS environment variable, else ~/projects.
fn root() -> PathBuf {
    if let Some(chosen) = ROOT.lock().unwrap().clone() {
        return chosen;
    }
    std::env::var_os("BUDDYBARA_PROJECTS")
        .filter(|p| !p.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| platform::home_dir().join("projects"))
}

/// The projects root as it stands now, for the folder picker's starting spot.
pub fn current_root() -> PathBuf {
    root()
}

/// Claude Code's own folder (~/.claude).
pub(crate) fn config_dir() -> PathBuf {
    std::env::var_os("CLAUDE_CONFIG_DIR").map(PathBuf::from).unwrap_or_else(|| platform::home_dir().join(".claude"))
}

/// Where Claude Code keeps conversations, one folder per project.
fn store() -> PathBuf {
    config_dir().join("projects")
}

/// Claude Code's folder name for a project: every character other than an
/// ASCII letter or digit becomes a dash (`C:\Users\me\x y` → `C--Users-me-x-y`).
pub fn folder_name(project: &str) -> String {
    project.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect()
}

/// A session id is a UUID: hex digits, with dashes at 8, 13, 18 and 23.
pub fn is_session_id(s: &str) -> bool {
    s.len() == 36
        && s.char_indices().all(|(i, c)| if matches!(i, 8 | 13 | 18 | 23) { c == '-' } else { c.is_ascii_hexdigit() })
}

fn modified(path: &Path) -> u64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_secs())
}

/// A project's session files, newest first: (id, path, modified). Every store
/// folder named after the project counts, whatever its case — VS Code writes
/// `c:`, a terminal `C:`.
fn session_files(project: &Path) -> Vec<(String, PathBuf, u64)> {
    let want = folder_name(&project.to_string_lossy());
    let mut files = Vec::new();
    let Ok(folders) = std::fs::read_dir(store()) else { return files };
    for folder in folders.flatten().filter(|f| f.file_name().to_string_lossy().eq_ignore_ascii_case(&want)) {
        let Ok(entries) = std::fs::read_dir(folder.path()) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().is_none_or(|e| e != "jsonl") {
                continue;
            }
            let Some(id) = path.file_stem().and_then(|s| s.to_str()).filter(|s| is_session_id(s)) else { continue };
            if is_stub(&path) {
                continue;
            }
            files.push((id.to_string(), path.clone(), modified(&path)));
        }
    }
    files.sort_by(|a, b| b.2.cmp(&a.2));
    files
}

/// Small enough to be read whole to tell a stub from a conversation.
const STUB_MAX: u64 = 16 * 1024;

/// A file with no turn in it: what VS Code writes for a session it only
/// remembers (its title, mode and cost) once the transcript itself moved to
/// another project. Nothing to read or continue there, so it isn't listed.
fn is_stub(path: &Path) -> bool {
    std::fs::metadata(path).is_ok_and(|m| m.len() <= STUB_MAX)
        && std::fs::read_to_string(path).is_ok_and(|text| is_stub_text(&text))
}

fn is_stub_text(text: &str) -> bool {
    !text.contains(r#""type":"user""#) && !text.contains(r#""lastPrompt""#)
}

// ── Which folders may be used ─────────────────────────────────────────────────

/// Folders a session was seen working in, from the hooks.
static SEEN: LazyLock<Mutex<HashSet<PathBuf>>> = LazyLock::new(Default::default);

/// Called by the relay server with every hook event: the folder the session
/// works in becomes one Buddybara may continue it in.
/// A hook's `cwd` is where the session is now, and a `cd` moves it. Its
/// project is where it started: the folder its transcript is stored under
/// (`~/.claude/projects/<folder_name>`). When `cwd` is below that folder, the
/// folder becomes the cwd, so the panel finds the session where Claude Code
/// keeps it.
/// Also: a transcript moved into another project's store folder (the store
/// reorganized by hand) and continued from where it first started (VS Code
/// opened on the home folder) belongs to the project it was moved to — where
/// that folder's sessions start. Its turns are written there, not in `cwd`.
pub fn anchor_cwd(payload: &mut Value) {
    let Some(stored) = payload
        .get("transcript_path")
        .and_then(Value::as_str)
        .and_then(|t| Some(Path::new(t).parent()?.to_path_buf()))
    else {
        return;
    };
    let Some(store) = stored.file_name().map(|n| n.to_string_lossy().into_owned()) else { return };
    let Some(cwd) = payload.get("cwd").and_then(Value::as_str).map(str::to_owned) else { return };
    // VS Code writes `c:`, a terminal `C:`: the same store folder.
    if folder_name(&cwd).eq_ignore_ascii_case(&store) {
        return;
    }
    if let Some(root) = Path::new(&cwd).ancestors().skip(1).find(|a| folder_name(&a.to_string_lossy()).eq_ignore_ascii_case(&store)) {
        payload["cwd"] = json!(root.to_string_lossy());
        return;
    }
    if let Some(home) = moved_to(&stored) {
        payload["cwd"] = json!(home);
    }
}

/// Where the sessions of a store folder start, when that folder still exists.
/// Asked again by every hook event of a moved session: read once per folder.
fn moved_to(stored: &Path) -> Option<String> {
    static KNOWN: LazyLock<Mutex<HashMap<PathBuf, Option<String>>>> = LazyLock::new(Default::default);
    if let Some(known) = KNOWN.lock().unwrap().get(stored) {
        return known.clone();
    }
    let found = started_in(stored).filter(|p| Path::new(p).is_dir());
    KNOWN.lock().unwrap().insert(stored.to_path_buf(), found.clone());
    found
}

pub fn remember(payload: &Value) {
    let Some(cwd) = payload.get("cwd").and_then(Value::as_str).filter(|c| !c.is_empty()) else { return };
    if let Ok(path) = std::fs::canonicalize(cwd) {
        SEEN.lock().unwrap().insert(path);
    }
}

/// The folder as given, once it is known to be one Buddybara may use: a direct
/// child of `root`, or one in `seen`. The given spelling is kept, because
/// Claude Code names its store folder after it.
fn check(root: &Path, seen: &HashSet<PathBuf>, project: &str) -> Result<PathBuf, String> {
    let given = PathBuf::from(project);
    let real = std::fs::canonicalize(&given).map_err(|_| format!("{project} is not a folder"))?;
    let in_root = std::fs::canonicalize(root).is_ok_and(|r| real.parent() == Some(r.as_path()));
    if real.is_dir() && (in_root || seen.contains(&real)) {
        Ok(given)
    } else {
        Err(format!("{project} is not a project folder"))
    }
}

/// Folders of Claude Code's session store outside the projects folder (VS
/// Code's projects, a terminal's), as `session_folders` last found them: their
/// sessions may be continued where they started.
static FOUND: LazyLock<Mutex<HashSet<PathBuf>>> = LazyLock::new(Default::default);
/// Settings `allSessionFolders`: the list also shows those folders.
static SESSION_FOLDERS: AtomicBool = AtomicBool::new(true);

pub fn set_session_folders(on: bool) {
    SESSION_FOLDERS.store(on, Ordering::Relaxed);
    if !on {
        FOUND.lock().unwrap().clear();
    }
}

/// Folders outside the projects folder Buddybara may use: seen in a hook, or
/// found in the session store.
fn known() -> HashSet<PathBuf> {
    let mut known = SEEN.lock().unwrap().clone();
    known.extend(FOUND.lock().unwrap().iter().cloned());
    known
}

pub(crate) fn allowed(project: &str) -> Result<PathBuf, String> {
    let root = root();
    let first = check(&root, &known(), project);
    if first.is_ok() || !SESSION_FOLDERS.load(Ordering::Relaxed) {
        return first;
    }
    // Asked before the list was read since launch: the store is read now.
    session_folders(&root);
    check(&root, &known(), project)
}

// ── Projects and sessions ─────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct Project {
    pub name: String,
    pub path: String,
    pub sessions: usize,
    /// Unix seconds of the newest session, 0 without one.
    pub last: u64,
    /// Not in the projects folder: a folder Claude Code has sessions for.
    pub elsewhere: bool,
}

/// The folders under ~/projects, most recent work first, then by name; then,
/// unless Settings says no, every other folder Claude Code has sessions for.
pub fn projects() -> Vec<Project> {
    let root = root();
    let mut list: Vec<Project> = std::fs::read_dir(&root)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                return None;
            }
            let path = e.path();
            let files = session_files(&path);
            Some(Project {
                name,
                path: path.to_string_lossy().into_owned(),
                sessions: files.len(),
                last: files.first().map_or(0, |f| f.2),
                elsewhere: false,
            })
        })
        .collect();
    list.sort_by(|a, b| b.last.cmp(&a.last).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    if SESSION_FOLDERS.load(Ordering::Relaxed) {
        list.extend(session_folders(&root));
    }
    list
}

/// The folders Claude Code has sessions for outside the projects folder,
/// newest work first. They become folders Buddybara may use (FOUND).
fn session_folders(root: &Path) -> Vec<Project> {
    let found = found_in(&store(), root);
    {
        let mut known = FOUND.lock().unwrap();
        known.clear();
        known.extend(found.iter().map(|(real, _)| real.clone()));
    }
    let mut list: Vec<Project> = found
        .into_iter()
        .map(|(_, given)| {
            let files = session_files(Path::new(&given));
            Project {
                // A drive's root has no name of its own: its path is one.
                name: Path::new(&given).file_name().map_or_else(|| given.clone(), |n| n.to_string_lossy().into_owned()),
                sessions: files.len(),
                last: files.first().map_or(0, |f| f.2),
                path: given,
                elsewhere: true,
            }
        })
        .collect();
    list.sort_by(|a, b| b.last.cmp(&a.last).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    list
}

/// Each folder of `store` whose sessions were started in a folder that still
/// exists, outside `root`'s list and outside the store itself: (real path, the
/// path as the transcripts spell it, which the store folder is named after).
fn found_in(store: &Path, root: &Path) -> Vec<(PathBuf, String)> {
    let root = std::fs::canonicalize(root).ok();
    let store_real = std::fs::canonicalize(store).ok();
    let mut taken = HashSet::new();
    let mut out = Vec::new();
    let Ok(folders) = std::fs::read_dir(store) else { return out };
    for folder in folders.flatten().filter(|f| f.file_type().is_ok_and(|t| t.is_dir())) {
        let Some(cwd) = started_in(&folder.path()) else { continue };
        let Ok(real) = std::fs::canonicalize(&cwd) else { continue };
        if !real.is_dir()
            // In the projects folder: listed already.
            || root.as_ref().is_some_and(|r| real.parent() == Some(r.as_path()))
            // Claude Code's own store: a session run from in there, not a project.
            || store_real.as_ref().is_some_and(|s| real.starts_with(s))
        {
            continue;
        }
        // VS Code writes `c:`, a terminal `C:`: one folder, two store folders.
        if taken.insert(real.clone()) {
            out.push((real, cwd));
        }
    }
    out
}

/// Where the sessions of a store folder were started: the `cwd` their newest
/// transcripts record, or the folder above it they are stored under (a `cd`
/// before the first line). None for a folder of stubs that record none.
fn started_in(folder: &Path) -> Option<String> {
    let name = folder.file_name()?.to_string_lossy().into_owned();
    let mut files: Vec<(PathBuf, u64)> = std::fs::read_dir(folder)
        .ok()?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|e| e == "jsonl"))
        .map(|p| {
            let at = modified(&p);
            (p, at)
        })
        .collect();
    files.sort_by(|a, b| b.1.cmp(&a.1));
    for (file, _) in files.iter().take(3) {
        let (head, _) = ends(file);
        let Some(cwd) = head
            .lines()
            .filter_map(|l| serde_json::from_str::<Value>(l).ok())
            .find_map(|v| v.get("cwd").and_then(Value::as_str).filter(|c| !c.is_empty()).map(str::to_owned))
        else {
            continue;
        };
        if folder_name(&cwd).eq_ignore_ascii_case(&name) {
            return Some(cwd);
        }
        if let Some(up) = Path::new(&cwd).ancestors().skip(1).find(|a| folder_name(&a.to_string_lossy()).eq_ignore_ascii_case(&name)) {
            return Some(up.to_string_lossy().into_owned());
        }
    }
    None
}

/// Characters Windows refuses in a file name.
const NOT_IN_NAMES: &[char] = &['/', '\\', ':', '*', '?', '"', '<', '>', '|'];
/// Longest name a new project may have.
const MAX_NAME: usize = 100;

/// The folder name a new project gets, or why it can't have it: one plain
/// segment — no separator or parent, nothing hidden (the list skips dot
/// folders), no character or device name Windows refuses, no trailing dot
/// (Windows would drop it) — so it only ever lands directly under `root()`.
pub fn project_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err(crate::i18n::t("A project needs a name."));
    }
    if name.starts_with('.')
        || name.ends_with('.')
        || name.chars().any(|c| NOT_IN_NAMES.contains(&c) || c.is_control())
        || crate::files::is_device_name(name)
    {
        return Err(crate::i18n::tf("“{name}” can't be a folder name.", &[("name", name)]));
    }
    if name.chars().count() > MAX_NAME {
        return Err(crate::i18n::tf("A project name is at most {max} characters.", &[("max", &MAX_NAME.to_string())]));
    }
    Ok(name.to_string())
}

/// Creates a new, empty project: a folder directly under `root()`.
pub fn new_project(name: &str) -> Result<Project, String> {
    let name = project_name(name)?;
    let root = root();
    let cannot = |what: &Path, e: std::io::Error| {
        crate::i18n::tf("Could not create {name}: {error}", &[("name", &what.display().to_string()), ("error", &e.to_string())])
    };
    // The very first project also brings the root into being.
    std::fs::create_dir_all(&root).map_err(|e| cannot(&root, e))?;
    let dir = root.join(&name);
    // Not create_dir_all: an existing folder (whatever its case) is refused, not reused.
    std::fs::create_dir(&dir).map_err(|e| match e.kind() {
        std::io::ErrorKind::AlreadyExists => crate::i18n::tf("{name} already exists.", &[("name", &name)]),
        _ => cannot(Path::new(&name), e),
    })?;
    Ok(Project { name, path: dir.to_string_lossy().into_owned(), sessions: 0, last: 0, elsewhere: false })
}

#[derive(Serialize)]
pub struct Session {
    pub id: String,
    /// The name the user gave it, else Claude's, else its first prompt.
    pub title: String,
    /// The last prompt, for the line under the title.
    pub prompt: String,
    pub last: u64,
}

pub fn sessions(project: &str) -> Result<Vec<Session>, String> {
    let project = allowed(project)?;
    Ok(session_files(&project)
        .into_iter()
        .take(MAX_SESSIONS)
        .map(|(id, path, last)| {
            let (head, tail) = ends(&path);
            let found = describe(&head, &tail);
            Session {
                title: found.title.unwrap_or_else(|| id[..8].to_string()),
                prompt: found.prompt.unwrap_or_default(),
                id,
                last,
            }
        })
        .collect())
}

/// Longest name a session may be given, in characters.
const MAX_SESSION_NAME: usize = 100;

/// Names a session the way Claude Code's own rename does: a `custom-title`
/// line appended to its file. VS Code and `claude --resume` read it too, and
/// `describe` puts it before Claude's own title. Returns the name as kept.
pub fn rename(project: &str, session: &str, name: &str) -> Result<String, String> {
    let project = allowed(project)?;
    if !is_session_id(session) {
        return Err(format!("{session} is not a session id"));
    }
    let name = one_line(name, MAX_SESSION_NAME);
    if name.is_empty() {
        return Err("A session needs a name.".into());
    }
    let (_, path, _) = session_files(&project)
        .into_iter()
        .find(|f| f.0 == session)
        .ok_or_else(|| "This session is gone.".to_string())?;
    let mut file = std::fs::OpenOptions::new().read(true).append(true).open(&path).map_err(|e| e.to_string())?;
    // A last line still without its newline must not run into ours.
    let len = file.metadata().map_or(0, |m| m.len());
    let mut last = [b'\n'];
    if len > 0 && file.seek(SeekFrom::Start(len - 1)).is_ok() {
        let _ = file.read_exact(&mut last);
    }
    let gap = if last[0] == b'\n' { "" } else { "\n" };
    file.write_all(format!("{gap}{}\n", title_line(session, &name)).as_bytes()).map_err(|e| e.to_string())?;
    Ok(name)
}

/// Deletes a session: its file, and the folder beside it with its subagents'
/// and tools' output, go to the Recycle Bin (they can be put back from there).
pub fn delete_session(project: &str, session: &str) -> Result<(), String> {
    let project = allowed(project)?;
    if !is_session_id(session) {
        return Err(format!("{session} is not a session id"));
    }
    let (_, path, _) = session_files(&project)
        .into_iter()
        .find(|f| f.0 == session)
        .ok_or_else(|| "This session is gone.".to_string())?;
    let mut doomed = vec![path.clone()];
    let beside = path.with_extension("");
    if beside.is_dir() {
        doomed.push(beside);
    }
    crate::platform::move_to_trash(&doomed)
}

/// What Claude Code appends to a session's file when it is renamed.
fn title_line(session: &str, name: &str) -> String {
    json!({ "type": "custom-title", "customTitle": name, "sessionId": session }).to_string()
}

/// The first and the last SLICE bytes of a file (all of it when it is small).
fn ends(path: &Path) -> (String, String) {
    let Ok(mut file) = std::fs::File::open(path) else { return Default::default() };
    let len = file.metadata().map_or(0, |m| m.len());
    let mut read = |from: u64, n: u64| {
        let mut buf = Vec::new();
        if file.seek(SeekFrom::Start(from)).is_ok() {
            let _ = (&mut file).take(n).read_to_end(&mut buf);
        }
        String::from_utf8_lossy(&buf).into_owned()
    };
    if len <= 2 * SLICE {
        let all = read(0, len);
        return (all.clone(), all);
    }
    (read(0, SLICE), read(len - SLICE, SLICE))
}

#[derive(Default, Debug, PartialEq)]
pub struct Found {
    pub title: Option<String>,
    pub prompt: Option<String>,
}

/// What a session is called and what was last asked, from the start and the
/// end of its file. Titles are appended as they change, so the last one wins,
/// and a name the user gave beats Claude's; without either, the first prompt.
/// Lines cut at the edges of a slice don't parse and are skipped.
pub fn describe(head: &str, tail: &str) -> Found {
    let (mut custom, mut ai, mut prompt) = (None, None, None);
    for v in tail.lines().filter_map(|l| serde_json::from_str::<Value>(l).ok()) {
        let text = |key: &str| {
            v.get(key).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(str::to_string)
        };
        match v.get("type").and_then(Value::as_str) {
            Some("custom-title") => custom = text("customTitle").or(custom),
            Some("ai-title") => ai = text("aiTitle").or(ai),
            Some("last-prompt") => prompt = text("lastPrompt").or(prompt),
            _ => {}
        }
    }
    let first = || head.lines().filter_map(|l| serde_json::from_str::<Value>(l).ok()).find_map(|v| user_text(&v));
    Found {
        title: custom.or(ai).or_else(|| first().map(|t| typed_part(&t))).map(|t| one_line(&t, 80)),
        prompt: prompt.map(|p| one_line(&typed_part(&p), 120)),
    }
}

/// A sent prompt as it was typed, without the list of files `with_attachments`
/// put after it — or, for a prompt that was only files, their names.
fn typed_part(text: &str) -> String {
    let marker = format!("\n\n{ATTACHED}\n");
    let (typed, list) = match text.rfind(&marker) {
        Some(i) => (&text[..i], &text[i + marker.len()..]),
        None => match text.strip_prefix(&marker[2..]) {
            Some(list) => ("", list),
            None => return text.to_string(),
        },
    };
    let names: Option<Vec<&str>> =
        list.lines().map(|l| l.strip_prefix("- ").map(|p| p.rsplit(['\\', '/']).next().unwrap_or(p))).collect();
    match names {
        // Not a list of ours after all: the text as it is.
        None => text.to_string(),
        Some(names) if typed.trim().is_empty() => names.join(", "),
        Some(_) => typed.trim_end().to_string(),
    }
}

// ── A conversation ────────────────────────────────────────────────────────────

#[derive(Serialize, Debug, PartialEq)]
pub struct Message {
    /// "user", "assistant", "step": a tool Claude called, or "compacted":
    /// where Claude Code summarized the conversation before it.
    pub role: &'static str,
    pub text: String,
    /// A step's tool and the few fields it is labelled by (`brief`): the page
    /// words it (hooks.ts stepLabel) as it does a live run's steps.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input: Option<Value>,
    /// How big the conversation was when it was compacted, in tokens.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tokens: Option<u64>,
}

impl Message {
    fn said(role: &'static str, text: String) -> Self {
        Self { role, text, tool: None, input: None, tokens: None }
    }

    fn step(block: &Value) -> Self {
        let tool = block.get("name").and_then(Value::as_str).unwrap_or("Tool").to_string();
        Self { role: "step", text: String::new(), tool: Some(tool), input: Some(brief(block.get("input"))), tokens: None }
    }

    fn compacted(tokens: Option<u64>) -> Self {
        Self { role: "compacted", text: String::new(), tool: None, input: None, tokens }
    }
}

pub fn messages(project: &str, session: &str) -> Result<Vec<Message>, String> {
    let project = allowed(project)?;
    if !is_session_id(session) {
        return Err(format!("{session} is not a session id"));
    }
    let (_, path, _) = session_files(&project)
        .into_iter()
        .find(|f| f.0 == session)
        .ok_or_else(|| "This session is gone.".to_string())?;
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    Ok(conversation(&String::from_utf8_lossy(&bytes), MAX_TURNS))
}

/// The conversation as a run draws it live: what the user typed (slash
/// commands too, with what they printed), what Claude answered and the tools
/// it called on the way, and where it was compacted, newest last — the last
/// `max` turns, each from its prompt on, with the newest MAX_STEPS steps among
/// them. Counting turns, not messages: a long answer split by its steps never
/// pushes the prompt that asked for it off the top. Tool results, thinking,
/// subagents and Claude Code's bookkeeping are left out; the pieces of one
/// answer between two steps are joined.
pub fn conversation(text: &str, max: usize) -> Vec<Message> {
    let mut out: Vec<Message> = Vec::new();
    for line in text.lines() {
        // Most lines are tool results: skip them before parsing.
        if !(line.contains("\"type\":\"user\"")
            || line.contains("\"type\":\"assistant\"")
            || line.contains("\"queued_command\"")
            || line.contains("\"compact_boundary\""))
        {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        if v.get("type").and_then(Value::as_str) == Some("system") {
            if v.get("subtype").and_then(Value::as_str) == Some("compact_boundary") {
                out.push(Message::compacted(v.pointer("/compactMetadata/preTokens").and_then(Value::as_u64)));
            }
            continue;
        }
        if let Some(text) = user_text(&v).or_else(|| typed_command(&v)).or_else(|| sent_meanwhile(&v)) {
            out.push(Message::said("user", text));
            continue;
        }
        if let Some(text) = command_output(&v) {
            out.push(Message::said("assistant", text));
            continue;
        }
        for block in assistant_blocks(&v) {
            match block.get("type").and_then(Value::as_str) {
                Some("text") => {
                    let Some(text) = block.get("text").and_then(Value::as_str).map(str::trim).filter(|t| !t.is_empty())
                    else {
                        continue;
                    };
                    match out.last_mut() {
                        Some(last) if last.role == "assistant" => {
                            last.text.push_str("\n\n");
                            last.text.push_str(text);
                        }
                        _ => out.push(Message::said("assistant", text.to_string())),
                    }
                }
                Some("tool_use") => out.push(Message::step(block)),
                _ => {}
            }
        }
    }
    let prompts: Vec<usize> = out.iter().enumerate().filter(|(_, m)| m.role == "user").map(|(i, _)| i).collect();
    if prompts.len() > max {
        let first = prompts.get(prompts.len() - max).copied().unwrap_or(out.len());
        out.drain(..first);
    }
    let mut extra = out.iter().filter(|m| m.role == "step").count().saturating_sub(MAX_STEPS);
    out.retain(|m| {
        let old_step = extra > 0 && m.role == "step";
        if old_step {
            extra -= 1;
        }
        !old_step
    });
    out
}

fn flag(v: &Value, key: &str) -> bool {
    v.get(key).and_then(Value::as_bool) == Some(true)
}

/// What the user typed, from a `user` line: nothing for tool results, meta
/// lines, subagents, compaction summaries, or Claude Code's own wrappers (an
/// editor's "the user opened this file" block is dropped, the prompt kept).
fn user_text(v: &Value) -> Option<String> {
    if v.get("type").and_then(Value::as_str) != Some("user")
        || ["isMeta", "isSidechain", "isCompactSummary"].iter().any(|k| flag(v, k))
    {
        return None;
    }
    let typed = |t: &str| !NOT_TYPED.iter().any(|p| t.trim_start().starts_with(p));
    let text = match v.get("message")?.get("content")? {
        Value::String(s) => s.clone(),
        Value::Array(blocks) => {
            if blocks.iter().any(|b| b.get("type").and_then(Value::as_str) == Some("tool_result")) {
                return None;
            }
            blocks
                .iter()
                .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
                .filter_map(|b| b.get("text").and_then(Value::as_str))
                .filter(|t| typed(t))
                .collect::<Vec<_>>()
                .join("\n")
        }
        _ => return None,
    };
    let text = text.trim();
    (!text.is_empty() && typed(text)).then(|| text.to_string())
}

/// A user line's text when it is the whole of it (not blocks), from a line
/// that is the conversation's own.
fn plain_user_text(v: &Value) -> Option<&str> {
    if v.get("type").and_then(Value::as_str) != Some("user") || ["isMeta", "isSidechain"].iter().any(|k| flag(v, k)) {
        return None;
    }
    v.pointer("/message/content").and_then(Value::as_str)
}

/// What is between `<tag>` and `</tag>` in `text`.
fn between<'a>(text: &'a str, tag: &str) -> Option<&'a str> {
    let start = text.find(&format!("<{tag}>"))? + tag.len() + 2;
    let end = start + text[start..].find(&format!("</{tag}>"))?;
    Some(&text[start..end])
}

/// A slash command the user typed (`/compact focus on the API`), as Claude
/// Code records it: `<command-name>/compact</command-name>` and its
/// `<command-args>`. A skill Claude loaded by itself is recorded the same way,
/// but without the slash, and is no message of the user's.
fn typed_command(v: &Value) -> Option<String> {
    let text = plain_user_text(v)?;
    let name = between(text, "command-name")?.trim();
    if !name.starts_with('/') {
        return None;
    }
    let args = between(text, "command-args").map(str::trim).unwrap_or_default();
    Some(if args.is_empty() { name.to_string() } else { format!("{name} {args}") })
}

/// What a slash command printed (`Set model to …`), from its
/// `<local-command-stdout>`, without the terminal's colours. Not the
/// "Compacted" of /compact: its divider says it.
fn command_output(v: &Value) -> Option<String> {
    let text = plain_user_text(v)?.trim_start();
    if !text.starts_with("<local-command-stdout>") {
        return None;
    }
    let output = strip_ansi(between(text, "local-command-stdout")?);
    let output = output.trim();
    (!output.is_empty() && !output.starts_with("Compacted")).then(|| output.to_string())
}

/// `s` without its ANSI escape sequences (`ESC [ … letter`).
fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' && chars.peek() == Some(&'[') {
            chars.next();
            for c in chars.by_ref() {
                if c.is_ascii_alphabetic() {
                    break;
                }
            }
        } else {
            out.push(c);
        }
    }
    out
}

/// A message sent while Claude was at work, from the line that recorded it
/// where Claude read it, mid-turn (one read after the turn is a `user` line).
fn sent_meanwhile(v: &Value) -> Option<String> {
    let a = v.get("attachment").filter(|_| !flag(v, "isSidechain"))?;
    if a.get("type").and_then(Value::as_str) != Some("queued_command") {
        return None;
    }
    let text = a.get("prompt")?.as_str()?.trim();
    (!text.is_empty() && !NOT_TYPED.iter().any(|p| text.starts_with(p))).then(|| text.to_string())
}

/// The blocks of an `assistant` line — text, thinking, tool calls, in order —
/// when it is the conversation's own: a subagent's lines are not.
fn assistant_blocks(v: &Value) -> &[Value] {
    if v.get("type").and_then(Value::as_str) != Some("assistant") || flag(v, "isSidechain") {
        return &[];
    }
    v.pointer("/message/content").and_then(Value::as_array).map_or(&[], Vec::as_slice)
}

/// `s` on one line, at most `max` characters, an ellipsis when cut.
fn one_line(s: &str, max: usize) -> String {
    let flat = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= max {
        return flat;
    }
    let mut cut: String = flat.chars().take(max).collect();
    cut.push('…');
    cut
}

// ── Runs ──────────────────────────────────────────────────────────────────────

static NEXT_RUN: AtomicU64 = AtomicU64::new(1);
/// Runs in flight: run → Claude Code and all it started, for Stop.
static RUNS: LazyLock<Mutex<HashMap<u64, platform::Tree>>> = LazyLock::new(Default::default);
/// Runs still taking messages, until their turn's result: run → their input,
/// and whether they may read the inbox (they started with files).
static INPUTS: LazyLock<Mutex<HashMap<u64, (Sender<String>, bool)>>> = LazyLock::new(Default::default);
/// Runs whose turn is over but that stay alive (background tasks, a plugin's
/// pane open): their input ends once nothing keeps them any more.
static BETWEEN_TURNS: LazyLock<Mutex<HashSet<u64>>> = LazyLock::new(Default::default);

// ── Plugins' panes ───────────────────────────────────────────────────────────
//
// A plugin's mod can open a pane (a weather plugin's /forecast, say). Claude Code
// draws panes for the surfaces attached to a session: Buddybara attaches to
// each run as one (the Agent SDK's `ui_attach`), hears the open panes in the
// stream (`system/ui_panes`), and asks for a pane's content, a tree of plain
// elements, with `ui_render`; clicks, typing and picks go back as `ui_press`,
// `ui_input`, `ui_select` (buddy.ts, buddy/pane.ts). The run stays alive while
// a pane is open, the way it does for background tasks.

/// The surface Buddybara draws as: of the three Claude Code knows, the one
/// whose elements (boxes, text, buttons, fields, pickers) the panel draws.
const SURFACE: &str = "desktop";
const CLIENT: &str = "buddybara";
/// What the page may ask a run about its panes, and nothing else.
const UI_ASKS: &[&str] = &["ui_render", "ui_press", "ui_input", "ui_select", "ui_panes", "ui_pane_show", "ui_pane_focus", "ui_close"];
/// How long a run gets to answer one of those.
const UI_WAIT: Duration = Duration::from_secs(10);
static NEXT_ASK: AtomicU64 = AtomicU64::new(1);
/// Asks waiting for their answer: request id → where it goes.
static ASKED: LazyLock<Mutex<HashMap<String, Sender<Value>>>> = LazyLock::new(Default::default);

/// A control request on a run's input: the line, and its id.
fn control_line(request: Value) -> (String, String) {
    let id = format!("buddybara-{}", NEXT_ASK.fetch_add(1, Ordering::Relaxed));
    (format!("{}\n", json!({ "type": "control_request", "request_id": id, "request": request })), id)
}

/// The page asks a run about its panes (one of UI_ASKS): Buddybara's surface
/// and client are filled in, the answer comes back as Claude Code gave it.
pub fn ui(run: u64, request: Value) -> Result<Value, String> {
    let Value::Object(mut request) = request else { return Err("not a request".into()) };
    let subtype = request.get("subtype").and_then(Value::as_str).unwrap_or("");
    if !UI_ASKS.contains(&subtype) {
        return Err(format!("{subtype} isn't asked from the page"));
    }
    if subtype != "ui_close" && subtype != "ui_panes" {
        request.insert("surface".into(), json!(SURFACE));
    }
    request.insert("client_id".into(), json!(CLIENT));
    let input = INPUTS.lock().unwrap().get(&run).map(|(input, _)| input.clone()).ok_or_else(|| crate::i18n::t("This pane's conversation has ended."))?;
    let (line, id) = control_line(Value::Object(request));
    let (found, answer) = channel::<Value>();
    ASKED.lock().unwrap().insert(id.clone(), found);
    if input.send(line).is_err() {
        ASKED.lock().unwrap().remove(&id);
        return Err(crate::i18n::t("This pane's conversation has ended."));
    }
    drop(input);
    let reply = answer.recv_timeout(UI_WAIT);
    ASKED.lock().unwrap().remove(&id);
    let reply = reply.map_err(|_| crate::i18n::t("The plugin didn't answer."))?;
    if reply.get("subtype").and_then(Value::as_str) == Some("error") {
        return Err(reply.get("error").and_then(Value::as_str).map_or_else(|| crate::i18n::t("The plugin couldn't do it."), str::to_string));
    }
    Ok(reply.get("response").cloned().unwrap_or(Value::Null))
}

/// Buddybara is quitting: the runs it kept alive between turns end (their
/// input closes, and Claude Code exits), so none is left behind.
pub fn end_all() {
    INPUTS.lock().unwrap().clear();
}

/// `claude`, from %PATH% or where its installer or winget puts it: installed
/// while Buddybara runs, it is on a PATH this process started too early to see.
pub(crate) fn claude_exe() -> Option<PathBuf> {
    platform::find_on_path("claude").or_else(|| {
        let exe = if cfg!(windows) { "claude.exe" } else { "claude" };
        let native = platform::home_dir().join(".local").join("bin").join(exe);
        let winget = std::env::var_os("LOCALAPPDATA").map(|d| PathBuf::from(d).join(r"Microsoft\WinGet\Links\claude.exe"));
        std::iter::once(native).chain(winget).find(|p| p.is_file())
    })
}

/// How a run is asked to work: the permission mode, the effort and the model,
/// each one of the values of its list, or Claude Code's own default when
/// absent. `ultracode`: workflows on every task, at whatever effort.
#[derive(serde::Deserialize, Default)]
pub struct Options {
    pub mode: Option<String>,
    pub effort: Option<String>,
    pub model: Option<String>,
    #[serde(default)]
    pub ultracode: bool,
    /// A side question (/btw): answered from a copy of the conversation that
    /// is never saved, so the conversation itself doesn't change.
    #[serde(default)]
    pub btw: bool,
}

/// The arguments of a run, before the prompt goes in on stdin. `files`: the
/// folder the attached files are in, which Claude may then read without asking.
fn arguments(session: Option<&str>, options: &Options, files: Option<&Path>) -> Result<Vec<String>, String> {
    let mut args: Vec<String> =
        ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"].map(String::from).into();
    // Never a bypass, whatever the page asks: only the four modes of the picker.
    let mode = options.mode.as_deref().unwrap_or("default");
    if !MODES.contains(&mode) {
        return Err(format!("unknown mode {mode}"));
    }
    args.extend(["--permission-mode".into(), mode.into()]);
    if let Some(effort) = options.effort.as_deref() {
        if !EFFORTS.contains(&effort) {
            return Err(format!("unknown effort {effort}"));
        }
    }
    // Ultracode is a setting of this run only, layered over the user's own
    // (CLI 2.1.299 and later: at any effort; `--effort ultracode` would force
    // extra high). A constant: nothing from the page goes into it.
    if options.ultracode {
        args.extend(["--settings".into(), ULTRACODE_ON.into()]);
    }
    if let Some(effort) = options.effort.as_deref() {
        args.extend(["--effort".into(), effort.into()]);
    }
    if let Some(model) = options.model.as_deref() {
        if !MODELS.contains(&model) {
            return Err(format!("unknown model {model}"));
        }
        args.extend(["--model".into(), model.into()]);
    }
    if let Some(id) = session {
        if !is_session_id(id) {
            return Err("Not a session id.".into());
        }
        args.extend(["--resume".into(), id.into()]);
        if options.btw {
            args.push("--fork-session".into());
        }
    }
    if options.btw {
        args.push("--no-session-persistence".into());
    }
    // Last: --add-dir takes every value up to the next option.
    if let Some(dir) = files {
        args.extend(["--add-dir".into(), dir.to_string_lossy().into_owned()]);
    }
    Ok(args)
}

/// Heads the list of attached files at the end of a prompt (run.ts
/// splitAttachments reads it back to show them as files).
const ATTACHED: &str = "Attached files:";

/// What a run is sent: the prompt, then the attached files by their full path,
/// where Claude Code reads them (images too) like any other file.
fn with_attachments(prompt: &str, files: &[PathBuf]) -> String {
    if files.is_empty() {
        return prompt.to_string();
    }
    let list: Vec<String> = files.iter().map(|f| format!("- {}", f.display())).collect();
    let block = format!("{ATTACHED}\n{}", list.join("\n"));
    if prompt.is_empty() { block } else { format!("{prompt}\n\n{block}") }
}

/// Starts `claude -p` in `project`: a new conversation, or `session` continued.
/// `attachments`: files of the inbox (files.rs) the prompt comes with.
/// What it says reaches the page as `code-run` events (see `events`).
pub fn send(
    app: AppHandle,
    project: &str,
    session: Option<String>,
    prompt: &str,
    options: &Options,
    attachments: &[String],
) -> Result<u64, String> {
    let cwd = allowed(project)?;
    let (line, with_files) = message(prompt, attachments)?;
    let inbox = with_files.then(crate::files::inbox_dir);
    let args = arguments(session.as_deref(), options, inbox.as_deref())?;
    let exe = claude_exe().ok_or_else(|| "Claude Code isn't installed (no claude on PATH or in ~/.local/bin).".to_string())?;
    let mut cmd = Command::new(exe);
    // Left unset, `claude -p` writes "sdk-cli" into the session's file, and
    // VS Code's session list hides every sdk-* session. Not "cli" either: in
    // print mode the CLI turns it into "sdk-cli". A name it doesn't know turns
    // on no host's behaviour.
    cmd.env("CLAUDE_CODE_ENTRYPOINT", ENTRYPOINT);
    cmd.envs(key_env());
    cmd.args(&args).current_dir(&cwd).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = platform::no_console(&mut cmd).spawn().map_err(|e| format!("Could not start Claude Code: {e}"))?;
    let run = NEXT_RUN.fetch_add(1, Ordering::Relaxed);
    RUNS.lock().unwrap().insert(run, platform::Tree::hold(&child));
    // Claude Code reads its input to the end: this message, then those sent
    // while it works, written in order off this thread. The input ends when
    // the last sender goes (`watch`, at the result): what was written is still
    // read, then Claude Code exits.
    let (input, lines) = channel::<String>();
    // Attached as a surface first, so a plugin's pane opened in this run shows
    // in the panel (not for a side question, never shown as a conversation).
    if !options.btw {
        let (attach, _) = control_line(json!({ "subtype": "ui_attach", "surface": SURFACE, "client_id": CLIENT }));
        let _ = input.send(attach);
    }
    let _ = input.send(line);
    if let Some(mut stdin) = child.stdin.take() {
        std::thread::spawn(move || {
            for line in lines {
                if stdin.write_all(line.as_bytes()).is_err() {
                    break;
                }
            }
        });
    }
    INPUTS.lock().unwrap().insert(run, (input, with_files));
    log::line(format!("code run {run} started ({})", if session.is_some() { "continued" } else { "new" }));
    std::thread::spawn(move || watch(&app, run, child));
    Ok(run)
}

/// What a run is sent, checked: the prompt and its attached files as a line of
/// `--input-format stream-json`, and whether files came with it.
fn message(prompt: &str, attachments: &[String]) -> Result<(String, bool), String> {
    let files = crate::files::attachments(attachments)?;
    let prompt = with_attachments(prompt.trim(), &files);
    if prompt.is_empty() {
        return Err("Nothing to send.".into());
    }
    if prompt.chars().count() > MAX_PROMPT {
        return Err(crate::i18n::tf("A message is at most {max} characters.", &[("max", &MAX_PROMPT.to_string())]));
    }
    let line = json!({ "type": "user", "message": { "role": "user", "content": prompt } });
    Ok((format!("{line}\n"), !files.is_empty()))
}

/// A message for a run at work, read at its next step (or as one more turn if
/// its answer is already being written), or for a run between turns that its
/// background tasks keep alive. False when it takes no more: its turn is over
/// with nothing in the background, or the message has files and the run may
/// not read the inbox — the page then sends it as the next run.
pub fn say(run: u64, prompt: &str, attachments: &[String]) -> Result<bool, String> {
    let (line, with_files) = message(prompt, attachments)?;
    let inputs = INPUTS.lock().unwrap();
    let Some((input, reads_inbox)) = inputs.get(&run) else { return Ok(false) };
    if with_files && !reads_inbox {
        return Ok(false);
    }
    let sent = input.send(line).is_ok();
    // A turn starts: closing the pane now mustn't end the run under it.
    if sent {
        BETWEEN_TURNS.lock().unwrap().remove(&run);
    }
    Ok(sent)
}

/// Turns every line Claude Code prints into events until it exits. A run that
/// ends without a `result` line (not logged in, stopped, crashed) still ends
/// with one, carrying the last thing it said on stderr.
fn watch(app: &AppHandle, run: u64, mut child: Child) {
    let stderr = child.stderr.take();
    let errors = std::thread::spawn(move || {
        let mut text = String::new();
        if let Some(mut e) = stderr {
            let _ = e.read_to_string(&mut text);
        }
        text
    });
    let emit = |event: Value| {
        let _ = app.emit_to(WINDOW_LABEL, "code-run", event);
    };
    let mut answered = false;
    // Background tasks still running (a dev server, a watcher): Claude Code
    // stays alive for them after its answer, and starts a turn by itself when
    // one ends. A plugin's pane open keeps it alive too.
    let mut background = 0;
    let mut panes = 0;
    let end_if_free = |background: usize, panes: usize| {
        if background == 0 && panes == 0 && BETWEEN_TURNS.lock().unwrap().contains(&run) {
            INPUTS.lock().unwrap().remove(&run);
        }
    };
    if let Some(out) = child.stdout.take() {
        for line in BufReader::new(out).lines().map_while(Result::ok) {
            let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
            // The answer to something the page asked (`ui`): back to it, not an event.
            if v.get("type").and_then(Value::as_str) == Some("control_response") {
                let id = v.pointer("/response/request_id").and_then(Value::as_str).unwrap_or("");
                if let Some(asker) = ASKED.lock().unwrap().remove(id) {
                    let _ = asker.send(v["response"].clone());
                }
                continue;
            }
            match v.get("subtype").and_then(Value::as_str) {
                // (The last one ending starts a turn that says so: the input
                // stays open for it, and ends at its result.)
                Some("background_tasks_changed") => {
                    background = v.get("tasks").and_then(Value::as_array).map_or(0, Vec::len);
                }
                // The last pane closed between turns: nothing keeps the run.
                Some("ui_panes") => {
                    panes = v.get("panes").and_then(Value::as_array).map_or(0, Vec::len);
                    end_if_free(background, panes);
                }
                _ => {}
            }
            // Claude at work: a turn it started by itself is under way.
            if v.get("type").and_then(Value::as_str) == Some("assistant") {
                BETWEEN_TURNS.lock().unwrap().remove(&run);
            }
            // The turn is over. With nothing left in the background and no
            // pane open the input ends and Claude Code exits; otherwise it
            // stays open, so the next message goes into this same process, as
            // in VS Code.
            if v.get("type").and_then(Value::as_str) == Some("result") {
                BETWEEN_TURNS.lock().unwrap().insert(run);
                end_if_free(background, panes);
            }
            for mut event in events(&v) {
                answered |= event["kind"] == "result";
                if event["kind"] == "result" {
                    event["background"] = json!(background);
                    event["panes"] = json!(panes);
                }
                event["run"] = json!(run);
                emit(event);
            }
        }
    }
    let code = child.wait().ok().and_then(|s| s.code());
    let errors = errors.join().unwrap_or_default();
    RUNS.lock().unwrap().remove(&run);
    INPUTS.lock().unwrap().remove(&run);
    BETWEEN_TURNS.lock().unwrap().remove(&run);
    if !answered {
        let last = errors.lines().rev().map(str::trim).find(|l| !l.is_empty()).unwrap_or("Claude Code stopped.");
        emit(json!({ "run": run, "kind": "result", "error": true, "text": last }));
    }
    log::line(format!("code run {run} ended ({})", code.map_or_else(|| "stopped".to_string(), |c| c.to_string())));
    emit(json!({ "run": run, "kind": "exit" }));
}

/// What the page hears of one line of `--output-format stream-json`: the
/// session's id when it starts, Claude's words and tool calls as they come (the
/// main conversation's, not its subagents'), compaction, and the result.
pub fn events(v: &Value) -> Vec<Value> {
    let session = v.get("session_id").cloned().unwrap_or(Value::Null);
    match v.get("type").and_then(Value::as_str) {
        Some("system") => match v.get("subtype").and_then(Value::as_str) {
            // With the commands the session has: the panel's `/` menu asks again
            // when one is new to it (a plugin's, registered as the session started).
            Some("init") => vec![json!({ "kind": "init", "session": session, "commands": v.get("slash_commands").cloned().unwrap_or(json!([])) })],
            Some("commands_changed") => vec![json!({ "kind": "commands_changed" })],
            // Compaction (asked for with /compact, or when the context is
            // full): a status when it starts, another with its result when it
            // ends, then, if it worked, the boundary with the sizes.
            Some("status") if v.get("status").and_then(Value::as_str) == Some("compacting") => {
                vec![json!({ "kind": "compacting" })]
            }
            Some("status") => match v.get("compact_result").and_then(Value::as_str) {
                Some(result) if result != "success" => vec![json!({
                    "kind": "compact_failed",
                    "text": v.get("compact_error").and_then(Value::as_str).unwrap_or_default(),
                })],
                // An automatic one Claude Code started, then found it needn't
                // do: the status goes back to none, with no result.
                None if v.get("status").is_none_or(Value::is_null) && v.get("permissionMode").is_none() => {
                    vec![json!({ "kind": "compact_skipped" })]
                }
                _ => Vec::new(),
            },
            Some("compact_boundary") => vec![json!({
                "kind": "compacted",
                "tokens": v.pointer("/compact_metadata/pre_tokens").and_then(Value::as_u64),
            })],
            // A plugin's panes (buddy/pane.ts): which are open, which one asks
            // to be shown, and when what they draw changed.
            Some("ui_panes") => vec![json!({
                "kind": "panes",
                "panes": v.get("panes").and_then(Value::as_array).map(|list| list.iter().map(|p| json!({
                    "id": p.get("id").and_then(Value::as_str).unwrap_or(""),
                    "title": p.get("title").and_then(Value::as_str).unwrap_or(""),
                    "plugin": p.get("plugin").and_then(Value::as_str).unwrap_or(""),
                })).collect::<Vec<_>>()).unwrap_or_default(),
                "focus": v.get("focus_requested_id").cloned().unwrap_or(Value::Null),
            })],
            Some("ui_invalidate") => vec![json!({
                "kind": "ui_invalidate",
                // Only these are stale; none named: every pane is.
                "instances": v.get("instances").and_then(Value::as_array).map(|list| list.iter()
                    .filter(|i| i.get("component").and_then(Value::as_str) == Some("Pane"))
                    .filter_map(|i| i.get("instance_id").cloned())
                    .collect::<Vec<_>>()),
            })],
            Some("ui_toast") => match v.get("text").and_then(Value::as_str).map(str::trim) {
                Some(text) if !text.is_empty() => vec![json!({ "kind": "ui_toast", "text": one_line(text, 300) })],
                _ => Vec::new(),
            },
            // The name the user gave the session (/rename), said again when a run starts.
            Some("session_title_changed") => match v.get("title").and_then(Value::as_str).map(str::trim) {
                Some(title) if !title.is_empty() => vec![json!({ "kind": "title", "text": title })],
                _ => Vec::new(),
            },
            _ => Vec::new(),
        },
        Some("assistant") if v.get("parent_tool_use_id").is_none_or(Value::is_null) => {
            let Some(blocks) = v.pointer("/message/content").and_then(Value::as_array) else { return Vec::new() };
            blocks
                .iter()
                .filter_map(|b| match b.get("type").and_then(Value::as_str) {
                    Some("text") => b
                        .get("text")
                        .and_then(Value::as_str)
                        .filter(|t| !t.trim().is_empty())
                        .map(|t| json!({ "kind": "text", "text": t })),
                    Some("tool_use") => Some(json!({
                        "kind": "tool",
                        "tool": b.get("name").cloned().unwrap_or(Value::Null),
                        "input": brief(b.get("input")),
                    })),
                    _ => None,
                })
                .collect()
        }
        Some("result") => vec![json!({
            "kind": "result",
            "text": v.get("result").and_then(Value::as_str).unwrap_or_default(),
            "error": flag(v, "is_error"),
            "session": session,
        })],
        _ => Vec::new(),
    }
}

/// The few fields a tool call is labelled by (hooks.ts stepLabel), each cut
/// short: never a whole file being written.
fn brief(input: Option<&Value>) -> Value {
    const KEYS: &[&str] = &["command", "path", "file_path", "notebook_path", "pattern", "url", "query", "description"];
    let mut out = Map::new();
    if let Some(map) = input.and_then(Value::as_object) {
        for key in KEYS {
            if let Some(s) = map.get(*key).and_then(Value::as_str) {
                out.insert((*key).into(), json!(one_line(s, 160)));
            }
        }
    }
    Value::Object(out)
}

/// Stops a run and everything it started (its shell commands too). The turn is
/// left unfinished; the conversation itself is kept.
pub fn stop(run: u64) {
    let runs = RUNS.lock().unwrap();
    let Some(tree) = runs.get(&run) else { return };
    log::line(format!("code run {run} stopped"));
    tree.end();
}

// ── The / menu ────────────────────────────────────────────────────────────────

/// How long Claude Code may take to answer (it loads its plugins first).
const COMMANDS_WAIT: Duration = Duration::from_secs(30);
/// How long it may take to end once its input is closed, before it is stopped.
const COMMANDS_EXIT: Duration = Duration::from_secs(5);
/// How long the session of a look at the commands stays quiet: its last hooks
/// (SessionEnd) may come a little after it ended.
const QUIET_FOR: Duration = Duration::from_secs(120);

/// The sessions of Buddybara's looks at the commands, and since when: their
/// hooks are no one's session (pipe.rs drops them).
static QUIET: LazyLock<Mutex<HashMap<String, std::time::Instant>>> = LazyLock::new(Default::default);

/// Whether hooks of `session` are Buddybara's own look at the commands.
pub fn is_quiet(session: &str) -> bool {
    let mut quiet = QUIET.lock().unwrap();
    quiet.retain(|_, at| at.elapsed() < QUIET_FOR);
    quiet.contains_key(session)
}

/// A new session id (a version 4 UUID), random from the hasher's per-process
/// keys and the time: no crate needed for it.
fn new_session_id() -> String {
    use std::hash::BuildHasher;
    let state = std::collections::hash_map::RandomState::new();
    let now = std::time::SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_nanos());
    let a = state.hash_one((now, std::process::id(), NEXT_ASK.fetch_add(1, Ordering::Relaxed)));
    let b = state.hash_one((a, now));
    let hex = format!("{a:016x}{b:016x}");
    format!("{}-{}-4{}-{:x}{}-{}", &hex[0..8], &hex[8..12], &hex[13..16], 8 | (u8::from_str_radix(&hex[16..17], 16).unwrap_or(0) & 3), &hex[17..20], &hex[20..32])
}

/// One entry of the `/` menu: a command built into Claude Code, a skill, a
/// plugin's (`plugin:name`, or a command a plugin's code registered, `plugin`
/// naming it), or one of the user's or the project's own.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SlashCommand {
    pub name: String,
    pub description: String,
    pub argument_hint: String,
    pub aliases: Vec<String>,
    pub builtin: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plugin: Option<String>,
}

/// The commands Claude Code has in `project`, asked as the Agent SDK asks for
/// them: an `initialize` request, answered before any message, so no model is
/// called. Its hooks run, since plugins register their commands from theirs
/// (`/forecast`), but its session id is chosen here and kept quiet, so nothing of it
/// shows in Buddybara; it saves nothing, and once it has answered its input is
/// closed and it ends (or is stopped). Without a project (Settings → Skills),
/// asked from the home folder: the user's own and plugins', no project's.
pub fn commands(project: Option<&str>) -> Result<Vec<SlashCommand>, String> {
    let cwd = match project {
        Some(project) => allowed(project)?,
        None => platform::home_dir(),
    };
    let exe = claude_exe().ok_or_else(|| "Claude Code isn't installed.".to_string())?;
    let session = new_session_id();
    QUIET.lock().unwrap().insert(session.clone(), std::time::Instant::now());
    let mut cmd = Command::new(exe);
    cmd.env("CLAUDE_CODE_ENTRYPOINT", ENTRYPOINT);
    cmd.args(["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"])
        .args(["--no-session-persistence", "--session-id", &session])
        .current_dir(&cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = platform::no_console(&mut cmd).spawn().map_err(|e| format!("Could not start Claude Code: {e}"))?;
    let tree = platform::Tree::hold(&child);
    let mut input = child.stdin.take();
    let request = json!({ "type": "control_request", "request_id": "buddybara-commands", "request": { "subtype": "initialize" } });
    if let Some(stdin) = input.as_mut() {
        let _ = stdin.write_all(format!("{request}\n").as_bytes());
    }
    let (found, answer) = channel::<Value>();
    if let Some(out) = child.stdout.take() {
        std::thread::spawn(move || {
            for line in BufReader::new(out).lines().map_while(Result::ok) {
                let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
                if v.get("type").and_then(Value::as_str) == Some("control_response") {
                    let _ = found.send(v);
                    return;
                }
            }
        });
    }
    let reply = answer.recv_timeout(COMMANDS_WAIT);
    drop(input);
    std::thread::spawn(move || {
        let deadline = std::time::Instant::now() + COMMANDS_EXIT;
        while std::time::Instant::now() < deadline {
            if !matches!(child.try_wait(), Ok(None)) {
                return;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        tree.end();
        let _ = child.wait();
    });
    let reply = reply.map_err(|_| "Claude Code didn't list its commands.".to_string())?;
    let list = parse_commands(&reply);
    if let Err(err) = &list {
        log::line(format!("commands: {err}"));
    }
    list
}

// ── Usage ─────────────────────────────────────────────────────────────────────

/// A conversation's totals as Claude Code keeps them (Settings → Claude Code →
/// Usage): what it cost, how long the API took, how long it has been going,
/// the lines it changed. They count every run it had, wherever it ran.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionUsage {
    pub project: String,
    pub session: String,
    pub title: String,
    pub cost_usd: f64,
    pub api_ms: u64,
    pub wall_ms: u64,
    pub lines_added: u64,
    pub lines_removed: u64,
    /// A model Claude Code has no price for was used: the cost leaves it out.
    pub unknown_cost: bool,
}

/// How many of the newest conversations are looked through for one with totals.
const USAGE_LOOK: usize = 12;

/// The totals of `session` in `project`; without a session, those of the
/// project's newest conversation that has some; without a project either,
/// the newest among the listed projects'. None: none saved yet.
pub fn usage(project: Option<&str>, session: Option<&str>) -> Result<Option<SessionUsage>, String> {
    let mut candidates: Vec<(String, String, PathBuf, u64)> = match project {
        Some(given) => {
            let dir = allowed(given)?;
            session_files(&dir)
                .into_iter()
                .filter(|f| session.is_none_or(|s| f.0 == s))
                .map(|(id, path, last)| (given.to_string(), id, path, last))
                .collect()
        }
        None => projects()
            .into_iter()
            .filter(|p| p.sessions > 0)
            .flat_map(|p| {
                let files = session_files(Path::new(&p.path));
                files.into_iter().map(move |(id, path, last)| (p.path.clone(), id, path, last))
            })
            .collect(),
    };
    if session.is_some() && candidates.is_empty() {
        return Err("This session is gone.".into());
    }
    candidates.sort_by(|a, b| b.3.cmp(&a.3));
    for (project, id, path, _) in candidates.into_iter().take(USAGE_LOOK) {
        let Some(state) = last_cost_state(&path, COST_CHUNK) else { continue };
        let (head, tail) = ends(&path);
        let title = describe(&head, &tail).title.unwrap_or_else(|| id[..8].to_string());
        return Ok(Some(session_usage(project, id, title, &state)));
    }
    Ok(None)
}

/// A `cost-state` line as the totals it holds.
fn session_usage(project: String, session: String, title: String, v: &Value) -> SessionUsage {
    let whole = |key: &str| v.get(key).and_then(Value::as_f64).map_or(0, |n| n.max(0.0) as u64);
    SessionUsage {
        cost_usd: v.get("totalCostUSD").and_then(Value::as_f64).unwrap_or(0.0),
        api_ms: whole("totalAPIDuration"),
        wall_ms: whole("totalDuration"),
        lines_added: whole("totalLinesAdded"),
        lines_removed: whole("totalLinesRemoved"),
        unknown_cost: flag(v, "hasUnknownModelCost"),
        project,
        session,
        title,
    }
}

/// How much of a file is read at a time, from its end, looking for its totals.
const COST_CHUNK: u64 = 256 * 1024;

/// The last `cost-state` line of a conversation's file: the running totals
/// Claude Code appends after its runs.
fn last_cost_state(path: &Path, chunk: u64) -> Option<Value> {
    const MARK: &[u8] = br#""type":"cost-state""#;
    last_line(path, chunk, |line| line.windows(MARK.len()).any(|w| w == MARK), |v| {
        v.get("type").and_then(Value::as_str) == Some("cost-state")
    })
}

// ── Handing a conversation over from the terminal ─────────────────────────────

/// Whether Claude Code is mid-turn in `session`: at work, or waiting on a
/// permission or a question. The panel only takes a conversation over from
/// the terminal between turns (buddy.ts takeFromTerminal).
pub fn turn_open(project: &str, session: &str) -> Result<bool, String> {
    let project = allowed(project)?;
    let (_, path, _) = session_files(&project)
        .into_iter()
        .find(|f| f.0 == session)
        .ok_or_else(|| "This session is gone.".to_string())?;
    const USER: &[u8] = br#""type":"user""#;
    const ASSISTANT: &[u8] = br#""type":"assistant""#;
    let turn = last_line(
        &path,
        COST_CHUNK,
        |line| line.windows(USER.len()).any(|w| w == USER) || line.windows(ASSISTANT.len()).any(|w| w == ASSISTANT),
        |v| matches!(v.get("type").and_then(Value::as_str), Some("user" | "assistant")) && !flag(v, "isSidechain"),
    );
    Ok(turn.as_ref().is_some_and(still_going))
}

/// A conversation's last turn line says Claude still has to answer: it asked
/// for a tool (running, or waiting on the user), or a prompt or a tool's result
/// has no answer yet. Not: an answer that ended the turn, a turn the user
/// interrupted, a typed command's own lines.
fn still_going(v: &Value) -> bool {
    if v.get("type").and_then(Value::as_str) == Some("assistant") {
        return v.pointer("/message/stop_reason").and_then(Value::as_str) == Some("tool_use");
    }
    // Claude Code's own lines (a caveat, the summary a compaction leaves) ask nothing.
    if flag(v, "isMeta") || flag(v, "isCompactSummary") {
        return false;
    }
    let content = v.pointer("/message/content");
    if content.and_then(Value::as_array).is_some_and(|blocks| blocks.iter().any(|b| b.get("type").and_then(Value::as_str) == Some("tool_result"))) {
        return true;
    }
    let text = match content {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(blocks)) => blocks.iter().filter_map(|b| b.get("text").and_then(Value::as_str)).collect::<Vec<_>>().join("\n"),
        _ => String::new(),
    };
    let text = text.trim_start();
    !(text.starts_with("[Request interrupted")
        || text.contains("<command-name>")
        || text.contains("<local-command-stdout>")
        || text.contains("<local-command-caveat>"))
}

/// The last line of a file that `maybe` (on its bytes, cheap) and `keep` (once
/// parsed) both pick. Read from the end, `chunk` bytes at a time, so a long
/// conversation isn't read whole.
fn last_line(path: &Path, chunk: u64, maybe: impl Fn(&[u8]) -> bool, keep: impl Fn(&Value) -> bool) -> Option<Value> {
    let mut file = std::fs::File::open(path).ok()?;
    let mut end = file.metadata().ok()?.len();
    // The start of a line the chunk after this one began in the middle of.
    let mut rest: Vec<u8> = Vec::new();
    while end > 0 {
        let start = end.saturating_sub(chunk);
        let mut buf = vec![0; (end - start) as usize];
        file.seek(SeekFrom::Start(start)).ok()?;
        file.read_exact(&mut buf).ok()?;
        buf.extend_from_slice(&rest);
        // Whole lines only: the first may have begun in the chunk before.
        let whole = if start == 0 { 0 } else { buf.iter().position(|&b| b == b'\n').map_or(buf.len(), |i| i + 1) };
        for line in buf[whole..].split(|&b| b == b'\n').rev() {
            if !maybe(line) {
                continue;
            }
            if let Ok(v) = serde_json::from_slice::<Value>(line) {
                if keep(&v) {
                    return Some(v);
                }
            }
        }
        rest = buf[..whole].to_vec();
        end = start;
    }
    None
}

/// /memory: the CLAUDE.md files Claude Code reads in `project` (the user's,
/// the project's, its `.claude` one, the local one), those there are, shown
/// as a link in an answer is: in VS Code. Returns how many.
pub fn memory(project: &str) -> Result<usize, String> {
    let project = allowed(project)?;
    let found: Vec<PathBuf> = memory_files(&config_dir(), &project).into_iter().filter(|f| f.is_file()).collect();
    if found.is_empty() {
        return Err(crate::i18n::t("No CLAUDE.md yet: /init writes one."));
    }
    for file in &found {
        platform::show_file(file, None);
    }
    Ok(found.len())
}

fn memory_files(config: &Path, project: &Path) -> [PathBuf; 4] {
    [
        config.join("CLAUDE.md"),
        project.join("CLAUDE.md"),
        project.join(".claude").join("CLAUDE.md"),
        project.join("CLAUDE.local.md"),
    ]
}

/// The commands of an answer to `initialize`.
fn parse_commands(reply: &Value) -> Result<Vec<SlashCommand>, String> {
    let response = reply.get("response").ok_or_else(|| "an answer without a response".to_string())?;
    if response.get("subtype").and_then(Value::as_str) == Some("error") {
        return Err(response.get("error").and_then(Value::as_str).unwrap_or("an error").to_string());
    }
    let list = response.pointer("/response/commands").and_then(Value::as_array).ok_or_else(|| "no commands".to_string())?;
    let text = |c: &Value, key: &str| c.get(key).and_then(Value::as_str).unwrap_or_default().trim().to_string();
    Ok(list
        .iter()
        .filter_map(|c| {
            let name = text(c, "name");
            (!name.is_empty()).then(|| SlashCommand {
                description: text(c, "description"),
                argument_hint: text(c, "argumentHint"),
                aliases: c
                    .get("aliases")
                    .and_then(Value::as_array)
                    .map(|a| a.iter().filter_map(Value::as_str).map(String::from).collect())
                    .unwrap_or_default(),
                builtin: flag(c, "builtin"),
                plugin: Some(text(c, "plugin")).filter(|p| !p.is_empty()),
                name,
            })
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_project_folder_is_named_as_claude_code_names_it() {
        assert_eq!(folder_name(r"C:\Users\me\projects\Claude assistant"), "C--Users-me-projects-Claude-assistant");
        assert_eq!(folder_name("/home/me/x.y"), "-home-me-x-y");
    }

    #[cfg(windows)]
    #[test]
    fn a_hook_cwd_moved_by_cd_goes_back_to_where_the_session_started() {
        let transcript = r"C:\Users\me\.claude\projects\C--Users-me-projects-my-app\644458cf-87fd-4800-881d-c7ccf962fd84.jsonl";
        let mut moved = json!({ "cwd": r"C:\Users\me\projects\my app\windows\src", "transcript_path": transcript });
        anchor_cwd(&mut moved);
        assert_eq!(moved["cwd"], r"C:\Users\me\projects\my app");
        // Started there, or no transcript to go by: left as it is.
        for cwd in [r"C:\Users\me\projects\my app", r"D:\elsewhere"] {
            let mut same = json!({ "cwd": cwd, "transcript_path": transcript });
            anchor_cwd(&mut same);
            assert_eq!(same["cwd"], cwd);
        }
        let mut bare = json!({ "cwd": r"C:\x\y" });
        anchor_cwd(&mut bare);
        assert_eq!(bare["cwd"], r"C:\x\y");
    }

    #[test]
    fn a_file_with_no_turn_in_it_is_not_a_session() {
        let stub = [
            r#"{"type":"ai-title","aiTitle":"Enemy shotgun visual glitch","sessionId":"ad606ca9-d5b8-4524-b42c-1c76095acaa6"}"#,
            r#"{"type":"mode","mode":"normal"}"#,
            r#"{"type":"cost-state","cost":0}"#,
        ]
        .join("\n");
        assert!(is_stub_text(&stub));
        assert!(!is_stub_text(&format!("{stub}\n{}", r#"{"type":"user","message":{"role":"user","content":"hi"}}"#)));
        assert!(!is_stub_text(r#"{"type":"last-prompt","lastPrompt":"hi"}"#));
    }

    #[test]
    fn a_transcript_moved_to_another_project_belongs_to_it() {
        let base = std::env::temp_dir().join(format!("buddybara-moved-{}", std::process::id()));
        let work = base.join("work stuff");
        let store = base.join("store").join(folder_name(&work.to_string_lossy()));
        std::fs::create_dir_all(&work).unwrap();
        std::fs::create_dir_all(&store).unwrap();
        let line = json!({ "type": "user", "cwd": work.to_string_lossy() }).to_string();
        std::fs::write(store.join("644458cf-87fd-4800-881d-c7ccf962fd84.jsonl"), format!("{line}\n")).unwrap();
        // Continued from the home folder, its turns written in the work folder's store.
        let transcript = store.join("ad606ca9-d5b8-4524-b42c-1c76095acaa6.jsonl");
        let mut event = json!({ "cwd": base.join("home").to_string_lossy(), "transcript_path": transcript.to_string_lossy() });
        anchor_cwd(&mut event);
        assert_eq!(event["cwd"], json!(work.to_string_lossy()));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn only_a_uuid_is_a_session_id() {
        assert!(is_session_id("644458cf-87fd-4800-881d-c7ccf962fd84"));
        for bad in ["", "644458cf", "644458cf-87fd-4800-881d-c7ccf962fd8", "644458cf-87fd-4800-881d-c7ccf962fd8z", "../../../../windows/x-y-z-w"] {
            assert!(!is_session_id(bad), "{bad}");
        }
    }

    #[test]
    fn a_run_only_ever_asks_for_a_mode_of_the_picker() {
        let args = arguments(Some("644458cf-87fd-4800-881d-c7ccf962fd84"), &Options { mode: Some("plan".into()), effort: Some("max".into()), model: Some("claude-fable-5-1".into()), ultracode: false, btw: false }, None).unwrap();
        assert_eq!(
            args.join(" "),
            "-p --input-format stream-json --output-format stream-json --verbose --permission-mode plan --effort max --model claude-fable-5-1 --resume 644458cf-87fd-4800-881d-c7ccf962fd84"
        );
        // A side question forks the session and saves nothing.
        let btw = Options { mode: Some("plan".into()), btw: true, ..Default::default() };
        assert!(arguments(Some("644458cf-87fd-4800-881d-c7ccf962fd84"), &btw, None).unwrap().join(" ").ends_with("--resume 644458cf-87fd-4800-881d-c7ccf962fd84 --fork-session --no-session-persistence"));
        // Ultracode goes with the effort, whatever it is.
        let ultra = Options { effort: Some("max".into()), ultracode: true, ..Default::default() };
        assert_eq!(
            arguments(None, &ultra, None).unwrap(),
            ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--permission-mode", "default", "--settings", r#"{"ultracode":true}"#, "--effort", "max"]
        );
        assert!(arguments(None, &Options::default(), None).unwrap().join(" ").contains("--permission-mode default"));
        for mode in ["bypassPermissions", "dontAsk", "--dangerously-skip-permissions"] {
            assert!(arguments(None, &Options { mode: Some(mode.into()), ..Default::default() }, None).is_err(), "{mode}");
        }
        assert!(arguments(None, &Options { effort: Some("ultra".into()), ..Default::default() }, None).is_err());
        for model in ["opus", "--dangerously-skip-permissions", ""] {
            assert!(arguments(None, &Options { model: Some(model.into()), ..Default::default() }, None).is_err(), "{model}");
        }
        assert!(arguments(Some("--help"), &Options::default(), None).is_err());
    }

    #[test]
    fn attached_files_are_listed_after_the_prompt_and_their_folder_comes_last() {
        let inbox = Path::new(r"C:\Users\me\AppData\Local\Buddybara\inbox");
        let args = arguments(Some("644458cf-87fd-4800-881d-c7ccf962fd84"), &Options::default(), Some(inbox)).unwrap();
        // Its values run to the next option: nothing may follow it.
        assert_eq!(args[args.len() - 2..], ["--add-dir".to_string(), inbox.to_string_lossy().into_owned()]);

        let files = [inbox.join("shot.png"), inbox.join("notes (2).txt")];
        assert_eq!(
            with_attachments("what is this?", &files),
            format!("what is this?\n\nAttached files:\n- {}\n- {}", files[0].display(), files[1].display())
        );
        assert_eq!(with_attachments("", &files[..1]), format!("Attached files:\n- {}", files[0].display()));
        assert_eq!(with_attachments("just text", &[]), "just text");
    }

    #[test]
    fn a_new_project_is_one_plain_folder_name() {
        assert_eq!(project_name("  Music tool ").unwrap(), "Music tool");
        assert_eq!(project_name("v2.0 rewrite").unwrap(), "v2.0 rewrite");
        assert_eq!(project_name("Console app").unwrap(), "Console app", "only the exact device names");
        for bad in ["", "   ", "..", ".hidden", "trailing.", "a/b", r"a\b", "C:", "what?", "<x>", "a|b", "tab\there", "CON", "nul.txt", "Com1 .md", "LPT9"] {
            assert!(project_name(bad).is_err(), "{bad:?}");
        }
        assert!(project_name(&"x".repeat(MAX_NAME)).is_ok());
        assert!(project_name(&"x".repeat(MAX_NAME + 1)).is_err());
    }

    #[test]
    fn only_project_folders_and_seen_ones_may_be_used() {
        let base = std::env::temp_dir().join(format!("buddybara-code-{}", std::process::id()));
        let root = base.join("projects");
        let inside = root.join("app");
        let nested = inside.join("src");
        let elsewhere = base.join("elsewhere");
        for dir in [&nested, &elsewhere] {
            std::fs::create_dir_all(dir).unwrap();
        }
        let none = HashSet::new();
        assert!(check(&root, &none, &inside.to_string_lossy()).is_ok());
        assert!(check(&root, &none, &nested.to_string_lossy()).is_err());
        assert!(check(&root, &none, &elsewhere.to_string_lossy()).is_err());
        assert!(check(&root, &none, &root.to_string_lossy()).is_err());
        assert!(check(&root, &none, &base.join("missing").to_string_lossy()).is_err());
        let seen = HashSet::from([std::fs::canonicalize(&elsewhere).unwrap()]);
        assert!(check(&root, &seen, &elsewhere.to_string_lossy()).is_ok());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn sessions_started_outside_the_projects_folder_are_found_where_they_started() {
        let base = std::env::temp_dir().join(format!("buddybara-found-{}", std::process::id()));
        let store = base.join("store");
        let root = base.join("projects");
        let mine = root.join("mine");
        let theirs = base.join("work").join("their app");
        let moved = base.join("moved");
        for dir in [&mine, &theirs, &moved] {
            std::fs::create_dir_all(dir).unwrap();
        }
        let session = |cwd: &Path, under: &Path| {
            let dir = store.join(folder_name(&under.to_string_lossy()));
            std::fs::create_dir_all(&dir).unwrap();
            let line = json!({ "type": "user", "cwd": cwd.to_string_lossy() }).to_string();
            std::fs::write(dir.join("644458cf-87fd-4800-881d-c7ccf962fd84.jsonl"), format!("{line}\n")).unwrap();
        };
        session(&theirs, &theirs);
        // A `cd` before its first line: found where it is stored, not where it went.
        session(&moved.join("src"), &moved);
        // Listed already, gone, or in the store itself: not found.
        session(&mine, &mine);
        session(&base.join("gone"), &base.join("gone"));
        session(&store.join("inside"), &store.join("inside"));
        std::fs::create_dir_all(store.join("inside")).unwrap();
        // A folder of stubs that record no folder.
        std::fs::create_dir_all(store.join("C--stubs")).unwrap();
        std::fs::write(store.join("C--stubs").join("a.jsonl"), r#"{"type":"custom-title","customTitle":"x"}"#).unwrap();

        let mut found: Vec<PathBuf> = found_in(&store, &root).into_iter().map(|(real, _)| real).collect();
        found.sort();
        let mut want = vec![std::fs::canonicalize(&theirs).unwrap(), std::fs::canonicalize(&moved).unwrap()];
        want.sort();
        assert_eq!(found, want);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_session_is_named_by_its_newest_title_and_a_given_name_wins() {
        let tail = [
            r#"{"type":"ai-title","aiTitle":"Old idea"}"#,
            r#"{"type":"last-prompt","lastPrompt":"first question"}"#,
            r#"{"type":"ai-title","aiTitle":"Desktop buddy app"}"#,
            r#"{"type":"last-prompt","lastPrompt":"can we   do it?"}"#,
        ]
        .join("\n");
        let found = describe("", &tail);
        assert_eq!(found, Found { title: Some("Desktop buddy app".into()), prompt: Some("can we do it?".into()) });
        let renamed = format!("{tail}\n{}", r#"{"type":"custom-title","customTitle":"Mic adjustments"}"#);
        assert_eq!(describe("", &renamed).title.as_deref(), Some("Mic adjustments"));
    }

    #[test]
    fn a_name_given_in_the_panel_is_the_one_claude_code_reads_back() {
        let id = "644458cf-87fd-4800-881d-c7ccf962fd84";
        let tail = format!("{}\n{}\n{}", r#"{"type":"ai-title","aiTitle":"Old idea"}"#, title_line(id, "My \"P4V\" setup"), r#"{"type":"ai-title","aiTitle":"Newer idea"}"#);
        assert_eq!(describe("", &tail).title.as_deref(), Some("My \"P4V\" setup"));
        let line: Value = serde_json::from_str(&title_line(id, "x")).unwrap();
        assert_eq!((line["type"].as_str(), line["sessionId"].as_str()), (Some("custom-title"), Some(id)));
    }

    #[test]
    fn without_a_title_a_session_is_named_by_its_first_typed_prompt() {
        let head = [
            r#"{"type":"user","message":{"content":"<command-name>/clear</command-name>"}}"#,
            r#"{"type":"user","message":{"content":[{"type":"text","text":"<ide_opened_file>The user opened a.ts</ide_opened_file>"},{"type":"text","text":"fix the login bug"}]}}"#,
        ]
        .join("\n");
        assert_eq!(describe(&head, "").title.as_deref(), Some("fix the login bug"));
        assert_eq!(describe("", ""), Found::default());
    }

    #[test]
    fn a_conversation_is_what_was_typed_answered_and_done_on_the_way() {
        let lines = [
            r#"{"type":"user","message":{"content":"what does auth do?"}}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"hmm"},{"type":"text","text":"Let me look."},{"type":"tool_use","name":"Read","input":{"file_path":"C:\\p\\auth.ts","limit":20}}]}}"#,
            r#"{"type":"user","message":{"content":[{"type":"tool_result","content":"huge file"}]}}"#,
            r#"{"type":"user","isMeta":true,"message":{"content":"meta"}}"#,
            r#"{"type":"assistant","isSidechain":true,"message":{"content":[{"type":"text","text":"subagent"},{"type":"tool_use","name":"Grep","input":{}}]}}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"It checks tokens."}]}}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Mostly."}]}}"#,
            r#"{"type":"attachment","attachment":{"type":"user"}}"#,
            r#"{"type":"user","message":{"content":"thanks"}}"#,
        ]
        .join("\n");
        let read = Message {
            role: "step",
            text: String::new(),
            tool: Some("Read".into()),
            input: Some(json!({ "file_path": "C:\\p\\auth.ts" })),
            tokens: None,
        };
        let all = conversation(&lines, 10);
        assert_eq!(
            all,
            vec![
                Message::said("user", "what does auth do?".into()),
                Message::said("assistant", "Let me look.".into()),
                read,
                Message::said("assistant", "It checks tokens.\n\nMostly.".into()),
                Message::said("user", "thanks".into()),
            ]
        );
        // The cut is counted in turns, each kept from its prompt on.
        assert_eq!(conversation(&lines, 1), vec![Message::said("user", "thanks".into())]);
        assert_eq!(conversation(&lines, 2), all);
        assert_eq!(conversation(&lines, 3), all);
        assert!(conversation(&lines, 0).is_empty());
    }

    #[test]
    fn a_message_sent_while_claude_works_shows_where_it_was_read() {
        let lines = [
            r#"{"type":"user","message":{"content":"run the tests"}}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"npm test"}}]}}"#,
            r#"{"type":"queue-operation","operation":"enqueue","content":"and the lint"}"#,
            r#"{"type":"attachment","attachment":{"type":"queued_command","prompt":"and the lint","commandMode":"prompt"}}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Both pass."}]}}"#,
        ]
        .join("\n");
        let said: Vec<(&str, String)> = conversation(&lines, 10).into_iter().map(|m| (m.role, m.text)).collect();
        let want = [("user", "run the tests"), ("step", ""), ("user", "and the lint"), ("assistant", "Both pass.")];
        assert_eq!(said, want.map(|(role, text)| (role, text.to_string())));
    }

    #[test]
    fn a_long_answer_split_by_its_steps_never_pushes_its_prompt_off_the_top() {
        let mut lines = vec![
            r#"{"type":"user","message":{"content":"first question"}}"#.to_string(),
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"First answer."}]}}"#.to_string(),
            r#"{"type":"user","message":{"content":"refactor everything"}}"#.to_string(),
        ];
        for i in 0..60 {
            lines.push(format!(r#"{{"type":"assistant","message":{{"content":[{{"type":"text","text":"Step {i}."}},{{"type":"tool_use","name":"Read","input":{{}}}}]}}}}"#));
        }
        let kept = conversation(&lines.join("\n"), 2);
        assert_eq!(kept[0], Message::said("user", "first question".into()));
        assert_eq!(kept.iter().filter(|m| m.role == "user").count(), 2);
        assert_eq!(kept.len(), 2 + 1 + 60 * 2);
        assert_eq!(conversation(&lines.join("\n"), 1)[0], Message::said("user", "refactor everything".into()));
    }

    #[test]
    fn a_session_list_shows_what_was_typed_not_the_attached_files_list() {
        let sent = with_attachments("what is this?", &[PathBuf::from(r"C:\Buddybara\inbox\shot.png")]);
        assert_eq!(typed_part(&sent), "what is this?");
        let only_files = with_attachments("", &[PathBuf::from(r"C:\Buddybara\inbox\a.png"), PathBuf::from("/tmp/inbox/b.txt")]);
        assert_eq!(typed_part(&only_files), "a.png, b.txt");
        // Typed by hand, it stays as it is.
        for text in ["see Attached files: below", "x\n\nAttached files:\nnot a list", "plain"] {
            assert_eq!(typed_part(text), text);
        }
        let tail = format!(r#"{{"type":"last-prompt","lastPrompt":{}}}"#, serde_json::to_string(&sent).unwrap());
        let head = format!(r#"{{"type":"user","message":{{"content":{}}}}}"#, serde_json::to_string(&only_files).unwrap());
        assert_eq!(describe(&head, &tail), Found { title: Some("a.png, b.txt".into()), prompt: Some("what is this?".into()) });
    }

    #[test]
    fn a_long_session_keeps_only_its_newest_steps() {
        let step = r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"ls"}}]}}"#;
        let mut lines = vec![r#"{"type":"user","message":{"content":"go"}}"#.to_string()];
        lines.extend(std::iter::repeat_n(step.to_string(), MAX_STEPS + 50));
        lines.push(r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Done."}]}}"#.into());
        let all = conversation(&lines.join("\n"), 10);
        assert_eq!(all.len(), MAX_STEPS + 2);
        assert_eq!((all[0].role, all[MAX_STEPS + 1].role), ("user", "assistant"));
    }

    #[test]
    fn the_stream_becomes_the_events_the_page_draws() {
        let init = json!({ "type": "system", "subtype": "init", "session_id": "s1", "slash_commands": ["compact", "forecast"] });
        assert_eq!(events(&init), vec![json!({ "kind": "init", "session": "s1", "commands": ["compact", "forecast"] })]);
        assert_eq!(events(&json!({ "type": "system", "subtype": "commands_changed", "commands": [] })), vec![json!({ "kind": "commands_changed" })]);
        // The look at the commands has its own session id, and its hooks stay quiet.
        let id = new_session_id();
        let groups: Vec<&str> = id.split('-').collect();
        assert_eq!(groups.iter().map(|g| g.len()).collect::<Vec<_>>(), vec![8, 4, 4, 4, 12], "{id}");
        assert!(id.chars().all(|c| c == '-' || c.is_ascii_hexdigit()), "{id}");
        assert!(groups[2].starts_with('4') && "89ab".contains(&groups[3][..1]), "{id}");
        assert!(is_session_id(&id) && id != new_session_id());
        assert!(!is_quiet(&id));

        let said = json!({ "type": "assistant", "parent_tool_use_id": null, "message": { "content": [
            { "type": "text", "text": "Fixing it." },
            { "type": "tool_use", "name": "Write", "input": { "file_path": "C:\\p\\a.ts", "content": "a whole file" } },
        ] } });
        assert_eq!(
            events(&said),
            vec![
                json!({ "kind": "text", "text": "Fixing it." }),
                json!({ "kind": "tool", "tool": "Write", "input": { "file_path": "C:\\p\\a.ts" } }),
            ]
        );

        let subagent = json!({ "type": "assistant", "parent_tool_use_id": "t1", "message": { "content": [{ "type": "text", "text": "x" }] } });
        assert!(events(&subagent).is_empty());

        let done = json!({ "type": "result", "result": "Done.", "is_error": false, "session_id": "s1" });
        assert_eq!(events(&done), vec![json!({ "kind": "result", "text": "Done.", "error": false, "session": "s1" })]);
        assert!(events(&json!({ "type": "user" })).is_empty());
    }

    #[test]
    fn compaction_starts_ends_and_says_how_big_the_conversation_was() {
        let status = |fields: Value| {
            let mut v = json!({ "type": "system", "subtype": "status", "session_id": "s1" });
            v.as_object_mut().unwrap().extend(fields.as_object().unwrap().clone());
            events(&v)
        };
        assert_eq!(status(json!({ "status": "compacting" })), vec![json!({ "kind": "compacting" })]);
        // A success says nothing yet: the boundary that follows has the sizes.
        assert!(status(json!({ "status": null, "compact_result": "success" })).is_empty());
        assert_eq!(
            status(json!({ "status": null, "compact_result": "failed", "compact_error": "Too few messages." })),
            vec![json!({ "kind": "compact_failed", "text": "Too few messages." })]
        );
        // An automatic one that turned out not to be needed ends with no result.
        assert_eq!(status(json!({ "status": null })), vec![json!({ "kind": "compact_skipped" })]);
        // Other statuses (a permission mode changing, a request starting) are not compaction.
        assert!(status(json!({ "status": null, "permissionMode": "plan" })).is_empty());
        assert!(status(json!({ "status": "requesting" })).is_empty());
        let boundary = json!({ "type": "system", "subtype": "compact_boundary", "compact_metadata": { "trigger": "manual", "pre_tokens": 73870, "post_tokens": 7470 } });
        assert_eq!(events(&boundary), vec![json!({ "kind": "compacted", "tokens": 73870 })]);
    }

    #[test]
    fn a_session_renamed_with_rename_says_its_new_name() {
        let renamed = json!({ "type": "system", "subtype": "session_title_changed", "title": " Mic fixes ", "session_id": "s1" });
        assert_eq!(events(&renamed), vec![json!({ "kind": "title", "text": "Mic fixes" })]);
        assert!(events(&json!({ "type": "system", "subtype": "session_title_changed", "title": "" })).is_empty());
    }

    #[test]
    fn a_conversations_totals_are_its_last_cost_state_whatever_the_read_size() {
        let dir = std::env::temp_dir().join(format!("buddybara-cost-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("s.jsonl");
        let lines = [
            r#"{"type":"user","message":{"content":"hi"}}"#,
            r#"{"type":"cost-state","sessionId":"s","totalCostUSD":1.5,"totalAPIDuration":1000,"totalDuration":5000}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"says \"type\":\"cost-state\" in passing"}]}}"#,
            r#"{"type":"cost-state","sessionId":"s","totalCostUSD":370.3015,"totalAPIDuration":49421631.0,"totalDuration":308110406,"totalLinesAdded":11850,"totalLinesRemoved":1006,"hasUnknownModelCost":true}"#,
            r#"{"type":"last-prompt","lastPrompt":"more"}"#,
        ];
        std::fs::write(&file, lines.join("\n")).unwrap();
        for chunk in [7, 64, 100, COST_CHUNK] {
            let state = last_cost_state(&file, chunk).expect("found");
            assert_eq!(state["totalCostUSD"], json!(370.3015), "chunk {chunk}");
        }
        let usage = session_usage("C:\\p".into(), "s".into(), "Slash commands".into(), &last_cost_state(&file, 64).unwrap());
        assert_eq!(
            usage,
            SessionUsage {
                project: "C:\\p".into(),
                session: "s".into(),
                title: "Slash commands".into(),
                cost_usd: 370.3015,
                api_ms: 49421631,
                wall_ms: 308110406,
                lines_added: 11850,
                lines_removed: 1006,
                unknown_cost: true,
            }
        );
        // None saved yet.
        std::fs::write(&file, lines[0]).unwrap();
        assert_eq!(last_cost_state(&file, 7), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_plugins_panes_reach_the_page_and_its_asks_are_control_requests() {
        let roster = json!({ "type": "system", "subtype": "ui_panes", "panes": [{ "id": "weather", "title": "Weather", "plugin": "weather" }], "shown_id": "weather", "focus_requested_id": "weather" });
        assert_eq!(
            events(&roster),
            vec![json!({ "kind": "panes", "panes": [{ "id": "weather", "title": "Weather", "plugin": "weather" }], "focus": "weather" })]
        );
        let closed = json!({ "type": "system", "subtype": "ui_panes", "panes": [], "focus_requested_id": null });
        assert_eq!(events(&closed), vec![json!({ "kind": "panes", "panes": [], "focus": null })]);
        // Stale: the panes named, or every one when none is.
        let some = json!({ "type": "system", "subtype": "ui_invalidate", "event": "ui.render", "instances": [
            { "surface": "desktop", "component": "Pane", "instance_id": "weather" },
            { "surface": "desktop", "component": "AbovePrompt", "instance_id": "above-prompt" }] });
        assert_eq!(events(&some), vec![json!({ "kind": "ui_invalidate", "instances": ["weather"] })]);
        assert_eq!(events(&json!({ "type": "system", "subtype": "ui_invalidate", "event": "ui.render" })), vec![json!({ "kind": "ui_invalidate", "instances": null })]);
        assert_eq!(events(&json!({ "type": "system", "subtype": "ui_toast", "plugin": "x", "text": " Done " })), vec![json!({ "kind": "ui_toast", "text": "Done" })]);
        let (line, id) = control_line(json!({ "subtype": "ui_attach", "surface": SURFACE, "client_id": CLIENT }));
        let sent: Value = serde_json::from_str(line.trim()).unwrap();
        assert_eq!(sent, json!({ "type": "control_request", "request_id": id, "request": { "subtype": "ui_attach", "surface": "desktop", "client_id": "buddybara" } }));
        // The page asks nothing but its panes, and only of a run that is there.
        assert!(ui(1, json!({ "subtype": "initialize" })).is_err());
        assert!(ui(1, json!({ "subtype": "interrupt" })).is_err());
        assert_eq!(ui(987_654, json!({ "subtype": "ui_panes" })), Err("This pane's conversation has ended.".into()));
    }

    #[test]
    fn claude_is_mid_turn_until_an_answer_ends_it() {
        let line = |s: &str| serde_json::from_str::<Value>(s).unwrap();
        // At work, or waiting on a permission or a question.
        assert!(still_going(&line(r#"{"type":"assistant","message":{"stop_reason":"tool_use","content":[{"type":"tool_use"}]}}"#)));
        assert!(still_going(&line(r#"{"type":"user","message":{"content":[{"type":"tool_result","content":"ok"}]}}"#)));
        assert!(still_going(&line(r#"{"type":"user","message":{"content":"fix the build"}}"#)));
        // Between turns.
        assert!(!still_going(&line(r#"{"type":"assistant","message":{"stop_reason":"end_turn","content":[{"type":"text","text":"Done."}]}}"#)));
        assert!(!still_going(&line(r#"{"type":"user","message":{"content":[{"type":"text","text":"[Request interrupted by user]"}]}}"#)));
        assert!(!still_going(&line(r#"{"type":"user","message":{"content":"<command-name>/model</command-name>"}}"#)));
        assert!(!still_going(&line(r#"{"type":"user","message":{"content":"<local-command-stdout>Set model to opus</local-command-stdout>"}}"#)));
        assert!(!still_going(&line(r#"{"type":"user","isMeta":true,"message":{"content":"Caveat"}}"#)));
        assert!(!still_going(&line(r#"{"type":"user","isCompactSummary":true,"message":{"content":"This session is being continued"}}"#)));
    }

    #[test]
    fn memory_is_the_users_claude_md_then_the_projects() {
        let files = memory_files(Path::new(r"C:\Users\me\.claude"), Path::new(r"C:\p"));
        assert_eq!(
            files.map(|f| f.to_string_lossy().into_owned()),
            [r"C:\Users\me\.claude\CLAUDE.md", r"C:\p\CLAUDE.md", r"C:\p\.claude\CLAUDE.md", r"C:\p\CLAUDE.local.md"]
        );
    }

    #[test]
    fn a_reopened_conversation_shows_typed_commands_their_output_and_compaction() {
        let lines = [
            r#"{"type":"user","message":{"content":"hello"}}"#,
            r#"{"type":"user","message":{"content":"<command-name>/model</command-name>\n            <command-message>model</command-message>\n            <command-args>opus</command-args>"}}"#,
            r#"{"type":"user","message":{"content":"<local-command-stdout>Set model to \u001b[1mopus\u001b[22m</local-command-stdout>"}}"#,
            r#"{"type":"user","message":{"content":"<command-name>/compact</command-name>\n            <command-message>compact</command-message>\n            <command-args></command-args>"}}"#,
            r#"{"parentUuid":null,"type":"system","subtype":"compact_boundary","content":"Conversation compacted","compactMetadata":{"trigger":"manual","preTokens":73870,"postTokens":7470}}"#,
            r#"{"type":"user","isCompactSummary":true,"message":{"content":"This session is being continued…"}}"#,
            r#"{"type":"user","message":{"content":"<local-command-stdout>Compacted </local-command-stdout>"}}"#,
            // A skill Claude loaded by itself: no slash, not the user's.
            r#"{"type":"user","message":{"content":"<command-message>notes</command-message>\n<command-name>notes</command-name>"}}"#,
            r#"{"type":"user","message":{"content":"thanks"}}"#,
        ]
        .join("\n");
        let said: Vec<(&str, String, Option<u64>)> = conversation(&lines, 10).into_iter().map(|m| (m.role, m.text, m.tokens)).collect();
        assert_eq!(
            said,
            vec![
                ("user", "hello".into(), None),
                ("user", "/model opus".into(), None),
                ("assistant", "Set model to opus".into(), None),
                ("user", "/compact".into(), None),
                ("compacted", String::new(), Some(73870)),
                ("user", "thanks".into(), None),
            ]
        );
    }

    #[test]
    fn the_menu_lists_what_claude_code_answers_to_initialize() {
        let reply = json!({ "type": "control_response", "response": { "subtype": "success", "request_id": "r", "response": { "commands": [
            { "name": "compact", "description": "Free up context", "argumentHint": "<instructions>", "builtin": true },
            { "name": "notes:daily", "description": "(notes) Write the daily note", "argumentHint": "", "aliases": ["today"] },
            { "name": "", "description": "nameless" },
            { "name": "forecast", "description": "Opens the panel", "argumentHint": "", "plugin": "weather" },
        ] } } });
        let list = parse_commands(&reply).unwrap();
        assert_eq!(list.len(), 3);
        // A command a plugin's code registered says whose it is.
        assert_eq!((list[2].name.as_str(), list[2].plugin.as_deref()), ("forecast", Some("weather")));
        assert_eq!(
            list[0],
            SlashCommand { name: "compact".into(), description: "Free up context".into(), argument_hint: "<instructions>".into(), aliases: vec![], builtin: true, plugin: None }
        );
        assert_eq!((list[1].name.as_str(), list[1].aliases.clone(), list[1].builtin), ("notes:daily", vec!["today".to_string()], false));
        let refused = json!({ "type": "control_response", "response": { "subtype": "error", "error": "not now" } });
        assert_eq!(parse_commands(&refused), Err("not now".to_string()));
    }

    #[test]
    fn ansi_colours_are_taken_out_of_command_output() {
        assert_eq!(strip_ansi("\u{1b}[1mBold\u{1b}[22m and \u{1b}[38;5;12mblue\u{1b}[0m"), "Bold and blue");
        assert_eq!(strip_ansi("plain [1m"), "plain [1m");
    }
}
