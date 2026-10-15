//! `std::error::Error` and `serde::Serialize` (as `{ code, message }`) for the
//! error types of the modules moved out of the desktop crate's workflow
//! engine. They are implemented here because of the orphan rule; the desktop
//! crate's `impl_workflow_error!` produces the same output for its own types.

use serde::ser::SerializeStruct;

/// Serializes an error as `{ code, message }`.
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

/// Implements `std::error::Error` and `serde::Serialize` for an error type
/// that already has an inherent `code()` and a `Display` impl.
macro_rules! impl_error {
    ($ty:ty) => {
        impl std::error::Error for $ty {}

        impl serde::Serialize for $ty {
            fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                crate::errors::serialize_error(self.code(), &self.to_string(), serializer)
            }
        }
    };
}
pub(crate) use impl_error;
