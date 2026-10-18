// Settings → Connectors: the MCP servers Claude Code can sign in to, from a
// fixed catalog of official ones. Their state comes from `claude mcp list`;
// "Auth" adds the server at user scope (`claude mcp add`) and runs its OAuth
// flow (`claude mcp login`), which opens the provider's sign-in page in the
// browser itself. Only Claude Code's own commands touch its configuration, and
// the page can only name a catalog entry: the addresses live here.

use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::i18n::{t, tf};
use crate::platform;

/// How a service connects.
enum Via {
    /// A remote MCP server with OAuth: added at user scope, then `claude mcp login`.
    Remote { transport: &'static str, url: &'static str },
    /// A claude.ai connector: its provider only signs in apps it registered
    /// itself (no client registration for Claude Code), Anthropic's among them.
    ClaudeAi,
}

struct Service {
    id: &'static str,
    name: &'static str,
    /// Where the page lists it: "work" | "design" | "dev" | "business".
    group: &'static str,
    via: Via,
}

const fn http(id: &'static str, name: &'static str, group: &'static str, url: &'static str) -> Service {
    Service { id, name, group, via: Via::Remote { transport: "http", url } }
}

const fn sse(id: &'static str, name: &'static str, group: &'static str, url: &'static str) -> Service {
    Service { id, name, group, via: Via::Remote { transport: "sse", url } }
}

const fn claude_ai(id: &'static str, name: &'static str, group: &'static str) -> Service {
    Service { id, name, group, via: Via::ClaudeAi }
}

/// Official servers only, from the MCP Registry (registry.modelcontextprotocol.io)
/// or the Claude Code docs, each checked to answer with OAuth metadata that lets
/// a client register. The ids become server names in Claude Code's
/// configuration: never rename one.
const CATALOG: &[Service] = &[
    http("airtable", "Airtable", "work", "https://mcp.airtable.com/mcp"),
    sse("asana", "Asana", "work", "https://mcp.asana.com/sse"),
    http("atlassian", "Atlassian", "work", "https://mcp.atlassian.com/v2/mcp"),
    http("clickup", "ClickUp", "work", "https://mcp.clickup.com/mcp"),
    http("dropbox", "Dropbox", "work", "https://mcp.dropbox.com/mcp"),
    http("fireflies", "Fireflies", "work", "https://api.fireflies.ai/mcp"),
    claude_ai("gmail", "Gmail", "work"),
    claude_ai("google-calendar", "Google Calendar", "work"),
    http("granola", "Granola", "work", "https://mcp.granola.ai/mcp"),
    http("intercom", "Intercom", "work", "https://mcp.intercom.com/mcp"),
    http("linear", "Linear", "work", "https://mcp.linear.app/mcp"),
    http("lucid", "Lucid", "work", "https://mcp.lucid.app/mcp"),
    claude_ai("microsoft-365", "Microsoft 365", "work"),
    http("miro", "Miro", "work", "https://mcp.miro.com/"),
    http("monday", "monday.com", "work", "https://mcp.monday.com/mcp"),
    http("notion", "Notion", "work", "https://mcp.notion.com/mcp"),
    claude_ai("slack", "Slack", "work"),
    http("todoist", "Todoist", "work", "https://ai.todoist.net/mcp"),
    http("zapier", "Zapier", "work", "https://mcp.zapier.com/api/v1/connect"),
    http("canva", "Canva", "design", "https://mcp.canva.com/mcp"),
    sse("cloudinary", "Cloudinary", "design", "https://asset-management.mcp.cloudinary.com/sse"),
    http("contentful", "Contentful", "design", "https://mcp.contentful.com/mcp"),
    http("figma", "Figma", "design", "https://mcp.figma.com/mcp"),
    http("gamma", "Gamma", "design", "https://mcp.gamma.app/mcp"),
    http("sanity", "Sanity", "design", "https://mcp.sanity.io"),
    http("webflow", "Webflow", "design", "https://mcp.webflow.com/mcp"),
    http("wix", "Wix", "design", "https://mcp.wix.com/mcp"),
    http("wordpress", "WordPress.com", "design", "https://public-api.wordpress.com/wpcom/v2/mcp/v1"),
    http("cloudflare", "Cloudflare", "dev", "https://bindings.mcp.cloudflare.com/mcp"),
    http("gitlab", "GitLab", "dev", "https://gitlab.com/api/v4/mcp"),
    http("grafana", "Grafana", "dev", "https://mcp.grafana.com/mcp"),
    http("huggingface", "Hugging Face", "dev", "https://huggingface.co/mcp?login"),
    http("neon", "Neon", "dev", "https://mcp.neon.tech/mcp"),
    http("netlify", "Netlify", "dev", "https://netlify-mcp.netlify.app/mcp"),
    http("planetscale", "PlanetScale", "dev", "https://mcp.pscale.dev/mcp/planetscale"),
    http("posthog", "PostHog", "dev", "https://mcp.posthog.com/mcp"),
    http("postman", "Postman", "dev", "https://mcp.postman.com/mcp"),
    http("prisma", "Prisma", "dev", "https://mcp.prisma.io/mcp"),
    http("railway", "Railway", "dev", "https://mcp.railway.com/mcp"),
    http("sentry", "Sentry", "dev", "https://mcp.sentry.dev/mcp"),
    http("supabase", "Supabase", "dev", "https://mcp.supabase.com/mcp"),
    http("vercel", "Vercel", "dev", "https://mcp.vercel.com"),
    http("amplitude", "Amplitude", "business", "https://mcp.amplitude.com/mcp"),
    http("attio", "Attio", "business", "https://mcp.attio.com/mcp"),
    http("cal-com", "Cal.com", "business", "https://mcp.cal.com/mcp"),
    claude_ai("hubspot", "HubSpot", "business"),
    http("klaviyo", "Klaviyo", "business", "https://mcp.klaviyo.com/mcp"),
    http("mercury", "Mercury", "business", "https://mcp.mercury.com/mcp"),
    http("mixpanel", "Mixpanel", "business", "https://mcp.mixpanel.com/mcp"),
    http("paypal", "PayPal", "business", "https://mcp.paypal.com/mcp"),
    sse("plaid", "Plaid", "business", "https://api.dashboard.plaid.com/mcp/sse"),
    http("ramp", "Ramp", "business", "https://mcp.ramp.com/mcp"),
    sse("square", "Square", "business", "https://mcp.squareup.com/sse"),
    http("stripe", "Stripe", "business", "https://mcp.stripe.com"),
];

