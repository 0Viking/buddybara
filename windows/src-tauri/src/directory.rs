// Settings → Skills and Plugins: the most used of Anthropic's Directory (what
// claude.ai/customize shows), by department, from its public API — the one
// Claude Code reads, which needs no sign-in. Install and Uninstall run Claude
// Code's own `claude plugin` commands; the name they install comes from Claude
// Code's copy of the Directory, never from the page.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use reqwest::Url;
use serde::Serialize;
use serde_json::Value;

use crate::i18n::t;
use crate::{mcp, net, platform};

const API: &str = "https://api.anthropic.com/api/directory/plugins";
/// claude.ai's connectors, with their page there (also public: Claude Code reads it).
const SERVERS: &str = "https://api.anthropic.com/api/directory/servers";
/// How many search results a page shows.
const RESULTS: usize = 30;
const MAX_QUERY: usize = 100;
/// Claude Code's built-in marketplace for the Directory.
const MARKETPLACE: &str = "anthropic-plugin-directory";
/// How many entries a department shows; claude.ai has the rest.
const PER_CATEGORY: usize = 15;
/// The departments the Directory files entries under (its `work_department`).
const DEPARTMENTS: &[&str] = &[
    "engineering", "product", "design", "data", "marketing", "sales", "customer-support", "finance", "legal", "hr",
    "operations", "it-security",
];
/// Answers are kept this long: switching pages doesn't ask again.
const FRESH: Duration = Duration::from_secs(600);
const INSTALL_LIMIT: Duration = Duration::from_secs(240);

/// What a page lists: skills alone, or plugins (commands, agents, hooks, or a
/// bundle with servers). Connectors alone are the Connectors page's.
fn kind_filter(kind: &str) -> Result<&'static str, String> {
    match kind {
        "skills" => Ok(r#"surfaces.exists(s, s == "claude_code") && components.all(c, c.type == "skill")"#),
        "plugins" => Ok(
            r#"surfaces.exists(s, s == "claude_code") && !components.all(c, c.type == "skill") && !components.all(c, c.type == "mcp_server")"#,
        ),
        _ => Err(format!("unknown kind {kind}")),
    }
}

#[derive(Serialize, Clone)]
pub struct Category {
    id: String,
    count: u64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    /// The Directory's id ("plugin_01…"): what Install and Uninstall are given.
    id: String,
    name: String,
    summary: String,
    publisher: String,
    /// "anthropic" | "partner" | "community"
    tier: String,
    skills: usize,
    commands: usize,
    agents: usize,
    hooks: usize,
    servers: usize,
    /// Claude Code knows how to install it (it is in its copy of the Directory).
    installable: bool,
    installed: bool,
}

static CACHE: Mutex<Option<HashMap<String, (Instant, Value)>>> = Mutex::new(None);

/// One answer of the Directory, kept FRESH.
async fn get(query: &[(&str, &str)]) -> Result<Value, String> {
    let url = Url::parse_with_params(API, query).map_err(|e| e.to_string())?;
    let key = url.to_string();
    if let Some((at, value)) = CACHE.lock().unwrap().get_or_insert_with(HashMap::new).get(&key) {
        if at.elapsed() < FRESH {
            return Ok(value.clone());
        }
    }
    let response = net::client(&url, Duration::from_secs(20))?
        .get(url)
        .send()
        .await
        .map_err(|e| crate::i18n::tf("Network error: {error}", &[("error", &e.to_string())]))?;
    let status = response.status();
    if !status.is_success() {
        let body = net::read_capped(response, net::MAX_ERROR_BODY).await.unwrap_or_default();
        return Err(format!("Directory {}: {}", status.as_u16(), net::error_detail(&body)));
    }
    let value: Value = serde_json::from_slice(&net::read_capped(response, net::MAX_BODY).await?)
        .map_err(|_| t("Unexpected API response."))?;
    CACHE.lock().unwrap().get_or_insert_with(HashMap::new).insert(key, (Instant::now(), value.clone()));
    Ok(value)
}

/// Claude Code's copy of the Directory: its id → the name it installs it as.
fn install_names() -> HashMap<String, String> {
    let path = platform::home_dir().join(".claude").join("plugins").join("plugin-directory-cache-v2.json");
    let Ok(bytes) = std::fs::read(path) else { return HashMap::new() };
    let Ok(cache) = serde_json::from_slice::<Value>(&bytes) else { return HashMap::new() };
    cache
        .get("entryNames")
        .and_then(Value::as_object)
        .map(|names| names.iter().filter_map(|(id, n)| Some((id.clone(), n.as_str()?.to_string()))).collect())
        .unwrap_or_default()
}

/// What Claude Code has installed, by its id ("name@marketplace").
fn installed() -> HashSet<String> {
    let path = platform::home_dir().join(".claude").join("plugins").join("installed_plugins.json");
    let Ok(bytes) = std::fs::read(path) else { return HashSet::new() };
    let Ok(file) = serde_json::from_slice::<Value>(&bytes) else { return HashSet::new() };
    file.get("plugins").or(Some(&file)).and_then(Value::as_object).map(|p| p.keys().cloned().collect()).unwrap_or_default()
}

