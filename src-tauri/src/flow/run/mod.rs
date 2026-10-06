//! Flow execution (spec 3–5): run model and event log, the serial driver,
//! command processes and the `mdium-v1` protocol, and the engine that
//! owns the drivers. Agent and action nodes and concurrency limits come later.

pub mod driver;
pub mod engine;
pub mod model;
pub mod prepare;
pub mod process;
pub mod scope;
pub mod store;
pub mod supervise;

#[cfg(test)]
mod test_helper;
#[cfg(test)]
mod tests;
