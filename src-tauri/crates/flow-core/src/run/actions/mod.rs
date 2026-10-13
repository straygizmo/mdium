//! Built-in actions of `action` nodes (`uses: mdium/<name>`). The driver
//! runs one action per node attempt on its own thread: it hands over an
//! owned [`ActionContext`] and gets one [`ActionEnd`] back, so an action
//! never touches driver state.

mod forge;
mod git;

use crate::forge::ForgeCli;
use crate::gitops::{GitError, WorktreeInfo};
use crate::issues::FLOW_ACTION_UNKNOWN;
use crate::project::ProjectDef;
use crate::run::model::Reason;
use crate::run::process::Launcher;
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

/// An input of an action is missing or has the wrong shape
/// (`input` = the `with` key, `reason`).
pub const FLOW_ACTION_INPUT_INVALID: &str = "FLOW_ACTION_INPUT_INVALID";
/// The action's operation failed (`code` = the gitops / forge code, `message`).
pub const FLOW_ACTION_FAILED: &str = "FLOW_ACTION_FAILED";
/// Approval request of an action that needs the user's go-ahead
/// (`show` explains why); approving runs the action again, acknowledged.
pub const FLOW_ACTION_APPROVAL: &str = "FLOW_ACTION_APPROVAL";
/// `FLOW_ACTION_FAILED` code of a declared action this build cannot run yet.
const FLOW_ACTION_NOT_IMPLEMENTED: &str = "FLOW_ACTION_NOT_IMPLEMENTED";

/// Everything an action may use, owned by its thread.
pub struct ActionContext {
    pub project_root: PathBuf,
    pub run_id: String,
    pub run_dir: PathBuf,
    /// The attempt's node directory.
    pub node_dir: PathBuf,
    pub node_id: String,
    pub project: Option<ProjectDef>,
    /// SHA-256 of the confirmed `.mdium/project.yaml` (None without a manifest).
    pub project_sha256: Option<String>,
    pub forge: Arc<dyn ForgeCli>,
    pub launcher: Arc<dyn Launcher>,
    /// Base directory of the managed worktrees (`<base>/mdium/worktrees`).
    pub worktree_base: PathBuf,
    pub poll: Duration,
    /// The `show` of this node's previous `NeedsApproval` when the user
    /// approved it (`None`: not acknowledged). Actions whose question depends
    /// on changing state compare it with what they find now.
    pub acknowledged: Option<BTreeMap<String, Value>>,
    /// Reports a progress line to the driver.
    pub progress: Box<dyn Fn(String) + Send>,
}

/// How an action ended.
#[derive(Debug, Clone, PartialEq)]
pub enum ActionEnd {
    Done {
        outputs: BTreeMap<String, Value>,
        /// Files to record: (path, label).
        artifacts: Vec<(PathBuf, String)>,
    },
    /// Pauses the node; approval runs the action again with `acknowledged`.
    NeedsApproval {
        message: String,
        show: BTreeMap<String, Value>,
        outputs: BTreeMap<String, Value>,
    },
    Failed(Reason),
}

impl ActionEnd {
    /// `Done` with `outputs` and no artifacts.
    fn done(outputs: BTreeMap<String, Value>) -> Self {
        ActionEnd::Done {
            outputs,
            artifacts: Vec::new(),
        }
    }
}

/// The `with` inputs (name, required) and outputs of a built-in action.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ActionSpec {
    pub uses: &'static str,
    pub inputs: &'static [(&'static str, bool)],
    pub outputs: &'static [&'static str],
}

/// Every built-in action. `model::KNOWN_ACTIONS` is derived from this list.
pub const ACTION_SPECS: [ActionSpec; 10] = [
    ActionSpec {
        uses: "mdium/screen-input",
        inputs: &[("text", true)],
        outputs: &["ok", "findings"],
    },
    ActionSpec {
        uses: "mdium/git-worktree-create",
        inputs: &[("title", true)],
        outputs: &["path", "branch", "baseBranch", "baseCommit", "integrityBaseline"],
    },
    ActionSpec {
        uses: "mdium/design-doc-commit",
        inputs: &[("worktree", true), ("docPath", true), ("title", true), ("body", true)],
        outputs: &["path", "commit"],
    },
    ActionSpec {
        uses: "mdium/issue-entry",
        inputs: &[("issue", true), ("entry", true), ("body", true), ("returned", false)],
        outputs: &["posted"],
    },
    ActionSpec {
        uses: "mdium/git-merge-local",
        inputs: &[("worktree", true), ("acknowledgeReviewPaths", false)],
        outputs: &["mergeCommit", "reviewPaths", "integrityChanges"],
    },
    ActionSpec {
        uses: "mdium/issue-close",
        inputs: &[("issue", true)],
        outputs: &["closed"],
    },
    ActionSpec {
        uses: "mdium/git-worktree-discard",
        inputs: &[("worktree", true)],
        outputs: &["ok"],
    },
    ActionSpec {
        uses: "mdium/project-setup",
        inputs: &[("projectRoot", false)],
        outputs: &["ok"],
    },
    ActionSpec {
        uses: "mdium/flow-run-latest",
        inputs: &[("flow", true)],
        outputs: &["runId", "runDir", "status", "outputs", "costUsd", "failedNodes"],
    },
    ActionSpec {
        uses: "mdium/metrics-compare",
        inputs: &[("baseline", true), ("candidate", true)],
        outputs: &["improved", "report", "reportPath"],
    },
];

