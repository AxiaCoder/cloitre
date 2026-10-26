use std::fs::File;
use std::io::{self, Read, Write};
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::ptr;

use windows_sys::Win32::Foundation::{
    ERROR_NO_DATA, ERROR_PIPE_BUSY, ERROR_PIPE_CONNECTED, GENERIC_WRITE, GetLastError, HANDLE,
    INVALID_HANDLE_VALUE, LocalFree,
};
use windows_sys::Win32::Security::Authorization::{
    ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
};
use windows_sys::Win32::Security::{
    GetLengthSid, GetTokenInformation, IsValidSid, PSECURITY_DESCRIPTOR, PSID, SECURITY_ATTRIBUTES,
    TOKEN_QUERY, TOKEN_USER, TokenUser,
};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, FILE_FLAG_FIRST_PIPE_INSTANCE, FILE_READ_ATTRIBUTES, OPEN_EXISTING,
    PIPE_ACCESS_INBOUND, SECURITY_ANONYMOUS, SECURITY_SQOS_PRESENT,
};
use windows_sys::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, GetNamedPipeServerProcessId, PIPE_READMODE_BYTE,
    PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE, PIPE_UNLIMITED_INSTANCES, PIPE_WAIT,
    WaitNamedPipeW,
};
use windows_sys::Win32::System::Threading::{
    GetCurrentProcess, OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION,
};

use super::MESSAGE_LIMIT;

/// The pipe mode of every server instance: bytes, blocking calls, and no
/// client from another machine.
const PIPE_MODE: u32 = PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS;

/// The longest the client waits, in milliseconds, for a free instance when
/// every one is busy.
const BUSY_WAIT_MS: u32 = 100;

/// Size, in bytes, of the system buffers of each pipe instance.
const BUFFER_SIZE: u32 = 4096;

/// Returns the open mode of a server instance: inbound only, and for the
/// `first` instance, failing when the pipe already exists.
fn open_mode(first: bool) -> u32 {
    if first {
        PIPE_ACCESS_INBOUND | FILE_FLAG_FIRST_PIPE_INSTANCE
    } else {
        PIPE_ACCESS_INBOUND
    }
}

/// Encodes `text` as a null-terminated UTF-16 string.
fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(Some(0)).collect()
}

/// A security identifier, copied into memory owned by Rust.
#[derive(Debug, Clone)]
pub struct Sid {
    /// The SID's bytes, in 32-bit words so the structure is aligned.
    words: Vec<u32>,
    /// The SID's length in bytes.
    len: usize,
}

impl Sid {
    /// Copies the SID at `sid`.
    ///
    /// # Safety
    /// `sid` must point to readable memory holding a SID, or be null.
    ///
    /// # Errors
    /// [`io::ErrorKind::InvalidData`] when `sid` is null or not a valid SID.
    unsafe fn copy_from(sid: PSID) -> io::Result<Self> {
        // SAFETY: the caller guarantees `sid` points to a SID or is null.
        if sid.is_null() || unsafe { IsValidSid(sid) } == 0 {
            return Err(io::ErrorKind::InvalidData.into());
        }
        // SAFETY: `sid` is a valid SID, checked above.
        let len = unsafe { GetLengthSid(sid) } as usize;
        let mut words = vec![0u32; len.div_ceil(4)];
        // SAFETY: `sid` holds `len` bytes, and `words` has room for them.
        unsafe { ptr::copy_nonoverlapping(sid.cast::<u8>(), words.as_mut_ptr().cast(), len) };
        Ok(Self { words, len })
    }

    /// Returns a pointer to the SID, valid while `self` lives.
    fn as_psid(&self) -> PSID {
        self.words.as_ptr().cast_mut().cast()
    }

    /// Returns the SID's bytes.
    fn bytes(&self) -> &[u8] {
        // SAFETY: `words` holds at least `len` initialised bytes.
        unsafe { std::slice::from_raw_parts(self.words.as_ptr().cast(), self.len) }
    }

