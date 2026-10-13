//! Flow execution (spec 3–5): run model and event log, the serial driver,
//! command processes and the `mdium-v1` protocol, and the engine that
//! owns the drivers, the agent turns of `agent` nodes and the built-in actions
//! of `action` nodes. Concurrency limits come later.

pub mod actions;
pub mod agent;
pub mod artifacts;
pub mod driver;
pub mod engine;
pub mod model;
pub mod prepare;
pub mod process;
pub mod scope;
pub mod store;
pub mod supervise;
pub mod worker;

#[cfg(test)]
mod test_helper;
#[cfg(test)]
mod tests;
