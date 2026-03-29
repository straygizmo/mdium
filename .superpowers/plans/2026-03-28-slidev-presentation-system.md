# Slidev Presentation System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable Slidev Markdown creation, preview, and PPTX export within mdium, with AI-powered image generation via a built-in MCP server.

**Architecture:** Tauri backend manages Slidev CLI processes (dev server + export) with a bundled Slidev environment. A built-in MCP server provides image generation. The opencode SKILL guides LLMs to produce well-structured Slidev Markdown. The preview panel embeds the Slidev dev server via iframe when a Slidev file is detected.

**Tech Stack:** Tauri (Rust), React, TypeScript, Slidev CLI, Node.js MCP SDK, OpenAI Images API, Zustand

---

## File Structure

### New Files

| File | Responsibility |
|------|---------------|
| `src-tauri/src/commands/slidev.rs` | Rust commands for Slidev process lifecycle (start/sync/export/stop) |
| `resources/slidev-env/package.json` | Bundled Slidev dependencies definition |
| `resources/mcp-servers/image-generator/package.json` | MCP server dependencies |
| `resources/mcp-servers/image-generator/src/index.ts` | MCP server entry point |
| `resources/mcp-servers/image-generator/tsconfig.json` | TypeScript config for MCP server |
| `src/features/opencode-config/lib/builtin-mcp-servers.ts` | Built-in MCP server registry |
| `src/features/opencode-config/lib/builtin-skills.ts` | Built-in SKILL registry (Slidev presentation) |
| `src/features/preview/components/SlidevPreviewPanel.tsx` | Slidev iframe preview component |
| `src/features/editor/components/GenerateImageDialog.tsx` | Dialog for image generation prompt input |
| `src/features/editor/components/GenerateImageDialog.css` | Styles for image generation dialog |
| `src/stores/slidev-store.ts` | Zustand store for Slidev process state per tab |

### Modified Files

| File | Change |
|------|--------|
| `src-tauri/src/commands/mod.rs` | Add `pub mod slidev;` |
| `src-tauri/src/lib.rs` | Register slidev commands in invoke_handler |
| `src-tauri/tauri.conf.json` | Add CSP for localhost iframe, add resources config |
| `src/shared/types/index.ts` | Add Slidev-related types, BuiltinMcpServer type |
| `src/shared/i18n/index.ts` | Add new translation keys (ja/en) |
| `src/stores/ui-store.ts` | Add `"slidev-preview"` to ViewTab union |
| `src/features/preview/components/PreviewPanel.tsx` | Add Slidev detection + SlidevPreviewPanel tab |
| `src/features/editor/components/EditorContextMenu.tsx` | Add "Generate Image" menu item |
| `src/features/editor/components/EditorPanel.tsx` | Add `onInsertGeneratedImage` handler |
| `src/features/opencode-config/components/sections/McpServersSection.tsx` | Add "Add Built-In MCP Server" dropdown |
| `src/features/opencode-config/components/sections/SkillsSection.tsx` | Add "Add Built-In Skill" dropdown |

---

### Task 1: Slidev Store (Zustand)

**Files:**
- Create: `src/stores/slidev-store.ts`
- Modify: `src/shared/types/index.ts`

- [ ] **Step 1: Add Slidev types to shared types**

In `src/shared/types/index.ts`, add the following types at the end of the file:

```typescript
/** Slidev dev server state for a given markdown file */
export interface SlidevSession {
  /** Temp directory path */
  tempDir: string;
  /** Dev server port */
  port: number;
  /** Whether the dev server is ready */
  ready: boolean;
  /** Error message if startup failed */
  error?: string;
}

/** Built-in MCP server definition */
export interface BuiltinMcpServer {
  serverName: string;
  type: "local";
  command: string[];
  enabled: boolean;
  environment: Record<string, string>;
}

/** Built-in skill definition */
export interface BuiltinSkill {
  name: string;
  description: string;
  content: string;
}
```

- [ ] **Step 2: Create slidev-store.ts**

```typescript
import { create } from "zustand";
import type { SlidevSession } from "@/shared/types";

interface SlidevState {
  /** Map from filePath to SlidevSession */
  sessions: Record<string, SlidevSession>;
  setSession: (filePath: string, session: SlidevSession) => void;
  updateSession: (filePath: string, partial: Partial<SlidevSession>) => void;
  removeSession: (filePath: string) => void;
}

export const useSlidevStore = create<SlidevState>()((set) => ({
  sessions: {},
  setSession: (filePath, session) =>
    set((s) => ({ sessions: { ...s.sessions, [filePath]: session } })),
  updateSession: (filePath, partial) =>
    set((s) => {
      const existing = s.sessions[filePath];
      if (!existing) return s;
      return { sessions: { ...s.sessions, [filePath]: { ...existing, ...partial } } };
    }),
  removeSession: (filePath) =>
    set((s) => {
      const { [filePath]: _, ...rest } = s.sessions;
      return { sessions: rest };
    }),
}));
```

- [ ] **Step 3: Commit**

```bash
git add src/shared/types/index.ts src/stores/slidev-store.ts
git commit -m "feat(slidev): add Slidev types and Zustand store"
```

---

### Task 2: Tauri Backend — Slidev Commands

**Files:**
- Create: `src-tauri/src/commands/slidev.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Create slidev.rs**

```rust
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Emitter, Manager};

struct SlidevProcess {
    pid: u32,
    port: u16,
    temp_dir: PathBuf,
}

fn slidev_store() -> &'static Arc<Mutex<HashMap<String, SlidevProcess>>> {
    static STORE: OnceLock<Arc<Mutex<HashMap<String, SlidevProcess>>>> = OnceLock::new();
    STORE.get_or_init(|| Arc::new(Mutex::new(HashMap::new())))
}

fn resources_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .resource_dir()
        .map_err(|e| format!("Failed to get resource dir: {}", e))
}

