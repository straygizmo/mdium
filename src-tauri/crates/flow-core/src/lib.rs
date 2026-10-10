//! Generic flow engine of MDium (spec 2026-10-06 and 2026-10-10 chapter 10).
//! This crate has no Tauri dependency; the desktop app and the flow server
//! both build on it.

pub mod condition;
pub mod fsutil;
pub mod issues;
pub mod load;
pub mod model;
pub mod parse;
pub mod project;
pub mod provider;
pub mod run;
pub mod service;
pub mod template;
pub mod validate;

#[cfg(test)]
mod tests;
