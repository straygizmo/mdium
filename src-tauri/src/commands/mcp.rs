use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

/// Strip the Windows extended-length path prefix (`\\?\`) if present.
fn strip_win_prefix(p: &std::path::Path) -> String {
    let s = p.to_string_lossy();
    s.strip_prefix(r"\\?\").unwrap_or(&s).to_string()
}

/// Return the resolved path to the bundled `mcp-servers` directory.
/// Checks production paths first, then falls back to the dev source tree.
#[tauri::command]
pub fn resolve_mcp_servers_path(app: tauri::AppHandle) -> Result<String, String> {
    use tauri::Manager;
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("Failed to get resource dir: {}", e))?;

    // Production bundle (Tauri copies ../resources/… into _up_/resources/…)
    let prod_path = resource_dir
        .join("_up_")
        .join("resources")
        .join("mcp-servers");
    if prod_path.exists() {
        return Ok(strip_win_prefix(&prod_path));
    }

    // Alternative production layout (flat)
    let flat_path = resource_dir.join("mcp-servers");
    if flat_path.exists() {
        return Ok(strip_win_prefix(&flat_path));
    }

    // Dev mode: project-root/resources/mcp-servers
    let dev_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap_or_else(|| std::path::Path::new("."))
        .join("resources")
        .join("mcp-servers");
    if dev_path.exists() {
        return Ok(strip_win_prefix(&dev_path));
    }

    Err(format!(
        "MCP servers directory not found. Checked:\n  {}\n  {}\n  {}",
        prod_path.display(),
        flat_path.display(),
        dev_path.display()
    ))
}

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
pub struct McpToolContent {
    #[serde(rename = "type")]
    pub content_type: String,
    pub text: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct McpCallToolResult {
    pub content: Vec<McpToolContent>,
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
            .stderr(Stdio::piped());
        #[cfg(target_os = "windows")]
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        let mut child = cmd.spawn()
            .map_err(|e| format!("Failed to spawn MCP server: {}", e))?;

        let stdin = child.stdin.as_mut().ok_or("Failed to open stdin")?;
        let stdout = child.stdout.take().ok_or("Failed to open stdout")?;
        let stderr = child.stderr.take();
        let mut reader = BufReader::new(stdout);

        // Helper: collect stderr output for error diagnostics
        let collect_stderr = |stderr: Option<std::process::ChildStderr>| -> String {
            stderr
                .and_then(|s| {
                    let mut buf = String::new();
                    std::io::Read::read_to_string(&mut BufReader::new(s), &mut buf).ok();
                    let msg = buf.trim().to_string();
                    if msg.is_empty() { None } else { Some(msg) }
                })
                .unwrap_or_default()
        };

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
        let init_resp = match read_jsonrpc_response(&mut reader) {
            Ok(resp) => resp,
            Err(e) => {
                let stderr_msg = collect_stderr(stderr);
                let _ = child.kill();
                let detail = if stderr_msg.is_empty() { e } else { format!("{} (stderr: {})", e, stderr_msg) };
                return Ok(McpTestResult { success: false, tools: vec![], error: Some(detail) });
            }
        };
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
        let tools_resp = match read_jsonrpc_response(&mut reader) {
            Ok(resp) => resp,
            Err(e) => {
                let stderr_msg = collect_stderr(stderr);
                let _ = child.kill();
                let detail = if stderr_msg.is_empty() { e } else { format!("{} (stderr: {})", e, stderr_msg) };
                return Ok(McpTestResult { success: false, tools: vec![], error: Some(detail) });
            }
        };
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

fn read_jsonrpc_response_with_timeout(
    reader: &mut BufReader<std::process::ChildStdout>,
    timeout_secs: u64,
) -> Result<JsonRpcResponse, String> {
    let deadline = Instant::now() + Duration::from_secs(timeout_secs);
    loop {
        if Instant::now() > deadline {
            return Err("Timeout waiting for MCP server response".to_string());
        }
        let mut line = String::new();
        let bytes_read = reader
            .read_line(&mut line)
            .map_err(|e| format!("Failed to read from stdout: {}", e))?;
        if bytes_read == 0 {
            return Err("MCP server process exited before sending a response".to_string());
        }
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if let Ok(resp) = serde_json::from_str::<JsonRpcResponse>(line) {
            if resp.id.is_some() {
                return Ok(resp);
            }
        }
    }
}

fn read_jsonrpc_response(reader: &mut BufReader<std::process::ChildStdout>) -> Result<JsonRpcResponse, String> {
    read_jsonrpc_response_with_timeout(reader, 15)
}

/// Call a tool on a local MCP server via stdio JSON-RPC.
#[tauri::command]
pub async fn mcp_call_tool(
    command: String,
    args: Vec<String>,
    env: HashMap<String, String>,
    tool_name: String,
    tool_args: serde_json::Value,
) -> Result<McpCallToolResult, String> {
    let env = resolve_env_map(env);
    tokio::task::spawn_blocking(move || {
        let mut cmd = Command::new(&command);
        cmd.args(&args)
            .envs(&env)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(target_os = "windows")]
        cmd.creation_flags(0x08000000);
        let mut child = cmd.spawn()
            .map_err(|e| format!("Failed to spawn MCP server: {}", e))?;

        let stdin = child.stdin.as_mut().ok_or("Failed to open stdin")?;
        let stdout = child.stdout.take().ok_or("Failed to open stdout")?;
        let stderr = child.stderr.take();
        let mut reader = BufReader::new(stdout);

        let collect_stderr = |stderr: Option<std::process::ChildStderr>| -> String {
            stderr
                .and_then(|s| {
                    let mut buf = String::new();
                    std::io::Read::read_to_string(&mut BufReader::new(s), &mut buf).ok();
                    let msg = buf.trim().to_string();
                    if msg.is_empty() { None } else { Some(msg) }
                })
                .unwrap_or_default()
        };

        // Initialize
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
        writeln!(stdin, "{}", serde_json::to_string(&init_req).unwrap())
            .map_err(|e| format!("Failed to write to stdin: {}", e))?;

        match read_jsonrpc_response(&mut reader) {
            Ok(resp) => {
                if let Some(err) = resp.error {
                    let _ = child.kill();
                    return Err(format!("Initialize error: {}", err));
                }
            }
            Err(e) => {
                let stderr_msg = collect_stderr(stderr);
                let _ = child.kill();
                return Err(if stderr_msg.is_empty() { e } else { format!("{} (stderr: {})", e, stderr_msg) });
            }
        }

        // Initialized notification
        let notif = serde_json::json!({ "jsonrpc": "2.0", "method": "notifications/initialized" });
        writeln!(stdin, "{}", serde_json::to_string(&notif).unwrap())
            .map_err(|e| format!("Failed to write to stdin: {}", e))?;

        // Call tool
        let call_req = JsonRpcRequest {
            jsonrpc: "2.0".to_string(),
            id: 2,
            method: "tools/call".to_string(),
            params: Some(serde_json::json!({
                "name": tool_name,
                "arguments": tool_args,
            })),
        };
        writeln!(stdin, "{}", serde_json::to_string(&call_req).unwrap())
            .map_err(|e| format!("Failed to write to stdin: {}", e))?;

        // Read tool result (longer timeout for image generation)
        let call_resp = match read_jsonrpc_response_with_timeout(&mut reader, 120) {
            Ok(resp) => resp,
            Err(e) => {
                let stderr_msg = collect_stderr(stderr);
                let _ = child.kill();
                return Err(if stderr_msg.is_empty() { e } else { format!("{} (stderr: {})", e, stderr_msg) });
            }
        };
        let _ = child.kill();

        if let Some(err) = call_resp.error {
            return Err(format!("Tool call error: {}", err));
        }

        // Parse content array from result
        let result = call_resp.result.ok_or("No result in tool call response")?;
        let content_arr = result.get("content")
            .and_then(|v| v.as_array())
            .ok_or("No content array in tool result")?;

        let content: Vec<McpToolContent> = content_arr.iter().filter_map(|c| {
            let t = c.get("type")?.as_str()?.to_string();
            let text = c.get("text")?.as_str()?.to_string();
            Some(McpToolContent { content_type: t, text })
        }).collect();

        Ok(McpCallToolResult { content })
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?
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