fn create_temp_project(app: &AppHandle, markdown: &str) -> Result<(PathBuf, PathBuf), String> {
    let temp_base = std::env::temp_dir().join("mdium-slidev");
    fs::create_dir_all(&temp_base).map_err(|e| format!("Failed to create temp dir: {}", e))?;

    let hash = format!("{:x}", md5_simple(markdown.as_bytes()));
    let temp_dir = temp_base.join(&hash);
    fs::create_dir_all(&temp_dir).map_err(|e| format!("mkdir: {}", e))?;
    fs::create_dir_all(temp_dir.join("public/images"))
        .map_err(|e| format!("mkdir public: {}", e))?;

    let res = resources_dir(app)?;
    let slidev_env = res.join("slidev-env");

    // Copy package.json
    let pkg = slidev_env.join("package.json");
    if pkg.exists() {
        fs::copy(&pkg, temp_dir.join("package.json"))
            .map_err(|e| format!("copy package.json: {}", e))?;
    }

    // Symlink node_modules
    let nm_src = slidev_env.join("node_modules");
    let nm_dst = temp_dir.join("node_modules");
    if nm_src.exists() && !nm_dst.exists() {
        #[cfg(target_os = "windows")]
        {
            std::os::windows::fs::symlink_dir(&nm_src, &nm_dst)
                .or_else(|_| junction::create(&nm_src, &nm_dst))
                .map_err(|e| format!("symlink node_modules: {}", e))?;
        }
        #[cfg(not(target_os = "windows"))]
        {
            std::os::unix::fs::symlink(&nm_src, &nm_dst)
                .map_err(|e| format!("symlink node_modules: {}", e))?;
        }
    }

    // Write slides.md
    let slides_path = temp_dir.join("slides.md");
    fs::write(&slides_path, markdown).map_err(|e| format!("write slides.md: {}", e))?;

    Ok((temp_dir, slides_path))
}

fn md5_simple(data: &[u8]) -> u64 {
    // Simple hash for directory naming (not cryptographic)
    let mut h: u64 = 0xcbf29ce484222325;
    for &b in data {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

#[tauri::command]
pub async fn slidev_start(
    app: AppHandle,
    file_path: String,
    markdown: String,
) -> Result<(String, u16), String> {
    // Check if already running
    {
        let guard = slidev_store().lock().unwrap();
        if let Some(proc) = guard.get(&file_path) {
            return Ok((proc.temp_dir.to_string_lossy().to_string(), proc.port));
        }
    }

    let (temp_dir, _slides_path) = create_temp_project(&app, &markdown)?;

    // Find available port
    let port = {
        let listener = std::net::TcpListener::bind("127.0.0.1:0")
            .map_err(|e| format!("bind port: {}", e))?;
        listener.local_addr().unwrap().port()
    };

    let npx = if cfg!(target_os = "windows") { "npx.cmd" } else { "npx" };
    let temp_dir_str = temp_dir.to_string_lossy().to_string();

    #[cfg(target_os = "windows")]
    let child = {
        use std::os::windows::process::CommandExt;
        Command::new(npx)
            .args(["slidev", "dev", "--port", &port.to_string(), "--open", "false", "--remote", "false"])
            .current_dir(&temp_dir)
            .creation_flags(0x08000000) // CREATE_NO_WINDOW
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .map_err(|e| format!("spawn slidev: {}", e))?
    };

    #[cfg(not(target_os = "windows"))]
    let child = {
        Command::new(npx)
            .args(["slidev", "dev", "--port", &port.to_string(), "--open", "false", "--remote", "false"])
            .current_dir(&temp_dir)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .map_err(|e| format!("spawn slidev: {}", e))?
    };

    let pid = child.id();
    let proc = SlidevProcess {
        pid,
        port,
        temp_dir: temp_dir.clone(),
    };

    {
        let mut guard = slidev_store().lock().unwrap();
        guard.insert(file_path.clone(), proc);
    }

    // Poll for server readiness in background
    let app_clone = app.clone();
    let file_path_clone = file_path.clone();
    tokio::spawn(async move {
        let url = format!("http://127.0.0.1:{}", port);
        for _ in 0..60 {
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            if reqwest::get(&url).await.is_ok() {
                let _ = app_clone.emit("slidev-ready", (&file_path_clone, port));
                return;
            }
        }
        let _ = app_clone.emit("slidev-error", (&file_path_clone, "Slidev dev server timed out"));
    });

    Ok((temp_dir_str, port))
}

#[tauri::command]
pub fn slidev_sync(file_path: String, markdown: String) -> Result<(), String> {
    let guard = slidev_store().lock().unwrap();
    let proc = guard
        .get(&file_path)
        .ok_or_else(|| "No Slidev session for this file".to_string())?;
    let slides_path = proc.temp_dir.join("slides.md");
    fs::write(&slides_path, &markdown).map_err(|e| format!("write slides.md: {}", e))?;
    Ok(())
}

#[tauri::command]
pub async fn slidev_export(
    app: AppHandle,
    file_path: String,
    format: String,
    output_path: String,
) -> Result<String, String> {
    let temp_dir = {
        let guard = slidev_store().lock().unwrap();
        let proc = guard
            .get(&file_path)
            .ok_or_else(|| "No Slidev session for this file".to_string())?;
        proc.temp_dir.clone()
    };

    let npx = if cfg!(target_os = "windows") { "npx.cmd" } else { "npx" };
    let export_path = temp_dir.join(format!("export.{}", if format == "pptx" { "pptx" } else { "pdf" }));

    let output = tokio::task::spawn_blocking(move || {
        let mut cmd = Command::new(npx);
        cmd.args(["slidev", "export", "--format", &format, "--output", &export_path.to_string_lossy()]);
        cmd.current_dir(&temp_dir);

        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000);
        }

        cmd.output().map_err(|e| format!("run export: {}", e))
    })
    .await
    .map_err(|e| format!("join: {}", e))??;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        return Err(format!("slidev export failed: {}", stderr));
    }

    // Copy export file to user-chosen output path
    let export_file = temp_dir.join(format!("export.{}", if format == "pptx" { "pptx" } else { "pdf" }));
    fs::copy(&export_file, &output_path)
        .map_err(|e| format!("copy export: {}", e))?;

    Ok(output_path)
}

