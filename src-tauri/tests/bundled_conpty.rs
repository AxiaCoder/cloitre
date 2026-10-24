//! Runs a pseudo-terminal through the ConPTY release under `vendor/conpty`, the
//! one the Windows build ships next to the executable.
//!
//! portable-pty loads `conpty.dll` once per process, from the executable's folder
//! first, so the test copies its own executable next to the vendored files and
//! reruns itself there: the copy hosts the pseudo-terminal, and a third run of the
//! same executable is the program writing inside it.
#![cfg(windows)]

use std::ffi::{CStr, c_void};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use portable_pty::{CommandBuilder, PtySize, native_pty_system};

/// Environment variable telling a rerun of this executable which part it plays.
const ROLE: &str = "CLOITRE_CONPTY_TEST_ROLE";

/// A composed emoji followed by a cursor move: the system ConPTY rewrites it,
/// the vendored release must not.
const SAMPLE: &str = "\u{1F468}\u{200D}\u{1F4BB}\x1b[1Dx";

/// How long the host waits for the sample to come out of the pseudo-terminal.
const TIMEOUT: Duration = Duration::from_secs(30);

/// Name of the test, as libtest expects it after `--exact`.
const TEST_NAME: &str = "vendored_conpty_passes_a_composed_emoji_through_unchanged";

#[link(name = "kernel32")]
unsafe extern "system" {
    fn GetStdHandle(which: u32) -> *mut c_void;
    fn GetConsoleMode(console: *mut c_void, mode: *mut u32) -> i32;
    fn SetConsoleMode(console: *mut c_void, mode: u32) -> i32;
    fn GetModuleHandleA(name: *const i8) -> *mut c_void;
    fn GetModuleFileNameA(module: *mut c_void, buffer: *mut u8, size: u32) -> u32;
}

/// Folder holding the vendored `conpty.dll` and `x64/OpenConsole.exe`.
fn vendored_conpty() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../vendor/conpty")
}

/// Arguments that make a rerun of this executable run only this test.
fn rerun_args() -> [&'static str; 3] {
    [TEST_NAME, "--exact", "--nocapture"]
}

#[test]
fn vendored_conpty_passes_a_composed_emoji_through_unchanged() {
    match std::env::var(ROLE).as_deref() {
        Ok("writer") => write_sample(),
        Ok("host") => host_writer_in_pseudo_terminal(),
        _ => rerun_next_to_vendored_conpty(),
    }
}

/// Copies this executable next to the vendored ConPTY files and runs the copy
/// as the host, failing when the host fails.
fn rerun_next_to_vendored_conpty() {
    let folder = tempfile::tempdir().unwrap();
    std::fs::create_dir(folder.path().join("x64")).unwrap();
    for name in ["conpty.dll", "x64/OpenConsole.exe"] {
        std::fs::copy(vendored_conpty().join(name), folder.path().join(name)).unwrap();
    }
    let host = folder.path().join("conpty-host.exe");
    std::fs::copy(std::env::current_exe().unwrap(), &host).unwrap();

    let output = Command::new(&host)
        .args(rerun_args())
        .env(ROLE, "host")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "host failed:\n{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

/// Turns on escape sequence processing for the console, as `claude` does at
/// startup, then writes the sample to it.
fn write_sample() {
    const STD_OUTPUT_HANDLE: u32 = -11i32 as u32;
    const ENABLE_VIRTUAL_TERMINAL_PROCESSING: u32 = 0x0004;
    // SAFETY: the handle comes from GetStdHandle and `mode` outlives both calls.
    unsafe {
        let console = GetStdHandle(STD_OUTPUT_HANDLE);
        let mut mode = 0;
        assert_ne!(GetConsoleMode(console, &mut mode), 0, "no console");
        assert_ne!(
            SetConsoleMode(console, mode | ENABLE_VIRTUAL_TERMINAL_PROCESSING),
            0,
            "console refused escape sequence processing"
        );
    }
    let mut stdout = std::io::stdout();
    stdout.write_all(SAMPLE.as_bytes()).unwrap();
    stdout.flush().unwrap();
}

/// Returns the file `conpty.dll` was loaded from in this process, or `None`
/// when it is not loaded.
fn loaded_conpty() -> Option<PathBuf> {
    let name: &CStr = c"conpty.dll";
    let mut buffer = [0u8; 1024];
    // SAFETY: `name` is NUL-terminated and `buffer` holds the size passed.
    let length = unsafe {
        let module = GetModuleHandleA(name.as_ptr());
        if module.is_null() {
            return None;
        }
        GetModuleFileNameA(module, buffer.as_mut_ptr(), buffer.len() as u32)
    };
    Some(PathBuf::from(
        String::from_utf8_lossy(&buffer[..length as usize]).into_owned(),
    ))
}

/// Opens a pseudo-terminal, runs this executable as the writer inside it, and
/// panics unless the ConPTY in use is the copy next to this executable and the
/// sample comes out byte for byte.
fn host_writer_in_pseudo_terminal() {
    let pair = native_pty_system()
        .openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })
        .unwrap();
    let own_folder = std::env::current_exe()
        .unwrap()
        .parent()
        .unwrap()
        .to_owned();
    assert_eq!(loaded_conpty(), Some(own_folder.join("conpty.dll")));

    let mut writer_command = CommandBuilder::new(std::env::current_exe().unwrap());
    writer_command.args(rerun_args());
    writer_command.env(ROLE, "writer");
    let mut child = pair.slave.spawn_command(writer_command).unwrap();
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().unwrap();
    let mut input = pair.master.take_writer().unwrap();
    let (chunks_tx, chunks) = mpsc::channel();
    std::thread::spawn(move || {
        let mut buffer = [0u8; 4096];
        while let Ok(read) = reader.read(&mut buffer) {
            if read == 0 || chunks_tx.send(buffer[..read].to_vec()).is_err() {
                break;
            }
        }
    });

    let deadline = Instant::now() + TIMEOUT;
    let mut seen = Vec::new();
    while !contains(&seen, SAMPLE.as_bytes()) {
        let Some(left) = deadline.checked_duration_since(Instant::now()) else {
            break;
        };
        let Ok(chunk) = chunks.recv_timeout(left) else {
            break;
        };
        if contains(&chunk, b"\x1b[6n") {
            let _ = input.write_all(b"\x1b[1;1R");
        }
        seen.extend_from_slice(&chunk);
    }
    let _ = child.kill();
    assert!(
        contains(&seen, SAMPLE.as_bytes()),
        "sample not passed through unchanged, got {:?}",
        String::from_utf8_lossy(&seen)
    );
}

/// Tells whether `needle` appears in `haystack`.
fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack
        .windows(needle.len())
        .any(|window| window == needle)
}