    /// Returns the SID in its text form, `S-1-5-21-…`.
    ///
    /// # Errors
    /// The system error when the conversion fails.
    fn to_text(&self) -> io::Result<String> {
        let mut text: *mut u16 = ptr::null_mut();
        // SAFETY: `self` holds a valid SID; `text` receives a string the
        // system allocates, freed below.
        if unsafe { ConvertSidToStringSidW(self.as_psid(), &mut text) } == 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: `text` is a null-terminated string allocated by the call.
        let len = (0..).take_while(|&i| unsafe { *text.add(i) } != 0).count();
        // SAFETY: `text` holds `len` UTF-16 units before its null.
        let result = String::from_utf16(unsafe { std::slice::from_raw_parts(text, len) })
            .map_err(|_| io::ErrorKind::InvalidData.into());
        // SAFETY: `text` was allocated with `LocalAlloc` by the call.
        unsafe { LocalFree(text.cast()) };
        result
    }
}

impl PartialEq for Sid {
    /// Two SIDs are equal when their bytes are.
    fn eq(&self, other: &Self) -> bool {
        self.bytes() == other.bytes()
    }
}

impl Eq for Sid {}

/// Returns the user SID of the access token `token`, opened with `TOKEN_QUERY`.
///
/// # Errors
/// The system error when the token cannot be read.
fn token_user(token: &OwnedHandle) -> io::Result<Sid> {
    let mut needed = 0u32;
    // SAFETY: a null buffer of length 0 only asks for the size needed.
    unsafe {
        GetTokenInformation(
            token.as_raw_handle(),
            TokenUser,
            ptr::null_mut(),
            0,
            &mut needed,
        )
    };
    if needed == 0 {
        return Err(io::Error::last_os_error());
    }
    let mut buffer = vec![0u64; (needed as usize).div_ceil(8)];
    // SAFETY: `buffer` is aligned for `TOKEN_USER` and holds `needed` bytes.
    let read = unsafe {
        GetTokenInformation(
            token.as_raw_handle(),
            TokenUser,
            buffer.as_mut_ptr().cast(),
            needed,
            &mut needed,
        )
    };
    if read == 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: the call filled `buffer` with a `TOKEN_USER` whose SID points
    // inside `buffer`, still alive here.
    unsafe { Sid::copy_from((*buffer.as_ptr().cast::<TOKEN_USER>()).User.Sid) }
}

/// Opens the access token of `process` for reading.
///
/// # Errors
/// The system error when the token cannot be opened.
fn open_token(process: HANDLE) -> io::Result<OwnedHandle> {
    let mut token: HANDLE = ptr::null_mut();
    // SAFETY: `process` is an open process handle; `token` receives a new handle.
    if unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) } == 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: `token` is a new handle owned by nobody else.
    Ok(unsafe { OwnedHandle::from_raw_handle(token) })
}

/// Returns the SID of the user this process runs as.
///
/// # Errors
/// The system error when its token cannot be read.
pub fn current_user() -> io::Result<Sid> {
    // SAFETY: the pseudo handle of the current process needs no closing.
    token_user(&open_token(unsafe { GetCurrentProcess() })?)
}

/// Returns the SID of the user process `pid` runs as.
///
/// # Errors
/// The system error when the process or its token cannot be opened, as for a
/// process of another user.
fn process_user(pid: u32) -> io::Result<Sid> {
    // SAFETY: plain call; a null result is handled below.
    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if process.is_null() {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: `process` is a new handle owned by nobody else.
    let process = unsafe { OwnedHandle::from_raw_handle(process) };
    token_user(&open_token(process.as_raw_handle())?)
}

/// Tells whether the client may write to a server run by `server`, the user
/// of the server process or the error met reading it: only when it is `own`.
fn trusts(own: &Sid, server: &io::Result<Sid>) -> bool {
    server.as_ref().is_ok_and(|server| server == own)
}

/// Returns the name of the state pipe of the build `identifier` for the
/// current user: `\\.\pipe\<identifier>.session-state.<user SID>`. `None`
/// when the user's SID cannot be read.
pub fn pipe_name(identifier: &str) -> Option<String> {
    let sid = current_user().ok()?.to_text().ok()?;
    Some(format!(r"\\.\pipe\{identifier}.session-state.{sid}"))
}

/// A security descriptor allocated by the system, freed on drop.
struct SecurityDescriptor(PSECURITY_DESCRIPTOR);

// SAFETY: the descriptor is plain memory owned by this value alone, only read
// by the system calls it is passed to.
unsafe impl Send for SecurityDescriptor {}

impl SecurityDescriptor {
    /// Builds a descriptor whose owner is `user` and whose protected DACL
    /// grants every access to `user` alone, so no other account may open the
    /// pipe, nor add an instance to it.
    ///
    /// # Errors
    /// The system error when the descriptor cannot be built.
    fn owner_only(user: &Sid) -> io::Result<Self> {
        let sid = user.to_text()?;
        let sddl = wide(&format!("O:{sid}D:P(A;;GA;;;{sid})"));
        let mut descriptor: PSECURITY_DESCRIPTOR = ptr::null_mut();
        // SAFETY: `sddl` is null-terminated; `descriptor` receives memory the
        // system allocates, freed on drop.
        let built = unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.as_ptr(),
                SDDL_REVISION_1,
                &mut descriptor,
                ptr::null_mut(),
            )
        };
        if built == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(Self(descriptor))
    }
}

