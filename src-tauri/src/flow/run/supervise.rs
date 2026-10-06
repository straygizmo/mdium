//! Detached command processes (spec 4.6 / 5.4): a small supervisor (a mode
//! of the MDium executable) starts the command, waits for it, and writes
//! `exit.json`. MDium can exit while the supervisor keeps running; on the
//! next start it reconnects by pid **and** process creation time, so a
//! reused pid is never mistaken for the supervisor.

use crate::flow::run::process::{
    build_command, kill_tree_by_pid, LaunchSpec, Launcher, ProcessHandle,
};
use crate::workflow::fsutil;
use serde::{Deserialize, Serialize};
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};

/// Command-line flag that runs the MDium executable as a supervisor.
pub const SUPERVISE_FLAG: &str = "--flow-supervise";

/// What the supervisor starts (`supervise.json` in the attempt directory).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SuperviseSpec {
    pub argv: Vec<String>,
    pub shell: bool,
    pub working_dir: PathBuf,
    pub env: Vec<(String, String)>,
    pub stdout: PathBuf,
    pub stderr: PathBuf,
    pub exit_file: PathBuf,
}

/// `exit.json`, written atomically when the command ended.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExitRecord {
    pub code: i32,
    pub finished_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

pub fn read_exit(path: &Path) -> Option<ExitRecord> {
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}

fn write_exit(path: &Path, code: i32, error: Option<String>) {
    let record = ExitRecord {
        code,
        finished_at: fsutil::now(),
        error,
    };
    if let Ok(json) = serde_json::to_vec(&record) {
        let _ = fsutil::atomic_write(path, &json);
    }
}

/// Supervisor main: start the command, wait, record the exit. Returns the
/// command's exit code (also the supervisor's).
pub fn supervise(spec_path: &Path) -> i32 {
    let spec: SuperviseSpec = match std::fs::read(spec_path)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
    {
        Some(spec) => spec,
        None => return 2,
    };
    let launch = LaunchSpec {
        argv: spec.argv.clone(),
        shell: spec.shell,
        working_dir: spec.working_dir.clone(),
        env: spec.env.clone(),
        stdout: spec.stdout.clone(),
        stderr: spec.stderr.clone(),
        node_dir: spec_path
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_default(),
        // Same process group / tree as the supervisor, so killing it kills both.
        new_group: false,
    };
    let result = build_command(&launch)
        .and_then(|mut c| c.spawn())
        .and_then(|mut child| child.wait());
    match result {
        Ok(status) => {
            let code = status.code().unwrap_or(-1);
            write_exit(&spec.exit_file, code, None);
            code
        }
        Err(err) => {
            write_exit(&spec.exit_file, -1, Some(err.to_string()));
            -1
        }
    }
}

/// Runs the supervisor when the process was started with [`SUPERVISE_FLAG`].
/// Returns the exit code to use, or `None` for a normal app start.
pub fn supervise_from_args(args: &[String]) -> Option<i32> {
    match args {
        [_, flag, spec, ..] if flag == SUPERVISE_FLAG => Some(supervise(Path::new(spec))),
        _ => None,
    }
}

