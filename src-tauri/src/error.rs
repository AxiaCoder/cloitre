use std::fmt;
use std::path::PathBuf;

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
    /// No `claude` executable was found, neither on the `PATH` nor at the
    /// install locations it carries, in the order they were tried.
    ClaudeNotFound(Vec<PathBuf>),
    /// The page reloaded while the session was starting: its process was stopped.
    SpawnCancelled,
    /// A terminal size had zero columns or zero rows.
    InvalidSize,
    /// No session is registered under this id.
    UnknownPty(u32),
    /// The pseudo-terminal layer failed; carries the underlying message.
    Pty(String),
    /// A recording name is not a name the app creates.
    InvalidRecordingName,
    /// No recording file has this name.
    UnknownRecording,
    /// Session `id` has no recording, or its recording stopped after a write error.
    NoRecording(u32),
    /// A recording file could not be read; carries the underlying message.
    Recording(String),
}

impl fmt::Display for AppError {
    /// Writes the message the webview shows to the user.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::FolderNotAbsolute => write!(f, "the folder path must be absolute"),
            Self::FolderNotFound => write!(f, "the folder does not exist"),
            Self::NotADirectory => write!(f, "the path is not a folder"),
            Self::ClaudeNotFound(locations) => {
                write!(f, "claude was not found: looked on the PATH")?;
                for (index, location) in locations.iter().enumerate() {
                    let joiner = if index == 0 { ", then in " } else { ", " };
                    write!(f, "{joiner}{}", location.display())?;
                }
                Ok(())
            }
            Self::SpawnCancelled => write!(
                f,
                "the session was stopped because the page reloaded while it was starting"
            ),
            Self::InvalidSize => write!(f, "the terminal size must be at least 1x1"),
            Self::UnknownPty(id) => write!(f, "no session with id {id}"),
            Self::Pty(message) => write!(f, "pseudo-terminal error: {message}"),
            Self::InvalidRecordingName => write!(f, "not a recording name"),
            Self::UnknownRecording => write!(f, "no recording with this name"),
            Self::NoRecording(id) => write!(f, "session {id} is not being recorded"),
            Self::Recording(message) => write!(f, "recording error: {message}"),
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

    #[test]
    fn claude_not_found_lists_every_location_tried() {
        assert_eq!(
            AppError::ClaudeNotFound(vec![]).to_string(),
            "claude was not found: looked on the PATH"
        );
        let locations = vec![PathBuf::from("first"), PathBuf::from("second")];
        assert_eq!(
            AppError::ClaudeNotFound(locations).to_string(),
            "claude was not found: looked on the PATH, then in first, second"
        );
    }

    #[test]
    fn recording_errors_say_what_was_refused() {
        assert_eq!(
            AppError::InvalidRecordingName.to_string(),
            "not a recording name"
        );
        assert_eq!(
            AppError::UnknownRecording.to_string(),
            "no recording with this name"
        );
        assert_eq!(
            AppError::NoRecording(3).to_string(),
            "session 3 is not being recorded"
        );
        assert_eq!(
            AppError::Recording("denied".into()).to_string(),
            "recording error: denied"
        );
    }
}
