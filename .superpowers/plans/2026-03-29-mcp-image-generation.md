# MCP Server Image Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add MCP server-based image generation to the MD editor via context menu, with a new dialog that filters servers by `generate_image` tool availability.

**Architecture:** New Tauri command `mcp_call_tool` reuses existing stdio/JSON-RPC infrastructure to invoke MCP tools. New React dialog `GenerateMcpImageDialog` scans configured servers, filters to those with `generate_image`, and calls the tool to generate images. Integrates into existing editor context menu and EditorPanel.

**Tech Stack:** Rust (Tauri commands), React/TypeScript, JSON-RPC 2.0, MCP protocol

---

### Task 1: Add `mcp_call_tool` Tauri command

**Files:**
- Modify: `src-tauri/src/commands/mcp.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Add McpCallToolResult struct and mcp_call_tool command to mcp.rs**

Add after the existing `McpTestResult` struct (around line 65):

```rust
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
```

Add the new command after the `mcp_test_server` function:

```rust
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
```

- [ ] **Step 2: Add `read_jsonrpc_response_with_timeout` helper**

Add next to the existing `read_jsonrpc_response` function:

```rust
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
```

Then update the existing `read_jsonrpc_response` to delegate:

```rust
fn read_jsonrpc_response(reader: &mut BufReader<std::process::ChildStdout>) -> Result<JsonRpcResponse, String> {
    read_jsonrpc_response_with_timeout(reader, 15)
}
```

- [ ] **Step 3: Register the command in lib.rs**

In `src-tauri/src/lib.rs`, add `commands::mcp::mcp_call_tool` to the invoke_handler list, after the existing `mcp_test_server` line:

```rust
            commands::mcp::resolve_mcp_servers_path,
            commands::mcp::mcp_test_server,
            commands::mcp::mcp_call_tool,
```

- [ ] **Step 4: Verify compilation**

Run: `cargo check --manifest-path src-tauri/Cargo.toml`
Expected: compiles with no errors

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands/mcp.rs src-tauri/src/lib.rs
git commit -m "feat(mcp): add mcp_call_tool command for invoking MCP tools via stdio"
```

---

### Task 2: Add i18n keys for MCP image generation

**Files:**
- Modify: `src/shared/i18n/locales/en/editor.json`
- Modify: `src/shared/i18n/locales/ja/editor.json`

- [ ] **Step 1: Add English translation keys**

Add these keys to the end of `src/shared/i18n/locales/en/editor.json` (before the closing `}`):

```json
"contextMenu.imageFromMcp": "Generate with MCP Server",
"genMcpImageTitle": "Generate Image (MCP Server)",
"genMcpImageServer": "MCP Server",
"genMcpImageScanning": "Scanning MCP servers...",
"genMcpImageNoServers": "No MCP servers with generate_image tool found"
```

- [ ] **Step 2: Add Japanese translation keys**

Add the corresponding keys to `src/shared/i18n/locales/ja/editor.json`:

```json
"contextMenu.imageFromMcp": "MCPサーバーで生成",
"genMcpImageTitle": "画像生成 (MCPサーバー)",
"genMcpImageServer": "MCPサーバー",
"genMcpImageScanning": "MCPサーバーをスキャン中...",
"genMcpImageNoServers": "generate_imageツールを持つMCPサーバーが見つかりません"
```

- [ ] **Step 3: Commit**

```bash
git add src/shared/i18n/locales/en/editor.json src/shared/i18n/locales/ja/editor.json
git commit -m "i18n: add MCP image generation dialog keys"
```

---

### Task 3: Create `GenerateMcpImageDialog` component

**Files:**
- Create: `src/features/editor/components/GenerateMcpImageDialog.tsx`

- [ ] **Step 1: Create the dialog component**

Create `src/features/editor/components/GenerateMcpImageDialog.tsx`:

