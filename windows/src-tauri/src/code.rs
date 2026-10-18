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
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{LazyLock, Mutex};
use std::time::UNIX_EPOCH;

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

/// Where Claude Code keeps conversations, one folder per project.
fn store() -> PathBuf {
    std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| platform::home_dir().join(".claude"))
        .join("projects")
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
            files.push((id.to_string(), path.clone(), modified(&path)));
        }
    }
    files.sort_by(|a, b| b.2.cmp(&a.2));
    files
}

// ── Which folders may be used ─────────────────────────────────────────────────

/// Folders a session was seen working in, from the hooks.
static SEEN: LazyLock<Mutex<HashSet<PathBuf>>> = LazyLock::new(Default::default);

/// Called by the relay server with every hook event: the folder the session
/// works in becomes one Buddybara may continue it in.
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

pub(crate) fn allowed(project: &str) -> Result<PathBuf, String> {
    check(&root(), &SEEN.lock().unwrap(), project)
}

// ── Projects and sessions ─────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct Project {
    pub name: String,
    pub path: String,
    pub sessions: usize,
    /// Unix seconds of the newest session, 0 without one.
    pub last: u64,
}

/// The folders under ~/projects, most recent work first, then by name.
pub fn projects() -> Vec<Project> {
    let Ok(entries) = std::fs::read_dir(root()) else { return Vec::new() };
    let mut list: Vec<Project> = entries
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
            })
        })
        .collect();
    list.sort_by(|a, b| b.last.cmp(&a.last).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    list
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
    Ok(Project { name, path: dir.to_string_lossy().into_owned(), sessions: 0, last: 0 })
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
    /// "user", "assistant", or "step": a tool Claude called.
    pub role: &'static str,
    pub text: String,
    /// A step's tool and the few fields it is labelled by (`brief`): the page
    /// words it (hooks.ts stepLabel) as it does a live run's steps.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input: Option<Value>,
}

impl Message {
    fn said(role: &'static str, text: String) -> Self {
        Self { role, text, tool: None, input: None }
    }

    fn step(block: &Value) -> Self {
        let tool = block.get("name").and_then(Value::as_str).unwrap_or("Tool").to_string();
        Self { role: "step", text: String::new(), tool: Some(tool), input: Some(brief(block.get("input"))) }
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

/// The conversation as a run draws it live: what the user typed, what Claude
/// answered and the tools it called on the way, newest last — the last `max`
/// turns, each from its prompt on, with the newest MAX_STEPS steps among
/// them. Counting turns, not messages: a long answer split by its steps never
/// pushes the prompt that asked for it off the top. Tool results, thinking,
/// subagents and Claude Code's bookkeeping are left out; the pieces of one
/// answer between two steps are joined.
pub fn conversation(text: &str, max: usize) -> Vec<Message> {
    let mut out: Vec<Message> = Vec::new();
    for line in text.lines() {
        // Most lines are tool results: skip them before parsing.
        if !(line.contains("\"type\":\"user\"") || line.contains("\"type\":\"assistant\"") || line.contains("\"queued_command\"")) {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        if let Some(text) = user_text(&v).or_else(|| sent_meanwhile(&v)) {
            out.push(Message::said("user", text));
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
/// Runs in flight: run → process id, for Stop.
static RUNS: LazyLock<Mutex<HashMap<u64, u32>>> = LazyLock::new(Default::default);
/// Runs still taking messages, until their turn's result: run → their input,
/// and whether they may read the inbox (they started with files).
static INPUTS: LazyLock<Mutex<HashMap<u64, (Sender<String>, bool)>>> = LazyLock::new(Default::default);

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
    RUNS.lock().unwrap().insert(run, child.id());
    // Claude Code reads its input to the end: this message, then those sent
    // while it works, written in order off this thread. The input ends when
    // the last sender goes (`watch`, at the result): what was written is still
    // read, then Claude Code exits.
    let (input, lines) = channel::<String>();
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
/// its answer is already being written). False when it takes no more: its turn
/// is over, or the message has files and the run may not read the inbox — the
/// page then sends it as the next run.
pub fn say(run: u64, prompt: &str, attachments: &[String]) -> Result<bool, String> {
    let (line, with_files) = message(prompt, attachments)?;
    let inputs = INPUTS.lock().unwrap();
    let Some((input, reads_inbox)) = inputs.get(&run) else { return Ok(false) };
    if with_files && !reads_inbox {
        return Ok(false);
    }
    Ok(input.send(line).is_ok())
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
    if let Some(out) = child.stdout.take() {
        for line in BufReader::new(out).lines().map_while(Result::ok) {
            let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
            if v.get("type").and_then(Value::as_str) == Some("result") {
                INPUTS.lock().unwrap().remove(&run);
            }
            for mut event in events(&v) {
                answered |= event["kind"] == "result";
                event["run"] = json!(run);
                emit(event);
            }
        }
    }
    let code = child.wait().ok().and_then(|s| s.code());
    let errors = errors.join().unwrap_or_default();
    RUNS.lock().unwrap().remove(&run);
    INPUTS.lock().unwrap().remove(&run);
    if !answered {
        let last = errors.lines().rev().map(str::trim).find(|l| !l.is_empty()).unwrap_or("Claude Code stopped.");
        emit(json!({ "run": run, "kind": "result", "error": true, "text": last }));
    }
    log::line(format!("code run {run} ended ({})", code.map_or_else(|| "stopped".to_string(), |c| c.to_string())));
    emit(json!({ "run": run, "kind": "exit" }));
}

/// What the page hears of one line of `--output-format stream-json`: the
/// session's id when it starts, Claude's words and tool calls as they come (the
/// main conversation's, not its subagents'), and the result.
pub fn events(v: &Value) -> Vec<Value> {
    let session = v.get("session_id").cloned().unwrap_or(Value::Null);
    match v.get("type").and_then(Value::as_str) {
        Some("system") if v.get("subtype").and_then(Value::as_str) == Some("init") => {
            vec![json!({ "kind": "init", "session": session })]
        }
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
    let Some(pid) = RUNS.lock().unwrap().get(&run).copied() else { return };
    log::line(format!("code run {run} stopped"));
    #[cfg(windows)]
    let _ = platform::no_console(Command::new("taskkill").args(["/PID", &pid.to_string(), "/T", "/F"])).status();
    #[cfg(unix)]
    let _ = Command::new("kill").args(["-TERM", &pid.to_string()]).status();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_project_folder_is_named_as_claude_code_names_it() {
        assert_eq!(folder_name(r"C:\Users\me\projects\Claude assistant"), "C--Users-me-projects-Claude-assistant");
        assert_eq!(folder_name("/home/me/x.y"), "-home-me-x-y");
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
        let args = arguments(Some("644458cf-87fd-4800-881d-c7ccf962fd84"), &Options { mode: Some("plan".into()), effort: Some("max".into()), model: Some("claude-fable-5-1".into()), ultracode: false }, None).unwrap();
        assert_eq!(
            args.join(" "),
            "-p --input-format stream-json --output-format stream-json --verbose --permission-mode plan --effort max --model claude-fable-5-1 --resume 644458cf-87fd-4800-881d-c7ccf962fd84"
        );
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
        let init = json!({ "type": "system", "subtype": "init", "session_id": "s1" });
        assert_eq!(events(&init), vec![json!({ "kind": "init", "session": "s1" })]);

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
}
