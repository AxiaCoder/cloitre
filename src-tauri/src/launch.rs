use std::path::{Path, PathBuf};

use portable_pty::CommandBuilder;

use crate::error::AppError;

/// Environment variables set on every `claude` session, on top of the inherited ones.
pub const SESSION_ENV: [(&str, &str); 2] = [("TERM", "xterm-256color"), ("COLORTERM", "truecolor")];

/// Finds the `claude` executable on the `PATH` of the app process.
///
/// # Errors
/// [`AppError::ClaudeNotFound`] when no executable is found.
pub fn resolve_claude() -> Result<PathBuf, AppError> {
    which::which("claude").map_err(|_| AppError::ClaudeNotFound)
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
    use std::ffi::OsStr;

    use super::*;

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
