use std::path::{Path, PathBuf};

use crate::error::AppError;

/// Validates a folder path sent by the webview and returns its canonical form.
///
/// The path must be absolute and name an existing directory. Symbolic links and
/// `..` segments are resolved. On Windows the result has no `\\?\` prefix, so it
/// can be used as a working directory as is.
///
/// # Errors
/// [`AppError::FolderNotAbsolute`], [`AppError::FolderNotFound`] or
/// [`AppError::NotADirectory`].
pub fn validate_folder(raw: &str) -> Result<PathBuf, AppError> {
    let path = Path::new(raw);
    if !path.is_absolute() {
        return Err(AppError::FolderNotAbsolute);
    }
    let canonical = dunce::canonicalize(path).map_err(|_| AppError::FolderNotFound)?;
    if !canonical.is_dir() {
        return Err(AppError::NotADirectory);
    }
    Ok(canonical)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_an_existing_folder() {
        let dir = tempfile::tempdir().unwrap();
        let expected = dunce::canonicalize(dir.path()).unwrap();
        let result = validate_folder(dir.path().to_str().unwrap()).unwrap();
        assert_eq!(result, expected);
    }

    #[test]
    fn resolves_dot_dot_segments() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("child")).unwrap();
        let roundabout = dir.path().join("child").join("..");
        let result = validate_folder(roundabout.to_str().unwrap()).unwrap();
        assert_eq!(result, dunce::canonicalize(dir.path()).unwrap());
    }

    #[test]
    fn result_has_no_verbatim_prefix() {
        let dir = tempfile::tempdir().unwrap();
        let result = validate_folder(dir.path().to_str().unwrap()).unwrap();
        assert!(!result.to_string_lossy().starts_with(r"\\?\"));
    }

    #[test]
    fn refuses_a_relative_path() {
        assert_eq!(
            validate_folder("some/folder"),
            Err(AppError::FolderNotAbsolute)
        );
        assert_eq!(validate_folder("."), Err(AppError::FolderNotAbsolute));
    }

    #[test]
    fn refuses_a_missing_folder() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("missing");
        assert_eq!(
            validate_folder(missing.to_str().unwrap()),
            Err(AppError::FolderNotFound)
        );
    }

    #[test]
    fn refuses_a_file() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("file.txt");
        std::fs::write(&file, "x").unwrap();
        assert_eq!(
            validate_folder(file.to_str().unwrap()),
            Err(AppError::NotADirectory)
        );
    }
}