/// The installed id of `name`, from whichever marketplace it came.
fn installed_id(installed: &HashSet<String>, name: &str) -> Option<String> {
    installed.iter().find(|id| id.split_once('@').is_some_and(|(n, _)| n == name)).cloned()
}

fn entry(x: &Value, names: &HashMap<String, String>, installed: &HashSet<String>) -> Option<Entry> {
    let id = x.get("id")?.as_str()?.to_string();
    let text = |k: &str| x.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    let count = |kind: &str| {
        x.get("components").and_then(Value::as_array).map_or(0, |c| c.iter().filter(|c| c["type"] == kind).count())
    };
    let install = names.get(&id);
    Some(Entry {
        name: text("name"),
        summary: text("summary"),
        publisher: x.pointer("/publisher/name").and_then(Value::as_str).unwrap_or("").to_string(),
        tier: text("verified_tier"),
        skills: count("skill"),
        commands: count("command"),
        agents: count("agent"),
        hooks: count("hook"),
        servers: count("mcp_server"),
        installable: install.is_some(),
        installed: install.is_some_and(|n| installed_id(installed, n).is_some()),
        id,
    })
}

/// The departments of `kind`, most entries first, with how many each has.
#[tauri::command]
pub async fn directory_categories(kind: String) -> Result<Vec<Category>, String> {
    let filter = kind_filter(&kind)?;
    let answer = get(&[("limit", "1"), ("include", "facets"), ("filter", filter)]).await?;
    let mut categories: Vec<Category> = answer
        .pointer("/facets/work_department")
        .and_then(Value::as_array)
        .map(|facets| {
            facets
                .iter()
                .filter_map(|f| Some(Category { id: f.get("value")?.as_str()?.to_string(), count: f.get("count")?.as_u64()? }))
                .filter(|c| c.count > 0 && DEPARTMENTS.contains(&c.id.as_str()))
                .collect()
        })
        .unwrap_or_default();
    categories.sort_by(|a, b| b.count.cmp(&a.count));
    Ok(categories)
}

/// The most used entries of `kind` in one department.
#[tauri::command]
pub async fn directory_section(kind: String, category: String) -> Result<Vec<Entry>, String> {
    if !DEPARTMENTS.contains(&category.as_str()) {
        return Err(format!("unknown category {category}"));
    }
    let filter = format!(r#"{} && taxonomy.work_department == "{category}""#, kind_filter(&kind)?);
    let limit = PER_CATEGORY.to_string();
    let answer = get(&[("limit", &limit), ("order_by", "popularity"), ("order", "desc"), ("filter", &filter)]).await?;
    let (names, installed) = (install_names(), installed());
    Ok(answer
        .get("data")
        .and_then(Value::as_array)
        .map(|list| list.iter().filter_map(|x| entry(x, &names, &installed)).collect())
        .unwrap_or_default())
}

/// What `claude plugin … --json` said went wrong: its message, not the JSON around it.
fn message_of(err: String) -> String {
    let Ok(v) = serde_json::from_str::<Value>(&err) else { return err };
    ["/error/message", "/error", "/message"]
        .iter()
        .find_map(|p| v.pointer(p).and_then(Value::as_str).map(str::to_string))
        .unwrap_or(err)
}

/// Skills or plugins of the whole Directory matching `query`, best match first.
#[tauri::command]
pub async fn directory_search(kind: String, query: String) -> Result<Vec<Entry>, String> {
    let query = query.trim();
    if query.is_empty() || query.chars().count() > MAX_QUERY {
        return Ok(Vec::new());
    }
    let limit = RESULTS.to_string();
    let answer = get(&[("limit", &limit), ("q", query), ("filter", kind_filter(&kind)?)]).await?;
    let (names, installed) = (install_names(), installed());
    Ok(answer
        .get("data")
        .and_then(Value::as_array)
        .map(|list| list.iter().filter_map(|x| entry(x, &names, &installed)).collect())
        .unwrap_or_default())
}

/// A connector of claude.ai's directory that Buddybara's catalog lacks.
#[derive(Serialize, Clone)]
pub struct Connector {
    name: String,
    summary: String,
    /// Its page on claude.ai, where it is switched on.
    page: String,
}

static SERVER_LIST: Mutex<Option<(Instant, Vec<Value>)>> = Mutex::new(None);

/// Every connector of claude.ai's directory, kept FRESH.
async fn servers() -> Result<Vec<Value>, String> {
    if let Some((at, list)) = SERVER_LIST.lock().unwrap().as_ref() {
        if at.elapsed() < FRESH {
            return Ok(list.clone());
        }
    }
    let mut all = Vec::new();
    let mut cursor: Option<String> = None;
    for _ in 0..10 {
        let mut query = vec![("limit", "500".to_string()), ("visibility", "commercial".to_string())];
        if let Some(c) = &cursor {
            query.push(("cursor", c.clone()));
        }
        let url = Url::parse_with_params(SERVERS, &query).map_err(|e| e.to_string())?;
        let response = net::client(&url, Duration::from_secs(20))?
            .get(url)
            .send()
            .await
            .map_err(|e| crate::i18n::tf("Network error: {error}", &[("error", &e.to_string())]))?;
        if !response.status().is_success() {
            return Err(format!("Directory {}", response.status().as_u16()));
        }
        let page: Value = serde_json::from_slice(&net::read_capped(response, net::MAX_BODY).await?)
            .map_err(|_| t("Unexpected API response."))?;
        all.extend(page.get("servers").and_then(Value::as_array).cloned().unwrap_or_default());
        cursor = page.get("next_cursor").and_then(Value::as_str).map(str::to_string);
        if cursor.is_none() {
            break;
        }
    }
    *SERVER_LIST.lock().unwrap() = Some((Instant::now(), all.clone()));
    Ok(all)
}

/// Whether a word of `text` starts with `q` (lowercase): "git" finds GitHub, not Digits.
fn word_starts(text: &str, q: &str) -> bool {
    text.to_lowercase().split(|c: char| !c.is_alphanumeric()).any(|w| w.starts_with(q))
}

/// claude.ai's connectors with a word starting with `query` (in the name first,
/// then the description) that the Connectors page doesn't list, most used first.
#[tauri::command]
pub async fn connector_search(query: String) -> Result<Vec<Connector>, String> {
    let q = query.trim().to_lowercase();
    if q.is_empty() || q.chars().count() > MAX_QUERY {
        return Ok(Vec::new());
    }
    let text = |x: &Value, k: &str| x.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    let mut found: Vec<(u8, u64, Connector)> = servers()
        .await?
        .iter()
        .filter_map(|x| {
            let name = Some(text(x, "display_name")).filter(|n| !n.is_empty()).unwrap_or_else(|| text(x, "name"));
            let summary = text(x, "one_liner");
            let page = text(x, "directory_url");
            let by_name = word_starts(&name, &q);
            if (!by_name && !word_starts(&summary, &q)) || !page.starts_with("https://claude.ai/") || mcp::in_catalog(&name) {
                return None;
            }
            let rank = x.get("popularity_rank").and_then(Value::as_u64).unwrap_or(u64::MAX);
            Some((u8::from(!by_name), rank, Connector { name, summary, page }))
        })
        .collect();
    found.sort_by_key(|(by, rank, _)| (*by, *rank));
    Ok(found.into_iter().take(15).map(|(_, _, c)| c).collect())
}

/// The name Claude Code installs Directory entry `id` as, checked.
fn install_name(id: &str) -> Result<String, String> {
    let name = install_names().get(id).cloned().ok_or_else(|| t("Claude Code doesn't know this one yet: open /plugin in Claude Code once, then try again."))?;
    if name.is_empty() || !name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.')) {
        return Err(format!("unexpected plugin name {name}"));
    }
    Ok(name)
}