/// Where claude.ai connectors are switched on.
const CLAUDE_AI_CONNECTORS: &str = "https://claude.ai/customize/connectors";
/// A sign-in the user walks away from is given up after this long.
const LOGIN_LIMIT: Duration = Duration::from_secs(300);
/// `claude mcp list` checks every server it lists.
const LIST_LIMIT: Duration = Duration::from_secs(90);

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    /// The catalog id, or the server's own name for the others.
    id: String,
    name: String,
    /// "connected" | "needsAuth" | "pending" | "failed" | "disabled" | "missing"
    state: &'static str,
    /// The catalog's group, or "other".
    group: &'static str,
    /// In the catalog, so it has an Auth button; the others are only listed.
    catalog: bool,
    /// Signed in on claude.ai rather than from here.
    claude_ai: bool,
}

// ── Reading `claude mcp list` ─────────────────────────────────────────────────

/// What a status from `claude mcp list` means ("✔ Connected", "! Needs
/// authentication", "✘ Failed to connect", "⏸ Pending approval…").
fn state_of(status: &str) -> &'static str {
    if status.contains("Connected") {
        "connected"
    } else if status.contains("Needs authentication") {
        "needsAuth"
    } else if status.contains("Pending approval") {
        "pending"
    } else if status.contains("Disabled") {
        "disabled"
    } else {
        "failed"
    }
}

/// The better of two states, for a service configured more than once.
fn rank(state: &str) -> u8 {
    match state {
        "connected" => 5,
        "needsAuth" => 4,
        "pending" => 3,
        "failed" => 2,
        "disabled" => 1,
        _ => 0,
    }
}

/// `(name, state)` for every server the list printed, as `<name>: <command or
/// URL> - <status>`. The command can hold anything, so the status is after the
/// last " - " and the name before the first ": ".
fn parse_list(text: &str) -> Vec<(String, &'static str)> {
    text.lines()
        .filter_map(|line| {
            let (name, rest) = line.split_once(": ")?;
            let (_, status) = rest.rsplit_once(" - ")?;
            Some((name.trim().to_string(), state_of(status)))
        })
        .collect()
}

/// A server name reduced to what a catalog entry is matched on: a claude.ai
/// connector ("claude.ai Google Calendar") counts as the service itself.
fn key(name: &str) -> String {
    let name = name.strip_prefix("claude.ai ").unwrap_or(name);
    name.chars().filter(char::is_ascii_alphanumeric).flat_map(char::to_lowercase).collect()
}

/// How a configured server is shown: a plugin's server by its own last name,
/// a claude.ai connector without the prefix (its card says "Via claude.ai").
fn display_name(name: &str) -> String {
    if let Some(rest) = name.strip_prefix("plugin:") {
        return rest.rsplit(':').next().unwrap_or(rest).to_string();
    }
    name.strip_prefix("claude.ai ").unwrap_or(name).to_string()
}

