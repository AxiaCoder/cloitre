use std::collections::{HashMap, HashSet};
use std::io;
use std::mem::offset_of;
use std::ptr;

use windows_sys::Win32::Foundation::{CloseHandle, ERROR_MORE_DATA, HANDLE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW, TH32CS_SNAPPROCESS,
};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, IsProcessInJob, JOB_OBJECT_LIMIT,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOBOBJECT_BASIC_PROCESS_ID_LIST,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectBasicProcessIdList,
    JobObjectExtendedLimitInformation, QueryInformationJobObject, SetInformationJobObject,
    TerminateJobObject,
};
use windows_sys::Win32::System::Threading::{
    OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SET_QUOTA, PROCESS_SYNCHRONIZE,
    PROCESS_TERMINATE, TerminateProcess, WaitForSingleObject,
};
use windows_sys::core::BOOL;

/// Exit code given to the processes stopped by [`Job::terminate`].
const TERMINATED_EXIT_CODE: u32 = 1;

/// Executable names, lowercase, of the browsers `claude` may start for Claude
/// in Chrome. [`Job::stop_sparing_browsers`] leaves them and their descendants running.
const BROWSER_EXES: [&str; 5] = [
    "chrome.exe",
    "msedge.exe",
    "brave.exe",
    "vivaldi.exe",
    "opera.exe",
];

/// Most passes [`Job::stop_sparing_browsers`] makes over the job before it
/// gives up sparing the browsers and stops every process.
const STOP_PASSES: usize = 5;

/// Milliseconds [`Job::stop_sparing_browsers`] waits for each process it stops to end.
const STOP_WAIT_MILLIS: u32 = 1_000;

/// A process as a system snapshot lists it.
#[derive(Debug, Clone, PartialEq, Eq)]
struct ProcessEntry {
    pid: u32,
    /// Id of the process that started it; that process may have ended and its
    /// id been given to another one.
    parent: u32,
    /// File name of its executable, without the folder.
    exe: String,
}

/// Tells whether `exe` is the file name of a browser of [`BROWSER_EXES`], any case.
fn is_browser(exe: &str) -> bool {
    BROWSER_EXES
        .iter()
        .any(|browser| exe.eq_ignore_ascii_case(browser))
}

/// Returns the ids of the processes of `job` to spare: a browser of
/// [`BROWSER_EXES`] and every process descending from one. A chain of parents
/// is followed only through processes of `job` listed in `processes`, so a
/// stale parent id, or a parent outside the job, ends it.
fn spared_processes(processes: &[ProcessEntry], job: &HashSet<u32>) -> HashSet<u32> {
    let members: HashMap<u32, &ProcessEntry> = processes
        .iter()
        .filter(|process| job.contains(&process.pid))
        .map(|process| (process.pid, process))
        .collect();
    members
        .keys()
        .copied()
        .filter(|&pid| descends_from_browser(pid, &members))
        .collect()
}

/// Tells whether process `pid`, or one of its parents in `members`, is a
/// browser. A loop in the parent chain ends the walk.
fn descends_from_browser(pid: u32, members: &HashMap<u32, &ProcessEntry>) -> bool {
    let mut seen = HashSet::new();
    let mut current = pid;
    while seen.insert(current) {
        let Some(process) = members.get(&current) else {
            return false;
        };
        if is_browser(&process.exe) {
            return true;
        }
        current = process.parent;
    }
    false
}

/// Lists every running process of the system.
///
/// # Errors
/// The system error when the snapshot cannot be taken.
fn process_snapshot() -> io::Result<Vec<ProcessEntry>> {
    // SAFETY: plain call; an invalid handle is checked below.
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    let mut entry = PROCESSENTRY32W {
        dwSize: size_of::<PROCESSENTRY32W>() as u32,
        ..Default::default()
    };
    let mut processes = Vec::new();
    // SAFETY: `snapshot` is open and `entry` has its size set, as the call expects.
    let mut listed = unsafe { Process32FirstW(snapshot, &raw mut entry) };
    while listed != 0 {
        let name = &entry.szExeFile;
        let length = name.iter().position(|&c| c == 0).unwrap_or(name.len());
        processes.push(ProcessEntry {
            pid: entry.th32ProcessID,
            parent: entry.th32ParentProcessID,
            exe: String::from_utf16_lossy(&name[..length]),
        });
        // SAFETY: same as above.
        listed = unsafe { Process32NextW(snapshot, &raw mut entry) };
    }
    // SAFETY: `snapshot` is open and closed only here.
    unsafe { CloseHandle(snapshot) };
    Ok(processes)
}

