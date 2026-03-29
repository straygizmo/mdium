# MCP Server Image Generation

## Overview

Add a context menu item "Generate with MCP Server" under Insert > Insert Image in the MD editor. Opens a new dialog where the user selects an MCP server (filtered to those with a `generate_image` tool) and generates an image via stdio JSON-RPC invocation.

## Architecture

### Rust Backend (`src-tauri/src/commands/mcp.rs`)

**New command: `mcp_call_tool`**

Invokes an MCP tool on a local stdio server. Reuses the existing process spawning and JSON-RPC infrastructure from `mcp_test_server`.

- Spawns the server process with command/args/env
- Sends: initialize → notifications/initialized → tools/call
- Returns the tool result (text content from the MCP response)
- Includes EOF handling, 60s timeout, and stderr capture (matching existing patterns)

Parameters:
```
command: String
args: Vec<String>
env: HashMap<String, String>
tool_name: String
tool_args: serde_json::Value
```

Returns: `Result<McpCallToolResult, String>` where `McpCallToolResult { content: Vec<McpToolContent> }` and `McpToolContent { type: String, text: String }`.

### Frontend

**GenerateMcpImageDialog** (`src/features/editor/components/GenerateMcpImageDialog.tsx`)

New dialog component.

Props:
```typescript
interface Props {
  visible: boolean;
  onClose: () => void;
  onInsert: (markdownImage: string) => void;
}
```

State:
- `prompt`, `filename`: text inputs
- `selectedServer`: chosen MCP server name
- `availableServers`: servers that have `generate_image` tool (filtered on mount)
- `scanning`: loading state while filtering servers
- `generating`, `error`, `generatedPath`, `previewUrl`: generation state (same pattern as GenerateImageDialog)

On mount / when visible:
1. Read global MCP config from `useOpencodeConfigStore`
2. For each enabled server, call `invoke("mcp_test_server")` to get tool list
3. Filter to servers whose tools include `generate_image`
4. Populate dropdown

On generate:
1. Get selected server's command/args/env from config
2. Call `invoke("mcp_call_tool", { command, args, env, toolName: "generate_image", toolArgs: { prompt, filename } })`
3. Parse response JSON to get file path
4. Load preview via `invoke("read_binary_file")`
5. Show preview, enable Insert button

**EditorContextMenu** changes:
- Add `onGenerateMcpImage` callback to Props
- Add "Generate with MCP Server" menu item under Insert > Insert Image

**EditorPanel** changes:
- Add `showGenMcpImageDialog` state
- Render `GenerateMcpImageDialog`
- Reuse existing `handleInsertGeneratedImage` for `onInsert`

## Data Flow

```
User clicks "Generate with MCP Server"
  → Dialog opens
  → Scans MCP servers via mcp_test_server (filter generate_image)
  → User selects server, enters prompt/filename
  → mcp_call_tool spawns server process
  → JSON-RPC: initialize → initialized → tools/call(generate_image)
  → Server generates image, writes to disk, returns path
  → Frontend loads preview via read_binary_file
  → User clicks Insert
  → ![prompt](/images/filename) inserted into editor
```

## Scope

- Local stdio MCP servers only (no remote)
- `generate_image` tool name is used for filtering
- No aspect ratio / resolution selection (server defaults)
- Environment variables resolved via existing `resolve_env_value` in Rust
