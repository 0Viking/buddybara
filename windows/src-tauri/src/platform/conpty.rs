// A real terminal for the buddy panel (terminal.rs): a program run inside a
// Windows pseudo console (ConPTY), its screen read and its keys written as
// the VT text xterm.js draws and types. The same thing a terminal app does,
// with the `windows` crate the app already has (no PTY crate).

use std::ffi::{c_void, OsString};
use std::io;
use std::os::windows::ffi::OsStrExt;
use std::path::Path;

use ::windows::core::{PCWSTR, PWSTR};
use ::windows::Win32::Foundation::{CloseHandle, HANDLE};
use ::windows::Win32::Storage::FileSystem::{ReadFile, WriteFile};
use ::windows::Win32::System::Console::{ClosePseudoConsole, CreatePseudoConsole, ResizePseudoConsole, COORD, HPCON};
use ::windows::Win32::System::Pipes::CreatePipe;
use ::windows::Win32::System::Threading::{
    CreateProcessW, DeleteProcThreadAttributeList, GetExitCodeProcess, InitializeProcThreadAttributeList,
    TerminateProcess, UpdateProcThreadAttribute, WaitForSingleObject, CREATE_UNICODE_ENVIRONMENT,
    EXTENDED_STARTUPINFO_PRESENT, INFINITE,
    LPPROC_THREAD_ATTRIBUTE_LIST, PROCESS_INFORMATION, PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, STARTUPINFOEXW,
};

/// A handle the threads of one terminal share. Every one is closed once, by
/// whoever owns it last (`Pty::finish`, `PtyReader`'s drop).
#[derive(Clone, Copy)]
struct Raw(HANDLE);
unsafe impl Send for Raw {}
unsafe impl Sync for Raw {}

/// The running program and its console: keys in, size, stop, wait.
pub struct Pty {
    console: isize,
    input: Raw,
    process: Raw,
}

/// Its screen, as VT bytes, until the console is closed.
pub struct PtyReader(Raw);

impl Pty {
    /// Starts `exe args…` in `cwd` inside a new console of `cols`×`rows`, with
    /// this app's environment plus `env`.
    pub fn spawn(
        exe: &Path,
        args: &[String],
        cwd: &Path,
        cols: u16,
        rows: u16,
        env: &[(&str, String)],
    ) -> Result<(Pty, PtyReader), String> {
        spawn(exe, args, cwd, cols, rows, env).map_err(|e| format!("Could not start the terminal: {e}"))
    }

    pub fn write(&self, bytes: &[u8]) -> io::Result<()> {
        let mut rest = bytes;
        while !rest.is_empty() {
            let mut done = 0u32;
            unsafe { WriteFile(self.input.0, Some(rest), Some(&mut done as *mut u32), None) }.map_err(io::Error::other)?;
            rest = &rest[done as usize..];
        }
        Ok(())
    }

    pub fn resize(&self, cols: u16, rows: u16) {
        let _ = unsafe { ResizePseudoConsole(HPCON(self.console), size(cols, rows)) };
    }

    pub fn kill(&self) {
        let _ = unsafe { TerminateProcess(self.process.0, 1) };
    }

    /// Blocks until the program ends; its exit code.
    pub fn wait(&self) -> u32 {
        let mut code = 0u32;
        unsafe {
            WaitForSingleObject(self.process.0, INFINITE);
            let _ = GetExitCodeProcess(self.process.0, &mut code);
        }
        code
    }

    /// After `wait`: the console goes, which ends the reader's stream too.
    pub fn finish(&self) {
        unsafe {
            ClosePseudoConsole(HPCON(self.console));
            let _ = CloseHandle(self.input.0);
            let _ = CloseHandle(self.process.0);
        }
    }
}

impl io::Read for PtyReader {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let mut n = 0u32;
        // The console closed: a broken pipe, which is the end of its screen.
        match unsafe { ReadFile(self.0 .0, Some(buf), Some(&mut n as *mut u32), None) } {
            Ok(()) => Ok(n as usize),
            Err(_) => Ok(0),
        }
    }
}

impl Drop for PtyReader {
    fn drop(&mut self) {
        let _ = unsafe { CloseHandle(self.0 .0) };
    }
}

fn size(cols: u16, rows: u16) -> COORD {
    COORD { X: cols.clamp(10, 500) as i16, Y: rows.clamp(4, 300) as i16 }
}

