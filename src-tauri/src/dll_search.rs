//! Limits where the process looks for a DLL loaded by bare name.

use std::io;

#[cfg(windows)]
mod windows;

/// Restricts the DLL search of the whole process to the executable's folder and
/// `System32`, so a DLL loaded by bare name (portable-pty's `conpty.dll`) never
/// comes from the current folder or `PATH`.
///
/// Must run before the first pseudo-terminal is opened: a DLL already loaded
/// stays loaded. A DLL loaded by full path is not affected. Does nothing
/// outside Windows.
///
/// # Errors
/// The Windows error when the search order cannot be changed.
pub fn restrict_dll_search() -> io::Result<()> {
    #[cfg(windows)]
    {
        windows::restrict_dll_search()
    }
    #[cfg(not(windows))]
    {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restricting_the_dll_search_succeeds() {
        restrict_dll_search().unwrap();
    }

    #[test]
    fn restricting_the_dll_search_twice_succeeds() {
        restrict_dll_search().unwrap();
        restrict_dll_search().unwrap();
    }
}