/// Installs Directory entry `id` for Claude Code (user scope). A plugin that
/// runs a command to install is left to Claude Code's /plugin, where the
/// command is shown before anything runs: nothing here ever accepts it.
#[tauri::command]
pub async fn plugin_install(id: String) -> Result<(), String> {
    let name = install_name(&id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let target = format!("{name}@{MARKETPLACE}");
        match mcp::claude(&["plugin", "install", &target, "--json"], INSTALL_LIMIT) {
            Ok(_) => Ok(()),
            Err(err) if err.contains("shownCommand") || err.to_lowercase().contains("confirm") => Err(t(
                "This plugin runs a command when it installs: install it from Claude Code (/plugin) to see the command first.",
            )),
            Err(err) => Err(message_of(err)),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Uninstalls Directory entry `id`, from whichever marketplace it came.
#[tauri::command]
pub async fn plugin_uninstall(id: String) -> Result<(), String> {
    let name = install_name(&id)?;
    let target = installed_id(&installed(), &name).unwrap_or_else(|| format!("{name}@{MARKETPLACE}"));
    tauri::async_runtime::spawn_blocking(move || mcp::claude(&["plugin", "uninstall", &target, "--json"], INSTALL_LIMIT).map(|_| ()).map_err(message_of))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn an_entry_reads_its_parts_and_whether_claude_code_has_it() {
        let names = HashMap::from([("plugin_1".to_string(), "productivity".to_string())]);
        let installed = HashSet::from(["productivity@claude-plugins-official".to_string()]);
        let x = json!({
            "id": "plugin_1", "name": "Productivity", "summary": "Plan your day", "verified_tier": "anthropic",
            "publisher": { "name": "Anthropic" },
            "components": [{ "type": "skill" }, { "type": "skill" }, { "type": "command" }, { "type": "mcp_server" }]
        });
        let e = entry(&x, &names, &installed).unwrap();
        assert_eq!((e.skills, e.commands, e.servers, e.installable, e.installed), (2, 1, 1, true, true));
        let unknown = entry(&json!({ "id": "plugin_2", "name": "x" }), &names, &installed).unwrap();
        assert!(!unknown.installable && !unknown.installed);
        assert!(kind_filter("connectors").is_err());
        assert!(word_starts("GitHub Enterprise", "git") && !word_starts("Digits", "git"));
    }
}
