//! Validation issues (`{ code, path, params }`) and their stable codes.
//! The UI localizes by `code` + `params`; `path` points into the file
//! (e.g. `nodes[2].retry.max`).

use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;

// Errors listed in spec 2.8.
pub const FLOW_SCHEMA_UNSUPPORTED: &str = "FLOW_SCHEMA_UNSUPPORTED";
pub const FLOW_PARSE_FAILED: &str = "FLOW_PARSE_FAILED";
pub const FLOW_DUPLICATE_NODE_ID: &str = "FLOW_DUPLICATE_NODE_ID";
pub const FLOW_UNKNOWN_NODE_REF: &str = "FLOW_UNKNOWN_NODE_REF";
pub const FLOW_UNKNOWN_PORT: &str = "FLOW_UNKNOWN_PORT";
pub const FLOW_CYCLE_WITHOUT_LIMIT: &str = "FLOW_CYCLE_WITHOUT_LIMIT";
pub const FLOW_LOOP_LIMIT_MISSING: &str = "FLOW_LOOP_LIMIT_MISSING";
pub const FLOW_SUBFLOW_RECURSION: &str = "FLOW_SUBFLOW_RECURSION";
pub const FLOW_PATH_OUTSIDE_PROJECT: &str = "FLOW_PATH_OUTSIDE_PROJECT";
pub const FLOW_TEMPLATE_INVALID: &str = "FLOW_TEMPLATE_INVALID";
pub const FLOW_ACTION_UNKNOWN: &str = "FLOW_ACTION_UNKNOWN";
/// Checked at run start (PR 3/5); defined here so the code list is complete.
pub const FLOW_PROVIDER_UNAVAILABLE: &str = "FLOW_PROVIDER_UNAVAILABLE";

// Errors added while implementing 2.8 (more precise than the spec's list).
/// A node / edge / nested object has an attribute that isn't defined.
pub const FLOW_UNKNOWN_FIELD: &str = "FLOW_UNKNOWN_FIELD";
/// A node's `kind` is missing or not one of the defined kinds.
pub const FLOW_UNKNOWN_NODE_KIND: &str = "FLOW_UNKNOWN_NODE_KIND";
/// A value has the wrong type or is out of range (`params.reason` says why).
pub const FLOW_INVALID_VALUE: &str = "FLOW_INVALID_VALUE";
/// A flow / node / param / port / variable name has an invalid form.
pub const FLOW_INVALID_ID: &str = "FLOW_INVALID_ID";
/// A `when` / `until` / `cases[].when` is malformed.
pub const FLOW_CONDITION_INVALID: &str = "FLOW_CONDITION_INVALID";
/// A referenced prompt / flow file does not exist.
pub const FLOW_REF_NOT_FOUND: &str = "FLOW_REF_NOT_FOUND";
/// A referenced flow file has validation errors.
pub const FLOW_SUBFLOW_INVALID: &str = "FLOW_SUBFLOW_INVALID";
/// Arguments passed to a sub-flow don't match its `params`.
pub const FLOW_PARAM_MISMATCH: &str = "FLOW_PARAM_MISMATCH";
/// A flow file is larger than [`crate::flow::load::MAX_FLOW_FILE_BYTES`].
pub const FLOW_FILE_TOO_LARGE: &str = "FLOW_FILE_TOO_LARGE";

// Warnings.
/// Unknown top-level key (ignored).
pub const FLOW_UNKNOWN_KEY: &str = "FLOW_UNKNOWN_KEY";
/// A field that is no longer used (ignored; `params.replacement` names the successor).
pub const FLOW_DEPRECATED_FIELD: &str = "FLOW_DEPRECATED_FIELD";
/// An edge has `maxTraversals` but does not close a cycle.
pub const FLOW_TRAVERSAL_LIMIT_UNUSED: &str = "FLOW_TRAVERSAL_LIMIT_UNUSED";

/// One validation finding.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowIssue {
    pub code: String,
    pub path: String,
    pub params: BTreeMap<String, Value>,
}

impl FlowIssue {
    pub fn new(code: &str, path: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            path: path.into(),
            params: BTreeMap::new(),
        }
    }

    pub fn with(mut self, key: &str, value: impl Into<Value>) -> Self {
        self.params.insert(key.to_string(), value.into());
        self
    }
}

/// Errors and warnings collected by a check.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Issues {
    pub errors: Vec<FlowIssue>,
    pub warnings: Vec<FlowIssue>,
}

impl Issues {
    pub fn error(&mut self, issue: FlowIssue) {
        self.errors.push(issue);
    }

    pub fn warn(&mut self, issue: FlowIssue) {
        self.warnings.push(issue);
    }

    pub fn has_errors(&self) -> bool {
        !self.errors.is_empty()
    }

    pub fn extend(&mut self, other: Issues) {
        self.errors.extend(other.errors);
        self.warnings.extend(other.warnings);
    }
}