#[tauri::command]
pub fn slidev_stop(file_path: String) -> Result<(), String> {
    let proc = {
        let mut guard = slidev_store().lock().unwrap();
        guard.remove(&file_path)
    };

    if let Some(proc) = proc {
        // Kill process
        #[cfg(target_os = "windows")]
        {
            let _ = Command::new("taskkill")
                .args(["/PID", &proc.pid.to_string(), "/F", "/T"])
                .output();
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = Command::new("kill")
                .args(["-9", &proc.pid.to_string()])
                .output();
        }

        // Clean up temp dir (best effort)
        let _ = fs::remove_dir_all(&proc.temp_dir);
    }

    Ok(())
}

#[tauri::command]
pub fn slidev_get_temp_dir(file_path: String) -> Result<String, String> {
    let guard = slidev_store().lock().unwrap();
    let proc = guard
        .get(&file_path)
        .ok_or_else(|| "No Slidev session for this file".to_string())?;
    Ok(proc.temp_dir.to_string_lossy().to_string())
}
```

- [ ] **Step 2: Register slidev module in mod.rs**

Add to `src-tauri/src/commands/mod.rs`:

```rust
pub mod slidev;
```

- [ ] **Step 3: Register slidev commands in lib.rs**

Add to the `invoke_handler` in `src-tauri/src/lib.rs`, after the MCP operations section:

```rust
// Slidev operations
commands::slidev::slidev_start,
commands::slidev::slidev_sync,
commands::slidev::slidev_export,
commands::slidev::slidev_stop,
commands::slidev::slidev_get_temp_dir,
```

- [ ] **Step 4: Add junction crate for Windows symlink fallback**

In `src-tauri/Cargo.toml`, add:

```toml
junction = "1"
```

- [ ] **Step 5: Verify it compiles**

Run: `cd src-tauri && cargo check`
Expected: Compiles without errors

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/commands/slidev.rs src-tauri/src/commands/mod.rs src-tauri/src/lib.rs src-tauri/Cargo.toml
git commit -m "feat(slidev): add Tauri backend commands for Slidev process management"
```

---

### Task 3: Bundled Slidev Environment

**Files:**
- Create: `resources/slidev-env/package.json`
- Modify: `src-tauri/tauri.conf.json`

- [ ] **Step 1: Create Slidev environment package.json**

```json
{
  "name": "mdium-slidev-env",
  "private": true,
  "dependencies": {
    "@slidev/cli": "^51.0.0",
    "@slidev/theme-default": "^0.25.0",
    "playwright-chromium": "^1.50.0"
  }
}
```

- [ ] **Step 2: Install Slidev dependencies**

Run: `cd resources/slidev-env && npm install`
Expected: `node_modules/` created with Slidev and dependencies

- [ ] **Step 3: Update tauri.conf.json — add resources**

In `src-tauri/tauri.conf.json`, add `resources` to the `bundle` section:

```json
"resources": [
  "../resources/slidev-env/package.json",
  "../resources/slidev-env/node_modules/**/*",
  "../resources/mcp-servers/**/*"
]
```

- [ ] **Step 4: Update tauri.conf.json — CSP for Slidev iframe**

Update the `csp` in `security` section to allow iframe from localhost:

```
frame-src http://127.0.0.1:* http://localhost:*;
```

Append this to the existing CSP string.

- [ ] **Step 5: Commit**

```bash
git add resources/slidev-env/package.json src-tauri/tauri.conf.json
git commit -m "feat(slidev): add bundled Slidev environment and Tauri resource config"
```

Note: `resources/slidev-env/node_modules/` should be added to `.gitignore`.

---

### Task 4: MCP Server — Image Generator

**Files:**
- Create: `resources/mcp-servers/image-generator/package.json`
- Create: `resources/mcp-servers/image-generator/tsconfig.json`
- Create: `resources/mcp-servers/image-generator/src/index.ts`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "mdium-mcp-image-generator",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.12.0",
    "openai": "^4.80.0"
  },
  "devDependencies": {
    "typescript": "^5.9.0",
    "@types/node": "^22.0.0"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "node16",
    "moduleResolution": "node16",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create src/index.ts**

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import OpenAI from "openai";
import * as fs from "fs";
import * as path from "path";

const provider = process.env.IMAGE_PROVIDER ?? "openai";
const apiKey = process.env.IMAGE_API_KEY ?? "";
const model = process.env.IMAGE_MODEL ?? "dall-e-3";
const outputDir = process.env.IMAGE_OUTPUT_DIR ?? process.cwd();

const server = new McpServer({
  name: "image-generator",
  version: "1.0.0",
});

server.tool(
  "generate_image",
  "Generate an image from a text description and save it to disk",
  {
    prompt: z.string().describe("Description of the image to generate"),
    width: z.number().default(1024).describe("Image width in pixels"),
    height: z.number().default(768).describe("Image height in pixels"),
    filename: z.string().describe("Output filename (e.g. architecture-diagram.png)"),
  },
  async ({ prompt, width, height, filename }) => {
    try {
      const dir = outputDir;
      fs.mkdirSync(dir, { recursive: true });

      const filePath = path.join(dir, filename);

      if (provider === "openai") {
        const client = new OpenAI({ apiKey });
        const response = await client.images.generate({
          model,
          prompt,
          n: 1,
          size: `${width}x${height}` as "1024x1024" | "1024x1792" | "1792x1024",
          response_format: "b64_json",
        });

        const b64 = response.data[0]?.b64_json;
        if (!b64) {
          return { content: [{ type: "text", text: "Error: No image data returned" }] };
        }

        fs.writeFileSync(filePath, Buffer.from(b64, "base64"));
      } else {
        return {
          content: [{ type: "text", text: `Error: Unsupported provider "${provider}"` }],
        };
      }

      const relativePath = path.relative(process.cwd(), filePath).replace(/\\/g, "/");
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              path: `/images/${filename}`,
              absolutePath: filePath,
              relativePath,
            }),
          },
        ],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: [{ type: "text", text: `Error generating image: ${message}` }] };
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
```

- [ ] **Step 4: Install dependencies and build**

Run: `cd resources/mcp-servers/image-generator && npm install && npm run build`
Expected: `dist/index.js` created

- [ ] **Step 5: Commit**

```bash
git add resources/mcp-servers/image-generator/package.json resources/mcp-servers/image-generator/tsconfig.json resources/mcp-servers/image-generator/src/index.ts
git commit -m "feat(mcp): add built-in image-generator MCP server"
```

Note: `resources/mcp-servers/image-generator/node_modules/` and `dist/` should be added to `.gitignore`.

---

### Task 5: Built-In MCP Server Registry & UI

**Files:**
- Create: `src/features/opencode-config/lib/builtin-mcp-servers.ts`
- Modify: `src/features/opencode-config/components/sections/McpServersSection.tsx`
- Modify: i18n translation files

- [ ] **Step 1: Create builtin-mcp-servers.ts**

```typescript
import type { BuiltinMcpServer } from "@/shared/types";

