//! Which coding agent runs an agent node. Serializes as lowercase.
//! Shared with the workflow module of the desktop app.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Codex,
    Copilot,
    Opencode,
    Claude,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_serializes_lowercase() {
        assert_eq!(
            serde_json::to_string(&Provider::Opencode).unwrap(),
            "\"opencode\""
        );
        assert_eq!(
            serde_json::from_str::<Provider>("\"claude\"").unwrap(),
            Provider::Claude
        );
    }
}
