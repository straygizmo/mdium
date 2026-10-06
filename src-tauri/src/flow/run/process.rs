//! Child processes of command nodes: launching (stdout/stderr to files,
//! no console window on Windows), killing the whole process tree, reading
//! the `mdium-v1` protocol by tailing the events file (spec 5.3), and
//! deciding the node's result from the protocol outcome and exit code.

use serde_json::Value;
use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};

/// What to start.
#[derive(Debug, Clone, PartialEq)]
pub struct LaunchSpec {
    /// argv (program first), or a single shell string when `shell` is true.
    pub argv: Vec<String>,
    pub shell: bool,
    pub working_dir: PathBuf,
    pub env: Vec<(String, String)>,
    pub stdout: PathBuf,
    pub stderr: PathBuf,
    /// The attempt directory (the detached launcher keeps its files there).
    pub node_dir: PathBuf,
    /// Unix: start a new process group (so the whole tree can be killed).
    pub new_group: bool,
}

/// A started process.
pub trait ProcessHandle: Send {
    fn pid(&self) -> u32;
    /// `Some(exit code)` once it exited (`-1` when killed by a signal).
    fn try_wait(&mut self) -> io::Result<Option<i32>>;
    /// Ends the process and everything it started.
    fn kill_tree(&mut self);
    /// OS creation-time identity (detached processes; used to reconnect).
    fn identity(&self) -> Option<String> {
        None
    }
    /// Where the supervisor records the exit (detached processes).
    fn exit_file(&self) -> Option<PathBuf> {
        None
    }
    /// Keeps running when MDium exits (detached processes).
    fn survives_app_exit(&self) -> bool {
        false
    }
}

/// Starts processes (replaceable in tests and by the detached launcher).
pub trait Launcher: Send + Sync {
    fn launch(&self, spec: &LaunchSpec) -> io::Result<Box<dyn ProcessHandle>>;
}

/// Builds the OS command for a spec (shell strings go through `cmd /C` or `sh -c`).
pub fn build_command(spec: &LaunchSpec) -> io::Result<Command> {
    let mut command = if spec.shell {
        let script = spec.argv.first().cloned().unwrap_or_default();
        if cfg!(windows) {
            let mut c = Command::new("cmd");
            c.arg("/D").arg("/S").arg("/C");
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                // Pass the script verbatim; `/S` strips the outer quotes.
                c.raw_arg(format!("\"{script}\""));
            }
            c
        } else {
            let mut c = Command::new("sh");
            c.arg("-c").arg(script);
            c
        }
    } else {
        let program = spec
            .argv
            .first()
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "empty argv"))?;
        let mut c = Command::new(program);
        c.args(&spec.argv[1..]);
        c
    };
    command.current_dir(&spec.working_dir);
    command.envs(spec.env.iter().map(|(k, v)| (k, v)));
    command.stdin(Stdio::null());
    command.stdout(Stdio::from(File::create(&spec.stdout)?));
    command.stderr(Stdio::from(File::create(&spec.stderr)?));
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        if spec.new_group {
            command.process_group(0);
        }
    }
    Ok(command)
}