export const BUILTIN_MCP_SERVERS: Record<string, BuiltinMcpServer> = {
  "image-generator": {
    serverName: "image-generator",
    type: "local",
    command: ["node", "<resources_path>/mcp-servers/image-generator/dist/index.js"],
    enabled: true,
    environment: {
      IMAGE_PROVIDER: "openai",
      IMAGE_API_KEY: "",
      IMAGE_MODEL: "dall-e-3",
      IMAGE_OUTPUT_DIR: "",
    },
  },
};

/** Resolve <resources_path> placeholder with actual path */
export function resolveBuiltinCommand(
  command: string[],
  resourcesPath: string
): string[] {
  return command.map((part) => part.replace("<resources_path>", resourcesPath));
}
```

- [ ] **Step 2: Add i18n keys**

Add the following keys to both ja and en translation files for the `opencode-config` namespace:

**Japanese:**
```json
{
  "mcpBuiltinAdd": "Add Built-In MCP Server",
  "mcpBuiltinSelect": "Built-In MCP Server を選択..."
}
```

**English:**
```json
{
  "mcpBuiltinAdd": "Add Built-In MCP Server",
  "mcpBuiltinSelect": "Select a Built-In MCP Server..."
}
```

- [ ] **Step 3: Modify McpServersSection.tsx — add built-in dropdown**

Import the registry at the top:

```typescript
import { BUILTIN_MCP_SERVERS, resolveBuiltinCommand } from "../../lib/builtin-mcp-servers";
```

Add a `resourcesPath` state and resolve it on mount:

```typescript
const [resourcesPath, setResourcesPath] = useState("");

useEffect(() => {
  invoke<string>("get_home_dir").then((home) => {
    // ... existing globalConfigPath logic ...
  });
  // Resolve resources path from Tauri
  import("@tauri-apps/api/path").then(({ resourceDir }) => {
    resourceDir().then(setResourcesPath).catch(() => {});
  });
}, []);
```

Add the "Add Built-In MCP Server" dropdown in the editing form, right after the JSON Import section and before the SERVER NAME field. Add it as a clickable label that expands a select:

```tsx
{/* Built-In MCP Server selector */}
<div className="oc-section__builtin-select">
  <label className="oc-section__label" style={{ color: "var(--accent)", cursor: "pointer" }}>
    {t("mcpBuiltinAdd")}
  </label>
  <select
    className="oc-section__input"
    value=""
    onChange={(e) => {
      const key = e.target.value;
      if (!key) return;
      const builtin = BUILTIN_MCP_SERVERS[key];
      if (!builtin) return;
      const resolved = resolveBuiltinCommand(builtin.command, resourcesPath);
      setFormName(builtin.serverName);
      setFormType(builtin.type);
      setFormEnabled(builtin.enabled);
      setFormCommand(resolved[0] ?? "");
      setFormArgs(resolved.slice(1).join(" "));
      setFormEnv(
        Object.entries(builtin.environment)
          .map(([k, v]) => `${k}=${v}`)
          .join("\n")
      );
    }}
  >
    <option value="">{t("mcpBuiltinSelect")}</option>
    {Object.keys(BUILTIN_MCP_SERVERS).map((key) => (
      <option key={key} value={key}>{key}</option>
    ))}
  </select>
</div>
```

- [ ] **Step 4: Verify the UI renders correctly**

Run: `npm run dev`
Navigate to Settings > MCP > click "+" to add > verify "Add Built-In MCP Server" dropdown appears and selecting "image-generator" populates the form fields.

- [ ] **Step 5: Commit**

```bash
git add src/features/opencode-config/lib/builtin-mcp-servers.ts src/features/opencode-config/components/sections/McpServersSection.tsx src/shared/i18n/
git commit -m "feat(mcp): add built-in MCP server selector to settings UI"
```

---

### Task 6: Built-In Skill Registry & UI

**Files:**
- Create: `src/features/opencode-config/lib/builtin-skills.ts`
- Modify: `src/features/opencode-config/components/sections/SkillsSection.tsx`
- Modify: i18n translation files

- [ ] **Step 1: Create builtin-skills.ts**

```typescript
import type { BuiltinSkill } from "@/shared/types";

