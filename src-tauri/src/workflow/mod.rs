//! Workflow foundation (Part 3b): data model, validation, the task/run
//! store, guarded runner integration, and the orchestrator that drives
//! multi-stage design/implement/review pipelines (exposed to the UI by
//! `commands::workflow`).
//!
//! Modules marked `#[allow(dead_code)]` still have items only used by
//! tests or kept for later callers.

pub mod actions;
#[allow(dead_code)]
pub mod attachments;
pub mod attempt;
#[allow(dead_code)]
pub mod checks;
pub mod containment;
pub mod errors;
pub mod flow;
pub mod frontmatter;
#[allow(dead_code)]
pub mod fsutil;
#[allow(dead_code)]
pub mod gitops;
#[allow(dead_code)]
pub mod integrity;
pub mod model;
pub mod orchestrator;
pub mod outcome;
pub mod prompt;
#[allow(dead_code)]
pub mod runner_client;
pub mod runner_host;
pub mod screening;
#[allow(dead_code)]
pub mod state;
pub mod store;
#[allow(dead_code)]
pub mod template;
