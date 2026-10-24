//! Runs `scripts/check-conpty.ps1` against copies of the vendored ConPTY files.
#![cfg(windows)]

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

/// Repository root, one level above the crate.
fn repository() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..")
}

/// Copies `conpty.dll` and `x64/OpenConsole.exe` from `vendor/conpty` into a
/// fresh temporary folder laid out the same way.
fn copy_of_vendored_conpty() -> tempfile::TempDir {
    let folder = tempfile::tempdir().unwrap();
    std::fs::create_dir(folder.path().join("x64")).unwrap();
    for name in ["conpty.dll", "x64/OpenConsole.exe"] {
        std::fs::copy(
            repository().join("vendor/conpty").join(name),
            folder.path().join(name),
        )
        .unwrap();
    }
    folder
}

/// Runs the check script with `-Root root` and returns what it printed and its exit code.
fn check(root: &Path) -> Output {
    Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
        ])
        .arg(repository().join("scripts/check-conpty.ps1"))
        .arg("-Root")
        .arg(root)
        .output()
        .unwrap()
}

/// Returns the standard output of `output` as text.
fn printed(output: &Output) -> String {
    String::from_utf8_lossy(&output.stdout).into_owned()
}

#[test]
fn script_passes_on_the_vendored_files() {
    let folder = copy_of_vendored_conpty();
    let output = check(folder.path());
    assert!(output.status.success(), "{}", printed(&output));
    assert!(printed(&output).contains("conpty check passed"));
}

#[test]
fn script_fails_when_a_file_is_altered() {
    let folder = copy_of_vendored_conpty();
    let dll = folder.path().join("conpty.dll");
    let mut bytes = std::fs::read(&dll).unwrap();
    let middle = bytes.len() / 2;
    bytes[middle] ^= 0xff;
    std::fs::write(&dll, bytes).unwrap();

    let output = check(folder.path());
    assert_eq!(output.status.code(), Some(1), "{}", printed(&output));
    let text = printed(&output);
    assert!(text.contains("conpty.dll: SHA-256 is"), "{text}");
    assert!(
        text.contains("conpty.dll: Authenticode signature is"),
        "{text}"
    );
    assert!(!text.contains("OpenConsole.exe"), "{text}");
}

#[test]
fn script_fails_when_a_file_is_missing() {
    let folder = copy_of_vendored_conpty();
    std::fs::remove_file(folder.path().join("x64/OpenConsole.exe")).unwrap();

    let output = check(folder.path());
    assert_eq!(output.status.code(), Some(1), "{}", printed(&output));
    assert!(printed(&output).contains("x64/OpenConsole.exe: file not found"));
}
