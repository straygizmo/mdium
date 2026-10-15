//! Moved to `flow_core::outcome`; re-exported for the old path.

pub use flow_core::outcome::*;
// This engine never used `outputs` / `artifacts`: a malformed one must not
// fail its stages, so the old name keeps the lenient parser.
pub use flow_core::outcome::parse_outcome_lenient as parse_outcome;
