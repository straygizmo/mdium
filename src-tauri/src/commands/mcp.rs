use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct McpToolInfo {
    pub name: String,
    pub description: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct McpTestResult {
    pub success: bool,
    pub tools: Vec<McpToolInfo>,
    pub error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
struct JsonRpcRequest {
    jsonrpc: String,
    id: u64,
    method: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    params: Option<serde_json::Value>,
}

#[derive(Debug, Serialize, Deserialize)]
struct JsonRpcResponse {
    #[allow(dead_code)]
    jsonrpc: String,
    #[allow(dead_code)]
    id: Option<serde_json::Value>,
    result: Option<serde_json::Value>,
    error: Option<serde_json::Value>,
}

/// Resolve `{env:VARIABLE_NAME}` patterns in a string with actual environment variable values.
fn resolve_env_value(value: &str) -> String {
    let mut result = String::new();
    let mut remaining = value;
    while let Some(start) = remaining.find("{env:") {
        result.push_str(&remaining[..start]);
        let after = &remaining[start + 5..];
        if let Some(end) = after.find('}') {
            let var_name = &after[..end];
            result.push_str(&std::env::var(var_name).unwrap_or_default());
            remaining = &after[end + 1..];
        } else {
            // No closing brace – keep literal text
            result.push_str(&remaining[start..]);
            remaining = "";
        }
    }
    result.push_str(remaining);
    result
}

/// Resolve `{env:...}` patterns in all values of a HashMap.
fn resolve_env_map(map: HashMap<String, String>) -> HashMap<String, String> {
    map.into_iter()
        .map(|(k, v)| (k, resolve_env_value(&v)))
        .collect()
}

/// Test a local MCP server by spawning the process, sending initialize + tools/list, and returning the tool list.
#[tauri::command]
pub async fn mcp_test_server(
    server_type: String,
    command: Option<String>,
    args: Option<Vec<String>>,
    env: Option<HashMap<String, String>>,
    url: Option<String>,
    headers: Option<HashMap<String, String>>,
) -> Result<McpTestResult, String> {
    if server_type == "remote" {
        return mcp_test_remote(url, headers.map(resolve_env_map)).await;
    }
    // Local (stdio) server
    let cmd = command.ok_or("command is required for local MCP server")?;
    mcp_test_local(&cmd, args.unwrap_or_default(), resolve_env_map(env.unwrap_or_default())).await
}

async fn mcp_test_local(
    command: &str,
    args: Vec<String>,
    env: HashMap<String, String>,
) -> Result<McpTestResult, String> {
    // Spawn in a blocking thread since std::process is synchronous
    let command = command.to_string();
    tokio::task::spawn_blocking(move || {
        let mut cmd = Command::new(&command);
        cmd.args(&args)
            .envs(&env)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        #[cfg(target_os = "windows")]
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        let mut child = cmd.spawn()
            .map_err(|e| format!("Failed to spawn MCP server: {}", e))?;

        let stdin = child.stdin.as_mut().ok_or("Failed to open stdin")?;
        let stdout = child.stdout.take().ok_or("Failed to open stdout")?;
        let mut reader = BufReader::new(stdout);

        // Send initialize request
        let init_req = JsonRpcRequest {
            jsonrpc: "2.0".to_string(),
            id: 1,
            method: "initialize".to_string(),
            params: Some(serde_json::json!({
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": { "name": "mdium", "version": "0.1.0" }
            })),
        };
        let init_json = serde_json::to_string(&init_req).unwrap();
        writeln!(stdin, "{}", init_json).map_err(|e| format!("Failed to write to stdin: {}", e))?;

        // Read initialize response
        let init_resp = read_jsonrpc_response(&mut reader)?;
        if let Some(err) = init_resp.error {
            let _ = child.kill();
            return Ok(McpTestResult {
                success: false,
                tools: vec![],
                error: Some(format!("Initialize error: {}", err)),
            });
        }

        // Send initialized notification
        let initialized_notif = serde_json::json!({
            "jsonrpc": "2.0",
            "method": "notifications/initialized"
        });
        writeln!(stdin, "{}", serde_json::to_string(&initialized_notif).unwrap())
            .map_err(|e| format!("Failed to write to stdin: {}", e))?;

        // Send tools/list request
        let tools_req = JsonRpcRequest {
            jsonrpc: "2.0".to_string(),
            id: 2,
            method: "tools/list".to_string(),
            params: None,
        };
        let tools_json = serde_json::to_string(&tools_req).unwrap();
        writeln!(stdin, "{}", tools_json)
            .map_err(|e| format!("Failed to write to stdin: {}", e))?;

        // Read tools/list response
        let tools_resp = read_jsonrpc_response(&mut reader)?;
        let _ = child.kill();

        if let Some(err) = tools_resp.error {
            return Ok(McpTestResult {
                success: false,
                tools: vec![],
                error: Some(format!("tools/list error: {}", err)),
            });
        }

        let tools = parse_tools(tools_resp.result);
        Ok(McpTestResult {
            success: true,
            tools,
            error: None,
        })
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?
}

async fn mcp_test_remote(
    url: Option<String>,
    headers: Option<HashMap<String, String>>,
) -> Result<McpTestResult, String> {
    let url = url.ok_or("url is required for remote MCP server")?;

    let client = reqwest::Client::new();

    // Send initialize request
    let init_req = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": { "name": "mdium", "version": "0.1.0" }
        }
    });

    let mut req_builder = client.post(&url).json(&init_req);
    if let Some(ref hdrs) = headers {
        for (k, v) in hdrs {
            req_builder = req_builder.header(k, v);
        }
    }

    let resp = req_builder
        .send()
        .await
        .map_err(|e| format!("Failed to connect: {}", e))?;
    let init_resp: JsonRpcResponse = resp
        .json()
        .await
        .map_err(|e| format!("Invalid response: {}", e))?;

    if let Some(err) = init_resp.error {
        return Ok(McpTestResult {
            success: false,
            tools: vec![],
            error: Some(format!("Initialize error: {}", err)),
        });
    }

    // Send initialized notification (fire and forget)
    let notif = serde_json::json!({
        "jsonrpc": "2.0",
        "method": "notifications/initialized"
    });
    let mut notif_builder = client.post(&url).json(&notif);
    if let Some(ref hdrs) = headers {
        for (k, v) in hdrs {
            notif_builder = notif_builder.header(k, v);
        }
    }
    let _ = notif_builder.send().await;

    // Send tools/list request
    let tools_req = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 2,
        "method": "tools/list"
    });
    let mut tools_builder = client.post(&url).json(&tools_req);
    if let Some(ref hdrs) = headers {
        for (k, v) in hdrs {
            tools_builder = tools_builder.header(k, v);
        }
    }

    let resp = tools_builder
        .send()
        .await
        .map_err(|e| format!("Failed to fetch tools: {}", e))?;
    let tools_resp: JsonRpcResponse = resp
        .json()
        .await
        .map_err(|e| format!("Invalid tools response: {}", e))?;

    if let Some(err) = tools_resp.error {
        return Ok(McpTestResult {
            success: false,
            tools: vec![],
            error: Some(format!("tools/list error: {}", err)),
        });
    }

    let tools = parse_tools(tools_resp.result);
    Ok(McpTestResult {
        success: true,
        tools,
        error: None,
    })
}

fn read_jsonrpc_response(reader: &mut BufReader<std::process::ChildStdout>) -> Result<JsonRpcResponse, String> {
    // Read lines until we get a valid JSON-RPC response (skip notifications)
    loop {
        let mut line = String::new();
        reader
            .read_line(&mut line)
            .map_err(|e| format!("Failed to read from stdout: {}", e))?;
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if let Ok(resp) = serde_json::from_str::<JsonRpcResponse>(line) {
            // Only return if it has an id (skip notifications)
            if resp.id.is_some() {
                return Ok(resp);
            }
        }
    }
}

fn parse_tools(result: Option<serde_json::Value>) -> Vec<McpToolInfo> {
    let Some(result) = result else {
        return vec![];
    };
    let Some(tools_arr) = result.get("tools").and_then(|v| v.as_array()) else {
        return vec![];
    };
    tools_arr
        .iter()
        .filter_map(|t| {
            let name = t.get("name")?.as_str()?.to_string();
            let description = t
                .get("description")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            Some(McpToolInfo { name, description })
        })
        .collect()
}
