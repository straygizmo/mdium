pub mod active_xlsm;
pub mod agent_runner;
pub mod ai;
pub mod claude_config;
pub mod claude_sidecar;
pub mod env;
pub mod file;
pub mod flow;
pub mod flow_run;
pub mod fs_search;
pub mod git;
pub mod image_gen;
pub mod mcp;
pub mod medium;
pub mod node_sidecar;
pub mod pty;
pub mod rag;
pub mod slidev;
pub mod speech;
pub mod vba;
#[allow(dead_code)] // normalize_source / validate_module_name are consumed by later tasks.
pub mod vba_source;
#[allow(dead_code)] // Used by the VBA path tools once later tasks wire them in.
pub mod vba_streams;
pub mod video;
pub mod workflow;