export const BUILTIN_SKILLS: Record<string, BuiltinSkill> = {
  "slidev-presentation": {
    name: "slidev-presentation",
    description: "Generate Slidev-format Markdown for presentations with narration notes and AI image generation",
    content: `---
name: slidev-presentation
description: Generate Slidev-format Markdown for presentations with narration notes and AI image generation
---

# Slidev Presentation Generator

You are an expert presentation designer. When asked to create a presentation, generate Slidev-format Markdown following these rules.

## Slidev Format Rules

### Frontmatter (first slide)
\`\`\`yaml
---
theme: default
title: Presentation Title
author: Author Name
---
\`\`\`

### Slide Separation
- Separate slides with \`---\` on its own line
- Each slide can have a layout specified in its own frontmatter block:
  \`\`\`
  ---
  layout: cover
  ---
  \`\`\`

### Available Layouts
- \`cover\` — Title slide with centered content
- \`default\` — Standard content slide
- \`two-cols\` — Two-column layout (use \`::left::\` and \`::right::\` slot markers)
- \`image-right\` — Content left, image right (set \`image\` in frontmatter)
- \`image-left\` — Image left, content right
- \`center\` — Centered content
- \`section\` — Section divider
- \`quote\` — Quote slide
- \`fact\` — Key fact/statistic

### Rich Content Support
- Mermaid diagrams: use \`\`\`mermaid code blocks
- KaTeX math: use \`$inline$\` or \`$$display$$\`
- Code highlighting: use \`\`\`lang code blocks with optional line highlighting \`{1,3-5}\`

## Narration Script Rules

- Write narration notes inside HTML comment blocks at the end of each slide
- Write narration in the same language as the user's message
- Use a natural presenter speaking style — conversational but professional
- Target 30 seconds to 1 minute of narration per slide
- Cover the key points shown on the slide, adding context not visible in the text

Example:
\`\`\`markdown
# System Architecture

![Architecture diagram](/images/slide03-architecture.png)

- Frontend: React + TypeScript
- Backend: Rust (Tauri)
- Database: SQLite

<!--
Let me walk you through our system architecture.
As you can see in this diagram, we have a clean separation between the frontend and backend.
The frontend is built with React and TypeScript, giving us type safety and a rich component ecosystem.
On the backend, we use Rust via the Tauri framework, which provides excellent performance and a small binary size.
For data storage, we use SQLite — it's embedded, requires no separate server, and is more than sufficient for our needs.
-->
\`\`\`

## Image Generation Guidelines

### When to use the \`generate_image\` tool
- Architecture or system diagrams that show component relationships
- Conceptual illustrations that make abstract ideas concrete
- Visual metaphors that reinforce the presentation narrative
- Data flow or process visualizations
- Comparison visuals (before/after, old/new)

### When NOT to use it
- The slide contains only text, bullet points, or code — no image needed
- A Mermaid diagram can express the content (flowcharts, sequence diagrams, ER diagrams)
- The slide is a title/section divider slide

### File naming convention
- Use descriptive names with slide context: \`slide03-system-overview.png\`, \`slide07-data-flow.png\`
- Always place in \`/images/\` directory
- Reference in Markdown as: \`![Description](/images/filename.png)\`

### Prompt best practices
- Write prompts in English for best results
- Be specific about style: "clean flat illustration", "technical diagram", "isometric view"
- Include context about what the image should communicate
- Specify relevant details: colors, layout orientation, key elements to include
`,
  },
};
```

- [ ] **Step 2: Add i18n keys**

Add to the `opencode-config` namespace:

**Japanese:**
```json
{
  "skillBuiltinAdd": "Add Built-In Skill",
  "skillBuiltinSelect": "Built-In Skill を選択..."
}
```

**English:**
```json
{
  "skillBuiltinAdd": "Add Built-In Skill",
  "skillBuiltinSelect": "Select a Built-In Skill..."
}
```

- [ ] **Step 3: Modify SkillsSection.tsx — add built-in dropdown**

Import the registry:

```typescript
import { BUILTIN_SKILLS } from "../../lib/builtin-skills";
```

Add the dropdown in the editing form, before the name field. When a built-in skill is selected, populate the name, description, and content fields:

```tsx
{/* Built-In Skill selector */}
<div className="oc-section__builtin-select">
  <label className="oc-section__label" style={{ color: "var(--accent)", cursor: "pointer" }}>
    {t("skillBuiltinAdd")}
  </label>
  <select
    className="oc-section__input"
    value=""
    onChange={(e) => {
      const key = e.target.value;
      if (!key) return;
      const builtin = BUILTIN_SKILLS[key];
      if (!builtin) return;
      setFormName(builtin.name);
      setFormDescription(builtin.description);
      setFormContent(builtin.content);
    }}
  >
    <option value="">{t("skillBuiltinSelect")}</option>
    {Object.keys(BUILTIN_SKILLS).map((key) => (
      <option key={key} value={key}>{key}</option>
    ))}
  </select>
