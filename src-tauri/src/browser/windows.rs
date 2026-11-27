use std::ffi::OsString;
use std::io;
use std::os::windows::ffi::OsStringExt;
use std::path::PathBuf;
use std::process::Command;
use std::ptr;

use windows_sys::Win32::Foundation::MAX_PATH;
use windows_sys::Win32::UI::Shell::{CSIDL_SYSTEM, SHGetFolderPathW};

use super::{URL_LIMIT, received_url};
use crate::state::windows::{Server, pipe_name_for, send};

/// Value of `SHGFP_TYPE_CURRENT`: the folder's current path.
const CURRENT_PATH: u32 = 0;

/// Purpose part of the name of the pipe that carries URLs to the app.
const PIPE_PURPOSE: &str = "open-url";

/// Returns the URL pipe of the build `identifier` for the current user:
/// `\\.\pipe\<identifier>.open-url.<user SID>`, `None` when the user's SID
/// cannot be read.
fn url_pipe(identifier: &str) -> Option<String> {
    pipe_name_for(identifier, PIPE_PURPOSE)
}

/// Returns a command running `rundll32.exe url.dll,OpenURL <url>` from the
/// system folder, by full path. The caller must pass a checked URL: it is
/// given as is.
///
/// # Errors
/// The system folder cannot be found.
fn opener(url: &str) -> io::Result<Command> {
    let mut command = Command::new(system_folder()?.join("rundll32.exe"));
    command.args(["url.dll,OpenURL", url]);
    Ok(command)
}

/// Runs the opener of `url` in the caller's job, waits for it and returns its
/// exit code (1 when it has none). The caller must pass a checked URL.
///
/// # Errors
/// The system folder cannot be found, or the process cannot be started.
pub fn open_in_job(url: &str) -> io::Result<i32> {
    Ok(opener(url)?.status()?.code().unwrap_or(1))
}

/// Sends `url` to the running app of the build `identifier`, which opens it
/// outside any session's job.
///
/// # Errors
/// The user's SID cannot be read, the pipe does not exist, or its server runs
/// as another user.
pub fn send_to_app(identifier: &str, url: &str) -> io::Result<()> {
    let name = url_pipe(identifier).ok_or(io::ErrorKind::NotFound)?;
    send(&name, url.as_bytes())
}

/// Starts, on a background thread, the server of the URL pipe of the build
/// `identifier`: each message accepted by [`received_url`] is opened with the
/// opener, started without waiting for it; any other message is dropped.
///
/// Does nothing when the pipe cannot be created, for instance because another
/// process already holds it: sessions then open URLs inside their own job.
pub fn start_server(identifier: &str) {
    let Some(name) = url_pipe(identifier) else {
        return;
    };
    let Ok(server) = Server::bind(&name) else {
        return;
    };
    std::thread::spawn(move || {
        server.serve_up_to(URL_LIMIT, |bytes| {
            if let Some(url) = received_url(&bytes)
                && let Ok(mut command) = opener(url)
            {
                let _ = command.spawn();
            }
        });
    });
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
    use std::sync::mpsc;
    use std::time::Duration;

    use super::*;

    /// A build identifier no other test or process uses.
    fn unique_identifier() -> String {
        format!("cloitre-test-{}", uuid::Uuid::new_v4())
    }

    #[test]
    fn the_url_pipe_is_named_after_the_identifier_and_its_purpose() {
        let name = url_pipe("com.example.app").unwrap();
        assert!(
            name.starts_with(r"\\.\pipe\com.example.app.open-url.S-1-"),
            "{name}"
        );
    }

    #[test]
    fn a_url_sent_to_the_app_reaches_the_server_of_its_identifier() {
        let identifier = unique_identifier();
        let server = Server::bind(&url_pipe(&identifier).unwrap()).unwrap();
        let (sender, received) = mpsc::channel();
        std::thread::spawn(move || {
            server.serve_up_to(URL_LIMIT, |message| sender.send(message).unwrap());
        });
        let url = format!("https://example.com/{}", "a".repeat(URL_LIMIT - 20));
        send_to_app(&identifier, &url).unwrap();
        let message = received.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(received_url(&message), Some(url.as_str()));
    }

    #[test]
    fn sending_a_url_without_a_running_app_fails() {
        assert!(send_to_app(&unique_identifier(), "https://example.com").is_err());
    }

    #[test]
    fn system_folder_holds_rundll32() {
        assert!(system_folder().unwrap().join("rundll32.exe").is_file());
    }
}
