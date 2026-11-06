use std::ptr;
use std::thread;
use std::time::Duration;

use windows_sys::Win32::System::DataExchange::{
    CloseClipboard, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard,
};
use windows_sys::Win32::System::Ole::CF_HDROP;
use windows_sys::Win32::UI::Shell::DragQueryFileW;

/// How many times the clipboard is asked for while another app holds it open.
const OPEN_ATTEMPTS: u32 = 10;

/// The wait between two attempts to open the clipboard.
const OPEN_RETRY_DELAY: Duration = Duration::from_millis(10);

/// The `DragQueryFileW` file index that asks for the number of files.
const FILE_COUNT_INDEX: u32 = u32::MAX;

/// The clipboard, opened by this thread; dropping it closes the clipboard.
struct OpenedClipboard;

impl OpenedClipboard {
    /// Opens the clipboard for this thread, or returns `None` when another app
    /// holds it open.
    fn open() -> Option<Self> {
        // SAFETY: a null owner window is allowed; the clipboard is then opened
        // for the calling thread, and closed by `Drop` on that same thread.
        (unsafe { OpenClipboard(ptr::null_mut()) } != 0).then_some(Self)
    }
}

impl Drop for OpenedClipboard {
    /// Closes the clipboard.
    fn drop(&mut self) {
        // SAFETY: the clipboard was opened by this thread in `open`.
        unsafe {
            CloseClipboard();
        }
    }
}

/// Calls `try_once` until it returns `Some`, at most `attempts` times, waiting
/// `delay` between two calls. Returns the first `Some`, or `None` when every
/// attempt returned `None`; never calls `try_once` for 0 attempts.
fn retry<T>(attempts: u32, delay: Duration, mut try_once: impl FnMut() -> Option<T>) -> Option<T> {
    for attempt in 0..attempts {
        if attempt > 0 {
            thread::sleep(delay);
        }
        if let Some(value) = try_once() {
            return Some(value);
        }
    }
    None
}

/// Returns the path held by the UTF-16 code units `wide`, or `None` when they
/// are not valid Unicode.
fn path_from_wide(wide: &[u16]) -> Option<String> {
    String::from_utf16(wide).ok()
}

/// Returns the paths of the clipboard's `CF_HDROP` file list, in its order, or
/// an empty list when the clipboard holds none or stays held by another app
/// after [`OPEN_ATTEMPTS`] attempts. A path that is not valid Unicode is left out.
pub fn file_paths() -> Vec<String> {
    let format = u32::from(CF_HDROP);
    // SAFETY: only asks whether a format is on the clipboard; needs no open clipboard.
    if unsafe { IsClipboardFormatAvailable(format) } == 0 {
        return Vec::new();
    }
    let Some(_opened) = retry(OPEN_ATTEMPTS, OPEN_RETRY_DELAY, OpenedClipboard::open) else {
        return Vec::new();
    };
    // SAFETY: the clipboard is open; the handle stays owned by the clipboard
    // and is only used before `_opened` closes it.
    let drop = unsafe { GetClipboardData(format) };
    if drop.is_null() {
        return Vec::new();
    }
    // SAFETY: `drop` is the clipboard's `CF_HDROP` handle, so an `HDROP`; a
    // null buffer asks for the count.
    let count = unsafe { DragQueryFileW(drop, FILE_COUNT_INDEX, ptr::null_mut(), 0) };
    let mut paths = Vec::new();
    for index in 0..count {
        // SAFETY: as above; a null buffer asks for the length, without the terminating null.
        let length = unsafe { DragQueryFileW(drop, index, ptr::null_mut(), 0) };
        let mut buffer = vec![0u16; length as usize + 1];
        let capacity = u32::try_from(buffer.len()).unwrap_or(u32::MAX);
        // SAFETY: `buffer` holds `capacity` code units, room for the path and its null.
        let written = unsafe { DragQueryFileW(drop, index, buffer.as_mut_ptr(), capacity) };
        let end = (written as usize).min(length as usize);
        if let Some(path) = path_from_wide(&buffer[..end]) {
            paths.push(path);
        }
    }
    paths
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retry_returns_the_first_success() {
        let mut calls = 0;
        let found = retry(5, Duration::ZERO, || {
            calls += 1;
            (calls == 3).then_some(calls)
        });
        assert_eq!(found, Some(3));
        assert_eq!(calls, 3);
    }

    #[test]
    fn retry_gives_up_after_its_attempts() {
        let mut calls = 0;
        let found: Option<()> = retry(4, Duration::ZERO, || {
            calls += 1;
            None
        });
        assert_eq!(found, None);
        assert_eq!(calls, 4);
    }

    #[test]
    fn retry_with_no_attempt_calls_nothing() {
        let found: Option<()> = retry(0, Duration::ZERO, || panic!("called"));
        assert_eq!(found, None);
    }

    #[test]
    fn a_wide_path_reads_as_text() {
        let wide: Vec<u16> = r"C:\Users\Example\Images\photo d'été.png"
            .encode_utf16()
            .collect();
        assert_eq!(
            path_from_wide(&wide).as_deref(),
            Some(r"C:\Users\Example\Images\photo d'été.png")
        );
    }

    #[test]
    fn a_path_with_an_unpaired_surrogate_is_left_out() {
        assert_eq!(path_from_wide(&[0x0043, 0xD800, 0x0078]), None);
    }
}
