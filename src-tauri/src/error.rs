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
    /// A tab id was 0: tab ids start at 1.
    InvalidTabId,
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
    /// A recording file holds `size` bytes, more than the `limit` that may be read.
    RecordingTooLarge {
        /// Size of the file, in bytes.
        size: u64,
        /// Largest size read, in bytes.
        limit: u64,
    },
    /// No project is registered under this id.
    UnknownProject(u32),
    /// No tab is registered under this id.
    UnknownTab(u32),
    /// The folder is not the folder of any project.
    FolderNotRegistered,
    /// The folder of this project, named here, no longer exists.
    ProjectFolderMissing(String),
    /// The folder already belongs to the project named here.
    FolderTaken(String),
    /// The folder path is not valid Unicode, so the project file cannot store it.
    UnsupportedFolderPath,
    /// The project list could not be written; carries the underlying message.
    ProjectsNotSaved(String),
    /// The project file could not be loaded nor copied aside, so no change is saved.
    ProjectsReadOnly,
    /// The marker catalog has no color or icon of this name.
    UnknownMarker(String),
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
            Self::InvalidTabId => write!(f, "the tab id must be at least 1"),
            Self::UnknownPty(id) => write!(f, "no session with id {id}"),
            Self::Pty(message) => write!(f, "pseudo-terminal error: {message}"),
            Self::InvalidRecordingName => write!(f, "not a recording name"),
            Self::UnknownRecording => write!(f, "no recording with this name"),
            Self::NoRecording(id) => write!(f, "session {id} is not being recorded"),
            Self::Recording(message) => write!(f, "recording error: {message}"),
            Self::RecordingTooLarge { size, limit } => write!(
                f,
                "recording of {size} bytes exceeds the {limit}-byte limit"
            ),
            Self::UnknownProject(id) => write!(f, "no project with id {id}"),
            Self::UnknownTab(id) => write!(f, "no tab with id {id}"),
            Self::FolderNotRegistered => write!(f, "the folder is not in the project list"),
            Self::ProjectFolderMissing(name) => write!(
                f,
                "the folder of project {name} no longer exists: choose its new location"
            ),
            Self::FolderTaken(name) => {
                write!(f, "the folder is already the folder of project {name}")
            }
            Self::UnsupportedFolderPath => write!(
                f,
                "the folder path has characters the project list cannot store"
            ),
            Self::ProjectsNotSaved(message) => {
                write!(f, "the project list could not be saved: {message}")
            }
            Self::ProjectsReadOnly => write!(
                f,
                "the project list is read-only until the app restarts: its file could not be loaded nor copied aside"
            ),
            Self::UnknownMarker(name) => write!(f, "no marker color or icon named {name}"),
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
    fn invalid_tab_id_says_where_ids_start() {
        assert_eq!(
            AppError::InvalidTabId.to_string(),
            "the tab id must be at least 1"
        );
    }

    #[test]
    fn spawn_cancelled_says_the_page_reloaded() {
        assert_eq!(
            AppError::SpawnCancelled.to_string(),
            "the session was stopped because the page reloaded while it was starting"
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
        assert_eq!(
            AppError::RecordingTooLarge {
                size: 70,
                limit: 64
            }
            .to_string(),
            "recording of 70 bytes exceeds the 64-byte limit"
        );
    }

    #[test]
    fn project_errors_say_what_was_refused() {
        assert_eq!(
            AppError::UnknownProject(4).to_string(),
            "no project with id 4"
        );
        assert_eq!(AppError::UnknownTab(5).to_string(), "no tab with id 5");
        assert_eq!(
            AppError::FolderNotRegistered.to_string(),
            "the folder is not in the project list"
        );
        assert_eq!(
            AppError::ProjectFolderMissing("alpha".into()).to_string(),
            "the folder of project alpha no longer exists: choose its new location"
        );
        assert_eq!(
            AppError::FolderTaken("beta".into()).to_string(),
            "the folder is already the folder of project beta"
        );
        assert_eq!(
            AppError::UnknownMarker("plaid".into()).to_string(),
            "no marker color or icon named plaid"
        );
    }

    #[test]
    fn project_list_errors_say_why_nothing_was_saved() {
        assert_eq!(
            AppError::UnsupportedFolderPath.to_string(),
            "the folder path has characters the project list cannot store"
        );
        assert_eq!(
            AppError::ProjectsNotSaved("disk full".into()).to_string(),
            "the project list could not be saved: disk full"
        );
        assert_eq!(
            AppError::ProjectsReadOnly.to_string(),
            "the project list is read-only until the app restarts: its file could not be loaded nor copied aside"
        );
    }
}
