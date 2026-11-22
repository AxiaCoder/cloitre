use std::io;

use windows_sys::Win32::System::LibraryLoader::{
    LOAD_LIBRARY_SEARCH_APPLICATION_DIR, LOAD_LIBRARY_SEARCH_SYSTEM32, SetDefaultDllDirectories,
};

/// Sets the process's default DLL search to the executable's folder and
/// `System32` only.
///
/// # Errors
/// The `GetLastError` value when `SetDefaultDllDirectories` fails.
pub fn restrict_dll_search() -> io::Result<()> {
    // SAFETY: SetDefaultDllDirectories takes plain flags and touches no memory of ours.
    let succeeded = unsafe {
        SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_APPLICATION_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32)
    };
    if succeeded == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}
