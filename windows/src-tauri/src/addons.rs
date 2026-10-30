// Settings → Skills and Plugins, beyond Anthropic's Directory (directory.rs):
// what Claude Code has installed, a skill written from a form, and adding one
// by hand — a skill (a folder with SKILL.md, or the .zip / .skill it is
// shared as), a command (an .md file), a plugin (a folder with
// .claude-plugin/plugin.json), or a marketplace (a folder, or a link).
//
// Buddybara looks inside first, in a copy of its own, and says what it adds
// and what it would run on this computer: nothing is installed before the
// user's click, and nothing that runs (hooks, servers) without its own tick.
// Skills and commands are copied into ~/.claude/skills and ~/.claude/commands,
// where Claude Code makes each a /command. Plugins and marketplaces go through
// Claude Code's own `claude plugin` commands, which write its settings.json
// (Buddybara never does): a plugin from a folder through a marketplace of
// Buddybara's own, in its data folder.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use crate::i18n::{t, tf};
use crate::{code, directory, island, mcp, platform, settings};

/// Buddybara's own marketplace, where a plugin added from a folder is kept for
/// Claude Code to install from.
const MARKETPLACE: &str = "buddybara";
/// What a copy (or an unpacked archive) may hold: no skill is this big.
const MAX_BYTES: u64 = 200 * 1024 * 1024;
const MAX_FILES: usize = 5000;
/// A picked or dropped path may be looked inside for this long.
const OFFER_FOR: Duration = Duration::from_secs(600);
/// A look inside that wasn't installed is forgotten, its copy deleted, after this.
const STAGED_FOR: Duration = Duration::from_secs(3600);
/// `claude plugin` clones and fetches: it may take a while.
const CLI_LIMIT: Duration = Duration::from_secs(240);
const LIST_LIMIT: Duration = Duration::from_secs(60);
/// What a plugin runs, listed up to this many.
const MAX_RUNS: usize = 30;
/// Names an unpacked archive may carry that aren't its content.
const JUNK: &[&str] = &["__MACOSX", ".DS_Store", "Thumbs.db", "desktop.ini"];

fn skills_dir() -> PathBuf {
    code::config_dir().join("skills")
}

fn commands_dir() -> PathBuf {
    code::config_dir().join("commands")
}

/// Buddybara's marketplace: one folder per plugin, and its marketplace.json.
fn market_dir() -> PathBuf {
    settings::local_dir().join("plugins")
}

/// Copies of the marketplaces added from a folder (the folder itself may go).
fn markets_dir() -> PathBuf {
    settings::local_dir().join("marketplaces")
}

fn staging_dir() -> PathBuf {
    settings::local_dir().join("staging")
}

/// Claude Code's commands changed: the panel asks for its `/` menu again.
pub(crate) fn changed(app: &AppHandle) {
    let _ = app.emit_to(island::WINDOW_LABEL, "commands-changed", ());
}

// ── Paths the user gave ───────────────────────────────────────────────────────

static OFFERED: Mutex<Vec<(PathBuf, Instant)>> = Mutex::new(Vec::new());

/// Paths the user picked in a dialog or dropped on Settings: the only ones
/// `addon_inspect` looks inside, so a page can't name any file it likes.
pub fn offer<I: IntoIterator<Item = PathBuf>>(paths: I) {
    let mut list = OFFERED.lock().unwrap_or_else(|e| e.into_inner());
    list.retain(|(_, at)| at.elapsed() < OFFER_FOR);
    list.extend(paths.into_iter().map(|p| (p, Instant::now())));
    let excess = list.len().saturating_sub(64);
    list.drain(..excess);
}

fn offered(path: &Path) -> bool {
    let list = OFFERED.lock().unwrap_or_else(|e| e.into_inner());
    list.iter().any(|(p, at)| at.elapsed() < OFFER_FOR && p == path)
}

/// Settings → Add → Choose a file / a folder: the path picked, now one it may look inside.
#[tauri::command]
pub async fn addon_pick(app: AppHandle, folder: bool) -> Result<Option<String>, String> {
    use tauri::Manager;
    let owner = app.get_webview_window("settings").and_then(|w| w.hwnd().ok()).map(|h| h.0 as isize);
    let kinds = t("Skills, commands and plugins");
    let picked = tauri::async_runtime::spawn_blocking(move || {
        if folder {
            platform::pick_folder(owner, None)
        } else {
            platform::pick_file(owner, (&kinds, "*.zip;*.skill;*.md"))
        }
    })
    .await
    .map_err(|e| e.to_string())?;
    if let Some(path) = &picked {
        offer([path.clone()]);
    }
    Ok(picked.map(|p| p.to_string_lossy().into_owned()))
}

// ── Reading what it is ────────────────────────────────────────────────────────

/// The `key: value` lines between a file's opening `---` lines, values
/// unquoted; a `>` or `|` value takes the indented lines under it.
fn front_matter(text: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    let mut lines = text.trim_start_matches('\u{feff}').lines();
    if lines.next().map(str::trim) != Some("---") {
        return out;
    }
    let join = |block: &[String], folded: bool| block.join(if folded { " " } else { "\n" }).trim().to_string();
    // A block value being read: its key, its lines, folded (>) or kept (|).
    let mut block: Option<(String, Vec<String>, bool)> = None;
    for line in lines {
        if line.trim() == "---" {
            break;
        }
        if let Some((_, lines, _)) = &mut block {
            if line.starts_with([' ', '\t']) || line.trim().is_empty() {
                lines.push(line.trim().to_string());
                continue;
            }
        }
        if let Some((key, lines, folded)) = block.take() {
            out.insert(key, join(&lines, folded));
        }
        let Some((key, value)) = line.split_once(':') else { continue };
        if key.starts_with([' ', '\t']) {
            continue;
        }
        let (key, value) = (key.trim().to_string(), value.trim());
        if value.starts_with(['>', '|']) && value.len() <= 2 {
            block = Some((key, Vec::new(), value.starts_with('>')));
        } else {
            out.insert(key, unquote(value));
        }
    }
    if let Some((key, lines, folded)) = block {
        out.insert(key, join(&lines, folded));
    }
    out
}

fn unquote(v: &str) -> String {
    let quoted = |q: char| v.len() >= 2 && v.starts_with(q) && v.ends_with(q);
    if quoted('"') {
        v[1..v.len() - 1].replace("\\\"", "\"").replace("\\\\", "\\")
    } else if quoted('\'') {
        v[1..v.len() - 1].replace("''", "'")
    } else {
        v.to_string()
    }
}

/// Text on one line, cut short.
fn one_line(text: &str, max: usize) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= max {
        flat
    } else {
        format!("{}…", flat.chars().take(max - 1).collect::<String>())
    }
}

/// A skill's name as Claude Code wants it: lowercase letters, digits and
/// dashes, at most 64 characters (`My Notes` → `my-notes`). None: nothing left.
pub fn skill_name(raw: &str) -> Option<String> {
    let mut out = String::new();
    for c in raw.trim().chars() {
        let c = c.to_ascii_lowercase();
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            out.push(c);
        } else if matches!(c, '-' | '_' | ' ' | '.') && !out.is_empty() && !out.ends_with('-') {
            out.push('-');
        }
    }
    let out: String = out.trim_end_matches('-').chars().take(64).collect();
    let out = out.trim_end_matches('-').to_string();
    (!out.is_empty()).then_some(out)
}

