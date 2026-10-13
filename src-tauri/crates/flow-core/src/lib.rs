//! Generic flow engine of MDium (spec 2026-10-06 and 2026-10-10 chapter 10).
//! This crate has no Tauri dependency; the desktop app and the flow server
//! both build on it.

pub mod condition;
pub mod containment;
pub mod forge;
pub mod frontmatter;
pub mod fsutil;
pub mod gitops;
pub mod integrity;
pub mod issue_sync;
pub mod issues;
pub mod load;
pub mod model;
pub mod outcome;
pub mod parse;
pub mod project;
pub mod provider;
pub mod run;
pub mod runner_client;
pub mod runner_host;
pub mod screening;
pub mod service;
pub mod setup;
pub mod template;
pub mod validate;

mod errors;

#[cfg(test)]
mod tests;
