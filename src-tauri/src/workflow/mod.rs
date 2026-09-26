//! Workflow foundation (Part 3b): data model, validation, and (in later
//! tasks) the task/run store, guarded runner integration, and Tauri
//! commands that drive multi-stage design/implement/review pipelines.
//!
//! Nothing here is wired into `lib.rs` yet (that happens in Part 3b-2), so
//! the module is allowed to have unused items in the meantime.
#![allow(dead_code)]

pub mod containment;
pub mod errors;
pub mod frontmatter;
pub mod fsutil;
pub mod gitops;
pub mod integrity;
pub mod model;
pub mod outcome;
pub mod prompt;
pub mod runner_client;
pub mod runner_host;
pub mod screening;
pub mod state;
pub mod store;
pub mod template;