/// A plugin's or a marketplace's name, as given: one plain word.
fn plain_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= 64 && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}

/// What `root` (a copy Buddybara made) holds.
#[derive(Clone, Debug, PartialEq)]
enum Found {
    /// One skill: its folder, with SKILL.md.
    Skill(PathBuf),
    /// Several skills, each its folder.
    Skills(Vec<PathBuf>),
    /// A command: its .md file.
    Command(PathBuf),
    Plugin(PathBuf),
    Marketplace(PathBuf),
}

fn nothing() -> String {
    t("Buddybara found no skill, command or plugin in it.")
}

fn find(root: &Path) -> Result<Found, String> {
    if root.is_file() {
        let name = root.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        if name.eq_ignore_ascii_case("SKILL.md") {
            return root.parent().map(|p| Found::Skill(p.to_path_buf())).ok_or_else(nothing);
        }
        if name.to_ascii_lowercase().ends_with(".md") {
            return Ok(Found::Command(root.to_path_buf()));
        }
        return Err(nothing());
    }
    let dir = descend(root);
    if dir.join(".claude-plugin").join("plugin.json").is_file() {
        return Ok(Found::Plugin(dir));
    }
    if dir.join(".claude-plugin").join("marketplace.json").is_file() {
        return Ok(Found::Marketplace(dir));
    }
    if dir.join("SKILL.md").is_file() {
        return Ok(Found::Skill(dir));
    }
    // A plugin may go without its plugin.json: what it brings says it is one.
    if dir.join(".mcp.json").is_file() || dir.join("hooks").join("hooks.json").is_file() || dir.join("commands").is_dir() || dir.join("agents").is_dir() {
        return Ok(Found::Plugin(dir));
    }
    let mut skills = Vec::new();
    skill_dirs(&dir, 3, &mut skills);
    skills.sort();
    match skills.len() {
        0 => Err(nothing()),
        1 => Ok(Found::Skill(skills.remove(0))),
        _ => Ok(Found::Skills(skills)),
    }
}

/// Into the one folder an archive or a folder wraps its content in.
fn descend(dir: &Path) -> PathBuf {
    let mut dir = dir.to_path_buf();
    loop {
        let marked = dir.join("SKILL.md").is_file() || dir.join(".claude-plugin").is_dir();
        let entries: Vec<_> = std::fs::read_dir(&dir)
            .into_iter()
            .flatten()
            .flatten()
            .filter(|e| !JUNK.contains(&e.file_name().to_string_lossy().as_ref()))
            .collect();
        match entries.as_slice() {
            [only] if !marked && only.file_type().is_ok_and(|t| t.is_dir()) => dir = only.path(),
            _ => return dir,
        }
    }
}

fn skill_dirs(dir: &Path, depth: u32, out: &mut Vec<PathBuf>) {
    if dir.join("SKILL.md").is_file() {
        out.push(dir.to_path_buf());
        return;
    }
    if depth == 0 {
        return;
    }
    for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if e.file_type().is_ok_and(|t| t.is_dir()) && name != ".git" && !JUNK.contains(&name.as_str()) {
            skill_dirs(&e.path(), depth - 1, out);
        }
    }
}

struct SkillInfo {
    name: String,
    description: String,
    /// It can be typed as /name (not `user-invocable: false`).
    command: bool,
}

fn skill_info(dir: &Path) -> Result<SkillInfo, String> {
    let text = std::fs::read_to_string(dir.join("SKILL.md")).map_err(|e| e.to_string())?;
    let fm = front_matter(&text);
    let raw = fm
        .get("name")
        .filter(|n| !n.trim().is_empty())
        .cloned()
        .or_else(|| dir.file_name().map(|n| n.to_string_lossy().into_owned()))
        .unwrap_or_default();
    let name = skill_name(&raw).ok_or_else(|| t("This skill has no name Buddybara can use."))?;
    Ok(SkillInfo {
        name,
        description: one_line(fm.get("description").map_or("", String::as_str), 300),
        command: fm.get("user-invocable").is_none_or(|v| v.trim() != "false"),
    })
}

/// A command file's name (its file's, made plain) and what it does: its
/// `description`, else its first line, as Claude Code reads it.
fn command_info(file: &Path) -> Result<(String, String), String> {
    let stem = file.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let name = skill_name(&stem).ok_or_else(|| t("This command has no name Buddybara can use."))?;
    let text = std::fs::read_to_string(file).map_err(|e| e.to_string())?;
    let fm = front_matter(&text);
    let description = fm.get("description").cloned().unwrap_or_else(|| {
        let body = if text.trim_start().starts_with("---") { text.splitn(3, "---").nth(2).unwrap_or("") } else { &text };
        body.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("").trim_start_matches('#').trim().to_string()
    });
    Ok((name, one_line(&description, 300)))
}

/// Something a plugin runs by itself (a hook, a server), or a service it connects to.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Run {
    /// "hook" | "server" | "remote" (a server at an address) | "lsp"
    kind: &'static str,
    name: String,
    detail: String,
}

#[derive(Default)]
struct PluginInfo {
    name: String,
    description: String,
    /// What it adds to the `/` menu: `plugin:skill`.
    commands: Vec<String>,
    runs: Vec<Run>,
}

/// A path a plugin.json gives (`./hooks/x.json`), inside the plugin's folder.
fn inside(dir: &Path, rel: &str) -> Option<PathBuf> {
    let rel = rel.trim().trim_start_matches("./");
    (!rel.is_empty() && !rel.replace('\\', "/").split('/').any(|p| p == "..") && !Path::new(rel).is_absolute()).then(|| dir.join(rel))
}

/// The paths a plugin.json field gives: one, or a list.
fn paths(dir: &Path, field: Option<&Value>) -> Vec<PathBuf> {
    match field {
        Some(Value::String(p)) => inside(dir, p).into_iter().collect(),
        Some(Value::Array(list)) => list.iter().filter_map(Value::as_str).filter_map(|p| inside(dir, p)).collect(),
        _ => Vec::new(),
    }
}

fn plugin_info(dir: &Path) -> Result<PluginInfo, String> {
    let manifest = read_json(&dir.join(".claude-plugin").join("plugin.json")).unwrap_or(Value::Null);
    let name = manifest
        .get("name")
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| dir.file_name().map(|n| n.to_string_lossy().into_owned()))
        .unwrap_or_default();
    if !plain_name(&name) {
        return Err(tf("“{name}” isn't a name Claude Code takes for a plugin.", &[("name", &name)]));
    }
    let mut info = PluginInfo {
        description: one_line(manifest.get("description").and_then(Value::as_str).unwrap_or(""), 300),
        ..Default::default()
    };
    let mut skill_roots = vec![dir.join("skills")];
    skill_roots.extend(paths(dir, manifest.get("skills")));
    for root in skill_roots {
        let mut found = Vec::new();
        skill_dirs(&root, 1, &mut found);
        for skill in found {
            match skill_info(&skill) {
                Ok(s) if s.command => info.commands.push(format!("{name}:{}", s.name)),
                _ => {}
            }
        }
    }
    let mut command_roots = vec![dir.join("commands")];
    command_roots.extend(paths(dir, manifest.get("commands")));
    for root in command_roots {
        let files: Vec<PathBuf> = if root.is_file() {
            vec![root]
        } else {
            std::fs::read_dir(&root).into_iter().flatten().flatten().map(|e| e.path()).collect()
        };
        for file in files.iter().filter(|f| f.extension().is_some_and(|x| x.eq_ignore_ascii_case("md"))) {
            if let Ok((command, _)) = command_info(file) {
                info.commands.push(format!("{name}:{command}"));
            }
        }
    }
    info.commands.sort();
    info.commands.dedup();
    info.runs = plugin_runs(dir, &manifest);
    info.name = name;
    Ok(info)
}