</div>
```

- [ ] **Step 4: Verify the UI renders correctly**

Run: `npm run dev`
Navigate to Settings > Skills > click "+" to add > verify "Add Built-In Skill" dropdown appears and selecting "slidev-presentation" populates the form.

- [ ] **Step 5: Commit**

```bash
git add src/features/opencode-config/lib/builtin-skills.ts src/features/opencode-config/components/sections/SkillsSection.tsx src/shared/i18n/
git commit -m "feat(skills): add built-in skill selector with slidev-presentation skill"
```

---

### Task 7: Slidev Preview Panel

**Files:**
- Create: `src/features/preview/components/SlidevPreviewPanel.tsx`
- Modify: `src/stores/ui-store.ts`
- Modify: `src/features/preview/components/PreviewPanel.tsx`

- [ ] **Step 1: Add "slidev-preview" to ViewTab**

In `src/stores/ui-store.ts`, update the `ViewTab` type:

```typescript
type ViewTab = "preview" | "table" | "pdf-preview" | "docx-preview" | "html-preview" | "slidev-preview";
```

- [ ] **Step 2: Create SlidevPreviewPanel.tsx**

```tsx
import { useEffect, useState, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { save } from "@tauri-apps/plugin-dialog";
import { useTabStore } from "@/stores/tab-store";
import { useSlidevStore } from "@/stores/slidev-store";

interface SlidevPreviewPanelProps {
  content: string;
  filePath: string | null;
}

export function SlidevPreviewPanel({ content, filePath }: SlidevPreviewPanelProps) {
  const { t } = useTranslation("preview");
  const session = useSlidevStore((s) => filePath ? s.sessions[filePath] : undefined);
  const setSession = useSlidevStore((s) => s.setSession);
  const updateSession = useSlidevStore((s) => s.updateSession);
  const removeSession = useSlidevStore((s) => s.removeSession);
  const [starting, setStarting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const syncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Start Slidev dev server
  const startServer = useCallback(async () => {
    if (!filePath || !content) return;
    setStarting(true);
    try {
      const [tempDir, port] = await invoke<[string, number]>("slidev_start", {
        filePath,
        markdown: content,
      });
      setSession(filePath, { tempDir, port, ready: false });
    } catch (e) {
      if (filePath) {
        setSession(filePath, { tempDir: "", port: 0, ready: false, error: String(e) });
      }
    } finally {
      setStarting(false);
    }
  }, [filePath, content, setSession]);

  // Listen for server ready event
  useEffect(() => {
    const unlisten = listen<[string, number]>("slidev-ready", (event) => {
      const [fp, _port] = event.payload;
      updateSession(fp, { ready: true });
    });
    const unlistenError = listen<[string, string]>("slidev-error", (event) => {
      const [fp, error] = event.payload;
      updateSession(fp, { error });
    });
    return () => {
      unlisten.then((fn) => fn());
      unlistenError.then((fn) => fn());
    };
  }, [updateSession]);

  // Auto-start on mount if no session
  useEffect(() => {
    if (filePath && !session) {
      startServer();
    }
  }, [filePath, session, startServer]);

  // Sync content changes (debounced)
  useEffect(() => {
    if (!filePath || !session?.ready) return;
    if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
    syncTimerRef.current = setTimeout(() => {
      invoke("slidev_sync", { filePath, markdown: content }).catch(console.warn);
    }, 500);
    return () => {
      if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
    };
  }, [content, filePath, session?.ready]);

  // Stop server on unmount
  useEffect(() => {
    return () => {
      if (filePath) {
        invoke("slidev_stop", { filePath }).catch(console.warn);
        removeSession(filePath);
      }
    };
  }, [filePath, removeSession]);

  const handleExport = async (format: "pptx" | "pdf") => {
    if (!filePath) return;
    const ext = format === "pptx" ? "pptx" : "pdf";
    const outputPath = await save({
      filters: [{ name: format.toUpperCase(), extensions: [ext] }],
    });
    if (!outputPath) return;
    setExporting(true);
    try {
      await invoke("slidev_export", { filePath, format, outputPath });
    } catch (e) {
      console.error("Export failed:", e);
    } finally {
      setExporting(false);
    }
  };

  if (!filePath) {
    return <div className="slidev-preview__empty">{t("slidevNoFile")}</div>;
  }

  if (starting || (session && !session.ready && !session.error)) {
    return (
      <div className="slidev-preview__loading">
        <div className="slidev-preview__spinner" />
        {t("slidevStarting")}
      </div>
    );
  }

  if (session?.error) {
    return (
      <div className="slidev-preview__error">
        <p>{t("slidevError")}: {session.error}</p>
        <button onClick={startServer}>{t("slidevRetry")}</button>
      </div>
    );
  }

  if (session?.ready) {
    return (
      <div className="slidev-preview" style={{ display: "flex", flexDirection: "column", height: "100%" }}>
        <div className="slidev-preview__toolbar" style={{ display: "flex", gap: 4, padding: "4px 8px", borderBottom: "1px solid var(--border)" }}>
          <span style={{ flex: 1, fontSize: 12, opacity: 0.7 }}>Slidev Preview</span>
          <button
            className="slidev-preview__export-btn"
            onClick={() => handleExport("pptx")}
            disabled={exporting}
          >
            {exporting ? "..." : "PPTX"}
          </button>
          <button
            className="slidev-preview__export-btn"
            onClick={() => handleExport("pdf")}
            disabled={exporting}
          >
            {exporting ? "..." : "PDF"}
          </button>
        </div>
        <iframe
          src={`http://127.0.0.1:${session.port}`}
          style={{ flex: 1, border: "none", width: "100%" }}
          title="Slidev Preview"
        />
      </div>
    );
  }

  return null;
}
```

- [ ] **Step 3: Add Slidev detection and tab to PreviewPanel.tsx**

Add a `isSlidevMarkdown` helper function at the top of PreviewPanel.tsx:

```typescript
const SLIDEV_FRONTMATTER_KEYS = ["theme", "class", "drawings", "layout", "background", "highlighter", "lineNumbers", "colorSchema"];

function isSlidevMarkdown(content: string): boolean {
  // Check for Slidev-specific frontmatter keys
  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (fmMatch) {
    const fm = fmMatch[1];
    if (SLIDEV_FRONTMATTER_KEYS.some((key) => new RegExp(`^${key}:`, "m").test(fm))) {
      return true;
    }
  }
  // Check for 2+ slide separators (--- on its own line, not in frontmatter)
  const withoutFm = content.replace(/^---\s*\n[\s\S]*?\n---/, "");
  const separators = withoutFm.match(/^\s*---\s*$/gm);
  return (separators?.length ?? 0) >= 2;
}
```

Add the SlidevPreviewPanel import and a "Slidev" tab button next to the existing preview tabs (PDF, DOCX, HTML). Show the Slidev tab only when the content is detected as Slidev Markdown. When the "Slidev" tab is active, render `<SlidevPreviewPanel>` instead of the normal preview.

- [ ] **Step 4: Add i18n keys for preview**

Add to the `preview` namespace (or `common` if preview namespace doesn't exist):

**Japanese:**
```json
{
  "slidevNoFile": "ファイルが選択されていません",
  "slidevStarting": "Slidev を起動中...",
  "slidevError": "Slidev エラー",
  "slidevRetry": "再試行"
}
```

**English:**
```json
{
  "slidevNoFile": "No file selected",
  "slidevStarting": "Starting Slidev...",
  "slidevError": "Slidev error",
  "slidevRetry": "Retry"
}
```

- [ ] **Step 5: Verify the preview renders**

Run: `npm run dev`
Create a test `.md` file with Slidev frontmatter (`theme: default`). Verify the "Slidev" tab appears in the preview panel. Click it — the Slidev dev server should start and the preview should load.

- [ ] **Step 6: Commit**

```bash
git add src/features/preview/components/SlidevPreviewPanel.tsx src/features/preview/components/PreviewPanel.tsx src/stores/ui-store.ts src/shared/i18n/ src/stores/slidev-store.ts
git commit -m "feat(slidev): add Slidev preview panel with iframe integration"
```

---

### Task 8: Context Menu — Generate Image

**Files:**
- Create: `src/features/editor/components/GenerateImageDialog.tsx`
- Create: `src/features/editor/components/GenerateImageDialog.css`
- Modify: `src/features/editor/components/EditorContextMenu.tsx`
- Modify: `src/features/editor/components/EditorPanel.tsx`

- [ ] **Step 1: Create GenerateImageDialog.css**

```css
.gen-image-dialog-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.gen-image-dialog {
  background: var(--bg-primary);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 20px;
  min-width: 400px;
  max-width: 500px;
}

.gen-image-dialog__title {
  margin: 0 0 16px;
  font-size: 16px;
  font-weight: 600;
}

.gen-image-dialog__field {
  margin-bottom: 12px;
}

.gen-image-dialog__label {
  display: block;
  font-size: 12px;
  margin-bottom: 4px;
  opacity: 0.8;
}

.gen-image-dialog__input {
  width: 100%;
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg-secondary);
  color: var(--text-primary);
  font-size: 13px;
  box-sizing: border-box;
}

.gen-image-dialog__textarea {
  width: 100%;
  min-height: 80px;
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg-secondary);
  color: var(--text-primary);
  font-size: 13px;
  resize: vertical;
  box-sizing: border-box;
}

