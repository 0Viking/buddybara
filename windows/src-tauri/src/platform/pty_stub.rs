// The buddy's terminal (terminal.rs) exists on Windows only for now (conpty.rs).
// Same names here, so the rest of the app builds everywhere.

use std::io;
use std::path::Path;

pub struct Pty;

pub struct PtyReader;

impl Pty {
    pub fn spawn(
        _exe: &Path,
        _args: &[String],
        _cwd: &Path,
        _cols: u16,
        _rows: u16,
        _env: &[(&str, String)],
    ) -> Result<(Pty, PtyReader), String> {
        Err("The terminal is only on Windows for now.".into())
    }

    pub fn write(&self, _bytes: &[u8]) -> io::Result<()> {
        Ok(())
    }

    pub fn resize(&self, _cols: u16, _rows: u16) {}

    pub fn kill(&self) {}

    pub fn wait(&self) -> u32 {
        0
    }

    pub fn finish(&self) {}
}

impl io::Read for PtyReader {
    fn read(&mut self, _buf: &mut [u8]) -> io::Result<usize> {
        Ok(0)
    }
}