/// An identity token for a live process: its creation time as the OS
/// reports it. `None` when the process does not exist (or cannot be queried).
pub fn process_identity(pid: u32) -> Option<String> {
    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::{CloseHandle, FILETIME, STILL_ACTIVE};
        use windows_sys::Win32::System::Threading::{
            GetExitCodeProcess, GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        };
        // SAFETY: plain Win32 calls on a handle we open and close here.
        unsafe {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if handle.is_null() {
                return None;
            }
            let mut exit_code = 0u32;
            let alive =
                GetExitCodeProcess(handle, &mut exit_code) != 0 && exit_code == STILL_ACTIVE as u32;
            let zero = FILETIME {
                dwLowDateTime: 0,
                dwHighDateTime: 0,
            };
            let (mut created, mut exited, mut kernel, mut user) = (zero, zero, zero, zero);
            let ok =
                GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user) != 0;
            CloseHandle(handle);
            if !ok || !alive {
                return None;
            }
            let ticks =
                (u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime);
            Some(format!("win:{ticks}"))
        }
    }
    #[cfg(target_os = "linux")]
    {
        // Field 22 of /proc/<pid>/stat: start time in clock ticks since boot.
        let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
        let after_comm = &stat[stat.rfind(')')? + 1..];
        let fields: Vec<&str> = after_comm.split_whitespace().collect();
        if fields.first() == Some(&"Z") {
            return None; // zombie: already exited
        }
        fields.get(19).map(|start| format!("linux:{start}"))
    }
    #[cfg(all(unix, not(target_os = "linux")))]
    {
        // Fallback without /proc (macOS, BSD): `ps` reports the start time.
        let out = Command::new("ps")
            .args(["-o", "lstart=", "-p", &pid.to_string()])
            .output()
            .ok()?;
        let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
        (!text.is_empty()).then(|| format!("ps:{text}"))
    }
}

/// Launches commands through the supervisor, detached from MDium.
pub struct DetachedLauncher {
    /// The supervisor executable and the arguments before the spec path
    /// (in the app: `[current_exe, "--flow-supervise"]`).
    pub supervisor: Vec<String>,
    /// Extra environment for the supervisor itself (tests use it).
    pub supervisor_env: Vec<(String, String)>,
}

impl DetachedLauncher {
    pub fn for_current_exe() -> io::Result<Self> {
        let exe = std::env::current_exe()?;
        Ok(Self {
            supervisor: vec![
                exe.to_string_lossy().into_owned(),
                SUPERVISE_FLAG.to_string(),
            ],
            supervisor_env: vec![],
        })
    }
}

impl Launcher for DetachedLauncher {
    fn launch(&self, spec: &LaunchSpec) -> io::Result<Box<dyn ProcessHandle>> {
        let spec_path = spec.node_dir.join("supervise.json");
        let exit_file = spec.node_dir.join("exit.json");
        let _ = std::fs::remove_file(&exit_file);
        let supervise_spec = SuperviseSpec {
            argv: spec.argv.clone(),
            shell: spec.shell,
            working_dir: spec.working_dir.clone(),
            env: spec.env.clone(),
            stdout: spec.stdout.clone(),
            stderr: spec.stderr.clone(),
            exit_file: exit_file.clone(),
        };
        fsutil::atomic_write(
            &spec_path,
            &serde_json::to_vec_pretty(&supervise_spec).map_err(io::Error::other)?,
        )?;
        let (program, args) = self
            .supervisor
            .split_first()
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "no supervisor"))?;
        let mut command = Command::new(program);
        command
            .args(args)
            .arg(&spec_path)
            .envs(self.supervisor_env.iter().map(|(k, v)| (k, v)))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let child = spawn_detached(command)?;
        let pid = child.id();
        let identity = process_identity(pid);
        Ok(Box::new(DetachedProcess {
            pid,
            identity,
            exit_file,
            child: Some(child),
        }))
    }
}

/// Spawns so the process outlives MDium: its own process group, no console,
/// and (Windows) outside MDium's job object when the job allows it.
fn spawn_detached(mut command: Command) -> io::Result<Child> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
        command.creation_flags(
            CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP | CREATE_BREAKAWAY_FROM_JOB,
        );
        match command.spawn() {
            Ok(child) => Ok(child),
            // The job forbids breakaway: start inside it (the process may then end with MDium).
            Err(err) if err.raw_os_error() == Some(5) => {
                command.creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP);
                command.spawn()
            }
            Err(err) => Err(err),
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
        command.spawn()
    }
}