.gen-image-dialog__size-row {
  display: flex;
  gap: 8px;
  align-items: center;
}

.gen-image-dialog__size-input {
  width: 80px;
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg-secondary);
  color: var(--text-primary);
  font-size: 13px;
}

.gen-image-dialog__actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  margin-top: 16px;
}

.gen-image-dialog__btn {
  padding: 6px 16px;
  border: 1px solid var(--border);
  border-radius: 4px;
  cursor: pointer;
  font-size: 13px;
  background: var(--bg-secondary);
  color: var(--text-primary);
}

.gen-image-dialog__btn--primary {
  background: var(--accent);
  color: white;
  border-color: var(--accent);
}

.gen-image-dialog__btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.gen-image-dialog__error {
  color: var(--error);
  font-size: 12px;
  margin-top: 8px;
}

.gen-image-dialog__preview {
  margin-top: 12px;
  text-align: center;
}

.gen-image-dialog__preview img {
  max-width: 100%;
  max-height: 200px;
  border-radius: 4px;
  border: 1px solid var(--border);
}

.gen-image-dialog__preview-actions {
  display: flex;
  gap: 8px;
  justify-content: center;
  margin-top: 8px;
}
```

- [ ] **Step 2: Create GenerateImageDialog.tsx**

```tsx
import { type FC, useState } from "react";
import { useTranslation } from "react-i18next";
import { getOpencodeClient } from "@/features/opencode-config/hooks/useOpencodeChat";
import "./GenerateImageDialog.css";

interface Props {
  visible: boolean;
  onClose: () => void;
  onInsert: (markdownImage: string) => void;
}

