// Codex CLI configuration: MCP servers live in `config.toml` under
// `[mcp_servers.<name>]` (global: ~/.codex/config.toml, project: .codex/config.toml).
// The file is user-owned and holds other settings, so it is edited with
// toml_edit to keep its formatting and comments intact.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;
use toml_edit::{Array, DocumentMut, Item, Table, TableLike, Value};

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CodexMcpServer {
    pub name: String,
    /// Local (stdio) server command.
    #[serde(default)]
    pub command: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    /// Remote (streamable HTTP) server URL.
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub bearer_token_env_var: Option<String>,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub startup_timeout_sec: Option<f64>,
    #[serde(default)]
    pub tool_timeout_sec: Option<f64>,
}

fn default_true() -> bool {
    true
}

fn load_doc(path: &Path) -> Result<DocumentMut, String> {
    if !path.exists() {
        return Ok(DocumentMut::new());
    }
    let raw = fs::read_to_string(path).map_err(|e| e.to_string())?;
    raw.parse::<DocumentMut>().map_err(|e| e.to_string())
}

fn save_doc(path: &Path, doc: &DocumentMut) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(path, doc.to_string()).map_err(|e| e.to_string())
}

fn number(item: &Item) -> Option<f64> {
    item.as_float().or_else(|| item.as_integer().map(|i| i as f64))
}

fn server_from_table(name: &str, table: &dyn TableLike) -> CodexMcpServer {
    let str_of = |key: &str| table.get(key).and_then(Item::as_str).map(str::to_string);
    let args = table
        .get("args")
        .and_then(Item::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect())
        .unwrap_or_default();
    let env = table
        .get("env")
        .and_then(Item::as_table_like)
        .map(|t| {
            t.iter()
                .filter_map(|(k, v)| v.as_str().map(|s| (k.to_string(), s.to_string())))
                .collect()
        })
        .unwrap_or_default();
    CodexMcpServer {
        name: name.to_string(),
        command: str_of("command"),
        args,
        env,
        url: str_of("url"),
        bearer_token_env_var: str_of("bearer_token_env_var"),
        enabled: table.get("enabled").and_then(Item::as_bool).unwrap_or(true),
        startup_timeout_sec: table.get("startup_timeout_sec").and_then(number),
        tool_timeout_sec: table.get("tool_timeout_sec").and_then(number),
    }
}

fn servers_from_doc(doc: &DocumentMut) -> Vec<CodexMcpServer> {
    let Some(servers) = doc.get("mcp_servers").and_then(Item::as_table_like) else {
        return vec![];
    };
    servers
        .iter()
        .filter_map(|(name, item)| item.as_table_like().map(|t| server_from_table(name, t)))
        .collect()
}

/// `[mcp_servers]` as a regular table, created implicitly so no bare header is emitted.
fn servers_table_mut(doc: &mut DocumentMut) -> Result<&mut dyn TableLike, String> {
    let entry = doc.entry("mcp_servers").or_insert_with(|| {
        let mut t = Table::new();
        t.set_implicit(true);
        Item::Table(t)
    });
    entry
        .as_table_like_mut()
        .ok_or_else(|| "mcp_servers is not a table".to_string())
}

fn set_or_remove(table: &mut dyn TableLike, key: &str, value: Option<Value>) {
    match value {
        Some(v) => {
            table.insert(key, Item::Value(v));
        }
        None => {
            table.remove(key);
        }
    }
}

