use std::fmt;

use serde::{Serialize, Serializer};

/// Every refusal or failure a command can return to the webview.
///
/// Serialised as its `Display` text, so the webview receives a plain string.
#[derive(Debug, PartialEq, Eq)]
pub enum AppError {
    /// The folder path is not absolute.
    FolderNotAbsolute,
    /// The folder does not exist or cannot be resolved.
    FolderNotFound,
    /// The path exists but is not a directory.
    NotADirectory,
    /// No `claude` executable was found on the `PATH`.
    ClaudeNotFound,
    /// A terminal size had zero columns or zero rows.
    InvalidSize,
    /// No session is registered under this id.
    UnknownPty(u32),
    /// The pseudo-terminal layer failed; carries the underlying message.
    Pty(String),
}

impl fmt::Display for AppError {
    /// Writes the message the webview shows to the user.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::FolderNotAbsolute => write!(f, "the folder path must be absolute"),
            Self::FolderNotFound => write!(f, "the folder does not exist"),
            Self::NotADirectory => write!(f, "the path is not a folder"),
            Self::ClaudeNotFound => write!(f, "claude was not found on the PATH"),
            Self::InvalidSize => write!(f, "the terminal size must be at least 1x1"),
            Self::UnknownPty(id) => write!(f, "no session with id {id}"),
            Self::Pty(message) => write!(f, "pseudo-terminal error: {message}"),
        }
    }
}

impl std::error::Error for AppError {}

impl Serialize for AppError {
    /// Serialises the error as its message string.
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_as_its_message() {
        let json = serde_json::to_string(&AppError::UnknownPty(7)).unwrap();
        assert_eq!(json, "\"no session with id 7\"");
    }
}