/// What a plugin runs by itself: its hooks, its MCP servers, its language servers.
fn plugin_runs(dir: &Path, manifest: &Value) -> Vec<Run> {
    let mut runs = Vec::new();
    let mut from = |default: PathBuf, field: &str, read: fn(&Value, &mut Vec<Run>)| {
        let mut files = vec![default];
        files.extend(paths(dir, manifest.get(field)));
        let mut seen = HashSet::new();
        for file in files.into_iter().filter(|f| seen.insert(f.clone())) {
            if let Some(v) = read_json(&file) {
                read(&v, &mut runs);
            }
        }
        // Written in plugin.json itself.
        if let Some(inline) = manifest.get(field).filter(|v| v.is_object()) {
            read(inline, &mut runs);
        }
    };
    from(dir.join("hooks").join("hooks.json"), "hooks", read_hooks);
    from(dir.join(".mcp.json"), "mcpServers", read_servers);
    from(dir.join(".lsp.json"), "lspServers", read_lsp);
    runs.truncate(MAX_RUNS);
    runs
}

fn read_hooks(v: &Value, out: &mut Vec<Run>) {
    let hooks = v.get("hooks").filter(|h| h.is_object()).unwrap_or(v);
    for (event, groups) in hooks.as_object().into_iter().flatten() {
        for group in groups.as_array().into_iter().flatten() {
            for hook in group.get("hooks").and_then(Value::as_array).into_iter().flatten() {
                // A prompt or agent hook asks a model: it runs nothing.
                let detail = hook.get("command").or_else(|| hook.get("url")).and_then(Value::as_str);
                if let Some(detail) = detail {
                    out.push(Run { kind: "hook", name: event.clone(), detail: one_line(detail, 200) });
                }
            }
        }
    }
}

fn read_servers(v: &Value, out: &mut Vec<Run>) {
    let servers = v.get("mcpServers").filter(|s| s.is_object()).unwrap_or(v);
    for (name, server) in servers.as_object().into_iter().flatten() {
        if let Some(command) = server.get("command").and_then(Value::as_str) {
            let args: Vec<&str> = server.get("args").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).collect();
            out.push(Run { kind: "server", name: name.clone(), detail: one_line(&[command].into_iter().chain(args).collect::<Vec<_>>().join(" "), 200) });
        } else if let Some(url) = server.get("url").and_then(Value::as_str) {
            out.push(Run { kind: "remote", name: name.clone(), detail: one_line(url, 200) });
        }
    }
}

fn read_lsp(v: &Value, out: &mut Vec<Run>) {
    for (name, server) in v.as_object().into_iter().flatten() {
        if let Some(command) = server.get("command").and_then(Value::as_str) {
            out.push(Run { kind: "lsp", name: name.clone(), detail: one_line(command, 200) });
        }
    }
}

/// A plugin a marketplace offers.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MarketPlugin {
    name: String,
    description: String,
    commands: Vec<String>,
    runs: Vec<Run>,
    /// It comes from elsewhere (its own repository): Buddybara can't look inside before it is installed.
    unknown: bool,
    installed: bool,
}

/// A marketplace's name, what it says it is, and its plugins.
fn market_info(dir: &Path, installed: &HashSet<String>) -> Result<(String, String, Vec<MarketPlugin>), String> {
    let manifest = read_json(&dir.join(".claude-plugin").join("marketplace.json")).ok_or_else(|| t("This marketplace has no marketplace.json Buddybara can read."))?;
    let name = manifest.get("name").and_then(Value::as_str).unwrap_or("").to_string();
    if !plain_name(&name) {
        return Err(tf("“{name}” isn't a name Claude Code takes for a marketplace.", &[("name", &name)]));
    }
    let description = manifest
        .pointer("/metadata/description")
        .or_else(|| manifest.get("description"))
        .and_then(Value::as_str)
        .map(|d| one_line(d, 300))
        .unwrap_or_default();
    let root = manifest.pointer("/metadata/pluginRoot").and_then(Value::as_str).unwrap_or("");
    let mut plugins = Vec::new();
    for p in manifest.get("plugins").and_then(Value::as_array).into_iter().flatten() {
        let Some(pname) = p.get("name").and_then(Value::as_str).filter(|n| plain_name(n)) else { continue };
        let local = match p.get("source") {
            Some(Value::String(s)) => {
                let rel = if s.starts_with("./") || root.is_empty() { s.clone() } else { format!("{root}/{s}") };
                inside(dir, &rel).filter(|d| d.is_dir()).or_else(|| (s == "./").then(|| dir.to_path_buf()))
            }
            _ => None,
        };
        let info = local.as_deref().and_then(|d| plugin_info(d).ok());
        plugins.push(MarketPlugin {
            name: pname.to_string(),
            description: p
                .get("description")
                .and_then(Value::as_str)
                .map(|d| one_line(d, 300))
                .or_else(|| info.as_ref().map(|i| i.description.clone()))
                .unwrap_or_default(),
            commands: info.as_ref().map(|i| i.commands.iter().map(|c| format!("{pname}:{}", c.split_once(':').map_or(c.as_str(), |(_, s)| s))).collect()).unwrap_or_default(),
            runs: info.as_ref().map(|i| i.runs.clone()).unwrap_or_default(),
            unknown: info.is_none(),
            installed: installed.contains(&format!("{pname}@{name}")),
        });
    }
    Ok((name, description, plugins))
}

/// What Claude Code's own check says is wrong with a plugin or a marketplace,
/// if anything (its advice for the Directory's listing aside).
fn validate(dir: &Path) -> Option<String> {
    let path = dir.to_string_lossy().into_owned();
    let (ok, out, err) = match mcp::claude_run(&["plugin", "validate", &path, "--json"], LIST_LIMIT) {
        Ok(run) => run,
        // Claude Code itself couldn't run: the install will say why.
        Err(_) => return None,
    };
    if ok {
        return None;
    }
    let Ok(report) = serde_json::from_str::<Value>(out.trim()) else {
        return Some(err.lines().chain(out.lines()).map(str::trim).rfind(|l| !l.is_empty()).unwrap_or("").to_string()).filter(|s| !s.is_empty());
    };
    let mut errors: Vec<String> = Vec::new();
    let mut take = |list: Option<&Value>| {
        for e in list.and_then(Value::as_array).into_iter().flatten() {
            let message = e.get("message").and_then(Value::as_str).unwrap_or("");
            let at = e.get("path").and_then(Value::as_str).filter(|p| !p.is_empty());
            if !message.is_empty() {
                errors.push(at.map_or_else(|| message.to_string(), |at| format!("{at}: {message}")));
            }
        }
    };
    take(report.pointer("/manifest/errors"));
    for item in report.get("contents").and_then(Value::as_array).into_iter().flatten() {
        take(item.get("errors"));
    }
    (!errors.is_empty()).then(|| errors.into_iter().take(4).collect::<Vec<_>>().join("\n"))
}

// ── Looking inside ────────────────────────────────────────────────────────────