fn upsert_server(doc: &mut DocumentMut, server: &CodexMcpServer) -> Result<(), String> {
    let servers = servers_table_mut(doc)?;
    let entry = servers
        .entry(&server.name)
        .or_insert_with(|| Item::Table(Table::new()));
    let table = entry
        .as_table_like_mut()
        .ok_or_else(|| format!("mcp_servers.{} is not a table", server.name))?;

    let is_remote = server.url.as_deref().map_or(false, |u| !u.is_empty());
    if is_remote {
        for key in ["command", "args", "env"] {
            table.remove(key);
        }
        set_or_remove(table, "url", server.url.clone().map(Value::from));
        set_or_remove(
            table,
            "bearer_token_env_var",
            server.bearer_token_env_var.clone().filter(|s| !s.is_empty()).map(Value::from),
        );
    } else {
        for key in ["url", "bearer_token_env_var"] {
            table.remove(key);
        }
        set_or_remove(table, "command", server.command.clone().map(Value::from));
        let args: Array = server.args.iter().map(|a| Value::from(a.as_str())).collect();
        set_or_remove(table, "args", if server.args.is_empty() { None } else { Some(Value::Array(args)) });
        if server.env.is_empty() {
            table.remove("env");
        } else {
            let mut env = toml_edit::InlineTable::new();
            for (k, v) in &server.env {
                env.insert(k.as_str(), Value::from(v.as_str()));
            }
            table.insert("env", Item::Value(Value::InlineTable(env)));
        }
    }
    // `enabled = true` is the default; omit it to keep the file minimal.
    set_or_remove(table, "enabled", if server.enabled { None } else { Some(Value::from(false)) });
    set_or_remove(table, "startup_timeout_sec", server.startup_timeout_sec.map(Value::from));
    set_or_remove(table, "tool_timeout_sec", server.tool_timeout_sec.map(Value::from));
    Ok(())
}

fn remove_server(doc: &mut DocumentMut, name: &str) {
    if let Some(servers) = doc.get_mut("mcp_servers").and_then(Item::as_table_like_mut) {
        servers.remove(name);
    }
}

fn set_server_enabled(doc: &mut DocumentMut, name: &str, enabled: bool) -> Result<(), String> {
    let table = doc
        .get_mut("mcp_servers")
        .and_then(Item::as_table_like_mut)
        .and_then(|s| s.get_mut(name))
        .and_then(Item::as_table_like_mut)
        .ok_or_else(|| format!("MCP server \"{name}\" not found"))?;
    set_or_remove(table, "enabled", if enabled { None } else { Some(Value::from(false)) });
    Ok(())
}

#[tauri::command]
pub fn codex_read_mcp_servers(path: String) -> Result<Vec<CodexMcpServer>, String> {
    let doc = load_doc(Path::new(&path))?;
    Ok(servers_from_doc(&doc))
}

#[tauri::command]
pub fn codex_write_mcp_server(path: String, server: CodexMcpServer) -> Result<(), String> {
    if server.name.trim().is_empty() {
        return Err("MCP server name is empty".to_string());
    }
    let path = Path::new(&path);
    let mut doc = load_doc(path)?;
    upsert_server(&mut doc, &server)?;
    save_doc(path, &doc)
}

#[tauri::command]
pub fn codex_delete_mcp_server(path: String, name: String) -> Result<(), String> {
    let path = Path::new(&path);
    let mut doc = load_doc(path)?;
    remove_server(&mut doc, &name);
    save_doc(path, &doc)
}

