#[cfg(windows)]
mod windows;

/// Returns the full paths of the files copied to the system clipboard (a file
/// manager's Copy), in the clipboard's order, or an empty list when the
/// clipboard holds no file list or cannot be read.
///
/// On Windows the list is the clipboard's `CF_HDROP` data; a path that is not
/// valid Unicode is left out. Elsewhere the list is always empty. Blocks for a
/// short while when another app holds the clipboard open.
pub fn file_paths() -> Vec<String> {
    #[cfg(windows)]
    {
        windows::file_paths()
    }
    #[cfg(not(windows))]
    {
        Vec::new()
    }
}

#[cfg(all(test, not(windows)))]
mod tests {
    use super::*;

    #[test]
    fn no_file_list_outside_windows() {
        assert!(file_paths().is_empty());
    }
}