/// Kills a process tree by pid (best effort).
pub fn kill_tree_by_pid(pid: u32) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(0x0800_0000)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    #[cfg(unix)]
    {
        // The child leads its own process group (see `build_command`).
        let _ = Command::new("kill")
            .args(["-KILL", &format!("-{pid}")])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

/// A child of this process.
pub struct AttachedProcess {
    child: Child,
}

impl ProcessHandle for AttachedProcess {
    fn pid(&self) -> u32 {
        self.child.id()
    }

    fn try_wait(&mut self) -> io::Result<Option<i32>> {
        Ok(self
            .child
            .try_wait()?
            .map(|status| status.code().unwrap_or(-1)))
    }

    fn kill_tree(&mut self) {
        if matches!(self.child.try_wait(), Ok(Some(_))) {
            return;
        }
        kill_tree_by_pid(self.child.id());
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Launches processes as children of MDium (they end with it).
pub struct AttachedLauncher;

impl Launcher for AttachedLauncher {
    fn launch(&self, spec: &LaunchSpec) -> io::Result<Box<dyn ProcessHandle>> {
        let child = build_command(spec)?.spawn()?;
        Ok(Box::new(AttachedProcess { child }))
    }
}

/// Protocol limits (spec 5.3).
pub const MAX_LINE_BYTES: usize = 64 * 1024;
pub const MAX_LINES: usize = 100_000;

/// `outcome.status` of the protocol.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "status", content = "detail", rename_all = "snake_case")]
pub enum ProtocolOutcome {
    Ok,
    Fail(Option<String>),
    NeedsApproval(Option<String>),
    Stopped,
}

/// One parsed protocol line.
#[derive(Debug, Clone, PartialEq)]
pub enum ProtocolItem {
    Progress {
        text: String,
        fraction: Option<f64>,
    },
    Cost {
        usd: f64,
        estimated: bool,
        provider: Option<String>,
        model: Option<String>,
        units: Option<Value>,
    },
    Output {
        key: String,
        value: Value,
    },
    Artifact {
        path: String,
        label: Option<String>,
    },
    Outcome(ProtocolOutcome),
    /// A line that was dropped (`reason`: too-long / too-many / invalid / ...).
    Warning {
        reason: &'static str,
        line: usize,
    },
}

/// Parses one protocol line (without the newline).
pub fn parse_line(line: &str) -> Result<ProtocolItem, &'static str> {
    let value: Value = serde_json::from_str(line).map_err(|_| "invalid-json")?;
    let obj = value.as_object().ok_or("not-an-object")?;
    if obj.get("v").and_then(Value::as_u64) != Some(1) {
        return Err("unsupported-version");
    }
    let s = |key: &str| obj.get(key).and_then(Value::as_str).map(String::from);
    match obj.get("type").and_then(Value::as_str) {
        Some("progress") => Ok(ProtocolItem::Progress {
            text: s("text").ok_or("missing-text")?,
            fraction: obj
                .get("fraction")
                .and_then(Value::as_f64)
                .filter(|f| (0.0..=1.0).contains(f)),
        }),
        Some("cost") => {
            let usd = obj
                .get("usd")
                .and_then(Value::as_f64)
                .filter(|v| v.is_finite() && *v >= 0.0)
                .ok_or("bad-usd")?;
            let estimated = match obj.get("kind").and_then(Value::as_str) {
                Some("actual") | None => false,
                Some("estimated") => true,
                Some(_) => return Err("bad-kind"),
            };
            Ok(ProtocolItem::Cost {
                usd,
                estimated,
                provider: s("provider"),
                model: s("model"),
                units: obj.get("units").cloned(),
            })
        }
        Some("output") => Ok(ProtocolItem::Output {
            key: s("key")
                .filter(|k| crate::flow::template::is_ident(k))
                .ok_or("bad-key")?,
            value: obj.get("value").cloned().unwrap_or(Value::Null),
        }),
        Some("artifact") => Ok(ProtocolItem::Artifact {
            path: s("path").ok_or("missing-path")?,
            label: s("label"),
        }),
        Some("outcome") => Ok(ProtocolItem::Outcome(
            match obj.get("status").and_then(Value::as_str) {
                Some("ok") => ProtocolOutcome::Ok,
                Some("fail") => ProtocolOutcome::Fail(s("reason")),
                Some("needs_approval") => ProtocolOutcome::NeedsApproval(s("message")),
                Some("stopped") => ProtocolOutcome::Stopped,
                _ => return Err("bad-status"),
            },
        )),
        _ => Err("unknown-type"),
    }
}

/// Follows a growing protocol file.
pub struct ProtocolReader {
    path: PathBuf,
    offset: u64,
    partial: Vec<u8>,
    skipping_long_line: bool,
    lines: usize,
    limit_warned: bool,
}

impl ProtocolReader {
    #[cfg(test)]
    pub fn new(path: &Path) -> Self {
        Self::resume(path, 0, 0)
    }

    /// Continues after `offset` bytes / `lines` lines already consumed.
    pub fn resume(path: &Path, offset: u64, lines: usize) -> Self {
        Self {
            path: path.to_path_buf(),
            offset,
            partial: Vec::new(),
            skipping_long_line: false,
            lines,
            limit_warned: lines > MAX_LINES,
        }
    }

    /// Bytes consumed up to the last complete line (safe point to resume from).
    pub fn committed_offset(&self) -> u64 {
        self.offset - self.partial.len() as u64
    }

    pub fn lines(&self) -> usize {
        self.lines
    }

    /// New complete lines since the last call; with `final_read`, a last
    /// line without a newline is taken too (the writer has exited).
    pub fn poll(&mut self, final_read: bool) -> Vec<ProtocolItem> {
        let mut items = Vec::new();
        let mut buf = Vec::new();
        if let Ok(mut file) = File::open(&self.path) {
            if file.seek(SeekFrom::Start(self.offset)).is_ok() {
                let _ = file.read_to_end(&mut buf);
            }
        }
        self.offset += buf.len() as u64;
        for byte in buf {
            if byte == b'\n' {
                let line = std::mem::take(&mut self.partial);
                if std::mem::take(&mut self.skipping_long_line) {
                    continue;
                }
                self.take_line(&line, &mut items);
            } else if self.skipping_long_line {
                continue;
            } else {
                self.partial.push(byte);
                if self.partial.len() > MAX_LINE_BYTES {
                    self.partial.clear();
                    self.skipping_long_line = true;
                    self.lines += 1;
                    items.push(ProtocolItem::Warning {
                        reason: "line-too-long",
                        line: self.lines,
                    });
                }
            }
        }
        if final_read && !self.partial.is_empty() && !self.skipping_long_line {
            let line = std::mem::take(&mut self.partial);
            self.take_line(&line, &mut items);
        }
        items
    }

    fn take_line(&mut self, raw: &[u8], items: &mut Vec<ProtocolItem>) {
        let text = String::from_utf8_lossy(raw);
        let text = text.trim();
        if text.is_empty() {
            return;
        }
        self.lines += 1;
        if self.lines > MAX_LINES {
            if !self.limit_warned {
                self.limit_warned = true;
                items.push(ProtocolItem::Warning {
                    reason: "too-many-lines",
                    line: self.lines,
                });
            }
            return;
        }
        match parse_line(text) {
            Ok(item) => items.push(item),
            Err(reason) => items.push(ProtocolItem::Warning {
                reason,
                line: self.lines,
            }),
        }
    }
}

/// The node result decided from the process end (spec 5.3).
#[derive(Debug, Clone, PartialEq)]
pub enum CommandResult {
    Succeeded,
    Failed {
        code: &'static str,
        detail: Option<String>,
    },
    NeedsApproval(Option<String>),
    /// Ended at a boundary because a stop was requested.
    Stopped,
}

/// `fail` (outcome or exit code) wins over everything else.
pub fn decide(
    outcome: Option<&ProtocolOutcome>,
    exit_code: i32,
    success_codes: &[i32],
) -> CommandResult {
    let exit_ok = success_codes.contains(&exit_code);
    match outcome {
        Some(ProtocolOutcome::Fail(reason)) => CommandResult::Failed {
            code: "FLOW_COMMAND_REPORTED_FAILURE",
            detail: reason.clone(),
        },
        _ if !exit_ok => CommandResult::Failed {
            code: "FLOW_COMMAND_EXIT_CODE",
            detail: Some(exit_code.to_string()),
        },
        Some(ProtocolOutcome::NeedsApproval(message)) => {
            CommandResult::NeedsApproval(message.clone())
        }
        Some(ProtocolOutcome::Stopped) => CommandResult::Stopped,
        Some(ProtocolOutcome::Ok) | None => CommandResult::Succeeded,
    }
}

/// Last `max_bytes` of a log file (lossy UTF-8, starting at a line break when possible).
pub fn tail_file(path: &Path, max_bytes: u64) -> io::Result<String> {
    let mut file = match File::open(path) {
        Ok(file) => file,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(String::new()),
        Err(err) => return Err(err),
    };
    let len = file.metadata()?.len();
    let start = len.saturating_sub(max_bytes);
    file.seek(SeekFrom::Start(start))?;
    let mut buf = Vec::new();
    file.read_to_end(&mut buf)?;
    if start > 0 {
        if let Some(i) = buf.iter().position(|b| *b == b'\n') {
            buf.drain(..=i);
        }
    }
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;
    use std::io::Write;

    #[test]
    fn parses_protocol_lines() {
        assert_eq!(
            parse_line(r#"{"v":1,"type":"progress","text":"3/15","fraction":0.2}"#),
            Ok(ProtocolItem::Progress {
                text: "3/15".into(),
                fraction: Some(0.2)
            })
        );
        assert_eq!(
            parse_line(r#"{"v":1,"type":"cost","usd":1.5,"kind":"estimated","provider":"p"}"#),
            Ok(ProtocolItem::Cost {
                usd: 1.5,
                estimated: true,
                provider: Some("p".into()),
                model: None,
                units: None
            })
        );
        assert_eq!(
            parse_line(r#"{"v":1,"type":"output","key":"score","value":7.5}"#),
            Ok(ProtocolItem::Output {
                key: "score".into(),
                value: json!(7.5)
            })
        );
        assert_eq!(
            parse_line(r#"{"v":1,"type":"artifact","path":"out/a.md"}"#),
            Ok(ProtocolItem::Artifact {
                path: "out/a.md".into(),
                label: None
            })
        );
        assert_eq!(
            parse_line(r#"{"v":1,"type":"outcome","status":"stopped"}"#),
            Ok(ProtocolItem::Outcome(ProtocolOutcome::Stopped))
        );
        assert_eq!(
            parse_line(r#"{"v":1,"type":"outcome","status":"needs_approval","message":"check"}"#),
            Ok(ProtocolItem::Outcome(ProtocolOutcome::NeedsApproval(Some(
                "check".into()
            ))))
        );
        for (line, reason) in [
            ("nope", "invalid-json"),
            ("[1]", "not-an-object"),
            (r#"{"type":"progress","text":"x"}"#, "unsupported-version"),
            (r#"{"v":1,"type":"cost","usd":-1}"#, "bad-usd"),
            (r#"{"v":1,"type":"output","key":"a b"}"#, "bad-key"),
            (r#"{"v":1,"type":"outcome","status":"great"}"#, "bad-status"),
            (r#"{"v":1,"type":"telemetry"}"#, "unknown-type"),
        ] {
            assert_eq!(parse_line(line), Err(reason), "{line}");
        }
    }

    #[test]
    fn reader_follows_the_file_and_enforces_limits() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("events.jsonl");
        let mut reader = ProtocolReader::new(&path);
        assert!(reader.poll(false).is_empty(), "missing file is fine");
        let mut file = File::create(&path).unwrap();
        write!(
            file,
            "{}\n{{\"v\":1,\"type\":\"out",
            r#"{"v":1,"type":"progress","text":"a"}"#
        )
        .unwrap();
        file.flush().unwrap();
        assert_eq!(
            reader.poll(false),
            vec![ProtocolItem::Progress {
                text: "a".into(),
                fraction: None
            }]
        );
        write!(file, "come\",\"status\":\"ok\"}}\nbroken\n").unwrap();
        file.flush().unwrap();
        assert_eq!(
            reader.poll(false),
            vec![
                ProtocolItem::Outcome(ProtocolOutcome::Ok),
                ProtocolItem::Warning {
                    reason: "invalid-json",
                    line: 3
                }
            ]
        );
        // A long line is dropped with one warning; the following line still parses.
        let long = format!(
            "{{\"v\":1,\"type\":\"progress\",\"text\":\"{}\"}}\n",
            "x".repeat(MAX_LINE_BYTES + 10)
        );
        file.write_all(long.as_bytes()).unwrap();
        write!(file, "{}", r#"{"v":1,"type":"artifact","path":"p"}"#).unwrap();
        file.flush().unwrap();
        let items = reader.poll(false);
        assert_eq!(
            items,
            vec![ProtocolItem::Warning {
                reason: "line-too-long",
                line: 4
            }]
        );
        // The last line without newline is taken on the final read.
        assert_eq!(
            reader.poll(true),
            vec![ProtocolItem::Artifact {
                path: "p".into(),
                label: None
            }]
        );
    }

    #[test]
    fn reader_stops_after_the_line_limit() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("events.jsonl");
        let line = r#"{"v":1,"type":"progress","text":"a"}"#;
        let mut text = String::new();
        for _ in 0..MAX_LINES + 5 {
            text.push_str(line);
            text.push('\n');
        }
        fs::write(&path, text).unwrap();
        let items = ProtocolReader::new(&path).poll(true);
        assert_eq!(items.len(), MAX_LINES + 1);
        assert_eq!(
            items.last(),
            Some(&ProtocolItem::Warning {
                reason: "too-many-lines",
                line: MAX_LINES + 1
            })
        );
    }

    #[test]
    fn decide_prefers_failure() {
        let ok = [0];
        assert_eq!(decide(None, 0, &ok), CommandResult::Succeeded);
        assert_eq!(
            decide(Some(&ProtocolOutcome::Ok), 0, &ok),
            CommandResult::Succeeded
        );
        assert!(matches!(
            decide(Some(&ProtocolOutcome::Ok), 2, &ok),
            CommandResult::Failed {
                code: "FLOW_COMMAND_EXIT_CODE",
                ..
            }
        ));
        assert!(matches!(
            decide(Some(&ProtocolOutcome::Fail(None)), 0, &ok),
            CommandResult::Failed {
                code: "FLOW_COMMAND_REPORTED_FAILURE",
                ..
            }
        ));
        assert_eq!(decide(None, 3, &[0, 3]), CommandResult::Succeeded);
        assert_eq!(
            decide(Some(&ProtocolOutcome::Stopped), 0, &ok),
            CommandResult::Stopped
        );
        assert!(matches!(
            decide(Some(&ProtocolOutcome::Stopped), 1, &ok),
            CommandResult::Failed { .. }
        ));
        assert_eq!(
            decide(Some(&ProtocolOutcome::NeedsApproval(None)), 0, &ok),
            CommandResult::NeedsApproval(None)
        );
    }

    #[test]
    fn tail_reads_the_end() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("log");
        fs::write(&path, "line1\nline2\nline3\n").unwrap();
        assert_eq!(tail_file(&path, 1000).unwrap(), "line1\nline2\nline3\n");
        assert_eq!(tail_file(&path, 8).unwrap(), "line3\n");
        assert_eq!(tail_file(&tmp.path().join("none"), 10).unwrap(), "");
    }
}
