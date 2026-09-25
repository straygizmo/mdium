//! Shared error conventions for the workflow modules.
//!
//! Every workflow error type:
//! - exposes `code() -> &'static str`: a stable SCREAMING_SNAKE machine code
//!   with a module prefix (`STORE_*`, `TASK_*` / `TRANSITION_*`, `GIT_*`,
//!   `INTEGRITY_*`, `OUTCOME_*`, `RUNNER_*`, `WORKFLOW_*`);
//! - implements `Display` (the code plus a detail for logs; never
//!   user-facing text, which the UI derives from the code) and
//!   `std::error::Error`;
//! - serializes as `{ "code": ..., "message": ... }` where `message` is the
//!   `Display` output.
//!
//! An error that wraps another module's error (e.g.
//! `TransitionError::Store`, `IntegrityError::Git`) reports the inner
//! error's code from `code()`, so the specific cause is never hidden behind
//! a generic wrapper code.

use crate::workflow::model::AttentionReason;
use serde::ser::SerializeStruct;
use std::collections::BTreeMap;

/// Serializes an error as `{ code, message }`. Used by
/// [`impl_workflow_error!`].
pub(crate) fn serialize_error<S: serde::Serializer>(
    code: &str,
    message: &str,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    let mut state = serializer.serialize_struct("WorkflowError", 2)?;
    state.serialize_field("code", code)?;
    state.serialize_field("message", message)?;
    state.end()
}

/// Implements `std::error::Error` and `serde::Serialize` (as
/// `{ code, message }`) for an error type that already has an inherent
/// `code()` and a `Display` impl.
macro_rules! impl_workflow_error {
    ($ty:ty) => {
        impl std::error::Error for $ty {}

        impl serde::Serialize for $ty {
            fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                crate::workflow::errors::serialize_error(self.code(), &self.to_string(), serializer)
            }
        }
    };
}
pub(crate) use impl_workflow_error;

/// Builds the [`AttentionReason`] recorded on a task for a machine `code`
/// (typically an error's `code()`) and its localization `params`.
pub fn to_attention<K, V>(code: &str, params: impl IntoIterator<Item = (K, V)>) -> AttentionReason
where
    K: Into<String>,
    V: Into<String>,
{
    AttentionReason {
        code: code.to_string(),
        params: params
            .into_iter()
            .map(|(key, value)| (key.into(), value.into()))
            .collect::<BTreeMap<String, String>>(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workflow::fsutil::InvalidId;
    use crate::workflow::gitops::GitError;
    use crate::workflow::integrity::IntegrityError;
    use crate::workflow::model::ValidationError;
    use crate::workflow::outcome::OutcomeError;
    use crate::workflow::runner_client::RunnerError;
    use crate::workflow::state::TransitionError;
    use crate::workflow::store::StoreError;
    use serde_json::json;

    /// Asserts `err` serializes as `{ code, message }` with its own code and
    /// Display text, and that the code follows the naming scheme.
    fn assert_shape<E>(err: &E, code: &str)
    where
        E: serde::Serialize + std::error::Error,
    {
        let value = serde_json::to_value(err).unwrap();
        assert_eq!(value, json!({ "code": code, "message": err.to_string() }));
        assert!(
            code.chars()
                .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_'),
            "{code}"
        );
        let prefixes = [
            "STORE_",
            "TASK_",
            "TRANSITION_",
            "GIT_",
            "INTEGRITY_",
            "OUTCOME_",
            "RUNNER_",
            "WORKFLOW_",
        ];
        assert!(prefixes.iter().any(|p| code.starts_with(p)), "{code}");
    }

    #[test]
    fn every_error_type_serializes_as_code_and_message() {
        let store = StoreError::Encode("boom".to_string());
        assert_eq!(store.code(), "STORE_ENCODE_FAILED");
        assert_shape(&store, store.code());
        assert_shape(&StoreError::Io("x".to_string()), "STORE_IO_FAILED");

        let transition = TransitionError::Conflict {
            actual: crate::workflow::model::TaskStatus::Running,
        };
        assert_shape(&transition, "TRANSITION_CONFLICT");
        assert_shape(
            &TransitionError::Store(StoreError::Corrupt("x".to_string())),
            "STORE_CORRUPT",
        );
        assert_shape(&TransitionError::NotFound, "TASK_NOT_FOUND");

        let git = GitError::new(crate::workflow::gitops::GIT_DETACHED_HEAD, "");
        assert_shape(&git, "GIT_DETACHED_HEAD");

        assert_shape(
            &IntegrityError::Io("hooks: denied".to_string()),
            "INTEGRITY_IO_FAILED",
        );
        assert_shape(&IntegrityError::Git(git), "GIT_DETACHED_HEAD");

        assert_shape(&OutcomeError::MissingReason, "OUTCOME_MISSING_REASON");

        let runner = RunnerError::InvalidRequest("RUNNER_GUARD_REQUIRED");
        assert_shape(&runner, "RUNNER_INVALID_REQUEST");
        assert!(runner.to_string().contains("RUNNER_GUARD_REQUIRED"));

        assert_shape(
            &ValidationError::Timeout("design".to_string()),
            "WORKFLOW_INVALID_TIMEOUT",
        );
        assert_shape(&InvalidId("../x".to_string()), "STORE_INVALID_ID");
    }

    #[test]
    fn to_attention_builds_reason_from_code_and_params() {
        let reason = to_attention(
            StoreError::NotFound.code(),
            [("taskId", "00000000000000aa")],
        );
        assert_eq!(reason.code, "STORE_NOT_FOUND");
        assert_eq!(
            reason.params.get("taskId").map(String::as_str),
            Some("00000000000000aa")
        );
        assert!(
            to_attention("RUNNER_TIMEOUT", Vec::<(String, String)>::new())
                .params
                .is_empty()
        );
    }
}