/// What Settings shows before anything is installed.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    /// The look inside, for installing it.
    id: String,
    /// "skill" | "skills" | "command" | "plugin" | "marketplace"
    kind: &'static str,
    name: String,
    description: String,
    /// What it adds to the `/` menu.
    commands: Vec<String>,
    /// What it would run on this computer: installing it takes a tick of its own.
    runs: Vec<Run>,
    /// A skill, command or plugin of that name is there: installing replaces it.
    replaces: bool,
    /// Why it can't be installed (Claude Code's own check).
    problem: Option<String>,
    /// A marketplace's plugins.
    plugins: Vec<MarketPlugin>,
}

struct Staged {
    found: Found,
    preview: Preview,
    at: Instant,
    /// The copy Buddybara made, deleted with it.
    dir: Option<PathBuf>,
    /// A marketplace Claude Code has now, by its name.
    added: Option<String>,
}

static STAGED: LazyLock<Mutex<HashMap<String, Staged>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

fn new_id() -> String {
    static NEXT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    let ms = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis());
    format!("{ms}-{}", NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed))
}

/// Looks gone stale go, with their copies, and copies a past run left.
fn sweep() {
    let mut staged = STAGED.lock().unwrap_or_else(|e| e.into_inner());
    let stale: Vec<String> = staged.iter().filter(|(_, s)| s.at.elapsed() > STAGED_FOR).map(|(id, _)| id.clone()).collect();
    for id in stale {
        if let Some(dir) = staged.remove(&id).and_then(|s| s.dir) {
            let _ = std::fs::remove_dir_all(dir);
        }
    }
    for e in std::fs::read_dir(staging_dir()).into_iter().flatten().flatten() {
        if !staged.contains_key(e.file_name().to_string_lossy().as_ref()) {
            let _ = std::fs::remove_dir_all(e.path());
        }
    }
}

fn too_big() -> String {
    tf("It's too big: Buddybara takes at most {files} files and {mb} MB.", &[("files", &MAX_FILES.to_string()), ("mb", &(MAX_BYTES / 1024 / 1024).to_string())])
}

/// Copies a folder, its links and `.git` left out, within the limits.
fn copy_dir(from: &Path, to: &Path) -> Result<(), String> {
    fn copy_into(from: &Path, to: &Path, budget: &mut (usize, u64)) -> Result<(), String> {
        std::fs::create_dir_all(to).map_err(|e| e.to_string())?;
        for e in std::fs::read_dir(from).map_err(|e| e.to_string())? {
            let e = e.map_err(|e| e.to_string())?;
            let kind = e.file_type().map_err(|e| e.to_string())?;
            if kind.is_symlink() || e.file_name() == ".git" {
                continue;
            }
            let (src, dst) = (e.path(), to.join(e.file_name()));
            if kind.is_dir() {
                copy_into(&src, &dst, budget)?;
            } else if kind.is_file() {
                let len = e.metadata().map_err(|e| e.to_string())?.len();
                if budget.0 == 0 || len > budget.1 {
                    return Err(too_big());
                }
                budget.0 -= 1;
                budget.1 -= len;
                std::fs::copy(&src, &dst).map_err(|e| e.to_string())?;
            }
        }
        Ok(())
    }
    copy_into(from, to, &mut (MAX_FILES, MAX_BYTES))
}

/// An archive's entry that would land outside the folder it is unpacked in.
fn climbs_out(name: &str) -> bool {
    let name = name.replace('\\', "/");
    name.starts_with('/') || name.as_bytes().get(1) == Some(&b':') || name.split('/').any(|p| p == "..")
}

/// Unpacks a .zip (or a .skill, which is one) with the system's own tools —
/// Windows' tar, which reads zips — after checking none of its names climbs out.
fn unpack(archive: &Path, into: &Path) -> Result<(), String> {
    if std::fs::metadata(archive).map_err(|e| e.to_string())?.len() > MAX_BYTES {
        return Err(too_big());
    }
    #[cfg(windows)]
    let (list, extract) = {
        let tar = std::env::var_os("SystemRoot").map_or_else(|| PathBuf::from(r"C:\Windows"), PathBuf::from).join("System32").join("tar.exe");
        let mut list = Command::new(&tar);
        list.arg("-tf").arg(archive);
        let mut extract = Command::new(&tar);
        extract.arg("-xf").arg(archive).arg("-C").arg(into);
        (list, extract)
    };
    #[cfg(not(windows))]
    let (list, extract) = {
        let mut list = Command::new("unzip");
        list.arg("-Z1").arg(archive);
        let mut extract = Command::new("unzip");
        extract.arg("-q").arg(archive).arg("-d").arg(into);
        (list, extract)
    };
    let run = |mut cmd: Command| -> Result<String, String> {
        let out = platform::no_console(&mut cmd).output().map_err(|e| tf("Couldn't unpack it: {error}", &[("error", &e.to_string())]))?;
        if !out.status.success() {
            let why = String::from_utf8_lossy(&out.stderr).trim().to_string();
            return Err(tf("Couldn't unpack it: {error}", &[("error", &why)]));
        }
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    };
    let names = run(list)?;
    let names: Vec<&str> = names.lines().filter(|l| !l.trim().is_empty()).collect();
    if names.len() > MAX_FILES {
        return Err(too_big());
    }
    if names.iter().any(|n| climbs_out(n)) {
        return Err(t("This archive has files that would land outside its folder: Buddybara won't open it."));
    }
    run(extract)?;
    // What came out: no links, within the limits.
    fn measure(dir: &Path, files: &mut usize, bytes: &mut u64) -> Result<(), String> {
        for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
            let kind = e.file_type().map_err(|e| e.to_string())?;
            if kind.is_symlink() {
                return Err(t("This archive has links in it: Buddybara won't open it."));
            }
            if kind.is_dir() {
                measure(&e.path(), files, bytes)?;
            } else {
                *files += 1;
                *bytes += e.metadata().map_or(0, |m| m.len());
            }
        }
        Ok(())
    }
    let (mut files, mut bytes) = (0, 0);
    measure(into, &mut files, &mut bytes)?;
    if files > MAX_FILES || bytes > MAX_BYTES {
        return Err(too_big());
    }
    Ok(())
}

/// A copy of what the user gave, in `dir`: the path to look inside.
fn stage(src: &Path, dir: &Path) -> Result<PathBuf, String> {
    let name = src.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "item".into());
    if src.is_dir() {
        let to = dir.join(&name);
        copy_dir(src, &to)?;
        return Ok(to);
    }
    let lower = name.to_ascii_lowercase();
    if lower.ends_with(".zip") || lower.ends_with(".skill") {
        unpack(src, dir)?;
        return Ok(dir.to_path_buf());
    }
    if lower.ends_with(".md") {
        // A SKILL.md alone: the folder it was in names it.
        let to = if lower == "skill.md" {
            let folder = src.parent().and_then(Path::file_name).map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "skill".into());
            dir.join(folder).join("SKILL.md")
        } else {
            dir.join(&name)
        };
        if let Some(parent) = to.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::copy(src, &to).map_err(|e| e.to_string())?;
        return Ok(to);
    }
    Err(t("Buddybara takes a folder, a .zip, a .skill or an .md file."))
}