#[tauri::command]
pub fn codex_set_mcp_server_enabled(path: String, name: String, enabled: bool) -> Result<(), String> {
    let path = Path::new(&path);
    let mut doc = load_doc(path)?;
    set_server_enabled(&mut doc, &name, enabled)?;
    save_doc(path, &doc)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"# user config
model = "gpt-5"

[projects.'c:\work']
trust_level = "trusted"

[mcp_servers.docs]
command = "npx"
args = ["-y", "docs-mcp"]
env = { TOKEN = "abc" }
enabled = false
startup_timeout_sec = 20

[mcp_servers.remote]
url = "https://example.com/mcp"
bearer_token_env_var = "EXAMPLE_TOKEN"
"#;

    #[test]
    fn reads_local_and_remote_servers() {
        let doc: DocumentMut = SAMPLE.parse().unwrap();
        let servers = servers_from_doc(&doc);
        assert_eq!(servers.len(), 2);
        let docs = &servers[0];
        assert_eq!(docs.name, "docs");
        assert_eq!(docs.command.as_deref(), Some("npx"));
        assert_eq!(docs.args, vec!["-y", "docs-mcp"]);
        assert_eq!(docs.env.get("TOKEN").map(String::as_str), Some("abc"));
        assert!(!docs.enabled);
        assert_eq!(docs.startup_timeout_sec, Some(20.0));
        let remote = &servers[1];
        assert_eq!(remote.url.as_deref(), Some("https://example.com/mcp"));
        assert_eq!(remote.bearer_token_env_var.as_deref(), Some("EXAMPLE_TOKEN"));
        assert!(remote.enabled);
    }

    #[test]
    fn upsert_keeps_other_content_and_unknown_keys() {
        let mut doc: DocumentMut = format!("{SAMPLE}enabled_tools = [\"a\"]\n").parse().unwrap();
        upsert_server(
            &mut doc,
            &CodexMcpServer {
                name: "remote".into(),
                url: Some("https://example.com/v2".into()),
                enabled: true,
                ..Default::default()
            },
        )
        .unwrap();
        let out = doc.to_string();
        assert!(out.starts_with("# user config\nmodel = \"gpt-5\""));
        assert!(out.contains("[projects.'c:\\work']"));
        assert!(out.contains("url = \"https://example.com/v2\""));
        assert!(!out.contains("bearer_token_env_var"));
        assert!(out.contains("enabled_tools = [\"a\"]"));
    }

    #[test]
    fn upsert_into_empty_doc_emits_only_the_server_table() {
        let mut doc = DocumentMut::new();
        let mut env = BTreeMap::new();
        env.insert("KEY".to_string(), "v".to_string());
        upsert_server(
            &mut doc,
            &CodexMcpServer {
                name: "local".into(),
                command: Some("npx".into()),
                args: vec!["-y".into(), "x".into()],
                env,
                enabled: false,
                ..Default::default()
            },
        )
        .unwrap();
        let out = doc.to_string();
        assert!(!out.contains("[mcp_servers]\n"), "{out}");
        assert!(out.contains("[mcp_servers.local]"));
        assert!(out.contains("command = \"npx\""));
        assert!(out.contains("args = [\"-y\", \"x\"]"));
        assert!(out.contains("env = { KEY = \"v\" }"));
        assert!(out.contains("enabled = false"));
    }

    #[test]
    fn switching_to_remote_drops_local_keys() {
        let mut doc: DocumentMut = SAMPLE.parse().unwrap();
        upsert_server(
            &mut doc,
            &CodexMcpServer {
                name: "docs".into(),
                url: Some("https://docs.example/mcp".into()),
                enabled: true,
                startup_timeout_sec: Some(20.0),
                ..Default::default()
            },
        )
        .unwrap();
        let servers = servers_from_doc(&doc);
        let docs = servers.iter().find(|s| s.name == "docs").unwrap();
        assert!(docs.command.is_none());
        assert!(docs.args.is_empty());
        assert!(docs.env.is_empty());
        assert!(docs.enabled);
        assert_eq!(docs.startup_timeout_sec, Some(20.0));
    }

    #[test]
    fn toggles_and_removes_servers() {
        let mut doc: DocumentMut = SAMPLE.parse().unwrap();
        set_server_enabled(&mut doc, "docs", true).unwrap();
        assert!(!doc.to_string().contains("enabled = false"));
        set_server_enabled(&mut doc, "remote", false).unwrap();
        assert!(servers_from_doc(&doc).iter().any(|s| s.name == "remote" && !s.enabled));
        assert!(set_server_enabled(&mut doc, "missing", false).is_err());
        remove_server(&mut doc, "docs");
        assert_eq!(servers_from_doc(&doc).len(), 1);
        assert!(doc.to_string().contains("[projects.'c:\\work']"));
    }
}
