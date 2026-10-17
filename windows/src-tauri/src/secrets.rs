// API keys live in the Windows Credential Manager or, on Linux, the Secret
// Service (GNOME Keyring, KWallet) — never on disk and never in the front end — the webview can only ask whether a key is present.

use keyring::Entry;

const SERVICE: &str = "com.buddybara.app";
/// Where the keys were kept before the rename; `get` moves them to SERVICE.
// ponytail: one-time move, delete once both PCs have run a build with it.
const LEGACY_SERVICE: &str = "fr.louisraille.coucou";

/// Every key Buddybara may store. Anything outside this list is refused.
pub const KNOWN_KEYS: &[&str] = &[
    "anthropic-api-key",
    "openai-api-key",
    "google-api-key",
    "openrouter-api-key",
    "openai-compatible-key",
    "n8n-url",
    "n8n-api-key",
    "vercel-token",
    "github-token",
    "obsidian-api-key",
    "stripe-api-key",
    "resend-api-key",
    "notion-api-key",
    "calcom-api-key",
];

fn entry(key: &str) -> Option<Entry> {
    if !KNOWN_KEYS.contains(&key) {
        return None;
    }
    Entry::new(SERVICE, key).ok()
}

pub fn get(key: &str) -> Option<String> {
    let entry = entry(key)?;
    if let Some(value) = entry.get_password().ok().filter(|v| !v.is_empty()) {
        return Some(value);
    }
    let old = Entry::new(LEGACY_SERVICE, key).ok()?;
    let value = old.get_password().ok().filter(|v| !v.is_empty())?;
    if entry.set_password(&value).is_ok() {
        let _ = old.delete_credential();
    }
    Some(value)
}

pub fn set(key: &str, value: &str) -> Result<(), String> {
    let entry = entry(key).ok_or_else(|| format!("unknown key {key}"))?;
    if value.is_empty() {
        let _ = entry.delete_credential();
        let _ = Entry::new(LEGACY_SERVICE, key).map(|old| old.delete_credential());
        return Ok(());
    }
    entry.set_password(value).map_err(|e| e.to_string())
}

pub fn present(key: &str) -> bool {
    get(key).is_some()
}