fn preview_of(id: &str, found: &Found) -> Result<Preview, String> {
    let mut p = Preview {
        id: id.to_string(),
        kind: "skill",
        name: String::new(),
        description: String::new(),
        commands: Vec::new(),
        runs: Vec::new(),
        replaces: false,
        problem: None,
        plugins: Vec::new(),
    };
    match found {
        Found::Skill(dir) => {
            let s = skill_info(dir)?;
            p.replaces = skills_dir().join(&s.name).exists();
            if s.command {
                p.commands.push(s.name.clone());
            }
            (p.name, p.description) = (s.name, s.description);
        }
        Found::Skills(dirs) => {
            p.kind = "skills";
            let infos = dirs.iter().map(|d| skill_info(d)).collect::<Result<Vec<_>, _>>()?;
            p.replaces = infos.iter().any(|s| skills_dir().join(&s.name).exists());
            p.commands = infos.iter().filter(|s| s.command).map(|s| s.name.clone()).collect();
            p.name = infos.iter().map(|s| s.name.as_str()).collect::<Vec<_>>().join(", ");
        }
        Found::Command(file) => {
            p.kind = "command";
            let (name, description) = command_info(file)?;
            p.replaces = commands_dir().join(format!("{name}.md")).exists();
            p.commands.push(name.clone());
            (p.name, p.description) = (name, description);
        }
        Found::Plugin(dir) => {
            p.kind = "plugin";
            let info = plugin_info(dir)?;
            p.replaces = directory::installed().contains(&format!("{}@{MARKETPLACE}", info.name)) || market_dir().join(&info.name).exists();
            p.problem = validate(dir);
            (p.name, p.description, p.commands, p.runs) = (info.name, info.description, info.commands, info.runs);
        }
        Found::Marketplace(dir) => {
            p.kind = "marketplace";
            let (name, description, plugins) = market_info(dir, &directory::installed())?;
            p.problem = validate(dir);
            (p.name, p.description, p.plugins) = (name, description, plugins);
        }
    }
    Ok(p)
}

/// Settings → Add: a picked or dropped file or folder, copied and looked
/// inside. Nothing is installed yet.
#[tauri::command]
pub async fn addon_inspect(path: String) -> Result<Preview, String> {
    let src = PathBuf::from(&path);
    if !offered(&src) {
        return Err("Pick it, or drop it on Settings, first.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        sweep();
        let id = new_id();
        let dir = staging_dir().join(&id);
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let looked = stage(&src, &dir).and_then(|root| {
            let found = find(&root)?;
            let preview = preview_of(&id, &found)?;
            Ok((found, preview))
        });
        match looked {
            Ok((found, preview)) => {
                STAGED.lock().unwrap_or_else(|e| e.into_inner()).insert(
                    id,
                    Staged { found, preview: preview.clone(), at: Instant::now(), dir: Some(dir), added: None },
                );
                Ok(preview)
            }
            Err(err) => {
                let _ = std::fs::remove_dir_all(&dir);
                Err(err)
            }
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// A marketplace's link as Claude Code takes it: an https address, or a GitHub `owner/repo`.
fn market_link(link: &str) -> Option<&str> {
    let link = link.trim();
    let repo = link.split_once('/').is_some_and(|(owner, repo)| plain_name(owner) && plain_name(repo));
    let address = link.starts_with("https://") && link.len() > 8;
    (link.len() <= 300 && !link.contains(char::is_whitespace) && (repo || address)).then_some(link)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct KnownMarket {
    name: String,
    #[serde(default)]
    repo: String,
    #[serde(default)]
    url: String,
    #[serde(default)]
    install_location: String,
}

fn markets() -> Result<Vec<KnownMarket>, String> {
    let out = mcp::claude(&["plugin", "marketplace", "list", "--json"], LIST_LIMIT).map_err(directory::message_of)?;
    serde_json::from_str(out.trim()).map_err(|_| t("Unexpected answer from Claude Code."))
}

/// Settings → Add → a marketplace's link: Claude Code adds it (it fetches it,
/// nothing runs), and its plugins show, each to install on its own.
#[tauri::command]
pub async fn addon_add_marketplace(link: String) -> Result<Preview, String> {
    let link = market_link(&link).ok_or_else(|| t("That isn't a link Claude Code takes: an https address, or a GitHub owner/repo."))?.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        sweep();
        let before: HashSet<String> = markets()?.into_iter().map(|m| m.name).collect();
        mcp::claude(&["plugin", "marketplace", "add", &link], CLI_LIMIT).map_err(directory::message_of)?;
        let after = markets()?;
        let bare = link.trim_end_matches('/').trim_end_matches(".git").to_lowercase();
        let added = after
            .iter()
            .find(|m| !before.contains(&m.name))
            .or_else(|| after.iter().find(|m| [&m.repo, &m.url].iter().any(|s| !s.is_empty() && s.trim_end_matches(".git").to_lowercase().ends_with(&bare))))
            .ok_or_else(|| t("Claude Code added it, but Buddybara couldn't tell which marketplace it is."))?;
        let dir = PathBuf::from(&added.install_location);
        let id = new_id();
        let found = Found::Marketplace(dir.clone());
        let mut preview = preview_of(&id, &found)?;
        // Claude Code took it: its own check is passed.
        preview.problem = None;
        STAGED.lock().unwrap_or_else(|e| e.into_inner()).insert(
            id,
            Staged { found, preview: preview.clone(), at: Instant::now(), dir: None, added: Some(added.name.clone()) },
        );
        Ok(preview)
    })
    .await
    .map_err(|e| e.to_string())?
}

// ── Installing ────────────────────────────────────────────────────────────────

fn trusted(runs: &[Run], unknown: bool, trust: bool) -> Result<(), String> {
    if (runs.is_empty() && !unknown) || trust {
        Ok(())
    } else {
        Err(t("Tick that you trust it first: it runs programs on this computer."))
    }
}

/// `claude plugin install`, said plainly when it can't go on its own.
fn install_plugin_id(id: &str) -> Result<(), String> {
    match mcp::claude(&["plugin", "install", id, "--json"], CLI_LIMIT) {
        Ok(_) => Ok(()),
        Err(err) if err.contains("shownCommand") || err.to_lowercase().contains("confirm") => Err(t(
            "This plugin runs a command when it installs: install it from Claude Code (/plugin) to see the command first.",
        )),
        Err(err) => Err(directory::message_of(err)),
    }
}

/// Buddybara's marketplace.json, listing every plugin folder it holds.
fn write_market(market: &Path) -> Result<(), String> {
    let mut plugins: Vec<Value> = std::fs::read_dir(market)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()) && e.file_name() != ".claude-plugin")
        .filter_map(|e| {
            let folder = e.file_name().to_string_lossy().into_owned();
            let name = plugin_info(&e.path()).map(|i| i.name).unwrap_or_else(|_| folder.clone());
            Some(json!({ "name": name, "source": format!("./{folder}") }))
        })
        .collect();
    plugins.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
    let manifest = json!({
        "name": MARKETPLACE,
        "owner": { "name": "Buddybara" },
        "metadata": { "description": "Plugins added in Buddybara's Settings" },
        "plugins": plugins,
    });
    let file = market.join(".claude-plugin").join("marketplace.json");
    std::fs::create_dir_all(file.parent().unwrap_or(market)).map_err(|e| e.to_string())?;
    std::fs::write(&file, serde_json::to_vec_pretty(&manifest).unwrap_or_default()).map_err(|e| e.to_string())
}

/// Claude Code knows Buddybara's marketplace, as it is now.
fn ensure_market(market: &Path) -> Result<(), String> {
    let path = market.to_string_lossy().into_owned();
    if markets()?.iter().any(|m| m.name == MARKETPLACE) {
        mcp::claude(&["plugin", "marketplace", "update", MARKETPLACE], CLI_LIMIT).map(drop).map_err(directory::message_of)
    } else {
        mcp::claude(&["plugin", "marketplace", "add", &path], CLI_LIMIT).map(drop).map_err(directory::message_of)
    }
}

/// A plugin from a folder: copied into Buddybara's marketplace, installed from there.
fn install_plugin(root: &Path, name: &str) -> Result<(), String> {
    let market = market_dir();
    let target = market.join(name);
    let id = format!("{name}@{MARKETPLACE}");
    if directory::installed().contains(&id) {
        let _ = mcp::claude(&["plugin", "uninstall", &id], CLI_LIMIT);
    }
    if target.exists() {
        platform::move_to_trash(std::slice::from_ref(&target))?;
    }
    copy_dir(root, &target)?;
    write_market(&market)?;
    ensure_market(&market)?;
    install_plugin_id(&id)
}

/// A skill's folder into ~/.claude/skills, under its name; one there already goes to the Recycle Bin.
fn install_skill(dir: &Path, name: &str) -> Result<(), String> {
    let target = skills_dir().join(name);
    if target.exists() {
        platform::move_to_trash(std::slice::from_ref(&target))?;
    }
    copy_dir(dir, &target)
}

/// Settings → Add → Install: what was looked inside, installed. `trust`: the
/// user ticked that it may run what it runs. The `/commands` it brought.
#[tauri::command]
pub async fn addon_install(app: AppHandle, id: String, trust: bool) -> Result<Vec<String>, String> {
    let (found, preview) = {
        let staged = STAGED.lock().unwrap_or_else(|e| e.into_inner());
        let s = staged.get(&id).ok_or_else(|| t("This look inside is too old: add it again."))?;
        (s.found.clone(), s.preview.clone())
    };
    if let Some(problem) = &preview.problem {
        return Err(problem.clone());
    }
    trusted(&preview.runs, false, trust)?;
    let done = tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        match &found {
            Found::Skill(dir) => install_skill(dir, &skill_info(dir)?.name),
            Found::Skills(dirs) => dirs.iter().try_for_each(|d| install_skill(d, &skill_info(d)?.name)),
            Found::Command(file) => {
                let (name, _) = command_info(file)?;
                let target = commands_dir().join(format!("{name}.md"));
                if target.exists() {
                    platform::move_to_trash(std::slice::from_ref(&target))?;
                }
                std::fs::create_dir_all(commands_dir()).map_err(|e| e.to_string())?;
                std::fs::copy(file, &target).map(drop).map_err(|e| e.to_string())
            }
            Found::Plugin(dir) => install_plugin(dir, &plugin_info(dir)?.name),
            Found::Marketplace(_) => Err("a marketplace installs its plugins one by one".into()),
        }
    })
    .await
    .map_err(|e| e.to_string())?;
    done?;
    if let Some(dir) = STAGED.lock().unwrap_or_else(|e| e.into_inner()).remove(&id).and_then(|s| s.dir) {
        let _ = std::fs::remove_dir_all(dir);
    }
    crate::log::line(format!("addons: installed {} {}", preview.kind, preview.name));
    changed(&app);
    Ok(preview.commands)
}

