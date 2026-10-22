// The relay runs on PCs that may not have the Visual C++ runtime: it is linked
// in, as tauri-build does for the app. The Universal CRT stays a DLL, it ships
// with Windows 10 and later.
//
// It also carries file details and the app's icon, as the app does: Claude
// Code runs it on every event, and an unsigned exe with no name, no publisher
// and no description is exactly what antivirus scanners distrust most.
fn main() {
    let msvc = std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc");
    if !msvc {
        return;
    }
    for lib in ["libvcruntimed.lib", "vcruntime.lib", "vcruntimed.lib", "libcmtd.lib", "msvcrt.lib", "msvcrtd.lib", "libucrt.lib", "libucrtd.lib"] {
        println!("cargo:rustc-link-arg=/NODEFAULTLIB:{lib}");
    }
    for lib in ["libcmt.lib", "libvcruntime.lib", "ucrt.lib"] {
        println!("cargo:rustc-link-arg=/DEFAULTLIB:{lib}");
    }
    #[cfg(windows)]
    {
        println!("cargo:rerun-if-changed=../src-tauri/icons/icon.ico");
        let mut res = tauri_winres::WindowsResource::new();
        res.set_icon("../src-tauri/icons/icon.ico")
            .set("FileDescription", "Buddybara hook relay")
            .set("ProductName", "Buddybara")
            .set("CompanyName", "Yuri Kotoman")
            .set("LegalCopyright", "© Yuri Kotoman")
            .set("InternalName", "buddybara-hook")
            .set("OriginalFilename", "buddybara-hook.exe");
        res.compile().expect("could not compile the relay's file details");
    }
}
