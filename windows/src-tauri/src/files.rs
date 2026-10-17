// Dropped files are copied into %LOCALAPPDATA%\Buddybara\inbox so the original is
// never touched and the copy survives the drag source going away.
// The inbox is swept of anything older than a week, as on macOS.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde::Serialize;

use crate::settings;

const KEEP_FOR: Duration = Duration::from_secs(7 * 24 * 60 * 60);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DroppedFile {
    pub name: String,
    pub path: String,
    pub size: u64,
}

pub fn inbox_dir() -> PathBuf {
    settings::local_dir().join("inbox")
}

// ── Paths a real drop delivered ─────────────────────────────────────────────
//
// `ingest_file` is callable from the page, so on its own it would copy any file
// the user can read (a script injected into the page could pull in ~/.ssh).
// Only paths the OS just delivered through a real drop are accepted: WebView2's
// drop objects on Windows (webview_drop.rs), Tauri's drag-drop window event
// elsewhere (lib.rs). Each is good once, for a couple of minutes.

const DROP_VALID_FOR: Duration = Duration::from_secs(120);
const DROP_MAX_PENDING: usize = 64;

static DROPPED: std::sync::Mutex<Vec<(String, std::time::Instant)>> = std::sync::Mutex::new(Vec::new());

/// Records paths that came from a real drop.
pub fn allow_dropped<I: IntoIterator<Item = String>>(paths: I) {
    let mut list = DROPPED.lock().unwrap_or_else(|e| e.into_inner());
    let now = std::time::Instant::now();
    list.retain(|(_, at)| now.duration_since(*at) < DROP_VALID_FOR);
    for p in paths {
        list.push((p, now));
    }
    let excess = list.len().saturating_sub(DROP_MAX_PENDING);
    list.drain(..excess);
}

/// True (once) when `path` was delivered by a drop in the last couple of minutes.
fn take_dropped(path: &str) -> bool {
    let mut list = DROPPED.lock().unwrap_or_else(|e| e.into_inner());
    let now = std::time::Instant::now();
    list.retain(|(_, at)| now.duration_since(*at) < DROP_VALID_FOR);
    match list.iter().position(|(p, _)| p == path) {
        Some(i) => {
            list.remove(i);
            true
        }
        None => false,
    }
}

pub fn ingest(source: &str) -> Result<DroppedFile, String> {
    if !take_dropped(source) {
        return Err(crate::i18n::t("Only files dropped on the buddy can be added."));
    }
    let src = Path::new(source);
    let meta = std::fs::metadata(src)
        .map_err(|e| crate::i18n::tf("Cannot read {path}: {error}", &[("path", source), ("error", &e.to_string())]))?;
    if meta.is_dir() {
        return Err(crate::i18n::t("Folders can't be dropped yet."));
    }

    let dir = inbox_dir();
    crate::platform::ensure_private_dir(&settings::local_dir()).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let name = src
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".into());

    let dest = unique(&dir, &name);
    std::fs::copy(src, &dest).map_err(|e| crate::i18n::tf("Cannot copy: {error}", &[("error", &e.to_string())]))?;
    // CopyFileEx carries the source's timestamps across, so a file last edited
    // three years ago would arrive already older than the sweep window and be
    // deleted on the spot. The inbox ages from when *we* copied it.
    if let Ok(file) = std::fs::File::options().write(true).open(&dest) {
        let _ = file.set_modified(SystemTime::now());
    }
    sweep(&dir);

    Ok(DroppedFile {
        name,
        path: dest.to_string_lossy().to_string(),
        size: meta.len(),
    })
}

/// `dir/name`, or `dir/name (2).ext`… when that one is taken: never an
/// existing file.
fn unique(dir: &Path, name: &str) -> PathBuf {
    let dest = dir.join(name);
    if !dest.exists() {
        return dest;
    }
    let stem = Path::new(name).file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let ext = Path::new(name).extension().map(|s| format!(".{}", s.to_string_lossy())).unwrap_or_default();
    (2..1000).map(|i| dir.join(format!("{stem} ({i}){ext}"))).find(|c| !c.exists()).unwrap_or(dest)
}

