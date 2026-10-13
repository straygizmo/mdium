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

impl Provider {
    /// The provider of a lowercase name (`codex`, `claude`, ...).
    pub fn from_name(name: &str) -> Option<Provider> {
        serde_json::from_value(serde_json::Value::String(name.to_string())).ok()
    }
}

/// The `provider` of an agent node: a fixed provider, or a template
/// (`${{ params.provider }}`) rendered when the node starts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ProviderRef {
    Fixed(Provider),
    Template(String),
}

impl ProviderRef {
    /// The provider when it is fixed in the file.
    pub fn fixed(&self) -> Option<Provider> {
        match self {
            ProviderRef::Fixed(provider) => Some(*provider),
            ProviderRef::Template(_) => None,
        }
    }
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
        assert_eq!(Provider::from_name("codex"), Some(Provider::Codex));
        assert_eq!(Provider::from_name("gpt"), None);
    }

    #[test]
    fn provider_ref_prefers_a_fixed_provider() {
        assert_eq!(
            serde_json::from_str::<ProviderRef>("\"codex\"").unwrap(),
            ProviderRef::Fixed(Provider::Codex)
        );
        assert_eq!(
            serde_json::from_str::<ProviderRef>("\"${{ params.p }}\"").unwrap(),
            ProviderRef::Template("${{ params.p }}".into())
        );
    }
}