impl Drop for SecurityDescriptor {
    /// Frees the descriptor.
    fn drop(&mut self) {
        // SAFETY: the descriptor was allocated with `LocalAlloc` by the system.
        unsafe { LocalFree(self.0) };
    }
}

/// The server end of the state pipe: always one instance waiting for the next
/// client.
pub struct Server {
    /// The pipe name, null-terminated UTF-16.
    name: Vec<u16>,
    /// The descriptor given to every instance.
    security: SecurityDescriptor,
    /// The instance waiting for the next client.
    next: OwnedHandle,
}

impl Server {
    /// Creates the pipe `name`, reachable by the current user only and by no
    /// other machine.
    ///
    /// # Errors
    /// The system error when the pipe cannot be created, for instance because
    /// a pipe of that name already exists, whoever created it.
    pub fn bind(name: &str) -> io::Result<Self> {
        let security = SecurityDescriptor::owner_only(&current_user()?)?;
        let name = wide(name);
        let next = create_instance(&name, &security, true)?;
        Ok(Self {
            name,
            security,
            next,
        })
    }

    /// Serves clients one after the other, forever: passes what each one
    /// wrote before closing, at most [`MESSAGE_LIMIT`] + 1 bytes, to
    /// `on_message`. Returns only when no new instance can be created or a
    /// wait for a client fails.
    pub fn serve(mut self, mut on_message: impl FnMut(Vec<u8>)) {
        loop {
            // SAFETY: `next` is an open pipe instance; no overlapped I/O.
            let connected = unsafe { ConnectNamedPipe(self.next.as_raw_handle(), ptr::null_mut()) }
                != 0
                // SAFETY: plain call.
                || matches!(unsafe { GetLastError() }, ERROR_PIPE_CONNECTED | ERROR_NO_DATA);
            if !connected {
                return;
            }
            let Ok(next) = create_instance(&self.name, &self.security, false) else {
                return;
            };
            let client = File::from(std::mem::replace(&mut self.next, next));
            let mut message = Vec::new();
            if client
                .take(MESSAGE_LIMIT as u64 + 1)
                .read_to_end(&mut message)
                .is_ok()
            {
                on_message(message);
            }
        }
    }
}