/// Device names Windows keeps for itself, with or without an extension: a file
/// or folder called `NUL.txt` opens the device instead.
pub(crate) fn is_device_name(name: &str) -> bool {
    const DEVICES: &[&str] = &[
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
        "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    let stem = name.split('.').next().unwrap_or_default().trim_end().to_ascii_uppercase();
    DEVICES.contains(&stem.as_str())
}

// ── Files pasted into the buddy panel, and its attachments ─────────────────

/// Largest file the buddy panel takes from the clipboard.
const PASTE_MAX: usize = 25 * 1024 * 1024;
/// Most files one buddy prompt carries.
const MAX_ATTACHMENTS: usize = 20;

/// A plain file name of letters, digits, spaces and `._-()`, nothing hidden,
/// no device, no trailing dot (Windows would drop it): "pasted" when that
/// leaves nothing usable.
fn pasted_name(name: &str) -> String {
    let base = Path::new(name).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let kept: String = base.chars().filter(|c| c.is_alphanumeric() || " ._-()".contains(*c)).take(80).collect();
    let kept = kept.trim_start_matches('.').trim_end_matches(['.', ' ']).trim();
    if kept.is_empty() || is_device_name(kept) { "pasted".into() } else { kept.to_string() }
}

/// A file pasted into the buddy panel (a screenshot, most of the time): its
/// bytes land in the inbox, as a dropped file's copy would, swept the same way.
pub fn save_pasted(name: &str, bytes: &[u8]) -> Result<DroppedFile, String> {
    if bytes.is_empty() {
        return Err(crate::i18n::t("Nothing to paste."));
    }
    if bytes.len() > PASTE_MAX {
        let mb = (PASTE_MAX / (1024 * 1024)).to_string();
        return Err(crate::i18n::tf("A pasted file is at most {mb} MB.", &[("mb", &mb)]));
    }
    let dir = inbox_dir();
    crate::platform::ensure_private_dir(&settings::local_dir()).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let dest = unique(&dir, &pasted_name(name));
    let mut file = std::fs::File::options()
        .write(true)
        .create_new(true)
        .open(&dest)
        .map_err(|e| crate::i18n::tf("Cannot copy: {error}", &[("error", &e.to_string())]))?;
    std::io::Write::write_all(&mut file, bytes)
        .map_err(|e| crate::i18n::tf("Cannot copy: {error}", &[("error", &e.to_string())]))?;
    sweep(&dir);
    Ok(DroppedFile {
        name: dest.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
        path: dest.to_string_lossy().into_owned(),
        size: bytes.len() as u64,
    })
}

/// A buddy prompt's attachments, as given, once each is known to be a file of
/// the inbox: Claude is only ever pointed at copies Buddybara made (code.rs send).
pub fn attachments(paths: &[String]) -> Result<Vec<PathBuf>, String> {
    if paths.len() > MAX_ATTACHMENTS {
        return Err(crate::i18n::tf("At most {max} files at a time.", &[("max", &MAX_ATTACHMENTS.to_string())]));
    }
    let inbox = std::fs::canonicalize(inbox_dir()).ok();
    paths
        .iter()
        .map(|p| {
            let real = std::fs::canonicalize(p).ok().filter(|r| r.is_file());
            match (real, inbox.as_deref()) {
                (Some(real), Some(inbox)) if real.parent() == Some(inbox) => Ok(PathBuf::from(p)),
                _ => {
                    let name = Path::new(p).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                    Err(crate::i18n::tf("{name} is no longer there: drop it again.", &[("name", &name)]))
                }
            }
        })
        .collect()
}

/// Drops anything copied here more than a week ago. `ingest` stamps every copy
/// with the time it landed, so this really is the age of the copy and not the
/// age of whatever the user happened to drag in.
fn sweep(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let now = SystemTime::now();
    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else { continue };
        let Ok(copied) = meta.modified() else { continue };
        if now.duration_since(copied).map(|age| age > KEEP_FOR).unwrap_or(false) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ingest_copies_and_never_overwrites() {
        let tmp = std::env::temp_dir().join(format!("buddybara-test-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let source = tmp.join("note.txt");
        std::fs::write(&source, b"hello").unwrap();

        let drop = |p: &Path| allow_dropped([p.to_string_lossy().to_string()]);
        drop(&source);
        let first = ingest(source.to_str().unwrap()).unwrap();
        assert_eq!(first.name, "note.txt");
        assert_eq!(std::fs::read(&first.path).unwrap(), b"hello");

        // A second drop of the same name must not clobber the first copy.
        std::fs::write(&source, b"second").unwrap();
        drop(&source);
        let second = ingest(source.to_str().unwrap()).unwrap();
        assert_ne!(first.path, second.path);
        assert_eq!(std::fs::read(&first.path).unwrap(), b"hello");
        assert_eq!(std::fs::read(&second.path).unwrap(), b"second");

        // Folders are refused rather than silently ignored.
        drop(&tmp);
        assert!(ingest(tmp.to_str().unwrap()).is_err());

        // An ancient source must not arrive already older than the sweep window.
        let old_source = tmp.join("ancient.txt");
        std::fs::write(&old_source, b"old").unwrap();
        let long_ago = SystemTime::now() - KEEP_FOR - Duration::from_secs(60 * 60);
        std::fs::File::options()
            .write(true)
            .open(&old_source)
            .unwrap()
            .set_modified(long_ago)
            .unwrap();
        drop(&old_source);
        let aged = ingest(old_source.to_str().unwrap()).unwrap();
        assert!(
            Path::new(&aged.path).exists(),
            "a file copied just now was swept as if it were a week old"
        );
        let _ = std::fs::remove_file(&aged.path);

        let _ = std::fs::remove_file(&first.path);
        let _ = std::fs::remove_file(&second.path);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn a_pasted_file_lands_in_the_inbox_under_a_plain_name() {
        assert_eq!(pasted_name("Screenshot 2026-10-14 (1).png"), "Screenshot 2026-10-14 (1).png");
        assert_eq!(pasted_name(r"..\..\evil:name?.png"), "evilname.png");
        assert_eq!(pasted_name(".hidden.png"), "hidden.png");
        assert_eq!(pasted_name("notes. . "), "notes");
        assert_eq!(pasted_name("NUL.png"), "pasted");
        assert_eq!(pasted_name("///"), "pasted");
        assert!(is_device_name("com3.txt") && is_device_name("CON") && !is_device_name("console.log"));

        let tag = std::process::id();
        let saved = save_pasted(&format!("clip-{tag}.png"), b"\x89PNG").unwrap();
        assert_eq!(Path::new(&saved.path).parent(), Some(inbox_dir().as_path()));
        assert_eq!(std::fs::read(&saved.path).unwrap(), b"\x89PNG");
        assert!(save_pasted("empty.png", b"").is_err());

        // The inbox's own files may be attached to a prompt; nothing else may.
        assert_eq!(attachments(&[saved.path.clone()]).unwrap(), vec![PathBuf::from(&saved.path)]);
        let outside = std::env::temp_dir().join(format!("buddybara-outside-{tag}.txt"));
        std::fs::write(&outside, b"x").unwrap();
        assert!(attachments(&[outside.to_string_lossy().into_owned()]).is_err());
        assert!(attachments(&[inbox_dir().to_string_lossy().into_owned()]).is_err(), "a folder");
        assert!(attachments(&[inbox_dir().join("never-there.png").to_string_lossy().into_owned()]).is_err());
        assert!(attachments(&vec![saved.path.clone(); MAX_ATTACHMENTS + 1]).is_err());

        let _ = std::fs::remove_file(&saved.path);
        let _ = std::fs::remove_file(&outside);
    }
}

#[cfg(test)]
mod drop_tests {
    use super::*;

    // One test: the list is process-wide and tests run in parallel.
    #[test]
    fn only_a_dropped_path_is_ingested_once_and_the_list_stays_bounded() {
        let p = "/tmp/buddybara-test-not-dropped.txt".to_string();
        assert!(ingest(&p).is_err(), "never dropped");
        allow_dropped([p.clone()]);
        assert!(take_dropped(&p));
        assert!(!take_dropped(&p), "good once");

        allow_dropped((0..200).map(|i| format!("/tmp/bounded-{i}")));
        assert!(DROPPED.lock().unwrap().len() <= DROP_MAX_PENDING);
        assert!(take_dropped("/tmp/bounded-199"));
        assert!(!take_dropped("/tmp/bounded-0"));
    }
}
