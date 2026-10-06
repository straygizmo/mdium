//! Generic flow engine (spec: `.superpowers/specs/2026-10-06-generic-flow-engine-design.md`).
//!
//! PR 1 scope: the flow definition model, parsing (YAML primary, JSON
//! accepted), validation with stable issue codes, templates and conditions.
//! Nothing here executes a flow yet. This module is independent of
//! `crate::workflow` apart from reusing its `Provider` enum.

// Items only the engine (PR 3+) will use, e.g. condition evaluation and
// template rendering, are tested here but not called yet.
#[allow(dead_code)]
pub mod condition;
#[allow(dead_code)]
pub mod issues;
pub mod load;
#[allow(dead_code)]
pub mod model;
pub mod parse;
#[allow(dead_code)]
pub mod template;
pub mod validate;

#[cfg(test)]
mod tests;