/// Creates an inbound instance of the pipe `name` with `security`; `first`
/// makes the call fail when the pipe already exists.
///
/// # Errors
/// The system error when the instance cannot be created.
fn create_instance(
    name: &[u16],
    security: &SecurityDescriptor,
    first: bool,
) -> io::Result<OwnedHandle> {
    let attributes = SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: security.0,
        bInheritHandle: 0,
    };
    // SAFETY: `name` is null-terminated and `attributes` outlives the call.
    let handle = unsafe {
        CreateNamedPipeW(
            name.as_ptr(),
            open_mode(first),
            PIPE_MODE,
            PIPE_UNLIMITED_INSTANCES,
            BUFFER_SIZE,
            BUFFER_SIZE,
            0,
            &attributes,
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: `handle` is a new handle owned by nobody else.
    Ok(unsafe { OwnedHandle::from_raw_handle(handle) })
}

/// Opens the client end of the pipe `name` (null-terminated UTF-16) for
/// writing, without letting the server impersonate the client.
///
/// # Errors
/// The system error, at once, when the pipe does not exist or has no free
/// instance.
fn open_client(name: &[u16]) -> io::Result<OwnedHandle> {
    // SAFETY: `name` is null-terminated; null attributes and template are allowed.
    let handle = unsafe {
        CreateFileW(
            name.as_ptr(),
            GENERIC_WRITE | FILE_READ_ATTRIBUTES,
            0,
            ptr::null(),
            OPEN_EXISTING,
            SECURITY_SQOS_PRESENT | SECURITY_ANONYMOUS,
            ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: `handle` is a new handle owned by nobody else.
    Ok(unsafe { OwnedHandle::from_raw_handle(handle) })
}

/// Writes `message` to the pipe `name`, once. Fails at once when the pipe
/// does not exist; when every instance is busy, waits at most
/// [`BUSY_WAIT_MS`] for one, then tries a last time.
///
/// Nothing is written unless the process serving the pipe runs as the
/// current user, so a pipe another account created first gets nothing. The
/// server may not impersonate the client.
///
/// # Errors
/// The system error of the call that failed, or
/// [`io::ErrorKind::PermissionDenied`] when the server runs as another user.
pub fn send(name: &str, message: &[u8]) -> io::Result<()> {
    let name = wide(name);
    let pipe = match open_client(&name) {
        Err(error) if error.raw_os_error() == Some(ERROR_PIPE_BUSY as i32) => {
            // SAFETY: `name` is null-terminated.
            unsafe { WaitNamedPipeW(name.as_ptr(), BUSY_WAIT_MS) };
            open_client(&name)?
        }
        opened => opened?,
    };
    let mut pid = 0u32;
    // SAFETY: `pipe` is an open pipe client handle.
    if unsafe { GetNamedPipeServerProcessId(pipe.as_raw_handle(), &mut pid) } == 0 {
        return Err(io::Error::last_os_error());
    }
    if !trusts(&current_user()?, &process_user(pid)) {
        return Err(io::ErrorKind::PermissionDenied.into());
    }
    File::from(pipe).write_all(message)
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    use windows_sys::Win32::Security::Authorization::{
        ConvertStringSidToSidW, GetSecurityInfo, SE_KERNEL_OBJECT,
    };
    use windows_sys::Win32::Security::{
        ACCESS_ALLOWED_ACE, ACL, DACL_SECURITY_INFORMATION, GetAce, GetSecurityDescriptorControl,
        OWNER_SECURITY_INFORMATION, SE_DACL_PROTECTED,
    };

    use std::ffi::c_void;

    use super::*;

    /// The ACE type of an access-allowed entry.
    const ACCESS_ALLOWED_ACE_TYPE: u8 = 0;

    /// A pipe name no other test or process uses.
    fn unique_name() -> String {
        format!(r"\\.\pipe\cloitre-test-{}", uuid::Uuid::new_v4())
    }

    /// The SID written `text`, such as `S-1-5-18`.
    fn sid_from_text(text: &str) -> Sid {
        let text = wide(text);
        let mut sid: PSID = ptr::null_mut();
        // SAFETY: `text` is null-terminated; `sid` receives memory freed below.
        assert_ne!(
            unsafe { ConvertStringSidToSidW(text.as_ptr(), &mut sid) },
            0
        );
        // SAFETY: the call returned a valid SID.
        let copy = unsafe { Sid::copy_from(sid) }.unwrap();
        // SAFETY: `sid` was allocated with `LocalAlloc` by the call.
        unsafe { LocalFree(sid) };
        copy
    }

    #[test]
    fn the_pipe_dacl_grants_the_current_user_alone() {
        let server = Server::bind(&unique_name()).unwrap();
        let mut owner: PSID = ptr::null_mut();
        let mut dacl: *mut ACL = ptr::null_mut();
        let mut descriptor: PSECURITY_DESCRIPTOR = ptr::null_mut();
        // SAFETY: `next` is an open pipe handle; the out pointers point into
        // `descriptor`, freed at the end.
        let status = unsafe {
            GetSecurityInfo(
                server.next.as_raw_handle(),
                SE_KERNEL_OBJECT,
                DACL_SECURITY_INFORMATION | OWNER_SECURITY_INFORMATION,
                &mut owner,
                ptr::null_mut(),
                &mut dacl,
                ptr::null_mut(),
                &mut descriptor,
            )
        };
        assert_eq!(status, 0);
        let user = current_user().unwrap();
        // SAFETY: `owner` points to a SID inside `descriptor`.
        assert_eq!(unsafe { Sid::copy_from(owner) }.unwrap(), user);
        assert!(!dacl.is_null());
        let mut control = 0u16;
        let mut revision = 0u32;
        // SAFETY: `descriptor` is the descriptor the call returned.
        unsafe { GetSecurityDescriptorControl(descriptor, &mut control, &mut revision) };
        assert_ne!(control & SE_DACL_PROTECTED, 0);
        // SAFETY: `dacl` points to the ACL inside `descriptor`.
        assert_eq!(unsafe { (*dacl).AceCount }, 1);
        let mut ace: *mut c_void = ptr::null_mut();
        // SAFETY: the ACL holds one entry, index 0.
        assert_ne!(unsafe { GetAce(dacl, 0, &mut ace) }, 0);
        let ace = ace.cast::<ACCESS_ALLOWED_ACE>();
        // SAFETY: `ace` points to the ACL's entry, inside `descriptor`.
        unsafe {
            assert_eq!((*ace).Header.AceType, ACCESS_ALLOWED_ACE_TYPE);
            let sid = Sid::copy_from((&raw mut (*ace).SidStart).cast()).unwrap();
            assert_eq!(sid, user);
            LocalFree(descriptor);
        }
    }

    #[test]
    fn instances_reject_remote_clients_and_the_first_one_refuses_an_existing_pipe() {
        assert_ne!(PIPE_MODE & PIPE_REJECT_REMOTE_CLIENTS, 0);
        assert_ne!(open_mode(true) & FILE_FLAG_FIRST_PIPE_INSTANCE, 0);
        assert_eq!(open_mode(false) & FILE_FLAG_FIRST_PIPE_INSTANCE, 0);
        let name = unique_name();
        let _server = Server::bind(&name).unwrap();
        assert!(Server::bind(&name).is_err());
    }

    #[test]
    fn the_client_trusts_only_a_server_of_its_own_user() {
        let own = current_user().unwrap();
        let mine = process_user(std::process::id());
        assert!(trusts(&own, &mine));
        let system = sid_from_text("S-1-5-18");
        assert_ne!(system, own);
        assert!(!trusts(&system, &mine));
        assert!(!trusts(&own, &Ok(system)));
        assert!(!trusts(&own, &Err(io::ErrorKind::PermissionDenied.into())));
    }

    #[test]
    fn the_pipe_name_holds_the_identifier_and_the_user() {
        let sid = current_user().unwrap().to_text().unwrap();
        assert!(sid.starts_with("S-1-"));
        assert_eq!(
            pipe_name("com.example.app").unwrap(),
            format!(r"\\.\pipe\com.example.app.session-state.{sid}")
        );
        assert_ne!(
            pipe_name("com.example.app"),
            pipe_name("com.example.app.dev")
        );
    }

    #[test]
    fn messages_go_from_client_to_server() {
        let name = unique_name();
        let server = Server::bind(&name).unwrap();
        let (sender, received) = mpsc::channel();
        std::thread::spawn(move || server.serve(|message| sender.send(message).unwrap()));
        send(&name, b"{\"tab\":1,\"state\":\"working\"}\n").unwrap();
        send(&name, b"{\"tab\":2,\"state\":\"done\"}\n").unwrap();
        let timeout = Duration::from_secs(5);
        assert_eq!(
            received.recv_timeout(timeout).unwrap(),
            b"{\"tab\":1,\"state\":\"working\"}\n"
        );
        assert_eq!(
            received.recv_timeout(timeout).unwrap(),
            b"{\"tab\":2,\"state\":\"done\"}\n"
        );
    }

    #[test]
    fn the_server_reads_no_more_than_the_limit() {
        let name = unique_name();
        let server = Server::bind(&name).unwrap();
        let (sender, received) = mpsc::channel();
        std::thread::spawn(move || server.serve(|message| sender.send(message).unwrap()));
        send(&name, &[b' '; 2 * MESSAGE_LIMIT]).unwrap();
        let message = received.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(message.len(), MESSAGE_LIMIT + 1);
    }

    #[test]
    fn sending_without_a_server_fails_at_once() {
        let start = Instant::now();
        assert!(send(&unique_name(), b"{}\n").is_err());
        assert!(start.elapsed() < Duration::from_secs(1));
    }
}