```tsx
import { type FC, useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { useTabStore } from "@/stores/tab-store";
import { useOpencodeConfigStore } from "@/stores/opencode-config-store";
import type { OpencodeMcpServer } from "@/shared/types";
import "./GenerateImageDialog.css";

interface Props {
  visible: boolean;
  onClose: () => void;
  onInsert: (markdownImage: string) => void;
}

interface McpToolInfo {
  name: string;
  description: string;
}

interface McpTestResult {
  success: boolean;
  tools: McpToolInfo[];
  error: string | null;
}

interface McpCallToolResult {
  content: { content_type: string; text: string }[];
}

interface AvailableServer {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}

function normalizeCommand(server: OpencodeMcpServer): string[] {
  const cmd = server.command;
  if (Array.isArray(cmd)) return cmd;
  if (typeof cmd === "string") {
    const args = Array.isArray(server.args) ? server.args : [];
    return [cmd, ...args];
  }
  return [];
}

export const GenerateMcpImageDialog: FC<Props> = ({ visible, onClose, onInsert }) => {
  const { t } = useTranslation("editor");
  const activeFolderPath = useTabStore((s) => s.activeFolderPath);
  const globalMcp = useOpencodeConfigStore((s) => s.config.mcp);
  const projectMcp = useOpencodeConfigStore((s) => s.projectMcpServers);

  const [prompt, setPrompt] = useState("");
  const [filename, setFilename] = useState("");
  const [selectedServer, setSelectedServer] = useState("");
  const [availableServers, setAvailableServers] = useState<AvailableServer[]>([]);
  const [scanning, setScanning] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState("");
  const [generatedPath, setGeneratedPath] = useState("");
  const [previewUrl, setPreviewUrl] = useState("");

  const scanServers = useCallback(async () => {
    const allServers: Record<string, OpencodeMcpServer> = {
      ...(globalMcp ?? {}),
      ...(projectMcp ?? {}),
    };

    const entries = Object.entries(allServers).filter(
      ([, s]) => s.enabled !== false && (s.type ?? "local") === "local"
    );

    if (entries.length === 0) {
      setAvailableServers([]);
      return;
    }

    setScanning(true);
    const found: AvailableServer[] = [];

    for (const [name, server] of entries) {
      try {
        const cmdArr = normalizeCommand(server);
        if (cmdArr.length === 0) continue;
        const result = await invoke<McpTestResult>("mcp_test_server", {
          serverType: "local",
          command: cmdArr[0],
          args: cmdArr.length > 1 ? cmdArr.slice(1) : null,
          env: server.environment ?? null,
          url: null,
          headers: null,
        });
        if (result.success && result.tools.some((t) => t.name === "generate_image")) {
          found.push({
            name,
            command: cmdArr[0],
            args: cmdArr.slice(1),
            env: server.environment ?? {},
          });
        }
      } catch {
        // skip servers that fail
      }
    }

    setAvailableServers(found);
    if (found.length > 0 && !selectedServer) {
      setSelectedServer(found[0].name);
    }
    setScanning(false);
  }, [globalMcp, projectMcp, selectedServer]);

  useEffect(() => {
    if (visible) {
      scanServers();
    }
  }, [visible, scanServers]);

  if (!visible) return null;

  const handleGenerate = async () => {
    if (!prompt.trim() || !filename.trim() || !selectedServer) return;
    setGenerating(true);
    setError("");
    setGeneratedPath("");

    try {
      const server = availableServers.find((s) => s.name === selectedServer);
      if (!server) {
        setError("Server not found");
        return;
      }

      const outputDir = activeFolderPath
        ? `${activeFolderPath.replace(/\\/g, "/")}/images`
        : "";
      if (!outputDir) {
        setError("No folder is open");
        return;
      }

      const result = await invoke<McpCallToolResult>("mcp_call_tool", {
        command: server.command,
        args: server.args,
        env: server.env,
        toolName: "generate_image",
        toolArgs: {
          prompt: prompt.trim(),
          filename: filename.trim(),
        },
      });

      const textContent = result.content.find((c) => c.content_type === "text");
      if (!textContent) {
        setError("No text content in tool response");
        return;
      }

      // MCP generate_image returns JSON with path info
      const parsed = JSON.parse(textContent.text);
      if (parsed.path) {
        setGeneratedPath(parsed.path);
      }

      // Load preview
      if (parsed.absolutePath) {
        try {
          const bytes = await invoke<number[]>("read_binary_file", { path: parsed.absolutePath });
          const mime = parsed.mimeType || "image/png";
          const blob = new Blob([new Uint8Array(bytes)], { type: mime });
          if (previewUrl) URL.revokeObjectURL(previewUrl);
          setPreviewUrl(URL.createObjectURL(blob));
        } catch {
          // Preview failed silently
        }
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setGenerating(false);
    }
  };

  const handleInsert = () => {
    const path = generatedPath || `/images/${filename}`;
    onInsert(`![${prompt}](${path})`);
    handleReset();
  };

  const handleReset = () => {
    setPrompt("");
    setFilename("");
    setSelectedServer(availableServers.length > 0 ? availableServers[0].name : "");
    setError("");
    setGeneratedPath("");
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl("");
    setGenerating(false);
    onClose();
  };

  return (
    <div className="gen-image-dialog-overlay" onClick={handleReset}>
      <div className="gen-image-dialog" onClick={(e) => e.stopPropagation()}>
        <h3 className="gen-image-dialog__title">{t("genMcpImageTitle")}</h3>

        <div className="gen-image-dialog__field">
          <label className="gen-image-dialog__label">{t("genMcpImageServer")}</label>
          {scanning ? (
            <div style={{ fontSize: 12, opacity: 0.7 }}>{t("genMcpImageScanning")}</div>
          ) : availableServers.length === 0 ? (
            <div style={{ fontSize: 12, color: "var(--accent-red)" }}>{t("genMcpImageNoServers")}</div>
          ) : (
            <select
              className="gen-image-dialog__select"
              value={selectedServer}
              onChange={(e) => setSelectedServer(e.target.value)}
              disabled={generating}
            >
              {availableServers.map((s) => (
                <option key={s.name} value={s.name}>{s.name}</option>
              ))}
            </select>
          )}
        </div>

        <div className="gen-image-dialog__field">
          <label className="gen-image-dialog__label">{t("genImagePrompt")}</label>
          <textarea
            className="gen-image-dialog__textarea"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={t("genImagePromptPlaceholder")}
            disabled={generating}
          />
        </div>

        <div className="gen-image-dialog__field">
          <label className="gen-image-dialog__label">{t("genImageFilename")}</label>
          <input
            className="gen-image-dialog__input"
            value={filename}
            onChange={(e) => setFilename(e.target.value)}
            placeholder="architecture-diagram.png"
            disabled={generating}
          />
        </div>

        {error && <div className="gen-image-dialog__error">{error}</div>}

        {generatedPath ? (
          <div style={{ marginTop: 12 }}>
            {previewUrl && (
              <img className="gen-image-dialog__preview" src={previewUrl} alt={prompt} />
            )}
            <p style={{ fontSize: 12, opacity: 0.7, marginBottom: 8 }}>{t("genImageGenerated")}: {generatedPath}</p>
            <div className="gen-image-dialog__actions">
              <button className="gen-image-dialog__btn gen-image-dialog__btn--primary" onClick={handleInsert}>
                {t("genImageInsert")}
              </button>
              <button className="gen-image-dialog__btn" onClick={handleGenerate} disabled={generating}>
                {t("genImageRegenerate")}
              </button>
              <button className="gen-image-dialog__btn" onClick={handleReset}>
                {t("cancel", { ns: "common" })}
              </button>
            </div>
          </div>
        ) : (
          <div className="gen-image-dialog__actions">
            <button
              className="gen-image-dialog__btn gen-image-dialog__btn--primary"
              onClick={handleGenerate}
              disabled={generating || !prompt.trim() || !filename.trim() || !selectedServer || scanning}
            >
              {generating ? t("genImageGenerating") : t("genImageGenerate")}
            </button>
            <button className="gen-image-dialog__btn" onClick={handleReset}>
              {t("cancel", { ns: "common" })}
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
```

