// The desktop Buddybara's own picture, chosen in Settings → Customization: it
// takes the capybara's place (src/buddybara/engine.ts), the plan usage and the
// work badges drawn over it. The page has already scaled it down and made it
// a PNG; it is kept beside settings.json and read back by every window that
// draws him. `skin-changed` tells them it changed.
//
// The pictures to pick from (the tiles under "Choose image…") are the PNGs of
// the skins folder beside it, and those an edition of the app ships in a
// `skins` folder of its own (bundle resources: see scripts/pack.mjs
// --edition). The plain app ships none.

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

/// More than any picture scaled for him needs.
const MAX_BYTES: usize = 4 * 1024 * 1024;
const PNG: &[u8] = b"\x89PNG\r\n\x1a\n";
/// At most this many tiles, and none for a picture past this size (the page
/// scales a big one down, but not a huge one).
const MAX_LIBRARY: usize = 200;
const MAX_LIBRARY_BYTES: u64 = 16 * 1024 * 1024;

fn path() -> PathBuf {
    crate::settings::config_dir().join("skin.png")
}

/// The user's skins folder: Settings opens it for them to add pictures.
fn library_dir() -> PathBuf {
    crate::settings::config_dir().join("skins")
}

/// The skins the app was installed with, beside its exe.
fn bundled_dir(app: &AppHandle) -> Option<PathBuf> {
    app.path().resource_dir().ok().map(|dir| dir.join("skins"))
}

/// What a file of a skins folder shows as: its name without ".png" (any
/// case), or None when it is not a PNG.
fn library_name(file: &str) -> Option<String> {
    let (stem, ext) = file.rsplit_once('.')?;
    (ext.eq_ignore_ascii_case("png") && !stem.is_empty()).then(|| stem.to_string())
}

/// A folder's PNGs, by the name they show as.
fn pngs(dir: &Path) -> Vec<(String, PathBuf)> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    entries
        .filter_map(Result::ok)
        .filter(|e| e.metadata().is_ok_and(|m| m.is_file() && m.len() <= MAX_LIBRARY_BYTES))
        .filter_map(|e| Some((library_name(&e.file_name().to_string_lossy())?, e.path())))
        .collect()
}

/// `mine` and `bundled` together, sorted the way people read them (case
/// aside): a picture of the user's own wins over a bundled one of the same name.
fn merged(mut mine: Vec<(String, PathBuf)>, bundled: Vec<(String, PathBuf)>) -> Vec<(String, PathBuf)> {
    for (name, file) in bundled {
        if !mine.iter().any(|(n, _)| n.eq_ignore_ascii_case(&name)) {
            mine.push((name, file));
        }
    }
    mine.sort_by_key(|(name, _)| name.to_lowercase());
    mine.truncate(MAX_LIBRARY);
    mine
}

/// Every picture to pick from: the user's, then the app's own.
fn library(app: &AppHandle) -> Vec<(String, PathBuf)> {
    merged(pngs(&library_dir()), bundled_dir(app).map(|dir| pngs(&dir)).unwrap_or_default())
}

#[derive(Serialize)]
pub struct SkinLibrary {
    /// Where they are: Settings opens it for the user to add some.
    dir: String,
    names: Vec<String>,
}

/// The pictures to pick from, by name.
#[tauri::command]
pub fn skin_library(app: AppHandle) -> SkinLibrary {
    SkinLibrary {
        dir: library_dir().to_string_lossy().into_owned(),
        names: library(&app).into_iter().map(|(name, _)| name).collect(),
    }
}

/// One of them, by a name `skin_library` gave: never a path, only what the
/// folders hold. Empty when there is no such picture (any more).
#[tauri::command]
pub fn skin_library_get(app: AppHandle, name: String) -> tauri::ipc::Response {
    let bytes = library(&app)
        .into_iter()
        .find(|(n, _)| *n == name)
        .and_then(|(_, file)| std::fs::read(file).ok())
        .unwrap_or_default();
    tauri::ipc::Response::new(bytes)
}

/// The skins folder in the file manager, made first if it isn't there yet.
#[tauri::command]
pub fn skin_library_open() -> Result<(), String> {
    let dir = library_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    crate::platform::open_folder(&dir);
    Ok(())
}

/// The picture is the request body.
#[tauri::command]
pub async fn skin_save(app: AppHandle, request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("no picture".into());
    };
    check(bytes)?;
    let dir = crate::settings::config_dir();
    crate::platform::ensure_private_dir(&dir).map_err(|e| e.to_string())?;
    let temp = dir.join("skin.png.tmp");
    std::fs::write(&temp, bytes)
        .and_then(|()| std::fs::rename(&temp, path()))
        .map_err(|e| {
            let _ = std::fs::remove_file(&temp);
            e.to_string()
        })?;
    let _ = app.emit("skin-changed", ());
    Ok(())
}

/// Back to the capybara.
#[tauri::command]
pub fn skin_remove(app: AppHandle) -> Result<(), String> {
    match std::fs::remove_file(path()) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.to_string()),
    }
    let _ = app.emit("skin-changed", ());
    Ok(())
}

/// The picture's bytes, none when he is the capybara.
#[tauri::command]
pub fn skin_get() -> tauri::ipc::Response {
    tauri::ipc::Response::new(std::fs::read(path()).unwrap_or_default())
}

fn check(bytes: &[u8]) -> Result<(), String> {
    if !bytes.starts_with(PNG) {
        return Err("not a PNG picture".into());
    }
    if bytes.len() > MAX_BYTES {
        return Err("the picture is too big".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_png_of_a_sensible_size_is_kept() {
        let png = [PNG, b"rest of it"].concat();
        assert!(check(&png).is_ok());
        assert!(check(b"GIF89a....").is_err());
        assert!(check(&[]).is_err());
        let huge = [PNG, &vec![0u8; MAX_BYTES]].concat();
        assert!(check(&huge).is_err());
    }

    #[test]
    fn a_picture_of_the_skins_folder_shows_as_its_name_and_nothing_else_shows() {
        assert_eq!(library_name("Mochi.png").as_deref(), Some("Mochi"));
        assert_eq!(library_name("Night Owl.PNG").as_deref(), Some("Night Owl"));
        assert_eq!(library_name("8-Bit Friend.png").as_deref(), Some("8-Bit Friend"));
        assert_eq!(library_name("a.b.png").as_deref(), Some("a.b"));
        for not_one in ["notes.txt", "Mochi.jpg", "png", ".png", "Mochi"] {
            assert_eq!(library_name(not_one), None, "{not_one}");
        }
    }

    #[test]
    fn the_users_pictures_and_the_apps_own_show_together_and_the_users_win() {
        let mine = vec![("mochi".to_string(), PathBuf::from("mine/mochi.png")), ("Zed".into(), "mine/Zed.png".into())];
        let bundled = vec![("Mochi".to_string(), PathBuf::from("app/Mochi.png")), ("Lantern".into(), "app/Lantern.png".into())];
        let all = merged(mine, bundled);
        let names: Vec<&str> = all.iter().map(|(n, _)| n.as_str()).collect();
        assert_eq!(names, ["Lantern", "mochi", "Zed"]);
        assert_eq!(all[1].1, PathBuf::from("mine/mochi.png"));
    }
}