/// The spec of a built-in action.
pub fn spec_of(uses: &str) -> Option<&'static ActionSpec> {
    ACTION_SPECS.iter().find(|spec| spec.uses == uses)
}

/// Runs one built-in action to its end (blocking).
pub fn run_action(uses: &str, with: &BTreeMap<String, Value>, ctx: &ActionContext) -> ActionEnd {
    let result = match uses {
        "mdium/screen-input" => git::screen_input(with, ctx),
        "mdium/git-worktree-create" => git::worktree_create(with, ctx),
        "mdium/git-worktree-discard" => git::worktree_discard(with, ctx),
        "mdium/git-merge-local" => git::merge_local(with, ctx),
        "mdium/design-doc-commit" => forge::design_doc_commit(with, ctx),
        "mdium/issue-entry" => forge::issue_entry(with, ctx),
        "mdium/issue-close" => forge::issue_close(with, ctx),
        "mdium/project-setup"
        | "mdium/flow-run-latest"
        | "mdium/metrics-compare" => Err(Reason::new(FLOW_ACTION_FAILED)
            .with("code", FLOW_ACTION_NOT_IMPLEMENTED)
            .with("uses", uses)),
        _ => Err(Reason::new(FLOW_ACTION_UNKNOWN).with("uses", uses)),
    };
    result.unwrap_or_else(ActionEnd::Failed)
}

// ------------------------------------------------------------ inputs

fn input_invalid(input: &str, reason: &str) -> Reason {
    Reason::new(FLOW_ACTION_INPUT_INVALID)
        .with("input", input)
        .with("reason", reason)
}

/// A required string input.
fn required_str(with: &BTreeMap<String, Value>, key: &str) -> Result<String, Reason> {
    match with.get(key) {
        None | Some(Value::Null) => Err(input_invalid(key, "missing")),
        Some(Value::String(text)) => Ok(text.clone()),
        Some(_) => Err(input_invalid(key, "not-a-string")),
    }
}

/// A required object input.
#[allow(dead_code)] // used by the forge and project actions
fn required_obj<'a>(
    with: &'a BTreeMap<String, Value>,
    key: &str,
) -> Result<&'a serde_json::Map<String, Value>, Reason> {
    match with.get(key) {
        None | Some(Value::Null) => Err(input_invalid(key, "missing")),
        Some(Value::Object(map)) => Ok(map),
        Some(_) => Err(input_invalid(key, "not-an-object")),
    }
}

/// An optional boolean input (absent or null: false).
fn optional_bool(with: &BTreeMap<String, Value>, key: &str) -> Result<bool, Reason> {
    match with.get(key) {
        None | Some(Value::Null) => Ok(false),
        Some(Value::Bool(flag)) => Ok(*flag),
        Some(_) => Err(input_invalid(key, "not-a-bool")),
    }
}

/// The `worktree` input: the object `git-worktree-create` outputs
/// (`{ path, branch, baseBranch, baseCommit }`).
fn worktree_of(with: &BTreeMap<String, Value>) -> Result<WorktreeInfo, Reason> {
    const KEY: &str = "worktree";
    match with.get(KEY) {
        None | Some(Value::Null) => Err(input_invalid(KEY, "missing")),
        Some(value @ Value::Object(_)) => serde_json::from_value(value.clone())
            .map_err(|err| input_invalid(KEY, "bad-worktree").with("message", err.to_string())),
        Some(_) => Err(input_invalid(KEY, "not-an-object")),
    }
}

/// `FLOW_ACTION_FAILED` carrying a git failure.
fn git_failed(err: GitError) -> Reason {
    Reason::new(FLOW_ACTION_FAILED)
        .with("code", err.code())
        .with("message", err.to_string())
}

/// A value's object as an output map (other values: empty).
fn into_outputs(value: Value) -> BTreeMap<String, Value> {
    match value {
        Value::Object(map) => map.into_iter().collect(),
        _ => BTreeMap::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::KNOWN_ACTIONS;

    #[test]
    fn known_actions_are_the_specs_in_order() {
        let uses: Vec<&str> = ACTION_SPECS.iter().map(|s| s.uses).collect();
        assert_eq!(KNOWN_ACTIONS.to_vec(), uses);
        assert_eq!(spec_of("mdium/git-merge-local").unwrap().outputs, ["mergeCommit", "reviewPaths", "integrityChanges"]);
        assert!(spec_of("mdium/launch-rockets").is_none());
    }
}
