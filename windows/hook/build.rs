// The relay runs on PCs that may not have the Visual C++ runtime: it is linked
// in, as tauri-build does for the app. The Universal CRT stays a DLL, it ships
// with Windows 10 and later.
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
}
