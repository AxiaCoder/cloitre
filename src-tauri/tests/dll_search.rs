//! Checks which `conpty.dll` a process opening a pseudo-terminal loads once
//! `restrict_dll_search` has run.
//!
//! portable-pty loads `conpty.dll` by bare name, once per process, at the first
//! `openpty`. Each case therefore copies this test executable into a fresh folder
//! and reruns it there as the host, with the current folder chosen by the case;
//! the host reports the file `conpty.dll` was loaded from.
#![cfg(windows)]

use std::ffi::{OsString, c_void};
use std::os::windows::ffi::{OsStrExt, OsStringExt};
use std::path::{Path, PathBuf};
use std::process::Command;

use portable_pty::{PtySize, native_pty_system};

/// Environment variable telling a rerun of this executable to act as the host,
/// and whether to restrict the DLL search first (`restricted` or `unrestricted`).
const ROLE: &str = "CLOITRE_DLL_SEARCH_TEST_ROLE";

/// Marker after which the host prints where `conpty.dll` came from.
const LOADED_PREFIX: &str = "loaded conpty: ";

/// What the host prints after the prefix when `conpty.dll` is not loaded.
const NOT_LOADED: &str = "none";

#[link(name = "kernel32")]
unsafe extern "system" {
    fn GetModuleHandleW(name: *const u16) -> *mut c_void;
    fn GetModuleFileNameW(module: *mut c_void, buffer: *mut u16, size: u32) -> u32;
}

/// Folder holding the vendored `conpty.dll` and `x64/OpenConsole.exe`.
fn vendored_conpty() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../vendor/conpty")
}

/// Copies the vendored `conpty.dll` and `x64/OpenConsole.exe` into `folder`.
fn copy_vendored_conpty(folder: &Path) {
    std::fs::create_dir(folder.join("x64")).unwrap();
    for name in ["conpty.dll", "x64/OpenConsole.exe"] {
        std::fs::copy(vendored_conpty().join(name), folder.join(name)).unwrap();
    }
}

/// Returns the file `conpty.dll` was loaded from in this process, or `None`
/// when it is not loaded.
fn loaded_conpty() -> Option<PathBuf> {
    let name: Vec<u16> = std::ffi::OsStr::new("conpty.dll")
        .encode_wide()
        .chain([0])
        .collect();
    let mut buffer = [0u16; 1024];
    // SAFETY: `name` is NUL-terminated and `buffer` holds the size passed.
    let length = unsafe {
        let module = GetModuleHandleW(name.as_ptr());
        if module.is_null() {
            return None;
        }
        GetModuleFileNameW(module, buffer.as_mut_ptr(), buffer.len() as u32)
    };
    Some(PathBuf::from(OsString::from_wide(
        &buffer[..length as usize],
    )))
}

/// Restricts the DLL search when `restricted`, opens a pseudo-terminal, and
/// prints where `conpty.dll` was loaded from. Panics when `openpty` fails.
fn host(restricted: bool) {
    if restricted {
        cloitre_lib::restrict_dll_search().unwrap();
    }
    native_pty_system()
        .openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })
        .expect("openpty failed");
    let loaded =
        loaded_conpty().map_or_else(|| NOT_LOADED.to_owned(), |path| path.display().to_string());
    println!("{LOADED_PREFIX}{loaded}");
}

/// Copies this executable into `host_folder`, runs the copy as the host of
/// `test_name` from `current_dir`, and returns where it loaded `conpty.dll`
/// from (`None` when not loaded). Panics when the host fails.
fn run_host(
    test_name: &str,
    role: &str,
    host_folder: &Path,
    current_dir: &Path,
) -> Option<PathBuf> {
    let host_exe = host_folder.join("dll-search-host.exe");
    std::fs::copy(std::env::current_exe().unwrap(), &host_exe).unwrap();
    let output = Command::new(&host_exe)
        .args([test_name, "--exact", "--nocapture", "--test-threads=1"])
        .current_dir(current_dir)
        .env(ROLE, role)
        .output()
        .unwrap();
    let printed = String::from_utf8_lossy(&output.stdout);
    assert!(
        output.status.success() && printed.contains("test result: ok. 1 passed"),
        "host failed:\n{printed}{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let loaded = printed
        .lines()
        .find_map(|line| line.split_once(LOADED_PREFIX).map(|(_, path)| path.trim()))
        .unwrap_or_else(|| panic!("host printed no loaded conpty line:\n{printed}"));
    (loaded != NOT_LOADED).then(|| std::fs::canonicalize(loaded).unwrap())
}

/// Runs the host role when this process is a rerun, and returns `true` then.
fn ran_as_host() -> bool {
    match std::env::var(ROLE).as_deref() {
        Ok("restricted") => host(true),
        Ok("unrestricted") => host(false),
        _ => return false,
    }
    true
}

#[test]
fn restricted_search_ignores_a_conpty_dll_in_the_current_folder() {
    if ran_as_host() {
        return;
    }
    let host_folder = tempfile::tempdir().unwrap();
    let current_dir = tempfile::tempdir().unwrap();
    copy_vendored_conpty(current_dir.path());

    let loaded = run_host(
        "restricted_search_ignores_a_conpty_dll_in_the_current_folder",
        "restricted",
        host_folder.path(),
        current_dir.path(),
    );

    assert_eq!(loaded, None);
}

#[test]
fn unrestricted_search_loads_the_conpty_dll_of_the_current_folder() {
    if ran_as_host() {
        return;
    }
    let host_folder = tempfile::tempdir().unwrap();
    let current_dir = tempfile::tempdir().unwrap();
    copy_vendored_conpty(current_dir.path());

    let loaded = run_host(
        "unrestricted_search_loads_the_conpty_dll_of_the_current_folder",
        "unrestricted",
        host_folder.path(),
        current_dir.path(),
    );

    let expected = std::fs::canonicalize(current_dir.path().join("conpty.dll")).unwrap();
    assert_eq!(loaded, Some(expected));
}

#[test]
fn restricted_search_still_loads_the_conpty_dll_next_to_the_executable() {
    if ran_as_host() {
        return;
    }
    let host_folder = tempfile::tempdir().unwrap();
    copy_vendored_conpty(host_folder.path());

    let loaded = run_host(
        "restricted_search_still_loads_the_conpty_dll_next_to_the_executable",
        "restricted",
        host_folder.path(),
        host_folder.path(),
    );

    let expected = std::fs::canonicalize(host_folder.path().join("conpty.dll")).unwrap();
    assert_eq!(loaded, Some(expected));
}