/// The catalog with each service's state, then every other configured server.
fn entries(listed: &[(String, &'static str)]) -> Vec<Entry> {
    let mut used = vec![false; listed.len()];
    let mut out: Vec<Entry> = CATALOG
        .iter()
        .map(|s| {
            let mut state = "missing";
            for (i, (name, st)) in listed.iter().enumerate() {
                let k = key(name);
                if k == key(s.id) || k == key(s.name) {
                    used[i] = true;
                    if rank(st) > rank(state) {
                        state = st;
                    }
                }
            }
            Entry {
                id: s.id.into(),
                name: s.name.into(),
                state,
                group: s.group,
                catalog: true,
                claude_ai: matches!(s.via, Via::ClaudeAi),
            }
        })
        .collect();
    for (i, (name, state)) in listed.iter().enumerate() {
        if !used[i] {
            out.push(Entry {
                id: name.clone(),
                name: display_name(name),
                state,
                group: "other",
                catalog: false,
                claude_ai: name.starts_with("claude.ai "),
            });
        }
    }
    out
}

// ── Running Claude Code ───────────────────────────────────────────────────────

fn drain(pipe: Option<impl Read + Send + 'static>) -> JoinHandle<String> {
    std::thread::spawn(move || {
        let mut text = String::new();
        if let Some(mut pipe) = pipe {
            let _ = pipe.read_to_string(&mut text);
        }
        text
    })
}

fn last_line(text: &str) -> Option<String> {
    text.lines().map(str::trim).rfind(|l| !l.is_empty()).map(String::from)
}

/// `claude` with `args`, from the home folder, with no console window, given up
/// after `limit`. Its output, or what it said went wrong.
fn claude(args: &[&str], limit: Duration) -> Result<String, String> {
    let exe = crate::code::claude_exe().ok_or_else(|| t("Claude Code isn't installed: `claude` was not found."))?;
    let mut cmd = Command::new(exe);
    cmd.args(args)
        .current_dir(platform::home_dir())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = platform::no_console(&mut cmd)
        .spawn()
        .map_err(|e| tf("Could not start Claude Code: {error}", &[("error", &e.to_string())]))?;
    let (out, err) = (drain(child.stdout.take()), drain(child.stderr.take()));
    let started = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            break status;
        }
        if started.elapsed() > limit {
            let _ = child.kill();
            return Err(t("Gave up waiting: the sign-in wasn't finished in time."));
        }
        std::thread::sleep(Duration::from_millis(200));
    };
    let (out, err) = (out.join().unwrap_or_default(), err.join().unwrap_or_default());
    if status.success() {
        Ok(out)
    } else {
        Err(last_line(&err).or_else(|| last_line(&out)).unwrap_or_else(|| t("Claude Code stopped with an error.")))
    }
}

/// Text without the terminal's control sequences (colours, cursor moves).
fn plain(text: &str) -> String {
    let mut out = String::new();
    let mut chars = text.chars();
    while let Some(c) = chars.next() {
        match c {
            '\u{1b}' => match chars.next() {
                // CSI: parameters up to a final byte in @..~
                Some('[') => {
                    for n in chars.by_ref() {
                        if ('@'..='~').contains(&n) {
                            break;
                        }
                    }
                }
                // OSC: up to BEL or ESC \
                Some(']') => {
                    while let Some(n) = chars.next() {
                        if n == '\u{7}' || (n == '\u{1b}' && chars.next().is_some()) {
                            break;
                        }
                    }
                }
                _ => {}
            },
            '\r' => {}
            c => out.push(c),
        }
    }
    out
}

/// The console of the sign-in under way, for its Cancel button. One at a time:
/// the page waits for one sign-in before it offers another.
static SIGN_IN: Mutex<Option<Arc<platform::Pty>>> = Mutex::new(None);

fn signing_in() -> MutexGuard<'static, Option<Arc<platform::Pty>>> {
    SIGN_IN.lock().unwrap_or_else(PoisonError::into_inner)
}