/// Settings → Add → a marketplace's plugin → Install: the marketplace added
/// first if it isn't yet (a copy of a folder, kept in Buddybara's data), then
/// the plugin, by Claude Code.
#[tauri::command]
pub async fn addon_install_from(app: AppHandle, id: String, plugin: String, trust: bool) -> Result<Vec<String>, String> {
    let (found, added, entry) = {
        let staged = STAGED.lock().unwrap_or_else(|e| e.into_inner());
        let s = staged.get(&id).ok_or_else(|| t("This look inside is too old: add it again."))?;
        let entry = s.preview.plugins.iter().find(|p| p.name == plugin).cloned().ok_or_else(|| "no such plugin".to_string())?;
        (s.found.clone(), s.added.clone(), entry)
    };
    trusted(&entry.runs, entry.unknown, trust)?;
    let Found::Marketplace(dir) = found else { return Err("not a marketplace".into()) };
    let market = tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let market = match added {
            Some(name) => name,
            None => {
                let (name, _, _) = market_info(&dir, &HashSet::new())?;
                let copy = markets_dir().join(&name);
                if copy.exists() {
                    platform::move_to_trash(std::slice::from_ref(&copy))?;
                }
                copy_dir(&dir, &copy)?;
                let path = copy.to_string_lossy().into_owned();
                if markets()?.iter().any(|m| m.name == name) {
                    mcp::claude(&["plugin", "marketplace", "update", &name], CLI_LIMIT).map_err(directory::message_of)?;
                } else {
                    mcp::claude(&["plugin", "marketplace", "add", &path], CLI_LIMIT).map_err(directory::message_of)?;
                }
                name
            }
        };
        install_plugin_id(&format!("{}@{market}", entry.name))?;
        Ok(market)
    })
    .await
    .map_err(|e| e.to_string())??;
    if let Some(s) = STAGED.lock().unwrap_or_else(|e| e.into_inner()).get_mut(&id) {
        s.added = Some(market);
        if let Some(p) = s.preview.plugins.iter_mut().find(|p| p.name == plugin) {
            p.installed = true;
        }
    }
    crate::log::line(format!("addons: installed plugin {plugin}"));
    changed(&app);
    Ok(entry.commands)
}

// ── What is installed ─────────────────────────────────────────────────────────

/// A plugin Claude Code has, for Settings → Plugins → Installed.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledPlugin {
    id: String,
    name: String,
    marketplace: String,
    version: String,
    enabled: bool,
    description: String,
    commands: Vec<String>,
    servers: usize,
    hooks: usize,
    /// "directory" | "official" | "managed" (by the organization: not the user's to change) | "yours" | "other"
    source: &'static str,
    /// Where Claude Code installed it: "user", "project" or "local" (one project only), "managed".
    /// A plugin can be there twice, for the user and for a project.
    scope: String,
    /// The project of a "project" or "local" install; empty otherwise.
    project: String,
}

/// The scopes `claude plugin <action> --scope` takes from Settings, and whether one belongs to a project.
fn project_scope(scope: &str) -> Option<bool> {
    match scope {
        "user" => Some(false),
        "project" | "local" => Some(true),
        _ => None,
    }
}

fn source_of(marketplace: &str, scope: &str) -> &'static str {
    match (scope, marketplace) {
        ("managed", _) => "managed",
        (_, "anthropic-plugin-directory") => "directory",
        (_, "claude-plugins-official") => "official",
        (_, MARKETPLACE) => "yours",
        _ => "other",
    }
}

