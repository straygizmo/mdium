//! Desktop-side pieces of the agent runner host: the Node sidecar spawner.
//! Everything else lives in `flow_core::runner_host`.

pub use flow_core::runner_host::*;

use crate::commands::node_sidecar;
use flow_core::containment::containment_env;
use flow_core::runner_client::{RunnerClient, RunnerError, RunnerTransport};
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};

/// [`RunnerTransport`] over a sidecar whose id is only known once the
/// process has been spawned (the client must exist before the spawn so that
/// no stdout line is lost).
struct LateSidecarTransport {
    id: OnceLock<u32>,
}

impl RunnerTransport for LateSidecarTransport {
    fn write_line(&self, line: &str) -> Result<(), String> {
        match self.id.get() {
            Some(id) => node_sidecar::write(*id, line),
            None => Err("sidecar not running".to_string()),
        }
    }

    fn kill(&self) {
        if let Some(id) = self.id.get() {
            if let Err(e) = node_sidecar::kill(*id) {
                eprintln!("[workflow-runner] kill failed: {e}");
            }
        }
    }
}

/// Production spawner: runs the bundled agent runner under `node` with the
/// containment environment rooted at `data_dir`.
pub struct SidecarSpawner {
    pub script_path: String,
    pub data_dir: PathBuf,
}

impl RunnerSpawner for SidecarSpawner {
    fn spawn(&self) -> Result<Arc<RunnerClient>, String> {
        let env =
            containment_env(&self.data_dir).map_err(|e| format!("containment env failed: {e}"))?;
        let transport = Arc::new(LateSidecarTransport {
            id: OnceLock::new(),
        });
        let client = RunnerClient::new(transport.clone());
        let on_line_client = client.clone();
        let on_exit_client = client.clone();
        let id = node_sidecar::spawn_with_handlers(
            &self.script_path,
            &env,
            Box::new(move |line| on_line_client.handle_line(&line)),
            Box::new(|line| {
                eprintln!(
                    "[workflow-runner] {}",
                    truncate_chars(&line, STDERR_LINE_MAX_CHARS)
                )
            }),
            Box::new(move |_code| on_exit_client.handle_exit()),
        )?;
        let _ = transport.id.set(id);
        Ok(client)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use flow_core::provider::Provider;
    use std::time::Duration;

    /// Runs the real bundled runner. Needs `node` on PATH and the bundle
    /// built by `npm run build:sidecar`; run with `--ignored`.
    #[test]
    #[ignore]
    fn sidecar_spawner_starts_the_bundled_runner() {
        let script = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("resources")
            .join("agent-runner")
            .join("agent-runner.mjs");
        assert!(script.exists(), "build the runner bundle first");
        let tmp = tempfile::TempDir::new().unwrap();
        let host = RunnerHost::new(Box::new(SidecarSpawner {
            script_path: script.to_str().unwrap().to_string(),
            data_dir: tmp.path().join("data"),
        }));
        let availability = host
            .probe(Provider::Codex, Duration::from_secs(60))
            .expect("probe answered");
        assert!(availability.get("kind").is_some(), "{availability}");
        host.shutdown();
        assert_eq!(
            host.probe(Provider::Codex, Duration::from_secs(1)),
            Err(RunnerError::Exited)
        );
    }
}
