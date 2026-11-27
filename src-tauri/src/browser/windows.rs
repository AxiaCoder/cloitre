use std::ffi::OsString;
use std::io;
use std::os::windows::ffi::OsStringExt;
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::Command;
use std::ptr;

use windows_sys::Win32::Foundation::MAX_PATH;
use windows_sys::Win32::System::Threading::CREATE_BREAKAWAY_FROM_JOB;
use windows_sys::Win32::UI::Shell::{CSIDL_SYSTEM, SHGetFolderPathW};

/// Value of `SHGFP_TYPE_CURRENT`: the folder's current path.
const CURRENT_PATH: u32 = 0;

/// Runs `rundll32.exe url.dll,OpenURL <url>` from the system folder, out of
/// the caller's job (`CREATE_BREAKAWAY_FROM_JOB`), waits for it and returns its
/// exit code. When a job refuses the breakaway (access denied), runs it again
/// inside the job. The caller must pass a checked web URL: it is given as is.
///
/// # Errors
/// The system folder cannot be found, or the process cannot be started.
pub fn open(url: &str) -> io::Result<i32> {
    let program = system_folder()?.join("rundll32.exe");
    let opener = || {
        let mut command = Command::new(&program);
        command.args(["url.dll,OpenURL", url]);
        command
    };
    let status = match opener().creation_flags(CREATE_BREAKAWAY_FROM_JOB).status() {
        Err(error) if breakaway_refused(error.kind()) => opener().status()?,
        result => result?,
    };
    Ok(status.code().unwrap_or(1))
}

/// Tells whether a start that failed with `kind` was refused because the job
/// forbids `CREATE_BREAKAWAY_FROM_JOB`, so it is worth running again inside it.
fn breakaway_refused(kind: io::ErrorKind) -> bool {
    kind == io::ErrorKind::PermissionDenied
}

/// Returns the Windows system folder (`System32`).
///
/// # Errors
/// The `HRESULT` of `SHGetFolderPathW` when it fails.
fn system_folder() -> io::Result<PathBuf> {
    let mut buffer = [0u16; MAX_PATH as usize];
    // SAFETY: null window and token are allowed; `buffer` holds MAX_PATH
    // characters, the size the call expects, and outlives it.
    let result = unsafe {
        SHGetFolderPathW(
            ptr::null_mut(),
            CSIDL_SYSTEM as i32,
            ptr::null_mut(),
            CURRENT_PATH,
            buffer.as_mut_ptr(),
        )
    };
    if result < 0 {
        return Err(io::Error::from_raw_os_error(result));
    }
    let length = buffer
        .iter()
        .position(|&unit| unit == 0)
        .unwrap_or(buffer.len());
    Ok(PathBuf::from(OsString::from_wide(&buffer[..length])))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_refused_breakaway_is_retried_inside_the_job() {
        assert!(breakaway_refused(io::ErrorKind::PermissionDenied));
    }

    #[test]
    fn other_start_failures_are_not_retried() {
        for kind in [
            io::ErrorKind::NotFound,
            io::ErrorKind::InvalidInput,
            io::ErrorKind::Other,
        ] {
            assert!(!breakaway_refused(kind), "{kind:?} was retried");
        }
    }

    #[test]
    fn system_folder_holds_rundll32() {
        assert!(system_folder().unwrap().join("rundll32.exe").is_file());
    }
}