#[tauri::command]
pub async fn plugins_installed() -> Result<Vec<InstalledPlugin>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let out = mcp::claude(&["plugin", "list", "--json"], LIST_LIMIT).map_err(directory::message_of)?;
        let list: Vec<Value> = serde_json::from_str(out.trim()).map_err(|_| t("Unexpected answer from Claude Code."))?;
        let text = |v: &Value, k: &str| v.get(k).and_then(Value::as_str).unwrap_or("").to_string();
        let mut plugins: Vec<InstalledPlugin> = list
            .iter()
            .filter_map(|v| {
                let id = text(v, "id");
                let (name, marketplace) = id.split_once('@').map(|(n, m)| (n.to_string(), m.to_string()))?;
                let info = plugin_info(Path::new(&text(v, "installPath"))).unwrap_or_default();
                let servers = v.get("mcpServers").and_then(Value::as_object).map_or(0, |s| s.len())
                    .max(info.runs.iter().filter(|r| matches!(r.kind, "server" | "remote")).count());
                let scope = text(v, "scope");
                let project = if project_scope(&scope) == Some(true) { text(v, "projectPath") } else { String::new() };
                Some(InstalledPlugin {
                    source: source_of(&marketplace, &scope),
                    scope,
                    project,
                    version: text(v, "version"),
                    enabled: v.get("enabled").and_then(Value::as_bool).unwrap_or(false),
                    description: info.description,
                    commands: info.commands,
                    servers,
                    hooks: info.runs.iter().filter(|r| r.kind == "hook").count(),
                    id,
                    name,
                    marketplace,
                })
            })
            .collect();
        // The user's install of a plugin first, then the projects'.
        plugins.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()).then_with(|| a.project.cmp(&b.project)));
        Ok(plugins)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn plugin_id(id: &str) -> Result<(String, String), String> {
    match id.split_once('@') {
        Some((name, market)) if plain_name(name) && plain_name(market) => Ok((name.to_string(), market.to_string())),
        _ => Err(format!("{id} is not a plugin id")),
    }
}

/// Settings → Plugins → Installed: on/off, Update, Uninstall, by Claude Code.
/// `scope` and `project` are the card's (plugins_installed): a project's install
/// is changed from that project's folder, the user's from the home folder.
#[tauri::command]
pub async fn plugin_action(app: AppHandle, id: String, action: String, scope: Option<String>, project: Option<String>) -> Result<(), String> {
    let (name, market) = plugin_id(&id)?;
    if !matches!(action.as_str(), "enable" | "disable" | "update" | "uninstall") {
        return Err(format!("unknown action {action}"));
    }
    let scope = scope.unwrap_or_else(|| "user".into());
    let dir = match project_scope(&scope) {
        Some(false) => platform::home_dir(),
        Some(true) => {
            let dir = PathBuf::from(project.unwrap_or_default());
            if !dir.is_absolute() || !dir.is_dir() {
                return Err(tf("The project folder {path} isn't there any more.", &[("path", &dir.to_string_lossy())]));
            }
            dir
        }
        None => return Err(format!("unknown scope {scope}")),
    };
    crate::log::line(format!("addons: {action} {id} ({scope})"));
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        mcp::claude_in(&dir, &["plugin", &action, &id, "--scope", &scope], CLI_LIMIT).map_err(directory::message_of)?;
        // One of Buddybara's own, uninstalled for the user: its copy goes too
        // (a project's install of it still reads the same copy).
        if action == "uninstall" && market == MARKETPLACE && scope == "user" {
            let copy = market_dir().join(&name);
            if copy.exists() {
                let _ = platform::move_to_trash(std::slice::from_ref(&copy));
            }
            if write_market(&market_dir()).is_ok() {
                let _ = mcp::claude(&["plugin", "marketplace", "update", MARKETPLACE], CLI_LIMIT);
            }
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())??;
    changed(&app);
    Ok(())
}

/// A skill or command of the user's own (~/.claude/skills, ~/.claude/commands).
#[derive(Serialize)]
pub struct MySkill {
    name: String,
    /// "skill" | "command"
    kind: &'static str,
    /// Its SKILL.md, or its .md: what Edit opens.
    path: String,
}

