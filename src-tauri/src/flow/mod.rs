//! Generic flow engine (spec: `.superpowers/specs/2026-10-06-generic-flow-engine-design.md`).
//!
//! Definitions (model, parsing, validation, templates, conditions) and,
//! in `run`, their execution. Independent of `crate::workflow` apart from
//! reusing its `Provider` enum and file utilities.

pub mod condition;
pub mod issues;
pub mod load;
pub mod model;
pub mod parse;
pub mod run;
pub mod template;
pub mod validate;

#[cfg(test)]
mod tests;
