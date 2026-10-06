//! A small "external command" for engine tests, implemented by the test
//! binary itself: a test that does nothing unless `FLOW_TEST_HELPER` holds
//! a JSON step script, in which case it runs the script and exits the
//! process. Cross-platform and needs no extra binary.

use serde_json::{json, Value};
use std::io::Write;
use std::time::{Duration, Instant};

const TEST_NAME: &str = "flow::run::test_helper::flow_test_helper_entry";

/// argv that runs `steps` as a command node.
pub fn helper_argv() -> Vec<String> {
    let exe = std::env::current_exe().expect("test exe");
    vec![
        exe.to_string_lossy().into_owned(),
        "--exact".into(),
        TEST_NAME.into(),
        "--nocapture".into(),
        "--test-threads=1".into(),
        "--quiet".into(),
    ]
}

/// The env entry that carries the script.
pub fn helper_env(steps: &[Value]) -> (String, String) {
    (
        "FLOW_TEST_HELPER".to_string(),
        Value::from(steps.to_vec()).to_string(),
    )
}

/// The attempt number (last component of `MDIUM_FLOW_NODE_DIR`).
fn attempt() -> u64 {
    let dir = std::env::var("MDIUM_FLOW_NODE_DIR").unwrap_or_default();
    std::path::Path::new(&dir)
        .file_name()
        .and_then(|n| n.to_str())
        .and_then(|n| n.parse().ok())
        .unwrap_or(0)
}

fn append(path: &str, line: &str) {
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .expect("events file");
    writeln!(file, "{line}").expect("write event");
}

#[test]
fn flow_test_helper_entry() {
    let Ok(script) = std::env::var("FLOW_TEST_HELPER") else {
        return;
    };
    let steps: Vec<Value> = serde_json::from_str(&script).expect("helper script");
    let events = std::env::var("MDIUM_FLOW_EVENTS_FILE").unwrap_or_default();
    let stop = std::env::var("MDIUM_FLOW_STOP_FILE").unwrap_or_default();
    for step in steps {
        if let Some(event) = step.get("emit") {
            append(&events, &event.to_string());
        } else if let Some(raw) = step.get("emit_raw").and_then(Value::as_str) {
            append(&events, raw);
        } else if let Some(text) = step.get("stdout").and_then(Value::as_str) {
            println!("{text}");
        } else if let Some(ms) = step.get("sleep_ms").and_then(Value::as_u64) {
            std::thread::sleep(Duration::from_millis(ms));
        } else if let Some(ms) = step.get("wait_stop_ms").and_then(Value::as_u64) {
            // Cooperative stop: finish "at a boundary" when the STOP file appears.
            let deadline = Instant::now() + Duration::from_millis(ms);
            while Instant::now() < deadline {
                if std::path::Path::new(&stop).exists() {
                    append(
                        &events,
                        &json!({ "v": 1, "type": "outcome", "status": "stopped" }).to_string(),
                    );
                    std::process::exit(0);
                }
                std::thread::sleep(Duration::from_millis(20));
            }
        } else if let Some(path) = step.get("dump_env").and_then(Value::as_str) {
            let vars: serde_json::Map<String, Value> = std::env::vars()
                .filter(|(k, _)| k.starts_with("MDIUM_FLOW_") || k.starts_with("FLOWT_"))
                .map(|(k, v)| (k, Value::String(v)))
                .collect();
            let cwd = std::env::current_dir()
                .unwrap()
                .to_string_lossy()
                .into_owned();
            let args: Vec<String> = std::env::args().collect();
            std::fs::write(
                path,
                json!({ "env": vars, "cwd": cwd, "args": args }).to_string(),
            )
            .unwrap();
        } else if let Some(path) = step.get("spawn_sleeper_pid_file").and_then(Value::as_str) {
            // A grandchild that sleeps; its pid is written for kill-tree checks.
            let mut command = std::process::Command::new(std::env::current_exe().unwrap());
            command
                .args(&super::test_helper::helper_argv()[1..])
                .env(
                    "FLOW_TEST_HELPER",
                    json!([{ "sleep_ms": 30000 }]).to_string(),
                )
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null());
            let child = command.spawn().unwrap();
            std::fs::write(path, child.id().to_string()).unwrap();
        } else if let Some(n) = step.get("fail_before_attempt").and_then(Value::as_u64) {
            if attempt() < n {
                std::process::exit(1);
            }
        } else if let Some(n) = step.get("succeed_from_attempt").and_then(Value::as_u64) {
            if attempt() >= n {
                std::process::exit(0);
            }
        } else if let Some(code) = step.get("exit").and_then(Value::as_i64) {
            std::process::exit(code as i32);
        }
    }
    std::process::exit(0);
}

/// The supervisor, run by the test binary (see `detached_launcher`).
#[test]
fn flow_supervisor_entry() {
    if std::env::var("FLOW_TEST_SUPERVISE").is_err() {
        return;
    }
    let spec = std::env::args().last().expect("spec path");
    std::process::exit(crate::flow::run::supervise::supervise(
        std::path::Path::new(&spec),
    ));
}

/// A detached launcher whose supervisor is this test binary.
pub fn detached_launcher() -> crate::flow::run::supervise::DetachedLauncher {
    let exe = std::env::current_exe().expect("test exe");
    crate::flow::run::supervise::DetachedLauncher {
        supervisor: vec![
            exe.to_string_lossy().into_owned(),
            "--exact".into(),
            "flow::run::test_helper::flow_supervisor_entry".into(),
            "--nocapture".into(),
            "--test-threads=1".into(),
            "--quiet".into(),
        ],
        supervisor_env: vec![("FLOW_TEST_SUPERVISE".into(), "1".into())],
    }
}

/// True while a process with `pid` exists.
pub fn process_alive(pid: u32) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let out = std::process::Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/NH", "/FO", "CSV"])
            .creation_flags(0x0800_0000)
            .output()
            .expect("tasklist");
        String::from_utf8_lossy(&out.stdout).contains(&format!("\"{pid}\""))
    }
    #[cfg(unix)]
    {
        std::process::Command::new("kill")
            .args(["-0", &pid.to_string()])
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }
}