#[tauri::command]
pub fn skills_mine() -> Vec<MySkill> {
    let mut out = Vec::new();
    for e in std::fs::read_dir(skills_dir()).into_iter().flatten().flatten() {
        let file = e.path().join("SKILL.md");
        if file.is_file() {
            out.push(MySkill { name: e.file_name().to_string_lossy().into_owned(), kind: "skill", path: file.to_string_lossy().into_owned() });
        }
    }
    for e in std::fs::read_dir(commands_dir()).into_iter().flatten().flatten() {
        let path = e.path();
        if path.is_file() && path.extension().is_some_and(|x| x.eq_ignore_ascii_case("md")) {
            let name = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
            out.push(MySkill { name, kind: "command", path: path.to_string_lossy().into_owned() });
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// Settings → Skills → Remove: one of the user's own, to the Recycle Bin.
#[tauri::command]
pub fn skill_remove(app: AppHandle, name: String, kind: String) -> Result<(), String> {
    if !plain_name(&name) {
        return Err(format!("{name} is not a skill's name"));
    }
    let path = match kind.as_str() {
        "skill" => skills_dir().join(&name),
        "command" => commands_dir().join(format!("{name}.md")),
        _ => return Err(format!("unknown kind {kind}")),
    };
    if !path.exists() {
        return Err(t("It isn't there any more."));
    }
    platform::move_to_trash(&[path])?;
    crate::log::line(format!("addons: removed {kind} {name}"));
    changed(&app);
    Ok(())
}

// ── A new skill ───────────────────────────────────────────────────────────────

/// What Settings → Skills → New skill asks.
#[derive(Deserialize)]
pub struct NewSkill {
    name: String,
    description: String,
    hint: String,
    instructions: String,
    /// Claude may use it by itself when it fits, not only when it is typed.
    auto: bool,
}

const MAX_DESCRIPTION: usize = 1024;
const MAX_INSTRUCTIONS: usize = 100_000;

/// A value on one YAML line, in double quotes.
fn yaml_text(text: &str) -> String {
    format!("\"{}\"", text.split_whitespace().collect::<Vec<_>>().join(" ").replace('\\', "\\\\").replace('"', "\\\""))
}

/// The SKILL.md of a new skill, and its name.
fn skill_file(form: &NewSkill) -> Result<(String, String), String> {
    let name = skill_name(&form.name).ok_or_else(|| t("Give it a name: letters, digits and dashes."))?;
    let description = form.description.trim();
    if description.is_empty() {
        return Err(t("Say what it does: the menu shows it, and Claude reads it to know when it fits."));
    }
    if description.chars().count() > MAX_DESCRIPTION {
        return Err(tf("What it does is at most {n} characters.", &[("n", &MAX_DESCRIPTION.to_string())]));
    }
    let instructions = form.instructions.trim();
    if instructions.is_empty() {
        return Err(t("Write what Claude should do when it is used."));
    }
    if instructions.chars().count() > MAX_INSTRUCTIONS {
        return Err(tf("The instructions are at most {n} characters.", &[("n", &MAX_INSTRUCTIONS.to_string())]));
    }
    let mut head = vec![format!("name: {name}"), format!("description: {}", yaml_text(description))];
    let hint = form.hint.trim();
    if !hint.is_empty() {
        head.push(format!("argument-hint: {}", yaml_text(&one_line(hint, 100))));
    }
    if !form.auto {
        head.push("disable-model-invocation: true".into());
    }
    Ok((name, format!("---\n{}\n---\n\n{instructions}\n", head.join("\n"))))
}

/// Settings → Skills → New skill: its SKILL.md written in ~/.claude/skills, as
/// Claude Code reads one. Its name, now a /command.
#[tauri::command]
pub fn skill_create(app: AppHandle, form: NewSkill) -> Result<String, String> {
    let (name, text) = skill_file(&form)?;
    let dir = skills_dir().join(&name);
    if dir.exists() {
        return Err(tf("You already have a skill called {name}.", &[("name", &name)]));
    }
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("SKILL.md"), text).map_err(|e| e.to_string())?;
    crate::log::line(format!("addons: new skill {name}"));
    changed(&app);
    Ok(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("buddybara-addons-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write(path: &Path, text: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    #[test]
    fn front_matter_reads_plain_quoted_and_folded_values() {
        let fm = front_matter("---\nname: notes\ndescription: >\n  Write today's note.\n  Use when asked.\nargument-hint: \"[day]\"\nuser-invocable: false\nmetadata:\n  owner: x\n---\nbody: not this\n");
        assert_eq!(fm["name"], "notes");
        assert_eq!(fm["description"], "Write today's note. Use when asked.");
        assert_eq!(fm["argument-hint"], "[day]");
        assert_eq!(fm["user-invocable"], "false");
        assert!(!fm.contains_key("owner") && !fm.contains_key("body"));
        assert!(front_matter("no front matter").is_empty());
    }

    #[test]
    fn names_are_made_plain_for_claude_code() {
        assert_eq!(skill_name("My Notes").as_deref(), Some("my-notes"));
        assert_eq!(skill_name("  daily_standup.v2 ").as_deref(), Some("daily-standup-v2"));
        assert_eq!(skill_name("--x--").as_deref(), Some("x"));
        assert_eq!(skill_name("Résumé"), Some("rsum".into()));
        assert_eq!(skill_name("!!!"), None);
        assert_eq!(skill_name(&"a".repeat(80)).map(|n| n.len()), Some(64));
        assert!(plain_name("slack") && plain_name("claude-code_setup.v1") && !plain_name("Bad Name!") && !plain_name(""));
    }

    #[test]
    fn what_was_given_is_told_apart() {
        let dir = temp("find");
        // A zip's one wrapping folder is gone into.
        write(&dir.join("skill/wrapped/SKILL.md"), "---\nname: Notes\n---\nx");
        assert_eq!(find(&dir.join("skill")).unwrap(), Found::Skill(dir.join("skill/wrapped")));
        write(&dir.join("plugin/.claude-plugin/plugin.json"), r#"{"name":"tools"}"#);
        assert_eq!(find(&dir.join("plugin")).unwrap(), Found::Plugin(dir.join("plugin")));
        write(&dir.join("market/.claude-plugin/marketplace.json"), r#"{"name":"mine","plugins":[]}"#);
        assert_eq!(find(&dir.join("market")).unwrap(), Found::Marketplace(dir.join("market")));
        write(&dir.join("many/a/SKILL.md"), "x");
        write(&dir.join("many/b/SKILL.md"), "x");
        assert_eq!(find(&dir.join("many")).unwrap(), Found::Skills(vec![dir.join("many/a"), dir.join("many/b")]));
        write(&dir.join("cmd/standup.md"), "Draft a standup");
        assert_eq!(find(&dir.join("cmd/standup.md")).unwrap(), Found::Command(dir.join("cmd/standup.md")));
        write(&dir.join("empty/readme.txt"), "x");
        assert!(find(&dir.join("empty")).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_plugin_says_its_commands_and_everything_it_runs() {
        let dir = temp("plugin");
        write(&dir.join(".claude-plugin/plugin.json"), r#"{"name":"tools","description":"Handy tools","lspServers":{"rust":{"command":"rust-analyzer"}}}"#);
        write(&dir.join("skills/standup/SKILL.md"), "---\nname: standup\ndescription: Draft one\n---\nx");
        write(&dir.join("skills/quiet/SKILL.md"), "---\nname: quiet\nuser-invocable: false\n---\nx");
        write(&dir.join("commands/deploy.md"), "Deploy it");
        write(&dir.join("hooks/hooks.json"), r#"{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"node start.js"},{"type":"prompt","prompt":"x"}]}]}}"#);
        write(&dir.join(".mcp.json"), r#"{"mcpServers":{"files":{"command":"npx","args":["-y","files-server"]},"docs":{"type":"http","url":"https://docs.example.com/mcp"}}}"#);
        let info = plugin_info(&dir).unwrap();
        assert_eq!((info.name.as_str(), info.description.as_str()), ("tools", "Handy tools"));
        assert_eq!(info.commands, vec!["tools:deploy", "tools:standup"]);
        let runs: Vec<(&str, &str, &str)> = info.runs.iter().map(|r| (r.kind, r.name.as_str(), r.detail.as_str())).collect();
        assert_eq!(runs, vec![
            ("hook", "SessionStart", "node start.js"),
            ("remote", "docs", "https://docs.example.com/mcp"),
            ("server", "files", "npx -y files-server"),
            ("lsp", "rust", "rust-analyzer"),
        ]);
        // A path in plugin.json that climbs out isn't followed.
        assert_eq!(inside(&dir, "../../etc/hooks.json"), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_marketplace_lists_its_plugins_looked_inside_where_they_are_local() {
        let dir = temp("market");
        write(&dir.join(".claude-plugin/marketplace.json"), r#"{"name":"team","metadata":{"description":"Team tools"},"plugins":[
            {"name":"notes","source":"./notes","description":"Notes"},
            {"name":"remote","source":{"source":"github","repo":"x/y"}}]}"#);
        write(&dir.join("notes/skills/today/SKILL.md"), "---\nname: today\n---\nx");
        let (name, description, plugins) = market_info(&dir, &HashSet::from(["notes@team".to_string()])).unwrap();
        assert_eq!((name.as_str(), description.as_str()), ("team", "Team tools"));
        assert_eq!((plugins[0].commands.clone(), plugins[0].unknown, plugins[0].installed), (vec!["notes:today".to_string()], false, true));
        assert!(plugins[1].unknown && !plugins[1].installed);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn archives_and_links_are_checked_before_anything_is_taken() {
        for bad in ["../evil.txt", "a/../../b", "/etc/passwd", "C:/Windows/x", r"..\x"] {
            assert!(climbs_out(bad), "{bad}");
        }
        assert!(!climbs_out("skill/SKILL.md") && !climbs_out("a..b/c"));
        assert_eq!(market_link("anthropics/skills"), Some("anthropics/skills"));
        assert_eq!(market_link(" https://github.com/x/y.git "), Some("https://github.com/x/y.git"));
        for bad in ["http://plain.example.com", "file:///C:/x", "not a link", "a/b/c d"] {
            assert_eq!(market_link(bad), None, "{bad}");
        }
    }

    #[test]
    fn a_new_skill_is_written_as_claude_code_reads_one() {
        let form = NewSkill {
            name: "Daily Standup".into(),
            description: "Draft my \"standup\"\nfrom yesterday".into(),
            hint: "[team]".into(),
            instructions: "Read yesterday's commits.\n\nWrite three bullets.".into(),
            auto: false,
        };
        let (name, text) = skill_file(&form).unwrap();
        assert_eq!(name, "daily-standup");
        assert_eq!(
            text,
            "---\nname: daily-standup\ndescription: \"Draft my \\\"standup\\\" from yesterday\"\nargument-hint: \"[team]\"\ndisable-model-invocation: true\n---\n\nRead yesterday's commits.\n\nWrite three bullets.\n"
        );
        // Read back, it says what was typed.
        let fm = front_matter(&text);
        assert_eq!(fm["description"], "Draft my \"standup\" from yesterday");
        assert!(skill_file(&NewSkill { name: "!!".into(), ..form }).is_err());
    }
}