/// `claude mcp login <id>`, in a console of its own where there is one
/// (Windows): Claude Code wants a terminal for its sign-in, and opens the
/// provider's page in the browser itself. Given up after LOGIN_LIMIT.
fn login(id: &str) -> Result<(), String> {
    let exe = crate::code::claude_exe().ok_or_else(|| t("Claude Code isn't installed: `claude` was not found."))?;
    let args = ["mcp", "login", id].map(String::from);
    let (pty, mut reader) = match platform::Pty::spawn(&exe, &args, &platform::home_dir(), 120, 32, &[]) {
        Ok(console) => console,
        Err(_) => return claude(&["mcp", "login", id], LOGIN_LIMIT).map(|_| ()),
    };
    let pty = Arc::new(pty);
    *signing_in() = Some(pty.clone());
    let screen = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = reader.read_to_end(&mut bytes);
        bytes
    });
    let (done, ended) = std::sync::mpsc::channel();
    let waiting = pty.clone();
    std::thread::spawn(move || {
        let _ = done.send(waiting.wait());
    });
    let code = match ended.recv_timeout(LOGIN_LIMIT) {
        Ok(code) => Some(code),
        Err(_) => {
            pty.kill();
            let _ = ended.recv();
            None
        }
    };
    // Closing the console ends its screen, which the reader then hands back.
    pty.finish();
    signing_in().take();
    let text = plain(&String::from_utf8_lossy(&screen.join().unwrap_or_default()));
    match code {
        Some(0) => Ok(()),
        Some(_) => Err(last_line(&text).unwrap_or_else(|| t("Claude Code stopped with an error."))),
        None => Err(t("Gave up waiting: the sign-in wasn't finished in time.")),
    }
}

/// Added once at user scope, so every project has it, then signed in. `again`:
/// signed out first, so the sign-in really runs again.
fn connect(id: &str, transport: &str, url: &str, again: bool) -> Result<(), String> {
    if let Err(err) = claude(&["mcp", "add", "--transport", transport, "--scope", "user", id, url], LIST_LIMIT) {
        if !err.contains("already exists") {
            return Err(err);
        }
    }
    if again {
        let _ = claude(&["mcp", "logout", id], LIST_LIMIT);
    }
    login(id)
}

// ── Commands ──────────────────────────────────────────────────────────────────

/// The catalog alone, every state "missing": the page draws it while the list
/// is read.
#[tauri::command]
pub fn mcp_catalog() -> Vec<Entry> {
    entries(&[])
}

/// The catalog with each service's state, and the other configured servers.
#[tauri::command]
pub async fn mcp_status() -> Result<Vec<Entry>, String> {
    tauri::async_runtime::spawn_blocking(|| claude(&["mcp", "list"], LIST_LIMIT).map(|out| entries(&parse_list(&out))))
        .await
        .map_err(|e| e.to_string())?
}

/// Signs Claude Code in to a catalog service: its OAuth page opens in the
/// browser, and this returns once the sign-in is done. `again`: it was signed
/// in already (Re-auth). A claude.ai connector opens claude.ai's connector page
/// instead.
#[tauri::command]
pub async fn mcp_connect(id: String, again: bool) -> Result<(), String> {
    let service = CATALOG.iter().find(|s| s.id == id).ok_or_else(|| format!("unknown service {id}"))?;
    match service.via {
        Via::ClaudeAi => {
            platform::open_url(CLAUDE_AI_CONNECTORS);
            Ok(())
        }
        Via::Remote { transport, url } => {
            let id = service.id;
            tauri::async_runtime::spawn_blocking(move || connect(id, transport, url, again))
                .await
                .map_err(|e| e.to_string())?
        }
    }
}

/// Ends the sign-in under way (its Cancel button): mcp_connect then fails, and
/// the page, which asked, says nothing of it.
#[tauri::command]
pub fn mcp_cancel() {
    if let Some(pty) = signing_in().take() {
        pty.kill();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The list as Claude Code 2.1.301 printed it on Windows (shortened).
    const LIST: &str = "Checking MCP server health…

claude.ai Claude Docs: https://api.anthropic.com/v1/pages/mcp - ✔ Connected
plugin:media-pipeline:media-pipeline: node C:/x/bundle.js - ✔ Connected
plugin:claude-mem:mcp-search: node -e const a=1 - 2 - ✔ Connected
youtube-mcp: youtube-mcp  - ✔ Connected
notion: https://mcp.notion.com/mcp (HTTP) - ! Needs authentication
claude.ai Google Calendar: https://example.test/mcp - ✘ Failed to connect";

    #[test]
    fn the_list_reads_into_the_catalog_and_the_rest() {
        let all = entries(&parse_list(LIST));
        let find = |id: &str| all.iter().find(|e| e.id == id).unwrap();
        assert_eq!(find("notion").state, "needsAuth");
        assert_eq!(find("google-calendar").state, "failed");
        assert!(find("google-calendar").claude_ai);
        assert_eq!((find("atlassian").state, find("atlassian").group), ("missing", "work"));
        // A " - " inside a command doesn't end the name or the status early.
        let mem = find("plugin:claude-mem:mcp-search");
        assert_eq!((mem.name.as_str(), mem.state, mem.group, mem.catalog), ("mcp-search", "connected", "other", false));
        assert_eq!(find("youtube-mcp").state, "connected");
        assert_eq!(find("claude.ai Claude Docs").name, "Claude Docs");
        assert!(parse_list("Checking MCP server health…\n\nNo MCP servers configured.").is_empty());
    }
}