/// Stops process `pid` if it is still in `job`, without waiting; returns its
/// open handle, which the caller waits on and closes, or `None` when nothing
/// was stopped. The job check keeps the id of an ended process, given to
/// another process since, from being stopped.
fn terminate_member(job: HANDLE, pid: u32) -> Option<HANDLE> {
    let access = PROCESS_TERMINATE | PROCESS_SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION;
    // SAFETY: plain call; a null result is checked below.
    let process = unsafe { OpenProcess(access, 0, pid) };
    if process.is_null() {
        return None;
    }
    let mut in_job: BOOL = 0;
    // SAFETY: both handles are open for the whole call.
    let checked = unsafe { IsProcessInJob(process, job, &raw mut in_job) };
    // SAFETY: `process` is open.
    if checked != 0 && in_job != 0 && unsafe { TerminateProcess(process, TERMINATED_EXIT_CODE) } != 0
    {
        return Some(process);
    }
    // SAFETY: `process` is open; on this path it is closed only here.
    unsafe { CloseHandle(process) };
    None
}

/// A Windows job object holding a session's process and every process it starts,
/// including those that open their own console. None of them may leave it:
/// a start with `CREATE_BREAKAWAY_FROM_JOB` is refused as access denied.
///
/// Dropping it closes the job, which stops every process still in it. The
/// system closes the job the same way when the app ends, even abruptly.
pub struct Job(HANDLE);

// SAFETY: a job handle is a kernel object handle, valid from any thread; `Job`
// owns it alone and only passes it to thread-safe kernel calls.
unsafe impl Send for Job {}

impl Job {
    /// Creates a job that stops its processes when it closes, and puts process
    /// `pid` in it. The processes `pid` starts afterwards join the job too; those
    /// it started before do not.
    ///
    /// # Errors
    /// The system error of the call that failed, for instance when `pid` names
    /// no running process.
    pub fn assign(pid: u32) -> io::Result<Job> {
        let job = Job::create()?;
        job.add(pid)?;
        Ok(job)
    }

    /// Creates an empty, unnamed job that stops its processes when it closes and
    /// lets none of them break away.
    ///
    /// # Errors
    /// The system error of the call that failed.
    fn create() -> io::Result<Job> {
        // SAFETY: null attributes and name are allowed: default security, no name.
        let handle = unsafe { CreateJobObjectW(ptr::null(), ptr::null()) };
        if handle.is_null() {
            return Err(io::Error::last_os_error());
        }
        let job = Job(handle);
        job.set_limits(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE)?;
        Ok(job)
    }