export const GenerateImageDialog: FC<Props> = ({ visible, onClose, onInsert }) => {
  const { t } = useTranslation("editor");
  const [prompt, setPrompt] = useState("");
  const [filename, setFilename] = useState("");
  const [width, setWidth] = useState(1024);
  const [height, setHeight] = useState(768);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState("");
  const [generatedPath, setGeneratedPath] = useState("");

  if (!visible) return null;

  const handleGenerate = async () => {
    if (!prompt.trim() || !filename.trim()) return;
    setGenerating(true);
    setError("");
    setGeneratedPath("");

    try {
      const client = getOpencodeClient();
      if (!client) {
        setError(t("genImageNoOpencode"));
        return;
      }

      // Create a session and send a tool-use request
      const session = await client.session.create({ body: { title: "Image Generation" } });
      const toolPrompt = `Use the generate_image tool with the following parameters:
- prompt: "${prompt}"
- width: ${width}
- height: ${height}
- filename: "${filename}"

Return only the tool result.`;

      await client.session.promptAsync({
        path: { id: session.id },
        body: { parts: [{ type: "text", text: toolPrompt }] },
      });

      // Wait for completion and parse result
      const messages = await client.session.messages({ path: { id: session.id } });
      const lastMsg = messages.messages?.[messages.messages.length - 1];
      if (lastMsg) {
        const toolPart = lastMsg.parts?.find((p: { type: string }) => p.type === "tool");
        if (toolPart && "output" in toolPart) {
          try {
            const result = JSON.parse(String(toolPart.output));
            setGeneratedPath(result.path || `/images/${filename}`);
          } catch {
            setGeneratedPath(`/images/${filename}`);
          }
        } else {
          setGeneratedPath(`/images/${filename}`);
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
    handleClose();
  };

  const handleClose = () => {
    setPrompt("");
    setFilename("");
    setWidth(1024);
    setHeight(768);
    setError("");
    setGeneratedPath("");
    setGenerating(false);
    onClose();
  };

  return (
    <div className="gen-image-dialog-overlay" onClick={handleClose}>
      <div className="gen-image-dialog" onClick={(e) => e.stopPropagation()}>
        <h3 className="gen-image-dialog__title">{t("genImageTitle")}</h3>

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

        <div className="gen-image-dialog__field">
          <label className="gen-image-dialog__label">{t("genImageSize")}</label>
          <div className="gen-image-dialog__size-row">
            <input
              className="gen-image-dialog__size-input"
              type="number"
              value={width}
              onChange={(e) => setWidth(Number(e.target.value))}
              disabled={generating}
            />
            <span>x</span>
            <input
              className="gen-image-dialog__size-input"
              type="number"
              value={height}
              onChange={(e) => setHeight(Number(e.target.value))}
              disabled={generating}
            />
          </div>
        </div>

        {error && <div className="gen-image-dialog__error">{error}</div>}

        {generatedPath && (
          <div className="gen-image-dialog__preview">
            <p style={{ fontSize: 12, opacity: 0.7 }}>{t("genImageGenerated")}: {generatedPath}</p>
            <div className="gen-image-dialog__preview-actions">
              <button className="gen-image-dialog__btn gen-image-dialog__btn--primary" onClick={handleInsert}>
                {t("genImageInsert")}
              </button>
              <button className="gen-image-dialog__btn" onClick={handleGenerate} disabled={generating}>
                {t("genImageRegenerate")}
              </button>
            </div>
          </div>
        )}

        <div className="gen-image-dialog__actions">
          {!generatedPath && (
            <button
              className="gen-image-dialog__btn gen-image-dialog__btn--primary"
              onClick={handleGenerate}
              disabled={generating || !prompt.trim() || !filename.trim()}
            >
              {generating ? t("genImageGenerating") : t("genImageGenerate")}
            </button>
          )}
          <button className="gen-image-dialog__btn" onClick={handleClose}>
            {t("cancel")}
          </button>
        </div>
      </div>
    </div>
  );
};
```

- [ ] **Step 3: Add i18n keys for editor**

Add to the `editor` namespace:

**Japanese:**
```json
{
  "genImage": "生成画像",
  "genImageTitle": "Generate Image",
  "genImagePrompt": "Prompt",
  "genImagePromptPlaceholder": "画像の説明を入力...",
  "genImageFilename": "Filename",
  "genImageSize": "Size",
  "genImageGenerate": "Generate",
  "genImageGenerating": "Generating...",
  "genImageGenerated": "Generated",
  "genImageInsert": "Insert",
  "genImageRegenerate": "Regenerate",
  "genImageNoOpencode": "opencode server is not running"
}
```

**English:**
```json
{
  "genImage": "Generate Image",
  "genImageTitle": "Generate Image",
  "genImagePrompt": "Prompt",
  "genImagePromptPlaceholder": "Describe the image to generate...",
  "genImageFilename": "Filename",
  "genImageSize": "Size",
  "genImageGenerate": "Generate",
  "genImageGenerating": "Generating...",
  "genImageGenerated": "Generated",
  "genImageInsert": "Insert",
  "genImageRegenerate": "Regenerate",
  "genImageNoOpencode": "opencode server is not running"
}
```

- [ ] **Step 4: Modify EditorContextMenu.tsx — add "Generate Image" menu item**

Add `onInsertGeneratedImage` to the Props interface:

```typescript
onInsertGeneratedImage: () => void;
```

Add the menu item inside the Insert submenu, after the existing items (Mermaid Template):

```tsx
<li
  className="editor-context-menu__item"
  onClick={() => { onInsertGeneratedImage(); onClose(); }}
>
  {t("genImage")}
</li>
```

- [ ] **Step 5: Modify EditorPanel.tsx — add dialog and handler**

Import the dialog component:

```typescript
import { GenerateImageDialog } from "./GenerateImageDialog";
```

Add state for the dialog:

```typescript
const [showGenImageDialog, setShowGenImageDialog] = useState(false);
```

Add the handler to insert generated image markdown at cursor position:

```typescript
const handleInsertGeneratedImage = useCallback((markdownImage: string) => {
  handleInsertFormatting(markdownImage);
}, [handleInsertFormatting]);
```

Pass `onInsertGeneratedImage={() => setShowGenImageDialog(true)}` to `EditorContextMenu`.

Render the dialog:

```tsx
<GenerateImageDialog
  visible={showGenImageDialog}
  onClose={() => setShowGenImageDialog(false)}
  onInsert={handleInsertGeneratedImage}
/>
```

- [ ] **Step 6: Verify the context menu and dialog**

Run: `npm run dev`
Right-click in editor > Insert > "Generate Image" should appear. Clicking it should open the dialog.

- [ ] **Step 7: Commit**

```bash
git add src/features/editor/components/GenerateImageDialog.tsx src/features/editor/components/GenerateImageDialog.css src/features/editor/components/EditorContextMenu.tsx src/features/editor/components/EditorPanel.tsx src/shared/i18n/
git commit -m "feat(editor): add Generate Image context menu and dialog"
```

---

### Task 9: Integration Testing & Polish

- [ ] **Step 1: Add .gitignore entries**

Add to the project root `.gitignore`:

```
resources/slidev-env/node_modules/
resources/mcp-servers/image-generator/node_modules/
resources/mcp-servers/image-generator/dist/
```

- [ ] **Step 2: End-to-end test — Slidev preview**

1. Open mdium
2. Create a new `.md` file with this content:
   ```markdown
   ---
   theme: default
   title: Test Presentation
   ---

   # Hello World

   This is the first slide.

   ---

   # Second Slide

   - Point 1
   - Point 2
   ```
3. Click the "Slidev" tab in preview panel
4. Verify Slidev dev server starts and slides render in iframe
5. Edit content in editor — verify iframe updates via hot-reload

- [ ] **Step 3: End-to-end test — PPTX export**

1. With the Slidev file open and preview active
2. Click "PPTX" button in the Slidev preview toolbar
3. Choose save location
4. Verify `.pptx` file is created and openable in PowerPoint

- [ ] **Step 4: End-to-end test — Built-in MCP server**

1. Go to Settings > MCP
2. Click "+" to add new server
3. Select "image-generator" from the "Add Built-In MCP Server" dropdown
4. Verify form fields are populated with defaults
5. Enter an API key, save

- [ ] **Step 5: End-to-end test — Built-in Skill**

1. Go to Settings > Skills
2. Click "+" to add new skill
3. Select "slidev-presentation" from the "Add Built-In Skill" dropdown
4. Verify name, description, and content are populated
5. Save the skill

- [ ] **Step 6: End-to-end test — Generate Image dialog**

1. Right-click in editor
2. Insert > Generate Image
3. Verify dialog opens with prompt, filename, and size fields
4. (If MCP server configured) Test generation flow

- [ ] **Step 7: Commit .gitignore and any final fixes**

```bash
git add .gitignore
git commit -m "chore: add resource build artifacts to gitignore"
```
