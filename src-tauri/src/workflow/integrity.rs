//! Guard-state integrity snapshot.
//!
//! This is a placeholder for Part 3b-2 (Task 8), which will define the real
//! fields captured before a workflow run starts (e.g. tracked-file hashes)
//! so a run can detect out-of-band modifications. It exists now only so
//! `WorkflowRun` compiles with an `integrity_baseline` field.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct IntegritySnapshot {}