/// One argument as CommandLineToArgvW reads it back.
fn quote(arg: &str) -> String {
    if !arg.is_empty() && !arg.contains([' ', '\t', '"']) {
        return arg.to_string();
    }
    let mut out = String::from("\"");
    let mut slashes = 0;
    for c in arg.chars() {
        match c {
            '\\' => slashes += 1,
            '"' => {
                out.push_str(&"\\".repeat(slashes * 2 + 1));
                out.push('"');
                slashes = 0;
            }
            _ => {
                out.push_str(&"\\".repeat(slashes));
                out.push(c);
                slashes = 0;
            }
        }
    }
    out.push_str(&"\\".repeat(slashes * 2));
    out.push('"');
    out
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// `NAME=value\0…\0\0` in UTF-16: this process's variables with `extra` on top,
/// sorted by name as Windows asks of an environment block.
fn environment_block(extra: &[(&str, String)]) -> Vec<u16> {
    let mut vars: Vec<(OsString, OsString)> = std::env::vars_os()
        .filter(|(name, _)| !extra.iter().any(|(e, _)| name.to_string_lossy().eq_ignore_ascii_case(e)))
        .collect();
    vars.extend(extra.iter().map(|(name, value)| (OsString::from(name), OsString::from(value))));
    vars.sort_by_key(|(name, _)| name.to_string_lossy().to_uppercase());
    let mut block = Vec::new();
    for (name, value) in &vars {
        block.extend(name.encode_wide());
        block.push(u16::from(b'='));
        block.extend(value.encode_wide());
        block.push(0);
    }
    block.push(0);
    block
}

fn spawn(
    exe: &Path,
    args: &[String],
    cwd: &Path,
    cols: u16,
    rows: u16,
    env: &[(&str, String)],
) -> ::windows::core::Result<(Pty, PtyReader)> {
    // Two pipes: what we type goes in one end of the first, the screen comes
    // out of the second. The console keeps its own copies of its ends.
    let (mut in_read, mut in_write, mut out_read, mut out_write) =
        (HANDLE::default(), HANDLE::default(), HANDLE::default(), HANDLE::default());
    unsafe {
        CreatePipe(&mut in_read, &mut in_write, None, 0)?;
        CreatePipe(&mut out_read, &mut out_write, None, 0)?;
    }
    let console = unsafe { CreatePseudoConsole(size(cols, rows), in_read, out_write, 0) };
    unsafe {
        let _ = CloseHandle(in_read);
        let _ = CloseHandle(out_write);
    }
    let console = match console {
        Ok(c) => c,
        Err(e) => {
            unsafe {
                let _ = CloseHandle(in_write);
                let _ = CloseHandle(out_read);
            }
            return Err(e);
        }
    };
    let fail = |e: ::windows::core::Error| {
        unsafe {
            ClosePseudoConsole(console);
            let _ = CloseHandle(in_write);
            let _ = CloseHandle(out_read);
        }
        e
    };

    // The program is started attached to that console, and to nothing of ours.
    let mut bytes = 0usize;
    let _ = unsafe { InitializeProcThreadAttributeList(None, 1, None, &mut bytes) };
    let mut list_buf = vec![0u8; bytes.max(1)];
    let list = LPPROC_THREAD_ATTRIBUTE_LIST(list_buf.as_mut_ptr() as *mut c_void);
    unsafe { InitializeProcThreadAttributeList(Some(list), 1, None, &mut bytes) }.map_err(fail)?;
    let attached = unsafe {
        UpdateProcThreadAttribute(
            list,
            0,
            PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE as usize,
            Some(console.0 as *const c_void),
            std::mem::size_of::<HPCON>(),
            None,
            None,
        )
    };
    if let Err(e) = attached {
        unsafe { DeleteProcThreadAttributeList(list) };
        return Err(fail(e));
    }
    let mut info = STARTUPINFOEXW::default();
    info.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
    info.lpAttributeList = list;

    let line = std::iter::once(quote(&exe.to_string_lossy()))
        .chain(args.iter().map(|a| quote(a)))
        .collect::<Vec<_>>()
        .join(" ");
    let mut line = wide(&line);
    let dir = wide(&cwd.to_string_lossy());
    // Nothing to add: the process simply inherits this one's environment.
    let block = (!env.is_empty()).then(|| environment_block(env));
    let flags = if block.is_some() {
        EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT
    } else {
        EXTENDED_STARTUPINFO_PRESENT
    };
    let mut process = PROCESS_INFORMATION::default();
    let started = unsafe {
        CreateProcessW(
            PCWSTR::null(),
            Some(PWSTR(line.as_mut_ptr())),
            None,
            None,
            false,
            flags,
            block.as_ref().map(|b| b.as_ptr() as *const c_void),
            PCWSTR(dir.as_ptr()),
            &info.StartupInfo,
            &mut process,
        )
    };
    unsafe { DeleteProcThreadAttributeList(list) };
    drop(list_buf);
    started.map_err(fail)?;
    unsafe {
        let _ = CloseHandle(process.hThread);
    }
    Ok((
        Pty { console: console.0, input: Raw(in_write), process: Raw(process.hProcess) },
        PtyReader(Raw(out_read)),
    ))
}

#[cfg(test)]
mod tests {
    use super::quote;

    #[test]
    fn arguments_reach_the_program_as_they_were() {
        assert_eq!(quote("--resume"), "--resume");
        assert_eq!(quote(r"C:\Users\me\.local\bin\claude.exe"), r"C:\Users\me\.local\bin\claude.exe");
        assert_eq!(quote(r"C:\Program Files\x\claude.exe"), r#""C:\Program Files\x\claude.exe""#);
        assert_eq!(quote(r#"a "b""#), r#""a \"b\"""#);
        assert_eq!(quote(r"dir with space\"), r#""dir with space\\""#);
        assert_eq!(quote(""), r#""""#);
    }
}