/// A supervised process, started now or reconnected after a restart.
pub struct DetachedProcess {
    pid: u32,
    /// Creation-time identity captured at launch (`None` if it could not be read).
    identity: Option<String>,
    exit_file: PathBuf,
    /// Present when this MDium process started it (reaped to avoid zombies).
    child: Option<Child>,
}

impl DetachedProcess {
    /// Reconnects to a supervisor recorded in a `process` event, if it is
    /// still the same process or already left its `exit.json`.
    pub fn reconnect(pid: u32, identity: &str, exit_file: &Path) -> Option<Self> {
        let me = Self {
            pid,
            identity: Some(identity.to_string()),
            exit_file: exit_file.to_path_buf(),
            child: None,
        };
        if exit_file.exists() || me.alive() {
            Some(me)
        } else {
            None
        }
    }

    /// The recorded process still runs (same pid and creation time).
    fn alive(&self) -> bool {
        match (&self.identity, process_identity(self.pid)) {
            (Some(expected), Some(actual)) => *expected == actual,
            _ => false,
        }
    }
}

impl ProcessHandle for DetachedProcess {
    fn pid(&self) -> u32 {
        self.pid
    }

    fn try_wait(&mut self) -> io::Result<Option<i32>> {
        if let Some(record) = read_exit(&self.exit_file) {
            if let Some(child) = self.child.as_mut() {
                let _ = child.wait();
            }
            return Ok(Some(record.code));
        }
        let running = match self.child.as_mut() {
            Some(child) => child.try_wait()?.is_none(),
            None => self.alive(),
        };
        if running {
            return Ok(None);
        }
        // The supervisor may have exited just after writing exit.json.
        if let Some(record) = read_exit(&self.exit_file) {
            return Ok(Some(record.code));
        }
        // Gone without a record (killed): report an abnormal end.
        Ok(Some(-1))
    }

    fn kill_tree(&mut self) {
        let ours = self
            .child
            .as_mut()
            .map(|c| matches!(c.try_wait(), Ok(None)))
            .unwrap_or(false);
        // Never kill a pid that now belongs to another process.
        if ours || self.alive() {
            kill_tree_by_pid(self.pid);
        }
        if let Some(child) = self.child.as_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    fn identity(&self) -> Option<String> {
        self.identity.clone()
    }

    fn exit_file(&self) -> Option<PathBuf> {
        Some(self.exit_file.clone())
    }

    fn survives_app_exit(&self) -> bool {
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_of_this_process_is_stable_and_absent_for_dead_pids() {
        let me = std::process::id();
        let a = process_identity(me).expect("own identity");
        assert_eq!(process_identity(me), Some(a));
        // A process that exited has no identity.
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "nothing::matches", "--quiet"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let pid = child.id();
        child.wait().unwrap();
        assert_eq!(process_identity(pid), None);
    }

    #[test]
    fn supervise_args_are_recognized() {
        let args = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(supervise_from_args(&args(&["mdium"])), None);
        assert_eq!(supervise_from_args(&args(&["mdium", "--other", "x"])), None);
        // A missing spec makes the supervisor exit with 2.
        assert_eq!(
            supervise_from_args(&args(&["mdium", SUPERVISE_FLAG, "/no/such/spec.json"])),
            Some(2)
        );
    }

    #[test]
    fn reconnect_requires_a_live_matching_process_or_an_exit_record() {
        let tmp = tempfile::tempdir().unwrap();
        let exit = tmp.path().join("exit.json");
        let me = std::process::id();
        let identity = process_identity(me).unwrap();
        assert!(DetachedProcess::reconnect(me, &identity, &exit).is_some());
        assert!(
            DetachedProcess::reconnect(me, "win:1", &exit).is_none(),
            "pid reused by another process"
        );
        write_exit(&exit, 4, None);
        let mut done = DetachedProcess::reconnect(me, "win:1", &exit).expect("exit record");
        assert_eq!(done.try_wait().unwrap(), Some(4));
        assert_eq!(read_exit(&exit).unwrap().code, 4);
    }
}
