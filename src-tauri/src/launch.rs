#[cfg(windows)]
mod windows;

use std::env;
use std::ffi::OsStr;
use std::path::{Path, PathBuf};

use portable_pty::CommandBuilder;

use crate::error::AppError;

/// Environment variables set on every `claude` session, on top of the inherited ones.
pub const SESSION_ENV: [(&str, &str); 2] = [("TERM", "xterm-256color"), ("COLORTERM", "truecolor")];

/// Finds the `claude` executable: first on the `path` list (a `PATH` value),
/// then at the first of `fallbacks` that is an existing file, in order.
///
/// On Windows the `PATH` lookup only accepts names with a `PATHEXT` extension
/// (`claude.exe`, `claude.cmd`…), never the extensionless shell script npm
/// installs next to them. `None` skips the `PATH` lookup.
///
/// # Errors
/// [`AppError::ClaudeNotFound`] with `fallbacks` when nothing is found.
pub fn find_claude(path: Option<&OsStr>, fallbacks: &[PathBuf]) -> Result<PathBuf, AppError> {
    let on_path = path.and_then(|path| which::which_in_global("claude", Some(path)).ok()?.next());
    on_path
        .or_else(|| {
            fallbacks
                .iter()
                .find(|candidate| candidate.is_file())
                .cloned()
        })
        .ok_or_else(|| AppError::ClaudeNotFound(fallbacks.to_vec()))
}

/// Lists where the official installers put `claude`, in the order they are tried
/// after the `PATH`.
///
/// On Windows: the native installer (`%USERPROFILE%\.local\bin\claude.exe`), then
/// a global npm install (`%APPDATA%\npm\claude.cmd`). Elsewhere:
/// `$HOME/.local/bin/claude`. A variable that is unset or not an absolute path
/// adds no location.
pub fn install_locations() -> Vec<PathBuf> {
    #[cfg(windows)]
    {
        windows::install_locations(env::var_os("USERPROFILE"), env::var_os("APPDATA"))
    }
    #[cfg(not(windows))]
    {
        env::var_os("HOME")
            .map(PathBuf::from)
            .filter(|home| home.is_absolute())
            .map(|home| home.join(".local").join("bin").join("claude"))
            .into_iter()
            .collect()
    }
}

/// Finds the `claude` executable with the app's own `PATH`, then at
/// [`install_locations`], so an app started from the desktop, whose `PATH` may
/// lack the folder of `claude`, still finds it.
///
/// # Errors
/// [`AppError::ClaudeNotFound`] with every location tried after the `PATH`.
pub fn resolve_claude() -> Result<PathBuf, AppError> {
    find_claude(env::var_os("PATH").as_deref(), &install_locations())
}

/// Builds the command line of a new `claude` session in `folder`.
///
/// The command is `program` with no argument at all: nothing coming from the
/// webview reaches the argument list. The caller must pass a folder already
/// checked by [`crate::folder::validate_folder`].
pub fn claude_command(program: &Path, folder: &Path) -> CommandBuilder {
    let mut command = CommandBuilder::new(program);
    command.cwd(folder);
    for (key, value) in SESSION_ENV {
        command.env(key, value);
    }
    command
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;

    /// File name of a fake `claude` the `PATH` lookup accepts on this system.
    const FAKE_NAME: &str = if cfg!(windows) {
        "claude.exe"
    } else {
        "claude"
    };

    /// Creates an empty file at `path` the `PATH` lookup takes for an executable.
    fn fake_executable(path: &Path) {
        fs::write(path, b"").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
        }
    }

    #[test]
    fn path_wins_over_fallbacks() {
        let on_path = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        let expected = on_path.path().join(FAKE_NAME);
        fake_executable(&expected);
        let fallback = other.path().join(FAKE_NAME);
        fake_executable(&fallback);
        let found = find_claude(Some(on_path.path().as_os_str()), &[fallback]).unwrap();
        assert_eq!(found, expected);
    }

    #[test]
    fn first_existing_fallback_wins() {
        let empty_path = tempfile::tempdir().unwrap();
        let first = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        let missing = first.path().join("missing").join(FAKE_NAME);
        let expected = first.path().join(FAKE_NAME);
        fake_executable(&expected);
        let later = second.path().join("claude.cmd");
        fake_executable(&later);
        let found = find_claude(
            Some(empty_path.path().as_os_str()),
            &[missing, expected.clone(), later],
        )
        .unwrap();
        assert_eq!(found, expected);
    }

    #[test]
    fn fallback_is_used_without_a_path() {
        let folder = tempfile::tempdir().unwrap();
        let expected = folder.path().join(FAKE_NAME);
        fake_executable(&expected);
        assert_eq!(
            find_claude(None, std::slice::from_ref(&expected)),
            Ok(expected)
        );
    }

    #[test]
    fn nothing_found_lists_every_location_tried() {
        let empty_path = tempfile::tempdir().unwrap();
        let first = empty_path.path().join("a").join(FAKE_NAME);
        let second = empty_path.path().join("b").join("claude.cmd");
        let error = find_claude(
            Some(empty_path.path().as_os_str()),
            &[first.clone(), second.clone()],
        )
        .unwrap_err();
        assert_eq!(error, AppError::ClaudeNotFound(vec![first, second]));
    }

    #[cfg(windows)]
    #[test]
    fn path_lookup_skips_the_extensionless_npm_script() {
        let on_path = tempfile::tempdir().unwrap();
        fs::write(
            on_path.path().join("claude"),
            b"#!/bin/sh
",
        )
        .unwrap();
        let expected = on_path.path().join("claude.cmd");
        fake_executable(&expected);
        let found = find_claude(Some(on_path.path().as_os_str()), &[]).unwrap();
        assert_eq!(found, expected);
    }

    /// Builds a command for a fixed program and folder that need not exist.
    fn sample_command() -> CommandBuilder {
        claude_command(
            Path::new("/opt/tools/claude"),
            Path::new("/projects/example"),
        )
    }

    #[test]
    fn has_no_argument() {
        let command = sample_command();
        assert_eq!(command.get_argv().len(), 1);
        assert_eq!(command.get_argv()[0], OsStr::new("/opt/tools/claude"));
    }

    #[test]
    fn starts_in_the_folder() {
        let command = sample_command();
        assert_eq!(
            command.get_cwd().map(|cwd| cwd.as_os_str()),
            Some(OsStr::new("/projects/example"))
        );
    }

    #[test]
    fn sets_the_terminal_variables() {
        let command = sample_command();
        assert_eq!(command.get_env("TERM"), Some(OsStr::new("xterm-256color")));
        assert_eq!(command.get_env("COLORTERM"), Some(OsStr::new("truecolor")));
    }
}
