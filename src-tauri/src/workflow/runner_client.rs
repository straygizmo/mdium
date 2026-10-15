//! Desktop-side pieces of the agent runner: the Node sidecar transport.
//! Everything else lives in `flow_core::runner_client`.

pub use flow_core::runner_client::*;

use crate::commands::node_sidecar;

/// [`RunnerTransport`] over a sidecar spawned by `node_sidecar`.
pub struct SidecarTransport {
    pub id: u32,
}

impl RunnerTransport for SidecarTransport {
    fn write_line(&self, line: &str) -> Result<(), String> {
        node_sidecar::write(self.id, line)
    }

    fn kill(&self) {
        if let Err(e) = node_sidecar::kill(self.id) {
            eprintln!("[workflow-runner] kill failed: {e}");
        }
    }
}