- [ ] **Step 2: Commit**

```bash
git add src/features/editor/components/GenerateMcpImageDialog.tsx
git commit -m "feat(editor): add GenerateMcpImageDialog component"
```

---

### Task 4: Integrate into EditorContextMenu and EditorPanel

**Files:**
- Modify: `src/features/editor/components/EditorContextMenu.tsx`
- Modify: `src/features/editor/components/EditorPanel.tsx`

- [ ] **Step 1: Add `onGenerateMcpImage` prop to EditorContextMenu**

In `EditorContextMenu.tsx`, add `onGenerateMcpImage: () => void;` to the Props interface (after `onGenerateImage`):

```typescript
interface Props {
  // ... existing props ...
  onGenerateImage: () => void;
  onGenerateMcpImage: () => void;
}
```

Add `onGenerateMcpImage` to the destructured props in the component function signature.

- [ ] **Step 2: Add menu item for MCP image generation**

In the Insert > Image submenu, add a new button after the existing "Image from NanoBanana" button (after line 203):

```tsx
<button className="editor-ctx__item" onClick={() => handleAction(onGenerateMcpImage)}>
  <span className="editor-ctx__label">{t("contextMenu.imageFromMcp")}</span>
</button>
```

- [ ] **Step 3: Add state and import in EditorPanel**

In `EditorPanel.tsx`:

Add import:
```typescript
import { GenerateMcpImageDialog } from "./GenerateMcpImageDialog";
```

Add state (next to the existing `showGenImageDialog` state):
```typescript
const [showGenMcpImageDialog, setShowGenMcpImageDialog] = useState(false);
```

- [ ] **Step 4: Add props and render dialog in EditorPanel**

Pass the new prop to `EditorContextMenu`:
```typescript
onGenerateMcpImage={() => setShowGenMcpImageDialog(true)}
```

Render the dialog (next to the existing `GenerateImageDialog`):
```tsx
<GenerateMcpImageDialog
  visible={showGenMcpImageDialog}
  onClose={() => setShowGenMcpImageDialog(false)}
  onInsert={handleInsertGeneratedImage}
/>
```

- [ ] **Step 5: Verify the app builds and runs**

Run: `cargo check --manifest-path src-tauri/Cargo.toml`
Then test the app with `npm run tauri dev` or equivalent.

- [ ] **Step 6: Commit**

```bash
git add src/features/editor/components/EditorContextMenu.tsx src/features/editor/components/EditorPanel.tsx
git commit -m "feat(editor): integrate MCP image generation into context menu"
```