    /// Replaces the job's limits with `flags`. Without
    /// `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, closing the job leaves its
    /// processes running. No flag given here lets a process break away.
    ///
    /// # Errors
    /// The system error of the call that failed.
    fn set_limits(&self, flags: JOB_OBJECT_LIMIT) -> io::Result<()> {
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = flags;
        // SAFETY: `limits` is the structure this information class expects, the
        // length given is its size, and it outlives the call.
        let set = unsafe {
            SetInformationJobObject(
                self.0,
                JobObjectExtendedLimitInformation,
                (&raw const limits).cast(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if set == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    /// Returns the ids of the processes in the job.
    ///
    /// # Errors
    /// The system error of the call that failed.
    fn process_ids(&self) -> io::Result<HashSet<u32>> {
        let header =
            offset_of!(JOBOBJECT_BASIC_PROCESS_ID_LIST, ProcessIdList) / size_of::<usize>();
        let mut capacity = 64;
        loop {
            let mut buffer = vec![0usize; header + capacity];
            // SAFETY: `buffer` is aligned for the structure, its length in bytes
            // is the one given, and it outlives the call.
            let queried = unsafe {
                QueryInformationJobObject(
                    self.0,
                    JobObjectBasicProcessIdList,
                    buffer.as_mut_ptr().cast(),
                    (buffer.len() * size_of::<usize>()) as u32,
                    ptr::null_mut(),
                )
            };
            let error = io::Error::last_os_error();
            if queried == 0 && error.raw_os_error() != Some(ERROR_MORE_DATA as i32) {
                return Err(error);
            }
            // SAFETY: the buffer starts with the structure's two counts.
            let list = unsafe { &*buffer.as_ptr().cast::<JOBOBJECT_BASIC_PROCESS_ID_LIST>() };
            let assigned = list.NumberOfAssignedProcesses as usize;
            let listed = list.NumberOfProcessIdsInList as usize;
            if queried != 0 && assigned <= listed {
                return Ok(buffer[header..header + listed]
                    .iter()
                    .map(|&pid| pid as u32)
                    .collect());
            }
            capacity = assigned.max(capacity * 2);
        }
    }

    /// Stops every process in the job except the browsers of [`BROWSER_EXES`]
    /// and their descendants, then lets closing the job leave those running.
    /// With no browser in the job, stops everything as [`Job::terminate`] does.
    ///
    /// The job is read again after each pass, for processes started during it.
    /// After [`STOP_PASSES`] passes that each still found a process to stop, or
    /// on any system error, every process is stopped, browsers included. Each
    /// pass waits up to [`STOP_WAIT_MILLIS`] per stopped process. Failures are
    /// ignored, as in [`Job::terminate`].
    pub fn stop_sparing_browsers(&self) {
        for _ in 0..STOP_PASSES {
            let Ok(members) = self.process_ids() else {
                break;
            };
            let Ok(processes) = process_snapshot() else {
                break;
            };
            let spared = spared_processes(&processes, &members);
            if spared.is_empty() {
                break;
            }
            if members.len() == spared.len() {
                if self.set_limits(0).is_ok() {
                    return;
                }
                break;
            }
            let stopped: Vec<HANDLE> = members
                .difference(&spared)
                .filter_map(|&pid| terminate_member(self.0, pid))
                .collect();
            for process in stopped {
                // SAFETY: `process` is open and closed only here.
                unsafe {
                    WaitForSingleObject(process, STOP_WAIT_MILLIS);
                    CloseHandle(process);
                }
            }
        }
        self.terminate();
    }

    /// Puts process `pid` in the job.
    ///
    /// # Errors
    /// The system error when the process cannot be opened or assigned.
    fn add(&self, pid: u32) -> io::Result<()> {
        // SAFETY: plain call; a null result is handled below.
        let process = unsafe { OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid) };
        if process.is_null() {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: both handles are open and owned here.
        let assigned = unsafe { AssignProcessToJobObject(self.0, process) };
        let error = io::Error::last_os_error();
        // SAFETY: `process` is open and closed only here.
        unsafe { CloseHandle(process) };
        if assigned == 0 { Err(error) } else { Ok(()) }
    }

    /// Stops every process in the job. Failures are ignored: the job also stops
    /// them when it is dropped.
    pub fn terminate(&self) {
        // SAFETY: `self.0` is an open job handle until drop.
        unsafe { TerminateJobObject(self.0, TERMINATED_EXIT_CODE) };
    }
}

impl Drop for Job {
    /// Closes the job handle, which stops every process still in the job.
    fn drop(&mut self) {
        // SAFETY: `self.0` is open and closed only here.
        unsafe { CloseHandle(self.0) };
    }
}

#[cfg(test)]
mod tests {
    use std::env;
    use std::io::{BufRead, BufReader, Write};
    use std::os::windows::io::AsRawHandle;
    use std::os::windows::process::CommandExt;
    use std::process::{Child, Command, Stdio};
    use std::thread;
    use std::time::{Duration, Instant};

    use std::fs;
    use std::path::{Path, PathBuf};

    use windows_sys::Win32::Foundation::WAIT_OBJECT_0;
    use windows_sys::Win32::System::Threading::CREATE_BREAKAWAY_FROM_JOB;

    use super::*;

    /// Starts a process that waits about 30 seconds without output.
    fn long_process() -> Child {
        Command::new("ping")
            .args(["-n", "30", "127.0.0.1"])
            .stdout(Stdio::null())
            .spawn()
            .expect("ping starts")
    }

    /// Waits up to 5 seconds for `child` to end; tells whether it did.
    fn ends_soon(child: &mut Child) -> bool {
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if child.try_wait().expect("child can be polled").is_some() {
                return true;
            }
            thread::sleep(Duration::from_millis(100));
        }
        false
    }

    #[test]
    fn assigned_process_is_in_the_job() {
        let mut child = long_process();
        let job = Job::assign(child.id()).unwrap();
        let mut in_job: BOOL = 0;
        // SAFETY: both handles are open for the whole call.
        let checked = unsafe { IsProcessInJob(child.as_raw_handle(), job.0, &raw mut in_job) };
        assert_ne!(checked, 0);
        assert_ne!(in_job, 0);
        let _ = child.kill();
    }

    #[test]
    fn dropping_the_job_stops_its_process() {
        let mut child = long_process();
        let job = Job::assign(child.id()).unwrap();
        drop(job);
        let ended = ends_soon(&mut child);
        let _ = child.kill();
        assert!(ended, "the process survived the job");
    }

    #[test]
    fn terminate_stops_its_process() {
        let mut child = long_process();
        let job = Job::assign(child.id()).unwrap();
        job.terminate();
        let ended = ends_soon(&mut child);
        let _ = child.kill();
        assert!(ended, "the process survived terminate");
    }

    #[test]
    fn assigning_a_missing_process_fails() {
        assert!(Job::assign(0).is_err());
    }

    /// Variable that turns a run of this test binary into [`spawning_helper`].
    const HELPER_VAR: &str = "CLOITRE_TEST_SPAWNING_HELPER";

    /// Prefix of the line on which [`spawning_helper`] reports what it started.
    const REPORT: &str = "SPAWNED:";

    /// A process opened by id, stopped and closed on drop.
    struct Process(HANDLE);

    impl Process {
        /// Opens process `pid` to wait for it and stop it.
        fn open(pid: u32) -> Process {
            // SAFETY: plain call; a null result is checked below.
            let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE | PROCESS_TERMINATE, 0, pid) };
            assert!(!handle.is_null(), "process {pid} cannot be opened");
            Process(handle)
        }

        /// Waits up to `millis` milliseconds for the process to end; tells whether it did.
        fn ends_within(&self, millis: u32) -> bool {
            // SAFETY: `self.0` is open until drop.
            unsafe { WaitForSingleObject(self.0, millis) == WAIT_OBJECT_0 }
        }
    }

    impl Drop for Process {
        /// Stops the process if it still runs and closes its handle.
        fn drop(&mut self) {
            // SAFETY: `self.0` is open and closed only here.
            unsafe {
                TerminateProcess(self.0, TERMINATED_EXIT_CODE);
                CloseHandle(self.0);
            }
        }
    }

    /// What [`spawning_helper`] reported: the ids of its two children, or the
    /// kind of the error that refused the breakaway one.
    enum Spawned {
        Children { breakaway: u32, attached: u32 },
        Refused(String),
    }

    /// Starts this test binary as [`spawning_helper`], puts it in the job that
    /// `job` makes from its id, lets it start its children and returns the job,
    /// the helper and its report.
    fn spawn_helper_in(job: impl FnOnce(u32) -> Job) -> (Job, Child, Spawned) {
        let mut helper = Command::new(env::current_exe().unwrap())
            .args([
                "pty::windows_job::tests::spawning_helper",
                "--exact",
                "--nocapture",
                "--test-threads=1",
            ])
            .env(HELPER_VAR, "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("the helper starts");
        let job = job(helper.id());
        writeln!(helper.stdin.take().unwrap(), "go").unwrap();
        let report = BufReader::new(helper.stdout.take().unwrap())
            .lines()
            .map(Result::unwrap)
            .find_map(|line| Some(line.split_once(REPORT)?.1.trim().to_owned()))
            .expect("the helper reports");
        let spawned = match report.split_once(' ') {
            Some(("refused", kind)) => Spawned::Refused(kind.to_owned()),
            Some((breakaway, attached)) => Spawned::Children {
                breakaway: breakaway.parse().unwrap(),
                attached: attached.parse().unwrap(),
            },
            None => panic!("unexpected report {report:?}"),
        };
        (job, helper, spawned)
    }

    /// Not a check: when [`HELPER_VAR`] is set, waits for a line on stdin, then
    /// starts a `ping` without `CREATE_BREAKAWAY_FROM_JOB` and one with it,
    /// prints their ids after [`REPORT`] (or `refused <error kind>`) and waits.
    #[test]
    fn spawning_helper() {
        if env::var_os(HELPER_VAR).is_none() {
            return;
        }
        std::io::stdin().read_line(&mut String::new()).unwrap();
        let ping = || {
            let mut command = Command::new("ping");
            command
                .args(["-n", "30", "127.0.0.1"])
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            command
        };
        let mut attached = ping().spawn().expect("ping starts");
        match ping().creation_flags(CREATE_BREAKAWAY_FROM_JOB).spawn() {
            Ok(breakaway) => println!("\n{REPORT} {} {}", breakaway.id(), attached.id()),
            Err(error) => println!("\n{REPORT} refused {:?}", error.kind()),
        }
        std::io::stdout().flush().unwrap();
        let _ = attached.wait();
    }

    #[test]
    fn a_child_asking_to_break_away_cannot_leave_the_job() {
        let (job, mut helper, spawned) = spawn_helper_in(|pid| Job::assign(pid).unwrap());
        let (breakaway, attached) = match spawned {
            Spawned::Children {
                breakaway,
                attached,
            } => (breakaway, attached),
            Spawned::Refused(kind) => {
                let _ = helper.kill();
                assert_eq!(kind, "PermissionDenied");
                return;
            }
        };
        let breakaway = Process::open(breakaway);
        let attached = Process::open(attached);
        job.terminate();
        let attached_ended = attached.ends_within(5_000);
        let breakaway_ended = breakaway.ends_within(5_000);
        let _ = helper.kill();
        assert!(attached_ended, "the plain child survived terminate");
        assert!(
            breakaway_ended,
            "a child started with CREATE_BREAKAWAY_FROM_JOB survived terminate"
        );
    }

    /// Builds a snapshot entry.
    fn entry(pid: u32, parent: u32, exe: &str) -> ProcessEntry {
        ProcessEntry {
            pid,
            parent,
            exe: exe.to_owned(),
        }
    }

    /// Builds a set of process ids.
    fn ids(pids: &[u32]) -> HashSet<u32> {
        pids.iter().copied().collect()
    }

    #[test]
    fn a_browser_and_all_its_descendants_are_spared() {
        let processes = [
            entry(1, 0, "claude.exe"),
            entry(2, 1, "chrome.exe"),
            entry(3, 2, "chrome.exe"),
            entry(4, 2, "cmd.exe"),
            entry(5, 4, "claude.exe"),
            entry(6, 1, "node.exe"),
            entry(7, 6, "bash.exe"),
        ];
        let spared = spared_processes(&processes, &ids(&[1, 2, 3, 4, 5, 6, 7]));
        assert_eq!(spared, ids(&[2, 3, 4, 5]));
    }

    #[test]
    fn every_browser_name_is_recognised_in_any_case() {
        let processes = [
            entry(1, 0, "Chrome.EXE"),
            entry(2, 0, "MSEDGE.exe"),
            entry(3, 0, "brave.exe"),
            entry(4, 0, "Vivaldi.exe"),
            entry(5, 0, "OPERA.EXE"),
            entry(6, 0, "notchrome.exe"),
            entry(7, 0, "chrome.exe.bak"),
        ];
        let spared = spared_processes(&processes, &ids(&[1, 2, 3, 4, 5, 6, 7]));
        assert_eq!(spared, ids(&[1, 2, 3, 4, 5]));
    }

    #[test]
    fn a_parent_outside_the_job_ends_the_chain() {
        let processes = [
            entry(10, 20, "node.exe"),
            entry(20, 0, "chrome.exe"),
            entry(11, 30, "node.exe"),
        ];
        let spared = spared_processes(&processes, &ids(&[10, 11, 30]));
        assert!(spared.is_empty(), "spared {spared:?}");
    }

    #[test]
    fn a_job_without_browser_spares_nothing() {
        let processes = [
            entry(1, 0, "claude.exe"),
            entry(2, 1, "bash.exe"),
            entry(3, 2, "node.exe"),
        ];
        assert!(spared_processes(&processes, &ids(&[1, 2, 3])).is_empty());
    }

    #[test]
    fn a_loop_in_the_parent_chain_spares_nothing() {
        let processes = [entry(1, 2, "node.exe"), entry(2, 1, "bash.exe")];
        assert!(spared_processes(&processes, &ids(&[1, 2])).is_empty());
    }

    #[test]
    fn stopping_a_job_without_browser_stops_its_process() {
        let mut child = long_process();
        let job = Job::assign(child.id()).unwrap();
        job.stop_sparing_browsers();
        let ended = ends_soon(&mut child);
        let _ = child.kill();
        assert!(ended, "the process survived stop_sparing_browsers");
    }

    /// Starts `program`, a copy of `cmd.exe`, so that it waits for a line on its
    /// stdin, then starts a `ping` of about 30 seconds and waits for it.
    fn gated_shell(program: &Path) -> Child {
        Command::new(program)
            .raw_arg(r#"/d /c "set /p x= & ping -n 30 127.0.0.1 >nul""#)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("the shell starts")
    }

    /// Releases a [`gated_shell`] and waits up to 5 seconds for the `ping` it
    /// starts; returns that `ping`'s id.
    fn release(shell: &mut Child) -> u32 {
        writeln!(shell.stdin.take().unwrap(), "go").unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            let child = process_snapshot()
                .unwrap()
                .into_iter()
                .find(|process| {
                    process.parent == shell.id() && process.exe.eq_ignore_ascii_case("ping.exe")
                });
            if let Some(child) = child {
                return child.pid;
            }
            thread::sleep(Duration::from_millis(50));
        }
        panic!("the shell {} started no ping", shell.id());
    }

    /// Makes an empty folder of its own under the system's temporary folder.
    fn scratch_folder() -> PathBuf {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let folder = env::temp_dir().join(format!(
            "cloitre-browser-test-{}-{stamp}",
            std::process::id()
        ));
        fs::create_dir_all(&folder).unwrap();
        folder
    }

    #[test]
    fn stopping_spares_a_browser_and_its_child_and_stops_the_rest() {
        let system = PathBuf::from(env::var_os("SystemRoot").expect("SystemRoot is set"));
        let cmd = system.join("System32").join("cmd.exe");
        let folder = scratch_folder();
        let browser_exe = folder.join("chrome.exe");
        fs::copy(&cmd, &browser_exe).unwrap();

        let mut shell = gated_shell(&cmd);
        let mut browser = gated_shell(&browser_exe);
        let job = Job::assign(shell.id()).unwrap();
        job.add(browser.id()).unwrap();
        let shell_child = Process::open(release(&mut shell));
        let browser_child = Process::open(release(&mut browser));
        let shell_process = Process::open(shell.id());
        let browser_process = Process::open(browser.id());

        job.stop_sparing_browsers();
        drop(job);
        let shell_ended = shell_process.ends_within(5_000);
        let shell_child_ended = shell_child.ends_within(5_000);
        let browser_ended = browser_process.ends_within(1_000);
        let browser_child_ended = browser_child.ends_within(0);

        drop((shell_child, browser_child, shell_process, browser_process));
        let _ = shell.wait();
        let _ = browser.wait();
        let _ = fs::remove_dir_all(&folder);

        assert!(shell_ended, "a process outside the browser survived");
        assert!(shell_child_ended, "the child of that process survived");
        assert!(!browser_ended, "the browser was stopped");
        assert!(!browser_child_ended, "the child of the browser was stopped");
    }
}
