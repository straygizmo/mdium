# Claude SDK Chat/Settings Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an independent "Claude" left-panel to mdium with a chat tab (Claude Agent SDK via a Node sidecar over stdio) and a settings tab (model/permission mode/CLAUDE.md rules + existing MCP/Skills tabs).

**Architecture:** A Node sidecar (esbuild-bundled `claude-sidecar.cjs`, shipped as a Tauri resource) wraps `@anthropic-ai/claude-agent-sdk` `query()` in streaming-input mode and talks JSON Lines over stdio. A generic Rust stdio bridge (`claude_sidecar.rs`) spawns it per folder and relays lines as Tauri events. The sidecar locates the user's installed `claude` CLI and passes it via `pathToClaudeCodeExecutable`, so auth follows the CLI's login. Spec: `.superpowers/specs/2026-07-04-claude-sdk-chat-design.md`.

**Tech Stack:** React 19 + Zustand + i18next (existing), `@anthropic-ai/claude-agent-sdk` (devDependency, bundled into sidecar), esbuild, Tauri 2 (Rust), vitest.

## Global Constraints

- All code comments in English (CLAUDE.md rule).
- No hardcoded UI strings — every user-visible string goes through i18n namespace `claude-config` (en + ja), except strings already in `common`/`settings` namespaces.
- Do not touch any `opencode-config` behavior.
- Model selector options (exact IDs): `claude-opus-4-8`, `claude-sonnet-5`, `claude-haiku-4-5`, plus "CLI default" (empty string = omit `model` option).
- Windows is the primary platform (cmd-wrapper spawn pattern, `taskkill /T /F` kill pattern — mirror `src-tauri/src/commands/pty.rs`).
- MVP scope only: no image attachments, no slash/@ completion, no session list UI, no usage popover, no preview-driven commands.
- Run tests with `npx vitest run <file>` (or `npm test` for all). Rust: `cargo check` / `cargo test` in `src-tauri`.

---

### Task 1: Sidecar protocol types + testable sidecar core

**Files:**
- Create: `src/shared/types/claude-sidecar.ts`
- Create: `sidecar/sidecar-core.ts`
- Test: `sidecar/__tests__/sidecar-core.test.ts`

**Interfaces:**
- Consumes: nothing (leaf module).
- Produces: `SidecarInbound` / `SidecarOutbound` union types (used by Tasks 3, 5, 8); `SidecarCore` class with `handleLine(line: string): void`, constructor `new SidecarCore(deps: SidecarCoreDeps)`; `SidecarCoreDeps = { startQuery(prompt, startMsg, canUseTool): SidecarQueryHandle; send(msg: SidecarOutbound): void }`.

- [ ] **Step 1: Write the protocol types**

```typescript
// src/shared/types/claude-sidecar.ts

/** Permission modes accepted by the Claude Agent SDK. */
export type ClaudePermissionMode =
  | "default"
  | "acceptEdits"
  | "bypassPermissions"
  | "plan";

/** mdium -> sidecar messages (one JSON object per stdin line). */
export interface StartSessionMessage {
  type: "start_session";
  cwd: string;
  /** Empty/undefined means "use the CLI default model". */
  model?: string;
  permissionMode: ClaudePermissionMode;
  resumeSessionId?: string;
  systemPromptAppend?: string;
}
export interface UserMessageMessage {
  type: "user_message";
  text: string;
}
export interface PermissionResponseMessage {
  type: "permission_response";
  id: string;
  behavior: "allow" | "deny";
  message?: string;
}
export type SidecarInbound =
  | StartSessionMessage
  | UserMessageMessage
  | PermissionResponseMessage
  | { type: "interrupt" }
  | { type: "stop" };

/** sidecar -> mdium messages (one JSON object per stdout line). */
export interface SidecarPermissionRequest {
  type: "permission_request";
  id: string;
  toolName: string;
  input: Record<string, unknown>;
}
export type SidecarOutbound =
  | { type: "ready" }
  /** Raw SDKMessage passthrough; UI-side mapping happens in claude-message-mapper. */
  | { type: "sdk_event"; event: Record<string, unknown> }
  | SidecarPermissionRequest
  | { type: "session_closed" }
  | { type: "error"; message: string; fatal?: boolean };
```

- [ ] **Step 2: Write the failing tests for the core**

```typescript
// sidecar/__tests__/sidecar-core.test.ts
import { describe, it, expect, vi } from "vitest";
import { SidecarCore, type SidecarCoreDeps, type SidecarQueryHandle } from "../sidecar-core";
import type { SidecarOutbound } from "../../src/shared/types/claude-sidecar";

/** A query handle whose async iteration blocks until finish() is called. */
function makeHandle() {
  let release: (() => void) | null = null;
  const done = new Promise<void>((r) => (release = r));
  const handle: SidecarQueryHandle = {
    interrupt: vi.fn(async () => {}),
    async *[Symbol.asyncIterator]() {
      await done;
    },
  };
  return { handle, finish: () => release!() };
}

function setup() {
  const sent: SidecarOutbound[] = [];
  const { handle, finish } = makeHandle();
  let capturedPrompt: AsyncIterable<unknown> | null = null;
  let capturedCanUseTool:
    | ((toolName: string, input: Record<string, unknown>) => Promise<unknown>)
    | null = null;
  const deps: SidecarCoreDeps = {
    startQuery: vi.fn((prompt, _startMsg, canUseTool) => {
      capturedPrompt = prompt;
      capturedCanUseTool = canUseTool;
      return handle;
    }),
    send: (m) => sent.push(m),
  };
  const core = new SidecarCore(deps);
  core.handleLine(
    JSON.stringify({ type: "start_session", cwd: "C:/x", permissionMode: "default" }),
  );
  return { core, sent, deps, finish, handle,
    prompt: () => capturedPrompt!, canUseTool: () => capturedCanUseTool! };
}

describe("SidecarCore", () => {
  it("starts a query on start_session and yields queued user messages in order", async () => {
    const { core, prompt } = setup();
    core.handleLine(JSON.stringify({ type: "user_message", text: "one" }));
    core.handleLine(JSON.stringify({ type: "user_message", text: "two" }));
    const it_ = prompt()[Symbol.asyncIterator]();
    const a = (await it_.next()).value as { message: { content: string } };
    const b = (await it_.next()).value as { message: { content: string } };
    expect(a.message.content).toBe("one");
    expect(b.message.content).toBe("two");
  });

  it("emits permission_request with unique ids and resolves the matching response", async () => {
    const { core, sent, canUseTool } = setup();
    const p1 = canUseTool()("Bash", { command: "ls" });
    const p2 = canUseTool()("Write", { file_path: "a.md" });
    const reqs = sent.filter((m) => m.type === "permission_request");
    expect(reqs).toHaveLength(2);
    expect(reqs[0]).toMatchObject({ toolName: "Bash", input: { command: "ls" } });
    expect(reqs[0].id).not.toBe(reqs[1].id);

    core.handleLine(JSON.stringify({
      type: "permission_response", id: reqs[1].id, behavior: "deny", message: "no",
    }));
    core.handleLine(JSON.stringify({
      type: "permission_response", id: reqs[0].id, behavior: "allow",
    }));
    await expect(p1).resolves.toMatchObject({ behavior: "allow", updatedInput: { command: "ls" } });
    await expect(p2).resolves.toMatchObject({ behavior: "deny", message: "no" });
  });

  it("denies all pending permissions on stop", async () => {
    const { core, sent, canUseTool } = setup();
    const p = canUseTool()("Bash", { command: "rm x" });
    core.handleLine(JSON.stringify({ type: "stop" }));
    await expect(p).resolves.toMatchObject({ behavior: "deny" });
    expect(sent.some((m) => m.type === "session_closed")).toBe(true);
  });

  it("forwards interrupt to the query handle", () => {
    const { core, handle } = setup();
    core.handleLine(JSON.stringify({ type: "interrupt" }));
    expect(handle.interrupt).toHaveBeenCalled();
  });

  it("emits a non-fatal error for malformed JSON lines", () => {
    const { core, sent } = setup();
    core.handleLine("{not json");
    const err = sent.find((m) => m.type === "error");
    expect(err).toBeDefined();
    expect((err as { fatal?: boolean }).fatal).not.toBe(true);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run sidecar/__tests__/sidecar-core.test.ts`
Expected: FAIL — cannot resolve `../sidecar-core`.

- [ ] **Step 4: Implement the core**

```typescript
// sidecar/sidecar-core.ts
import type {
  SidecarInbound,
  SidecarOutbound,
  StartSessionMessage,
} from "../src/shared/types/claude-sidecar";

/** Structural subset of the SDK's PermissionResult. */
export type PermissionResultLike =
  | { behavior: "allow"; updatedInput: Record<string, unknown> }
  | { behavior: "deny"; message: string };

export type CanUseToolFn = (
  toolName: string,
  input: Record<string, unknown>,
) => Promise<PermissionResultLike>;

/** Minimal user message shape for the SDK's streaming-input mode. */
export interface SdkUserMessageLike {
  type: "user";
  message: { role: "user"; content: string };
  parent_tool_use_id: null;
  session_id: string;
}

/** Structural subset of the SDK Query object the core needs. */
export interface SidecarQueryHandle extends AsyncIterable<Record<string, unknown>> {
  interrupt(): Promise<void>;
}

export interface SidecarCoreDeps {
  startQuery(
    prompt: AsyncIterable<SdkUserMessageLike>,
    startMsg: StartSessionMessage,
    canUseTool: CanUseToolFn,
  ): SidecarQueryHandle;
  send(msg: SidecarOutbound): void;
}

/**
 * Protocol brain of the sidecar, kept free of process/stdio concerns so it can
 * be unit-tested. The entry point wires it to stdin/stdout and the real SDK.
 */
export class SidecarCore {
  private queue: SdkUserMessageLike[] = [];
  private wake: (() => void) | null = null;
  private stopped = false;
  private permSeq = 0;
  private pendingPermissions = new Map<string, (r: PermissionResultLike) => void>();
  private query: SidecarQueryHandle | null = null;

  constructor(private deps: SidecarCoreDeps) {}

  handleLine(line: string): void {
    let msg: SidecarInbound;
    try {
      msg = JSON.parse(line) as SidecarInbound;
    } catch {
      this.deps.send({ type: "error", message: `unparseable input line: ${line.slice(0, 200)}` });
      return;
    }
    switch (msg.type) {
      case "start_session":
        this.startSession(msg);
        break;
      case "user_message":
        this.queue.push({
          type: "user",
          message: { role: "user", content: msg.text },
          parent_tool_use_id: null,
          session_id: "",
        });
        this.wake?.();
        this.wake = null;
        break;
      case "permission_response": {
        const resolve = this.pendingPermissions.get(msg.id);
        if (resolve) {
          this.pendingPermissions.delete(msg.id);
          if (msg.behavior === "allow") {
            resolve({ behavior: "allow", updatedInput: this.permInputs.get(msg.id) ?? {} });
          } else {
            resolve({ behavior: "deny", message: msg.message ?? "Denied by user" });
          }
          this.permInputs.delete(msg.id);
        }
        break;
      }
      case "interrupt":
        void this.query?.interrupt();
        break;
      case "stop":
        this.shutdownSession();
        break;
    }
  }

  /** Original tool inputs kept so an "allow" can echo them back as updatedInput. */
  private permInputs = new Map<string, Record<string, unknown>>();

  private canUseTool: CanUseToolFn = (toolName, input) =>
    new Promise<PermissionResultLike>((resolve) => {
      const id = `perm-${++this.permSeq}`;
      this.pendingPermissions.set(id, resolve);
      this.permInputs.set(id, input);
      this.deps.send({ type: "permission_request", id, toolName, input });
    });

  private async *inputStream(): AsyncGenerator<SdkUserMessageLike> {
    while (!this.stopped) {
      if (this.queue.length > 0) {
        yield this.queue.shift()!;
      } else {
        await new Promise<void>((r) => (this.wake = r));
      }
    }
  }

  private startSession(msg: StartSessionMessage): void {
    this.stopped = false;
    try {
      this.query = this.deps.startQuery(this.inputStream(), msg, this.canUseTool);
    } catch (e) {
      this.deps.send({ type: "error", message: String(e), fatal: true });
      return;
    }
    void this.pump();
  }

  private async pump(): Promise<void> {
    try {
      for await (const event of this.query!) {
        this.deps.send({ type: "sdk_event", event });
      }
    } catch (e) {
      this.deps.send({ type: "error", message: String(e) });
    } finally {
      this.shutdownSession();
    }
  }

  private shutdownSession(): void {
    if (this.stopped) return;
    this.stopped = true;
    // Resolve dangling permission prompts so the SDK's awaits never leak.
    for (const [id, resolve] of this.pendingPermissions) {
      resolve({ behavior: "deny", message: "Session stopped" });
      this.permInputs.delete(id);
    }
    this.pendingPermissions.clear();
    this.wake?.();
    this.wake = null;
    this.deps.send({ type: "session_closed" });
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run sidecar/__tests__/sidecar-core.test.ts`
Expected: PASS (5 tests). Note: `shutdownSession` may fire `session_closed` twice (stop + pump-finally) — the guard `if (this.stopped) return;` prevents that; if the stop test sees two `session_closed`, fix the guard, not the test.

- [ ] **Step 6: Commit**

```bash
git add src/shared/types/claude-sidecar.ts sidecar/sidecar-core.ts sidecar/__tests__/sidecar-core.test.ts
git commit -m "feat(claude): add sidecar protocol types and testable core"
```

---

### Task 2: Installed claude CLI resolution

**Files:**
- Create: `sidecar/resolve-claude.ts`
- Test: `sidecar/__tests__/resolve-claude.test.ts`

**Interfaces:**
- Produces: `resolveClaudeExecutable(deps?): Promise<ResolvedClaude | null>` with `ResolvedClaude = { executablePath: string; executable?: "node" }` (`executable: "node"` set when pointing at an npm-installed `cli.js`). Consumed by Task 3.

- [ ] **Step 1: Write the failing tests**

```typescript
// sidecar/__tests__/resolve-claude.test.ts
import { describe, it, expect } from "vitest";
import { resolveClaudeExecutable, type ResolveDeps } from "../resolve-claude";

function deps(overrides: Partial<ResolveDeps>): ResolveDeps {
  return {
    platform: "win32",
    whichClaude: async () => [],
    exists: () => false,
    homeDir: "C:\\Users\\me",
    ...overrides,
  };
}

describe("resolveClaudeExecutable", () => {
  it("returns a native exe from PATH as-is", async () => {
    const r = await resolveClaudeExecutable(deps({
      whichClaude: async () => ["C:\\Users\\me\\.local\\bin\\claude.exe"],
    }));
    expect(r).toEqual({ executablePath: "C:\\Users\\me\\.local\\bin\\claude.exe" });
  });

  it("derives cli.js from an npm .cmd shim and sets executable=node", async () => {
    const shim = "C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd";
    const cliJs =
      "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js";
    const r = await resolveClaudeExecutable(deps({
      whichClaude: async () => [shim],
      exists: (p) => p === cliJs,
    }));
    expect(r).toEqual({ executablePath: cliJs, executable: "node" });
  });

  it("falls back to ~/.local/bin/claude.exe when PATH lookup fails", async () => {
    const fallback = "C:\\Users\\me\\.local\\bin\\claude.exe";
    const r = await resolveClaudeExecutable(deps({
      whichClaude: async () => { throw new Error("not found"); },
      exists: (p) => p === fallback,
    }));
    expect(r).toEqual({ executablePath: fallback });
  });

  it("returns null when nothing is found", async () => {
    const r = await resolveClaudeExecutable(deps({}));
    expect(r).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run sidecar/__tests__/resolve-claude.test.ts`
Expected: FAIL — cannot resolve `../resolve-claude`.

- [ ] **Step 3: Implement**

```typescript
// sidecar/resolve-claude.ts
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";

export interface ResolvedClaude {
  executablePath: string;
  /** Set to "node" when executablePath is a JS entry (npm install layout). */
  executable?: "node";
}

export interface ResolveDeps {
  platform: NodeJS.Platform;
  /** Returns candidate paths for the `claude` command (like `where`/`which`). */
  whichClaude: () => Promise<string[]>;
  exists: (p: string) => boolean;
  homeDir: string;
}

function defaultWhich(platform: NodeJS.Platform): () => Promise<string[]> {
  const cmd = platform === "win32" ? "where.exe" : "which";
  return () =>
    new Promise((resolve, reject) => {
      execFile(cmd, ["claude"], (err, stdout) => {
        if (err) return reject(err);
        resolve(stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
      });
    });
}

export async function resolveClaudeExecutable(
  deps?: Partial<ResolveDeps>,
): Promise<ResolvedClaude | null> {
  const platform = deps?.platform ?? process.platform;
  const d: ResolveDeps = {
    platform,
    whichClaude: deps?.whichClaude ?? defaultWhich(platform),
    exists: deps?.exists ?? existsSync,
    homeDir: deps?.homeDir ?? homedir(),
  };

  let candidates: string[] = [];
  try {
    candidates = await d.whichClaude();
  } catch {
    // fall through to fixed locations
  }

  for (const c of candidates) {
    const lower = c.toLowerCase();
    if (lower.endsWith(".cmd") || lower.endsWith(".ps1")) {
      // npm global shim: the real entry is node_modules/@anthropic-ai/claude-code/cli.js
      const cliJs = path.join(
        path.dirname(c), "node_modules", "@anthropic-ai", "claude-code", "cli.js",
      );
      if (d.exists(cliJs)) return { executablePath: cliJs, executable: "node" };
    } else if (lower.endsWith(".js")) {
      return { executablePath: c, executable: "node" };
    } else {
      // Native binary (claude.exe on Windows, claude elsewhere).
      return { executablePath: c };
    }
  }

  // Native installer default location.
  const native = path.join(
    d.homeDir, ".local", "bin", platform === "win32" ? "claude.exe" : "claude",
  );
  if (d.exists(native)) return { executablePath: native };
  return null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run sidecar/__tests__/resolve-claude.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add sidecar/resolve-claude.ts sidecar/__tests__/resolve-claude.test.ts
git commit -m "feat(claude): resolve installed claude CLI executable for the sidecar"
```

---

### Task 3: Sidecar entry point + esbuild bundling + resource wiring

**Files:**
- Create: `sidecar/claude-sidecar.ts`
- Create: `scripts/build-claude-sidecar.mjs`
- Modify: `package.json` (devDependency + scripts)
- Modify: `src-tauri/tauri.conf.json` (bundle.resources)

**Interfaces:**
- Consumes: `SidecarCore` (Task 1), `resolveClaudeExecutable` (Task 2), `query` from `@anthropic-ai/claude-agent-sdk`.
- Produces: `resources/claude-sidecar/claude-sidecar.cjs` (build artifact, git-ignored), spawned by Task 4 as `node <path>`.

- [ ] **Step 1: Install the SDK as a devDependency**

Run: `npm install -D @anthropic-ai/claude-agent-sdk`
Expected: package added (version ^0.3.x). It is bundled into the sidecar only — never imported from `src/`.

- [ ] **Step 2: Write the entry point**

```typescript
// sidecar/claude-sidecar.ts
// Entry point: wires SidecarCore to stdin/stdout and the real Agent SDK.
// Bundled by scripts/build-claude-sidecar.mjs into resources/claude-sidecar/.
import { createInterface } from "node:readline";
import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
import { SidecarCore, type SidecarCoreDeps, type SdkUserMessageLike } from "./sidecar-core";
import { resolveClaudeExecutable, type ResolvedClaude } from "./resolve-claude";
import type { SidecarOutbound, StartSessionMessage } from "../src/shared/types/claude-sidecar";

function send(msg: SidecarOutbound): void {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

let resolved: ResolvedClaude | null = null;

const deps: SidecarCoreDeps = {
  startQuery(prompt, startMsg: StartSessionMessage, canUseTool) {
    if (!resolved) {
      throw new Error("CLAUDE_CLI_NOT_FOUND");
    }
    const options: Options = {
      cwd: startMsg.cwd,
      permissionMode: startMsg.permissionMode,
      settingSources: ["user", "project", "local"],
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        ...(startMsg.systemPromptAppend ? { append: startMsg.systemPromptAppend } : {}),
      },
      includePartialMessages: true,
      canUseTool: (toolName, input) => canUseTool(toolName, input as Record<string, unknown>),
      pathToClaudeCodeExecutable: resolved.executablePath,
      ...(resolved.executable ? { executable: resolved.executable } : {}),
      ...(startMsg.model ? { model: startMsg.model } : {}),
      ...(startMsg.resumeSessionId ? { resume: startMsg.resumeSessionId } : {}),
      stderr: (data: string) => process.stderr.write(data),
    };
    return query({
      prompt: prompt as AsyncIterable<SdkUserMessageLike>,
      options,
    }) as unknown as ReturnType<SidecarCoreDeps["startQuery"]>;
  },
  send,
};

async function main(): Promise<void> {
  resolved = await resolveClaudeExecutable();
  if (!resolved) {
    // Fatal: mdium shows the "install claude CLI" guidance and stops.
    send({ type: "error", message: "CLAUDE_CLI_NOT_FOUND", fatal: true });
  }
  const core = new SidecarCore(deps);
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    if (line.trim()) core.handleLine(line);
  });
  rl.on("close", () => process.exit(0));
  send({ type: "ready" });
}

void main();
```

Note: if `Options`/`query` typings differ from the above in the installed SDK version (e.g. `canUseTool` third parameter, `executable` literal type), adapt the entry point to the SDK's actual types — the core and protocol stay unchanged. Check with `npx tsc --noEmit -p tsconfig.json` only if sidecar files are included there; otherwise rely on the esbuild step and editor diagnostics.

- [ ] **Step 3: Write the build script**

```javascript
// scripts/build-claude-sidecar.mjs
import { build } from "esbuild";

await build({
  entryPoints: ["sidecar/claude-sidecar.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  outfile: "resources/claude-sidecar/claude-sidecar.cjs",
  // The SDK's per-platform native binary packages must not be bundled;
  // we always pass pathToClaudeCodeExecutable so they are never loaded.
  external: ["@anthropic-ai/claude-agent-sdk-*"],
  logLevel: "info",
});
```

- [ ] **Step 4: Wire package.json and tauri.conf.json**

In `package.json` scripts:

```json
"build": "tsc && vite build && npm run build:sidecar",
"build:sidecar": "node scripts/build-claude-sidecar.mjs",
```

In `src-tauri/tauri.conf.json`, add to `bundle.resources`:

```json
"../resources/claude-sidecar/**/*",
```

- [ ] **Step 5: Verify the bundle builds and boots**

Run: `npm run build:sidecar`
Expected: `resources/claude-sidecar/claude-sidecar.cjs` created without errors.

Run (Git Bash): `echo "" | node resources/claude-sidecar/claude-sidecar.cjs`
Expected: prints one or two JSON lines (`{"type":"error","message":"CLAUDE_CLI_NOT_FOUND",...}` if claude is absent, then `{"type":"ready"}`) and exits 0. If esbuild fails on a dynamic require inside the SDK, add the failing module to `external` and re-run.

- [ ] **Step 6: Commit**

```bash
git add sidecar/claude-sidecar.ts scripts/build-claude-sidecar.mjs package.json package-lock.json src-tauri/tauri.conf.json
git commit -m "feat(claude): sidecar entry point and esbuild bundle wiring"
```

Also confirm `resources/claude-sidecar/` is NOT committed: add `resources/claude-sidecar/` to `.gitignore` in this commit (it is a build artifact).

---

### Task 4: Rust stdio bridge (claude_sidecar.rs)

**Files:**
- Create: `src-tauri/src/commands/claude_sidecar.rs`
- Modify: `src-tauri/src/commands/mod.rs` (add `pub mod claude_sidecar;`)
- Modify: `src-tauri/src/lib.rs` (register 4 commands after the pty block, ~line 252)

**Interfaces:**
- Produces Tauri commands consumed by Task 5:
  - `resolve_claude_sidecar_path() -> String`
  - `spawn_claude_sidecar(script_path: String, cwd: String) -> u32`
  - `write_claude_sidecar(id: u32, line: String)`
  - `kill_claude_sidecar(id: u32)`
- Produces Tauri events: `claude-sidecar://line` `{id, line}`, `claude-sidecar://stderr` `{id, line}`, `claude-sidecar://exit` `{id, code}`.

- [ ] **Step 1: Implement the module**

```rust
// src-tauri/src/commands/claude_sidecar.rs
use serde::Serialize;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{ChildStdin, Command, Stdio};
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[derive(Serialize, Clone)]
pub struct SidecarLine {
    pub id: u32,
    pub line: String,
}

#[derive(Serialize, Clone)]
pub struct SidecarExit {
    pub id: u32,
    pub code: Option<i32>,
}

fn stdin_map() -> &'static Mutex<HashMap<u32, ChildStdin>> {
    static MAP: OnceLock<Mutex<HashMap<u32, ChildStdin>>> = OnceLock::new();
    MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Forward non-empty lines from a reader to a callback. Extracted for testing.
pub fn forward_lines<R: BufRead>(reader: R, mut emit: impl FnMut(String)) {
    for line in reader.lines() {
        match line {
            Ok(l) if !l.trim().is_empty() => emit(l),
            Ok(_) => {}
            Err(_) => break,
        }
    }
}

fn strip_win_prefix(p: &PathBuf) -> String {
    let s = p.to_string_lossy().to_string();
    s.strip_prefix("\\\\?\\").map(|x| x.to_string()).unwrap_or(s)
}

#[tauri::command]
pub fn resolve_claude_sidecar_path(app: AppHandle) -> Result<String, String> {
    use tauri::Manager;
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("Failed to get resource dir: {}", e))?;

    // Production bundle (Tauri copies ../resources/... into _up_/resources/...)
    let candidates = [
        resource_dir
            .join("_up_")
            .join("resources")
            .join("claude-sidecar")
            .join("claude-sidecar.cjs"),
        resource_dir.join("claude-sidecar").join("claude-sidecar.cjs"),
        // Dev fallback: repo-root resources dir relative to src-tauri.
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("resources")
            .join("claude-sidecar")
            .join("claude-sidecar.cjs"),
    ];
    for c in candidates.iter() {
        if c.exists() {
            return Ok(strip_win_prefix(c));
        }
    }
    Err("claude-sidecar.cjs not found; run `npm run build:sidecar`".to_string())
}

#[tauri::command]
pub fn spawn_claude_sidecar(app: AppHandle, script_path: String, cwd: String) -> Result<u32, String> {
    // Mirror pty.rs: go through cmd on Windows so PATH lookup of node matches
    // the rest of the app; stdio pipes pass through cmd to node unchanged.
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = Command::new("cmd");
        c.arg("/C").arg("node").arg(&script_path);
        c.creation_flags(0x08000000); // CREATE_NO_WINDOW
        c
    };
    #[cfg(not(target_os = "windows"))]
    let mut cmd = {
        let mut c = Command::new("node");
        c.arg(&script_path);
        c
    };

    cmd.current_dir(&cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn claude sidecar: {}", e))?;
    let id = child.id();

    let stdin = child.stdin.take().ok_or("sidecar stdin unavailable")?;
    stdin_map().lock().unwrap().insert(id, stdin);

    let stdout = child.stdout.take().ok_or("sidecar stdout unavailable")?;
    let app_out = app.clone();
    std::thread::spawn(move || {
        forward_lines(BufReader::new(stdout), |line| {
            let _ = app_out.emit("claude-sidecar://line", SidecarLine { id, line });
        });
    });

    let stderr = child.stderr.take().ok_or("sidecar stderr unavailable")?;
    let app_err = app.clone();
    std::thread::spawn(move || {
        forward_lines(BufReader::new(stderr), |line| {
            let _ = app_err.emit("claude-sidecar://stderr", SidecarLine { id, line });
        });
    });

    let app_exit = app.clone();
    std::thread::spawn(move || {
        let code = child.wait().ok().and_then(|s| s.code());
        stdin_map().lock().unwrap().remove(&id);
        let _ = app_exit.emit("claude-sidecar://exit", SidecarExit { id, code });
    });

    Ok(id)
}

#[tauri::command]
pub fn write_claude_sidecar(id: u32, line: String) -> Result<(), String> {
    let mut map = stdin_map().lock().unwrap();
    let stdin = map.get_mut(&id).ok_or("sidecar not running")?;
    stdin
        .write_all(line.as_bytes())
        .and_then(|_| stdin.write_all(b"\n"))
        .and_then(|_| stdin.flush())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn kill_claude_sidecar(id: u32) -> Result<(), String> {
    // Dropping stdin lets a healthy sidecar exit on rl "close".
    stdin_map().lock().unwrap().remove(&id);
    #[cfg(target_os = "windows")]
    {
        let _ = Command::new("taskkill")
            .args(["/PID", &id.to_string(), "/F", "/T"])
            .creation_flags(0x08000000)
            .output();
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = Command::new("kill").args(["-9", &id.to_string()]).output();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::forward_lines;
    use std::io::Cursor;

    #[test]
    fn forward_lines_skips_blank_lines() {
        let input = Cursor::new("a\n\n  \nb\n");
        let mut got: Vec<String> = vec![];
        forward_lines(input, |l| got.push(l));
        assert_eq!(got, vec!["a".to_string(), "b".to_string()]);
    }
}
```

- [ ] **Step 2: Register module and commands**

In `src-tauri/src/commands/mod.rs` add `pub mod claude_sidecar;` (alphabetical order with the other mods).

In `src-tauri/src/lib.rs`, inside `generate_handler![...]` after `commands::pty::kill_background_process,` (~line 252) add:

```rust
            commands::claude_sidecar::resolve_claude_sidecar_path,
            commands::claude_sidecar::spawn_claude_sidecar,
            commands::claude_sidecar::write_claude_sidecar,
            commands::claude_sidecar::kill_claude_sidecar,
```

- [ ] **Step 3: Verify compilation and unit test**

Run: `cargo test -p mdium forward_lines --manifest-path src-tauri/Cargo.toml` (adjust package name to the one in `src-tauri/Cargo.toml` if different; `cargo test forward_lines` from `src-tauri/` also works)
Expected: 1 test passes. Then `cargo check` from `src-tauri/` — no errors.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands/claude_sidecar.rs src-tauri/src/commands/mod.rs src-tauri/src/lib.rs
git commit -m "feat(claude): Rust stdio bridge for the claude sidecar"
```

---

### Task 5: Frontend sidecar client

**Files:**
- Create: `src/features/claude-config/lib/claude-sidecar-client.ts`
- Test: `src/features/claude-config/lib/__tests__/claude-sidecar-client.test.ts`

**Interfaces:**
- Consumes: Task 4 commands/events, `SidecarInbound`/`SidecarOutbound` types.
- Produces (used by Task 8):
  - `spawnSidecar(cwd: string): Promise<number>`
  - `sendToSidecar(id: number, msg: SidecarInbound): Promise<void>`
  - `killSidecar(id: number): Promise<void>`
  - `parseSidecarLine(line: string): SidecarOutbound | null`
  - `subscribeSidecar(id, handlers: { onMessage(m: SidecarOutbound): void; onStderr(line: string): void; onExit(code: number | null): void }): Promise<() => void>`

- [ ] **Step 1: Write the failing test for parseSidecarLine**

```typescript
// src/features/claude-config/lib/__tests__/claude-sidecar-client.test.ts
import { describe, it, expect, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import { parseSidecarLine } from "../claude-sidecar-client";

describe("parseSidecarLine", () => {
  it("parses a valid outbound message", () => {
    expect(parseSidecarLine('{"type":"ready"}')).toEqual({ type: "ready" });
  });

  it("returns null for invalid JSON", () => {
    expect(parseSidecarLine("not json")).toBeNull();
  });

  it("returns null for JSON without a string type", () => {
    expect(parseSidecarLine('{"foo":1}')).toBeNull();
    expect(parseSidecarLine('"just a string"')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/features/claude-config/lib/__tests__/claude-sidecar-client.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
// src/features/claude-config/lib/claude-sidecar-client.ts
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { SidecarInbound, SidecarOutbound } from "@/shared/types/claude-sidecar";

interface SidecarLinePayload {
  id: number;
  line: string;
}
interface SidecarExitPayload {
  id: number;
  code: number | null;
}

export async function spawnSidecar(cwd: string): Promise<number> {
  const scriptPath = await invoke<string>("resolve_claude_sidecar_path");
  return invoke<number>("spawn_claude_sidecar", { scriptPath, cwd });
}

export function sendToSidecar(id: number, msg: SidecarInbound): Promise<void> {
  return invoke("write_claude_sidecar", { id, line: JSON.stringify(msg) });
}

export function killSidecar(id: number): Promise<void> {
  return invoke("kill_claude_sidecar", { id });
}

export function parseSidecarLine(line: string): SidecarOutbound | null {
  try {
    const parsed: unknown = JSON.parse(line);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as { type?: unknown }).type === "string"
    ) {
      return parsed as SidecarOutbound;
    }
  } catch {
    // fall through
  }
  return null;
}

export interface SidecarHandlers {
  onMessage(msg: SidecarOutbound): void;
  onStderr(line: string): void;
  onExit(code: number | null): void;
}

/** Subscribe to one sidecar's events. Returns a combined unlisten function. */
export async function subscribeSidecar(
  id: number,
  handlers: SidecarHandlers,
): Promise<() => void> {
  const unlisteners = await Promise.all([
    listen<SidecarLinePayload>("claude-sidecar://line", (e) => {
      if (e.payload.id !== id) return;
      const msg = parseSidecarLine(e.payload.line);
      if (msg) handlers.onMessage(msg);
      else console.warn("[claude][diag] unparseable sidecar line:", e.payload.line);
    }),
    listen<SidecarLinePayload>("claude-sidecar://stderr", (e) => {
      if (e.payload.id === id) handlers.onStderr(e.payload.line);
    }),
    listen<SidecarExitPayload>("claude-sidecar://exit", (e) => {
      if (e.payload.id === id) handlers.onExit(e.payload.code);
    }),
  ]);
  return () => unlisteners.forEach((u) => u());
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/features/claude-config/lib/__tests__/claude-sidecar-client.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/features/claude-config/lib/claude-sidecar-client.ts src/features/claude-config/lib/__tests__/claude-sidecar-client.test.ts
git commit -m "feat(claude): frontend sidecar client over Tauri events"
```

---

### Task 6: SDK event → UI message mapper

**Files:**
- Create: `src/features/claude-config/lib/claude-message-mapper.ts`
- Test: `src/features/claude-config/lib/__tests__/claude-message-mapper.test.ts`

**Interfaces:**
- Produces (used by Task 8/10):

```typescript
export interface ClaudeTextPart { type: "text"; text: string }
export interface ClaudeToolPart {
  type: "tool"; id: string; name: string; input: unknown;
  output?: string; isError?: boolean; done: boolean;
}
export type ClaudePart = ClaudeTextPart | ClaudeToolPart;
export interface ClaudeMessage { role: "user" | "assistant"; parts: ClaudePart[]; streaming?: boolean }
export interface ChatModelState {
  sessionId: string | null;
  messages: ClaudeMessage[];
  running: boolean;
  usage: { inputTokens: number; outputTokens: number } | null;
}
export function emptyChatModel(): ChatModelState;
export function appendUserMessage(state: ChatModelState, text: string): ChatModelState;
export function applySdkEvent(state: ChatModelState, event: Record<string, unknown>): ChatModelState;
```

- [ ] **Step 1: Write the failing tests**

```typescript
// src/features/claude-config/lib/__tests__/claude-message-mapper.test.ts
import { describe, it, expect } from "vitest";
import {
  emptyChatModel,
  appendUserMessage,
  applySdkEvent,
  type ClaudeToolPart,
} from "../claude-message-mapper";

describe("claude-message-mapper", () => {
  it("captures session id from system init", () => {
    const s = applySdkEvent(emptyChatModel(), {
      type: "system", subtype: "init", session_id: "sess-1",
    });
    expect(s.sessionId).toBe("sess-1");
  });

  it("accumulates stream_event text deltas into a streaming assistant message", () => {
    let s = emptyChatModel();
    const delta = (text: string) => ({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text } },
    });
    s = applySdkEvent(s, delta("Hel"));
    s = applySdkEvent(s, delta("lo"));
    expect(s.messages).toHaveLength(1);
    expect(s.messages[0]).toMatchObject({
      role: "assistant", streaming: true, parts: [{ type: "text", text: "Hello" }],
    });
  });

  it("replaces the streaming placeholder with the complete assistant message", () => {
    let s = applySdkEvent(emptyChatModel(), {
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hel" } },
    });
    s = applySdkEvent(s, {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Hello there" },
          { type: "tool_use", id: "tu-1", name: "Read", input: { file_path: "a.md" } },
        ],
      },
    });
    expect(s.messages).toHaveLength(1);
    expect(s.messages[0].streaming).toBeUndefined();
    expect(s.messages[0].parts[0]).toEqual({ type: "text", text: "Hello there" });
    expect(s.messages[0].parts[1]).toMatchObject({
      type: "tool", id: "tu-1", name: "Read", done: false,
    });
  });

  it("attaches tool results to the matching tool part", () => {
    let s = applySdkEvent(emptyChatModel(), {
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "tu-1", name: "Bash", input: {} }] },
    });
    s = applySdkEvent(s, {
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: "tu-1", content: "ok", is_error: false }],
      },
    });
    const tool = s.messages[0].parts[0] as ClaudeToolPart;
    expect(tool.done).toBe(true);
    expect(tool.output).toBe("ok");
    expect(tool.isError).toBe(false);
  });

  it("result event stops running and records usage", () => {
    let s = { ...emptyChatModel(), running: true };
    s = applySdkEvent(s, {
      type: "result", session_id: "sess-1",
      usage: { input_tokens: 10, output_tokens: 20 },
    });
    expect(s.running).toBe(false);
    expect(s.usage).toEqual({ inputTokens: 10, outputTokens: 20 });
  });

  it("appendUserMessage adds a user message and sets running", () => {
    const s = appendUserMessage(emptyChatModel(), "hi");
    expect(s.messages[0]).toEqual({ role: "user", parts: [{ type: "text", text: "hi" }] });
    expect(s.running).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/features/claude-config/lib/__tests__/claude-message-mapper.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
// src/features/claude-config/lib/claude-message-mapper.ts
// Pure reducer that folds raw Agent SDK messages (passed through the sidecar
// as sdk_event) into a renderable chat model. Keeping this pure isolates the
// UI from SDK message-shape changes and makes it unit-testable.

export interface ClaudeTextPart {
  type: "text";
  text: string;
}
export interface ClaudeToolPart {
  type: "tool";
  id: string;
  name: string;
  input: unknown;
  output?: string;
  isError?: boolean;
  done: boolean;
}
export type ClaudePart = ClaudeTextPart | ClaudeToolPart;

export interface ClaudeMessage {
  role: "user" | "assistant";
  parts: ClaudePart[];
  streaming?: boolean;
}

export interface ChatModelState {
  sessionId: string | null;
  messages: ClaudeMessage[];
  running: boolean;
  usage: { inputTokens: number; outputTokens: number } | null;
}

export function emptyChatModel(): ChatModelState {
  return { sessionId: null, messages: [], running: false, usage: null };
}

export function appendUserMessage(state: ChatModelState, text: string): ChatModelState {
  return {
    ...state,
    running: true,
    messages: [...state.messages, { role: "user", parts: [{ type: "text", text }] }],
  };
}

type AnyRec = Record<string, unknown>;

function contentBlocks(event: AnyRec): AnyRec[] {
  const message = event.message as AnyRec | undefined;
  const content = message?.content;
  return Array.isArray(content) ? (content as AnyRec[]) : [];
}

function toolResultText(block: AnyRec): string {
  const content = block.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return (content as AnyRec[])
      .map((c) => (typeof c.text === "string" ? c.text : ""))
      .join("");
  }
  return "";
}

function dropStreamingPlaceholder(messages: ClaudeMessage[]): ClaudeMessage[] {
  const last = messages[messages.length - 1];
  return last?.streaming ? messages.slice(0, -1) : messages;
}

export function applySdkEvent(state: ChatModelState, event: AnyRec): ChatModelState {
  switch (event.type) {
    case "system": {
      if (event.subtype === "init" && typeof event.session_id === "string") {
        return { ...state, sessionId: event.session_id };
      }
      return state;
    }

    case "stream_event": {
      const inner = event.event as AnyRec | undefined;
      const delta = inner?.delta as AnyRec | undefined;
      if (inner?.type !== "content_block_delta" || delta?.type !== "text_delta") return state;
      const text = typeof delta.text === "string" ? delta.text : "";
      if (!text) return state;
      const messages = [...state.messages];
      const last = messages[messages.length - 1];
      if (last?.streaming) {
        const firstPart = last.parts[0] as ClaudeTextPart;
        messages[messages.length - 1] = {
          ...last,
          parts: [{ type: "text", text: firstPart.text + text }],
        };
      } else {
        messages.push({ role: "assistant", streaming: true, parts: [{ type: "text", text }] });
      }
      return { ...state, messages };
    }

    case "assistant": {
      const parts: ClaudePart[] = [];
      for (const block of contentBlocks(event)) {
        if (block.type === "text" && typeof block.text === "string" && block.text) {
          parts.push({ type: "text", text: block.text });
        } else if (block.type === "tool_use") {
          parts.push({
            type: "tool",
            id: String(block.id ?? ""),
            name: String(block.name ?? ""),
            input: block.input,
            done: false,
          });
        }
      }
      if (parts.length === 0) return state;
      return {
        ...state,
        messages: [...dropStreamingPlaceholder(state.messages), { role: "assistant", parts }],
      };
    }

    case "user": {
      // Tool results echo back as user messages containing tool_result blocks.
      let messages = state.messages;
      for (const block of contentBlocks(event)) {
        if (block.type !== "tool_result") continue;
        const toolUseId = String(block.tool_use_id ?? "");
        messages = messages.map((m) => ({
          ...m,
          parts: m.parts.map((p) =>
            p.type === "tool" && p.id === toolUseId
              ? {
                  ...p,
                  done: true,
                  output: toolResultText(block),
                  isError: block.is_error === true,
                }
              : p,
          ),
        }));
      }
      return messages === state.messages ? state : { ...state, messages };
    }

    case "result": {
      const usage = event.usage as AnyRec | undefined;
      return {
        ...state,
        running: false,
        messages: dropStreamingPlaceholder(state.messages).map((m) => ({ ...m })),
        sessionId: typeof event.session_id === "string" ? event.session_id : state.sessionId,
        usage:
          usage &&
          typeof usage.input_tokens === "number" &&
          typeof usage.output_tokens === "number"
            ? { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens }
            : state.usage,
      };
    }

    default:
      return state;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/features/claude-config/lib/__tests__/claude-message-mapper.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/features/claude-config/lib/claude-message-mapper.ts src/features/claude-config/lib/__tests__/claude-message-mapper.test.ts
git commit -m "feat(claude): pure mapper from SDK events to chat model"
```

---

### Task 7: Per-folder session/settings store

**Files:**
- Create: `src/stores/claude-session-store.ts`
- Test: `src/stores/__tests__/claude-session-store.test.ts`

**Interfaces:**
- Produces (used by Tasks 8, 11):

```typescript
export interface ClaudeFolderSettings {
  lastSessionId: string | null;
  model: string;             // "" = CLI default
  permissionMode: ClaudePermissionMode;
}
useClaudeSessionStore: {
  folders: Record<string, ClaudeFolderSettings>;
  getFolderSettings(folder: string): ClaudeFolderSettings;
  setLastSessionId(folder: string, id: string | null): void;
  setModel(folder: string, model: string): void;
  setPermissionMode(folder: string, mode: ClaudePermissionMode): void;
}
```

- [ ] **Step 1: Write the failing tests**

```typescript
// src/stores/__tests__/claude-session-store.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { useClaudeSessionStore, DEFAULT_CLAUDE_FOLDER_SETTINGS } from "../claude-session-store";

describe("claude-session-store", () => {
  beforeEach(() => {
    useClaudeSessionStore.setState({ folders: {} });
  });

  it("returns defaults for an unknown folder", () => {
    const s = useClaudeSessionStore.getState().getFolderSettings("C:/proj");
    expect(s).toEqual(DEFAULT_CLAUDE_FOLDER_SETTINGS);
  });

  it("persists per-folder session id, model and permission mode independently", () => {
    const st = useClaudeSessionStore.getState();
    st.setLastSessionId("C:/a", "sess-1");
    st.setModel("C:/a", "claude-sonnet-5");
    st.setPermissionMode("C:/b", "acceptEdits");

    const a = useClaudeSessionStore.getState().getFolderSettings("C:/a");
    const b = useClaudeSessionStore.getState().getFolderSettings("C:/b");
    expect(a).toMatchObject({ lastSessionId: "sess-1", model: "claude-sonnet-5" });
    expect(a.permissionMode).toBe("default");
    expect(b).toMatchObject({ lastSessionId: null, permissionMode: "acceptEdits" });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/stores/__tests__/claude-session-store.test.ts`
Expected: FAIL — module not found. (If vitest errors on `localStorage` being undefined in the node environment, add `// @vitest-environment happy-dom` as the first line of the test file.)

- [ ] **Step 3: Implement**

```typescript
// src/stores/claude-session-store.ts
import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { ClaudePermissionMode } from "@/shared/types/claude-sidecar";

export interface ClaudeFolderSettings {
  lastSessionId: string | null;
  model: string; // "" means "use the CLI default model"
  permissionMode: ClaudePermissionMode;
}

export const DEFAULT_CLAUDE_FOLDER_SETTINGS: ClaudeFolderSettings = {
  lastSessionId: null,
  model: "",
  permissionMode: "default",
};

interface ClaudeSessionState {
  folders: Record<string, ClaudeFolderSettings>;
  getFolderSettings: (folder: string) => ClaudeFolderSettings;
  setLastSessionId: (folder: string, id: string | null) => void;
  setModel: (folder: string, model: string) => void;
  setPermissionMode: (folder: string, mode: ClaudePermissionMode) => void;
}

export const useClaudeSessionStore = create<ClaudeSessionState>()(
  persist(
    (set, get) => {
      const update = (folder: string, patch: Partial<ClaudeFolderSettings>) =>
        set((s) => ({
          folders: {
            ...s.folders,
            [folder]: { ...DEFAULT_CLAUDE_FOLDER_SETTINGS, ...s.folders[folder], ...patch },
          },
        }));
      return {
        folders: {},
        getFolderSettings: (folder) =>
          get().folders[folder] ?? DEFAULT_CLAUDE_FOLDER_SETTINGS,
        setLastSessionId: (folder, id) => update(folder, { lastSessionId: id }),
        setModel: (folder, model) => update(folder, { model }),
        setPermissionMode: (folder, mode) => update(folder, { permissionMode: mode }),
      };
    },
    { name: "mdium-claude-sessions" },
  ),
);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/stores/__tests__/claude-session-store.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/stores/claude-session-store.ts src/stores/__tests__/claude-session-store.test.ts
git commit -m "feat(claude): persisted per-folder session and settings store"
```

---

### Task 8: Chat store + useClaudeChat hook

**Files:**
- Create: `src/features/claude-config/hooks/useClaudeChat.ts`

**Interfaces:**
- Consumes: Tasks 5, 6, 7; `ensureCommand` + `NODE_INSTALL_URL` from `@/shared/lib/ensureCommand`; `evaluateStall`, `STALL_TICK_MS` from `@/features/opencode-config/hooks/stall-watchdog`; `useTabStore` (active file path); i18n keys added in Task 9.
- Produces (used by Task 10):

```typescript
useClaudeChatStore: {
  connected: boolean; connecting: boolean; error: string | null;
  chat: ChatModelState; pendingPermission: SidecarPermissionRequest | null;
  stallNotice: boolean;
}
export function useClaudeChat(): {
  connected; connecting; error; chat; pendingPermission; stallNotice;
  connect(): Promise<void>;
  sendMessage(text: string): Promise<void>;
  interrupt(): Promise<void>;
  respondPermission(id: string, behavior: "allow" | "deny"): Promise<void>;
  newSession(): Promise<void>;
};
export function killClaudeSidecar(): Promise<void>; // for App shutdown
```

- [ ] **Step 1: Implement the hook module**

```typescript
// src/features/claude-config/hooks/useClaudeChat.ts
import { useEffect } from "react";
import { create } from "zustand";
import i18n from "@/shared/i18n";
import { useTabStore } from "@/stores/tab-store";
import { useClaudeSessionStore } from "@/stores/claude-session-store";
import { ensureCommand, NODE_INSTALL_URL } from "@/shared/lib/ensureCommand";
import {
  evaluateStall,
  STALL_TICK_MS,
} from "@/features/opencode-config/hooks/stall-watchdog";
import {
  spawnSidecar,
  sendToSidecar,
  killSidecar,
  subscribeSidecar,
} from "../lib/claude-sidecar-client";
import {
  applySdkEvent,
  appendUserMessage,
  emptyChatModel,
  type ChatModelState,
} from "../lib/claude-message-mapper";
import type {
  SidecarOutbound,
  SidecarPermissionRequest,
} from "@/shared/types/claude-sidecar";

export const CLAUDE_INSTALL_URL = "https://code.claude.com/docs/";

interface ClaudeChatUIState {
  connected: boolean;
  connecting: boolean;
  error: string | null;
  chat: ChatModelState;
  pendingPermission: SidecarPermissionRequest | null;
  stallNotice: boolean;
  lastEventAt: number;
}

export const useClaudeChatStore = create<ClaudeChatUIState>()(() => ({
  connected: false,
  connecting: false,
  error: null,
  chat: emptyChatModel(),
  pendingPermission: null,
  stallNotice: false,
  lastEventAt: 0,
}));

// Module-level singleton connection (mirrors the useOpencodeChat pattern).
let _sidecarId: number | null = null;
let _folder: string | null = null;
let _unsubscribe: (() => void) | null = null;

function setState(patch: Partial<ClaudeChatUIState>): void {
  useClaudeChatStore.setState(patch);
}

function handleSidecarMessage(msg: SidecarOutbound): void {
  const st = useClaudeChatStore.getState();
  switch (msg.type) {
    case "ready": {
      // Sidecar booted; start (or resume) the session.
      const folder = _folder!;
      const settings = useClaudeSessionStore.getState().getFolderSettings(folder);
      void sendToSidecar(_sidecarId!, {
        type: "start_session",
        cwd: folder,
        model: settings.model || undefined,
        permissionMode: settings.permissionMode,
        resumeSessionId: settings.lastSessionId ?? undefined,
      });
      setState({ connected: true, connecting: false, error: null });
      break;
    }
    case "sdk_event": {
      const chat = applySdkEvent(st.chat, msg.event);
      if (chat.sessionId && chat.sessionId !== st.chat.sessionId && _folder) {
        useClaudeSessionStore.getState().setLastSessionId(_folder, chat.sessionId);
      }
      setState({ chat, lastEventAt: Date.now(), stallNotice: false });
      break;
    }
    case "permission_request":
      setState({ pendingPermission: msg, lastEventAt: Date.now() });
      break;
    case "error": {
      const message =
        msg.message === "CLAUDE_CLI_NOT_FOUND"
          ? i18n.t("claudeCliNotFound", { ns: "claude-config" })
          : msg.message;
      setState({ error: message });
      if (msg.fatal) setState({ connected: false, connecting: false });
      break;
    }
    case "session_closed":
      setState({ chat: { ...st.chat, running: false } });
      break;
  }
}

export async function doClaudeConnect(folder: string): Promise<void> {
  if (_sidecarId !== null && _folder === folder) return;
  await killClaudeSidecar();

  const nodeOk = await ensureCommand("node", {
    messageKey: "nodeNotFound",
    promptKey: "openInstallGuide",
    installUrl: NODE_INSTALL_URL,
  });
  if (!nodeOk) {
    setState({ error: i18n.t("nodeNotFound", { ns: "common" }) });
    return;
  }

  setState({ connecting: true, error: null, chat: emptyChatModel() });
  _folder = folder;
  try {
    _sidecarId = await spawnSidecar(folder);
  } catch (e) {
    setState({ connecting: false, error: String(e) });
    _folder = null;
    return;
  }
  _unsubscribe = await subscribeSidecar(_sidecarId, {
    onMessage: handleSidecarMessage,
    onStderr: (line) => console.warn("[claude][diag]", line),
    onExit: () => {
      _sidecarId = null;
      _unsubscribe?.();
      _unsubscribe = null;
      setState({ connected: false, connecting: false });
    },
  });
}

/**
 * Prefix outgoing messages with the file currently open in the editor so the
 * agent knows what the user is looking at (same idea as wrapWithMdiumContext
 * in useOpencodeChat, but sourced from the tab store).
 */
function wrapWithFileContext(text: string): string {
  const active = useTabStore.getState().getActiveTab();
  if (!active?.filePath) return text;
  return `<mdium_context>\nactive_file="${active.filePath.replace(/"/g, '\\"')}"\n</mdium_context>\n\n${text}`;
}

export async function doClaudeSend(text: string): Promise<void> {
  if (_sidecarId === null) return;
  const st = useClaudeChatStore.getState();
  setState({ chat: appendUserMessage(st.chat, text), lastEventAt: Date.now() });
  await sendToSidecar(_sidecarId, { type: "user_message", text: wrapWithFileContext(text) });
}

export async function doClaudeInterrupt(): Promise<void> {
  if (_sidecarId === null) return;
  await sendToSidecar(_sidecarId, { type: "interrupt" });
  const st = useClaudeChatStore.getState();
  setState({ chat: { ...st.chat, running: false }, pendingPermission: null });
}

export async function doClaudeRespondPermission(
  id: string,
  behavior: "allow" | "deny",
): Promise<void> {
  if (_sidecarId === null) return;
  setState({ pendingPermission: null });
  await sendToSidecar(_sidecarId, { type: "permission_response", id, behavior });
}

export async function doClaudeNewSession(): Promise<void> {
  if (_folder) useClaudeSessionStore.getState().setLastSessionId(_folder, null);
  const folder = _folder;
  await killClaudeSidecar();
  if (folder) await doClaudeConnect(folder);
}

/** Kill the sidecar (app shutdown / folder close). Safe to call when idle. */
export async function killClaudeSidecar(): Promise<void> {
  const id = _sidecarId;
  _sidecarId = null;
  _folder = null;
  _unsubscribe?.();
  _unsubscribe = null;
  useClaudeChatStore.setState({
    connected: false,
    connecting: false,
    pendingPermission: null,
    chat: emptyChatModel(),
  });
  if (id !== null) {
    try {
      await sendToSidecar(id, { type: "stop" });
    } catch {
      // already gone
    }
    await killSidecar(id).catch(() => {});
  }
}

export function useClaudeChat() {
  const state = useClaudeChatStore();

  // Soft stall watchdog: only the "still waiting" notice for the MVP.
  useEffect(() => {
    const timer = setInterval(() => {
      const s = useClaudeChatStore.getState();
      const action = evaluateStall({
        now: Date.now(),
        lastEventAt: s.lastEventAt,
        loading: s.chat.running,
        aborted: false,
        noticeShown: s.stallNotice,
      });
      if (action === "notice") setState({ stallNotice: true });
    }, STALL_TICK_MS);
    return () => clearInterval(timer);
  }, []);

  return {
    connected: state.connected,
    connecting: state.connecting,
    error: state.error,
    chat: state.chat,
    pendingPermission: state.pendingPermission,
    stallNotice: state.stallNotice,
    connect: doClaudeConnect,
    sendMessage: doClaudeSend,
    interrupt: doClaudeInterrupt,
    respondPermission: doClaudeRespondPermission,
    newSession: doClaudeNewSession,
  };
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no new errors (pre-existing errors, if any, are unchanged).

- [ ] **Step 3: Commit**

```bash
git add src/features/claude-config/hooks/useClaudeChat.ts
git commit -m "feat(claude): chat connection hook and UI store"
```

---

### Task 9: i18n namespace + shared type/ui-store wiring

**Files:**
- Create: `src/shared/i18n/locales/en/claude-config.json`
- Create: `src/shared/i18n/locales/ja/claude-config.json`
- Modify: `src/shared/i18n/index.ts`
- Modify: `src/shared/types/index.ts` (add `ClaudeTopTab`)
- Modify: `src/stores/ui-store.ts` (add `"claude"` to `LeftPanel`, add `claudeTopTab`)

**Interfaces:**
- Produces: namespace `claude-config` with the keys below; `LeftPanel` union including `"claude"`; `useUiStore` fields `claudeTopTab: ClaudeTopTab`, `setClaudeTopTab(tab)`.

- [ ] **Step 1: Create locale files**

```json
// src/shared/i18n/locales/en/claude-config.json
{
  "tabChat": "Chat",
  "tabSettings": "Settings",
  "tabGeneral": "General",
  "tabRules": "Rules",
  "tabMcp": "MCP",
  "tabSkills": "Skills",
  "noFolderOpen": "Open a folder to use Claude.",
  "connect": "Connect",
  "reconnect": "Reconnect",
  "connecting": "Connecting...",
  "newSession": "New chat",
  "send": "Send",
  "stop": "Stop",
  "chatPlaceholder": "Message Claude... (Enter to send, Shift+Enter for newline)",
  "stallNotice": "Still waiting for a response...",
  "claudeCliNotFound": "Claude Code CLI was not found. Install it and sign in with `claude` first.",
  "permissionTitle": "Claude wants to run a tool",
  "allow": "Allow",
  "deny": "Deny",
  "toolRunning": "Running...",
  "toolFailed": "Failed",
  "model": "Model",
  "modelDefault": "CLI default",
  "permissionMode": "Permission mode",
  "pmDefault": "Ask for permission (default)",
  "pmAcceptEdits": "Auto-accept file edits",
  "pmBypass": "Bypass permissions",
  "pmPlan": "Plan mode",
  "rulesScopeGlobal": "Global (~/.claude/CLAUDE.md)",
  "rulesScopeProject": "Project (CLAUDE.md)",
  "save": "Save",
  "saved": "Saved"
}
```

```json
// src/shared/i18n/locales/ja/claude-config.json
{
  "tabChat": "チャット",
  "tabSettings": "設定",
  "tabGeneral": "一般",
  "tabRules": "ルール",
  "tabMcp": "MCP",
  "tabSkills": "スキル",
  "noFolderOpen": "Claudeを使うにはフォルダを開いてください。",
  "connect": "接続",
  "reconnect": "再接続",
  "connecting": "接続中...",
  "newSession": "新規チャット",
  "send": "送信",
  "stop": "停止",
  "chatPlaceholder": "Claudeにメッセージ... (Enterで送信、Shift+Enterで改行)",
  "stallNotice": "応答を待っています...",
  "claudeCliNotFound": "Claude Code CLIが見つかりません。先に`claude`をインストールしてログインしてください。",
  "permissionTitle": "Claudeがツールの実行許可を求めています",
  "allow": "許可",
  "deny": "拒否",
  "toolRunning": "実行中...",
  "toolFailed": "失敗",
  "model": "モデル",
  "modelDefault": "CLIの既定",
  "permissionMode": "許可モード",
  "pmDefault": "都度確認 (既定)",
  "pmAcceptEdits": "ファイル編集を自動許可",
  "pmBypass": "確認をバイパス",
  "pmPlan": "プランモード",
  "rulesScopeGlobal": "グローバル (~/.claude/CLAUDE.md)",
  "rulesScopeProject": "プロジェクト (CLAUDE.md)",
  "save": "保存",
  "saved": "保存しました"
}
```

- [ ] **Step 2: Register the namespace**

In `src/shared/i18n/index.ts`, following the existing pattern:

```typescript
import jaClaudeConfig from "./locales/ja/claude-config.json";
import enClaudeConfig from "./locales/en/claude-config.json";
```

and add `"claude-config": jaClaudeConfig,` / `"claude-config": enClaudeConfig,` to the `ja` / `en` resource maps.

- [ ] **Step 3: Add ClaudeTopTab type and ui-store fields**

In `src/shared/types/index.ts` next to `OpencodeTopTab` (line ~189):

```typescript
/** Claude panel top-level tab */
export type ClaudeTopTab = "chat" | "settings";
```

In `src/stores/ui-store.ts`:
- line 4: `export type LeftPanel = "folder" | "outline" | "rag" | "opencode-config" | "git" | "replacement" | "claude";`
- import `ClaudeTopTab` from `@/shared/types`; add to `UiState`: `claudeTopTab: ClaudeTopTab;` and `setClaudeTopTab: (tab: ClaudeTopTab) => void;`
- add to the store object: `claudeTopTab: "chat" as ClaudeTopTab,` and `setClaudeTopTab: (tab) => set({ claudeTopTab: tab }),`

- [ ] **Step 4: Type-check and run all tests**

Run: `npx tsc --noEmit && npm test`
Expected: clean compile; all tests pass. If `setFolderLeftPanel` in `tab-store` has its own union type not derived from `LeftPanel`, add `"claude"` there too.

- [ ] **Step 5: Commit**

```bash
git add src/shared/i18n src/shared/types/index.ts src/stores/ui-store.ts
git commit -m "feat(claude): i18n namespace and claude panel ui-store wiring"
```

---

### Task 10: Chat UI components

**Files:**
- Create: `src/features/claude-config/components/ClaudePanel.tsx`
- Create: `src/features/claude-config/components/ClaudeChat.tsx`
- Create: `src/features/claude-config/components/ToolUseCard.tsx`
- Create: `src/features/claude-config/components/PermissionCard.tsx`
- Create: `src/features/claude-config/components/ClaudePanel.css`

**Interfaces:**
- Consumes: Tasks 8, 9. Settings tab content comes from Task 11 (`ClaudeSettings`); until Task 11 lands, render a placeholder `<div />` in its place and replace it in Task 11.
- Produces: `<ClaudePanel />` mounted by Task 12.

- [ ] **Step 1: PermissionCard**

```tsx
// src/features/claude-config/components/PermissionCard.tsx
import { useTranslation } from "react-i18next";
import type { SidecarPermissionRequest } from "@/shared/types/claude-sidecar";

interface Props {
  request: SidecarPermissionRequest;
  onRespond: (id: string, behavior: "allow" | "deny") => void;
}

export function PermissionCard({ request, onRespond }: Props) {
  const { t } = useTranslation("claude-config");
  return (
    <div className="claude-permission">
      <div className="claude-permission__title">{t("permissionTitle")}</div>
      <div className="claude-permission__tool">{request.toolName}</div>
      <pre className="claude-permission__input">
        {JSON.stringify(request.input, null, 2)}
      </pre>
      <div className="claude-permission__actions">
        <button
          className="claude-permission__btn claude-permission__btn--allow"
          onClick={() => onRespond(request.id, "allow")}
        >
          {t("allow")}
        </button>
        <button
          className="claude-permission__btn"
          onClick={() => onRespond(request.id, "deny")}
        >
          {t("deny")}
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: ToolUseCard**

```tsx
// src/features/claude-config/components/ToolUseCard.tsx
import { useTranslation } from "react-i18next";
import type { ClaudeToolPart } from "../lib/claude-message-mapper";

export function ToolUseCard({ part }: { part: ClaudeToolPart }) {
  const { t } = useTranslation("claude-config");
  const status = !part.done
    ? t("toolRunning")
    : part.isError
      ? t("toolFailed")
      : "✓";
  return (
    <details className="claude-tool">
      <summary className="claude-tool__summary">
        <span className="claude-tool__name">{part.name}</span>
        <span className={`claude-tool__status${part.isError ? " claude-tool__status--error" : ""}`}>
          {status}
        </span>
      </summary>
      <pre className="claude-tool__body">{JSON.stringify(part.input, null, 2)}</pre>
      {part.output ? <pre className="claude-tool__body">{part.output}</pre> : null}
    </details>
  );
}
```

- [ ] **Step 3: ClaudeChat**

```tsx
// src/features/claude-config/components/ClaudeChat.tsx
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useTabStore } from "@/stores/tab-store";
import { useClaudeChat } from "../hooks/useClaudeChat";
import { ToolUseCard } from "./ToolUseCard";
import { PermissionCard } from "./PermissionCard";

export function ClaudeChat() {
  const { t } = useTranslation("claude-config");
  const activeFolderPath = useTabStore((s) => s.activeFolderPath);
  const {
    connected, connecting, error, chat, pendingPermission, stallNotice,
    connect, sendMessage, interrupt, respondPermission, newSession,
  } = useClaudeChat();
  const [input, setInput] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (activeFolderPath) void connect(activeFolderPath);
  }, [activeFolderPath, connect]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [chat.messages, pendingPermission]);

  const handleSend = () => {
    const text = input.trim();
    if (!text || chat.running || !connected) return;
    setInput("");
    void sendMessage(text);
  };

  return (
    <div className="claude-chat">
      <div className="claude-chat__toolbar">
        <button className="claude-chat__toolbar-btn" onClick={() => void newSession()}>
          {t("newSession")}
        </button>
        {!connected && !connecting && activeFolderPath && (
          <button className="claude-chat__toolbar-btn" onClick={() => void connect(activeFolderPath)}>
            {t("reconnect")}
          </button>
        )}
        {connecting && <span className="claude-chat__status">{t("connecting")}</span>}
      </div>

      {error && <div className="claude-chat__error">{error}</div>}

      <div className="claude-chat__messages">
        {chat.messages.map((m, i) => (
          <div key={i} className={`claude-chat__msg claude-chat__msg--${m.role}`}>
            {m.parts.map((p, j) =>
              p.type === "text" ? (
                <div key={j} className="claude-chat__text">{p.text}</div>
              ) : (
                <ToolUseCard key={j} part={p} />
              ),
            )}
          </div>
        ))}
        {chat.running && stallNotice && (
          <div className="claude-chat__stall">{t("stallNotice")}</div>
        )}
        {pendingPermission && (
          <PermissionCard
            request={pendingPermission}
            onRespond={(id, behavior) => void respondPermission(id, behavior)}
          />
        )}
        <div ref={bottomRef} />
      </div>

      <div className="claude-chat__input-area">
        <textarea
          className="claude-chat__input"
          value={input}
          placeholder={t("chatPlaceholder")}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              handleSend();
            }
          }}
        />
        {chat.running ? (
          <button className="claude-chat__send" onClick={() => void interrupt()}>
            {t("stop")}
          </button>
        ) : (
          <button className="claude-chat__send" onClick={handleSend} disabled={!connected}>
            {t("send")}
          </button>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: ClaudePanel (with settings placeholder until Task 11)**

```tsx
// src/features/claude-config/components/ClaudePanel.tsx
import { useTranslation } from "react-i18next";
import { useUiStore } from "@/stores/ui-store";
import { useTabStore } from "@/stores/tab-store";
import { ClaudeChat } from "./ClaudeChat";
import "./ClaudePanel.css";

export function ClaudePanel() {
  const { t } = useTranslation("claude-config");
  const activeFolderPath = useTabStore((s) => s.activeFolderPath);
  const topTab = useUiStore((s) => s.claudeTopTab);
  const setTopTab = useUiStore((s) => s.setClaudeTopTab);

  if (!activeFolderPath) {
    return (
      <div className="claude-panel claude-panel--disabled">
        <div className="claude-panel__no-folder">{t("noFolderOpen")}</div>
      </div>
    );
  }

  return (
    <div className="claude-panel">
      <div className="claude-panel__top-tabs">
        <button
          className={`claude-panel__top-tab${topTab === "chat" ? " claude-panel__top-tab--active" : ""}`}
          onClick={() => setTopTab("chat")}
        >
          {t("tabChat")}
        </button>
        <button
          className={`claude-panel__top-tab${topTab === "settings" ? " claude-panel__top-tab--active" : ""}`}
          onClick={() => setTopTab("settings")}
        >
          {t("tabSettings")}
        </button>
      </div>
      {topTab === "chat" ? <ClaudeChat /> : <div className="claude-panel__settings" />}
    </div>
  );
}
```

- [ ] **Step 5: CSS**

```css
/* src/features/claude-config/components/ClaudePanel.css */
.claude-panel { display: flex; flex-direction: column; flex: 1; min-height: 0; }
.claude-panel--disabled { align-items: center; justify-content: center; }
.claude-panel__no-folder { padding: 16px; opacity: 0.7; font-size: 12px; }
.claude-panel__top-tabs { display: flex; border-bottom: 1px solid var(--border-color, #444); }
.claude-panel__top-tab { flex: 1; padding: 6px 0; background: none; border: none; color: inherit; cursor: pointer; opacity: 0.6; font-size: 12px; }
.claude-panel__top-tab--active { opacity: 1; border-bottom: 2px solid var(--accent-color, #4a9eff); }
.claude-panel__settings { flex: 1; min-height: 0; display: flex; flex-direction: column; overflow-y: auto; }

.claude-chat { display: flex; flex-direction: column; flex: 1; min-height: 0; }
.claude-chat__toolbar { display: flex; gap: 6px; align-items: center; padding: 6px; }
.claude-chat__toolbar-btn { font-size: 11px; padding: 2px 8px; cursor: pointer; }
.claude-chat__status { font-size: 11px; opacity: 0.7; }
.claude-chat__error { margin: 4px 6px; padding: 6px; font-size: 11px; color: #f66; border: 1px solid #f66; border-radius: 4px; white-space: pre-wrap; }
.claude-chat__messages { flex: 1; overflow-y: auto; padding: 6px; display: flex; flex-direction: column; gap: 8px; }
.claude-chat__msg { border-radius: 6px; padding: 6px 8px; font-size: 12px; }
.claude-chat__msg--user { background: var(--bg-tertiary, #2f2f2f); align-self: flex-end; max-width: 90%; }
.claude-chat__msg--assistant { background: var(--bg-secondary, #262626); }
.claude-chat__text { white-space: pre-wrap; word-break: break-word; }
.claude-chat__stall { font-size: 11px; opacity: 0.7; font-style: italic; }
.claude-chat__input-area { display: flex; gap: 6px; padding: 6px; border-top: 1px solid var(--border-color, #444); }
.claude-chat__input { flex: 1; min-height: 52px; resize: vertical; font-size: 12px; }
.claude-chat__send { align-self: flex-end; padding: 4px 12px; cursor: pointer; }

.claude-tool { border: 1px solid var(--border-color, #444); border-radius: 4px; margin: 4px 0; font-size: 11px; }
.claude-tool__summary { display: flex; justify-content: space-between; padding: 4px 6px; cursor: pointer; }
.claude-tool__name { font-weight: 600; }
.claude-tool__status--error { color: #f66; }
.claude-tool__body { margin: 0; padding: 6px; max-height: 200px; overflow: auto; white-space: pre-wrap; word-break: break-all; border-top: 1px solid var(--border-color, #444); }

.claude-permission { border: 1px solid var(--accent-color, #4a9eff); border-radius: 6px; padding: 8px; font-size: 12px; }
.claude-permission__title { font-weight: 600; margin-bottom: 4px; }
.claude-permission__tool { font-family: monospace; margin-bottom: 4px; }
.claude-permission__input { max-height: 160px; overflow: auto; font-size: 11px; margin: 0 0 6px; white-space: pre-wrap; word-break: break-all; }
.claude-permission__actions { display: flex; gap: 8px; }
.claude-permission__btn { padding: 4px 14px; cursor: pointer; }
.claude-permission__btn--allow { background: var(--accent-color, #4a9eff); color: #fff; border: none; border-radius: 4px; }
```

Match the CSS variable names actually used in `OpencodeConfigPanel.css` — open it and align (`var(--...)` fallbacks above are guesses; reuse the project's real tokens).

- [ ] **Step 6: Type-check and commit**

Run: `npx tsc --noEmit`
Expected: clean.

```bash
git add src/features/claude-config/components
git commit -m "feat(claude): chat panel UI with tool cards and permission prompts"
```

---

### Task 11: Settings tab (General / Rules / MCP / Skills)

**Files:**
- Create: `src/features/claude-config/components/ClaudeSettings.tsx`
- Create: `src/features/claude-config/components/sections/GeneralSection.tsx`
- Create: `src/features/claude-config/components/sections/RulesSection.tsx`
- Modify: `src/features/claude-config/components/ClaudePanel.tsx` (replace placeholder)
- Delete: `src/features/claude-config/components/ProjectConfigPanel.tsx` and `ProjectConfigPanel.css` (superseded, never wired in)

**Interfaces:**
- Consumes: `useClaudeSessionStore` (Task 7), existing `McpServersTab` / `SkillsTab` (unchanged), Rust `read_text_file` / `write_text_file_with_dirs` / `get_home_dir` commands (existing).
- Produces: `<ClaudeSettings />` rendered inside `ClaudePanel`.

- [ ] **Step 1: GeneralSection**

```tsx
// src/features/claude-config/components/sections/GeneralSection.tsx
import { useTranslation } from "react-i18next";
import { useTabStore } from "@/stores/tab-store";
import { useClaudeSessionStore } from "@/stores/claude-session-store";
import type { ClaudePermissionMode } from "@/shared/types/claude-sidecar";

const MODELS = ["claude-opus-4-8", "claude-sonnet-5", "claude-haiku-4-5"];

export function GeneralSection() {
  const { t } = useTranslation("claude-config");
  const folder = useTabStore((s) => s.activeFolderPath)!;
  const settings = useClaudeSessionStore((s) => s.getFolderSettings(folder));
  const setModel = useClaudeSessionStore((s) => s.setModel);
  const setPermissionMode = useClaudeSessionStore((s) => s.setPermissionMode);

  return (
    <div className="claude-settings__section">
      <label className="claude-settings__label">{t("model")}</label>
      <select
        className="claude-settings__select"
        value={settings.model}
        onChange={(e) => setModel(folder, e.target.value)}
      >
        <option value="">{t("modelDefault")}</option>
        {MODELS.map((m) => (
          <option key={m} value={m}>{m}</option>
        ))}
      </select>

      <label className="claude-settings__label">{t("permissionMode")}</label>
      <select
        className="claude-settings__select"
        value={settings.permissionMode}
        onChange={(e) => setPermissionMode(folder, e.target.value as ClaudePermissionMode)}
      >
        <option value="default">{t("pmDefault")}</option>
        <option value="acceptEdits">{t("pmAcceptEdits")}</option>
        <option value="bypassPermissions">{t("pmBypass")}</option>
        <option value="plan">{t("pmPlan")}</option>
      </select>
    </div>
  );
}
```

Note: model/permission changes take effect on the next session start (`newSession` or reconnect) — acceptable for MVP.

- [ ] **Step 2: RulesSection (CLAUDE.md editor)**

```tsx
// src/features/claude-config/components/sections/RulesSection.tsx
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { useTabStore } from "@/stores/tab-store";

type Scope = "global" | "project";

async function rulesPath(scope: Scope, folder: string): Promise<string> {
  if (scope === "project") return `${folder}/CLAUDE.md`;
  const home = await invoke<string>("get_home_dir");
  return `${home}/.claude/CLAUDE.md`;
}

export function RulesSection() {
  const { t } = useTranslation("claude-config");
  const folder = useTabStore((s) => s.activeFolderPath)!;
  const [scope, setScope] = useState<Scope>("project");
  const [text, setText] = useState("");
  const [savedAt, setSavedAt] = useState(0);

  const load = useCallback(async (sc: Scope) => {
    const path = await rulesPath(sc, folder);
    try {
      setText(await invoke<string>("read_text_file", { path }));
    } catch {
      setText(""); // file does not exist yet
    }
  }, [folder]);

  useEffect(() => {
    void load(scope);
  }, [scope, load]);

  const save = async () => {
    const path = await rulesPath(scope, folder);
    await invoke("write_text_file_with_dirs", { path, content: text });
    setSavedAt(Date.now());
    setTimeout(() => setSavedAt(0), 2000);
  };

  return (
    <div className="claude-settings__section claude-settings__section--rules">
      <div className="claude-settings__scope">
        <label>
          <input type="radio" checked={scope === "project"} onChange={() => setScope("project")} />
          {t("rulesScopeProject")}
        </label>
        <label>
          <input type="radio" checked={scope === "global"} onChange={() => setScope("global")} />
          {t("rulesScopeGlobal")}
        </label>
      </div>
      <textarea
        className="claude-settings__rules-editor"
        value={text}
        onChange={(e) => setText(e.target.value)}
        spellCheck={false}
      />
      <div>
        <button onClick={() => void save()}>{t("save")}</button>
        {savedAt > 0 && <span className="claude-settings__saved">{t("saved")}</span>}
      </div>
    </div>
  );
}
```

Check the exact Tauri command signature of `write_text_file_with_dirs` in `src-tauri/src/commands/file.rs:101` (parameter names `path`/`content`) and confirm it is registered in `lib.rs`; if not registered, register it alongside the other file commands.

- [ ] **Step 3: ClaudeSettings container + wire into ClaudePanel**

```tsx
// src/features/claude-config/components/ClaudeSettings.tsx
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { GeneralSection } from "./sections/GeneralSection";
import { RulesSection } from "./sections/RulesSection";
import { McpServersTab } from "./McpServersTab";
import { SkillsTab } from "./SkillsTab";

type SettingsTab = "general" | "rules" | "mcp" | "skills";

const TABS: { key: SettingsTab; labelKey: string }[] = [
  { key: "general", labelKey: "tabGeneral" },
  { key: "rules", labelKey: "tabRules" },
  { key: "mcp", labelKey: "tabMcp" },
  { key: "skills", labelKey: "tabSkills" },
];

export function ClaudeSettings() {
  const { t } = useTranslation("claude-config");
  const [tab, setTab] = useState<SettingsTab>("general");

  return (
    <div className="claude-settings">
      <div className="claude-settings__tabs">
        {TABS.map(({ key, labelKey }) => (
          <button
            key={key}
            className={`claude-settings__tab${tab === key ? " claude-settings__tab--active" : ""}`}
            onClick={() => setTab(key)}
          >
            {t(labelKey)}
          </button>
        ))}
      </div>
      <div className="claude-settings__body">
        {tab === "general" && <GeneralSection />}
        {tab === "rules" && <RulesSection />}
        {tab === "mcp" && <McpServersTab />}
        {tab === "skills" && <SkillsTab />}
      </div>
    </div>
  );
}
```

In `ClaudePanel.tsx`, replace `<div className="claude-panel__settings" />` with `<ClaudeSettings />` (add the import). Append settings CSS to `ClaudePanel.css`:

```css
.claude-settings { display: flex; flex-direction: column; flex: 1; min-height: 0; }
.claude-settings__tabs { display: flex; flex-wrap: wrap; border-bottom: 1px solid var(--border-color, #444); }
.claude-settings__tab { padding: 4px 10px; background: none; border: none; color: inherit; cursor: pointer; opacity: 0.6; font-size: 11px; }
.claude-settings__tab--active { opacity: 1; border-bottom: 2px solid var(--accent-color, #4a9eff); }
.claude-settings__body { flex: 1; overflow-y: auto; padding: 8px; }
.claude-settings__section { display: flex; flex-direction: column; gap: 6px; font-size: 12px; }
.claude-settings__label { font-weight: 600; margin-top: 8px; }
.claude-settings__select { font-size: 12px; }
.claude-settings__scope { display: flex; gap: 12px; font-size: 12px; }
.claude-settings__rules-editor { min-height: 240px; font-family: monospace; font-size: 12px; resize: vertical; }
.claude-settings__saved { margin-left: 8px; font-size: 11px; opacity: 0.7; }
```

- [ ] **Step 4: Delete the superseded ProjectConfigPanel**

`ProjectConfigPanel.tsx`/`ProjectConfigPanel.css` were never imported anywhere (verified). Before deleting, re-verify: `rg "ProjectConfigPanel" src/ --glob '!src/features/claude-config/**'` must return nothing. Then delete both files. If `SkillsTab`/`McpServersTab` compile-error because they referenced something from it, fix imports (they don't — they only use the store).

- [ ] **Step 5: Type-check, test, commit**

Run: `npx tsc --noEmit && npm test`
Expected: clean.

```bash
git add -A src/features/claude-config
git commit -m "feat(claude): settings tab with general/rules/mcp/skills sections"
```

---

### Task 12: App wiring (activity bar, shortcut, lifecycle) + smoke test

**Files:**
- Modify: `src/features/file-tree/components/LeftPanel.tsx` (activity button ~line 158, header title ~line 220)
- Modify: `src/app/App.tsx` (Ctrl+Shift+O ~line 1057; sidecar kill at ~lines 312/326)

**Interfaces:**
- Consumes: `ClaudePanel` (Task 10/11), `killClaudeSidecar` (Task 8), ui-store `"claude"` (Task 9).

- [ ] **Step 1: Activity-bar button + panel mount + header title**

In `LeftPanel.tsx`, after the opencode button (line ~158) add:

```tsx
          <button
            className={`left-panel__activity-btn ${leftPanel === "claude" ? "left-panel__activity-btn--active" : ""}`}
            onClick={() => { setLeftPanel("claude"); setFolderLeftPanel("claude"); }}
            title="Claude"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 2v20" />
              <path d="M4 7l16 10" />
              <path d="M20 7L4 17" />
            </svg>
          </button>
```

In the section-header title block (~line 220) add:

```tsx
            {leftPanel === "claude" && "CLAUDE"}
```

Find where `<OpencodeConfigPanel />` is conditionally mounted (~line 374) and add next to it:

```tsx
        {leftPanel === "claude" && <ClaudePanel />}
```

with `import { ClaudePanel } from "@/features/claude-config/components/ClaudePanel";` at the top.

- [ ] **Step 2: Keyboard shortcut and shutdown lifecycle**

In `App.tsx` keyboard handler, BEFORE the existing `e.ctrlKey && e.key === "o"` branch (line ~1057) add:

```tsx
      } else if (e.ctrlKey && e.shiftKey && (e.key === "O" || e.key === "o")) {
        e.preventDefault();
        useUiStore.getState().setLeftPanel("claude");
        useTabStore.getState().setFolderLeftPanel("claude");
```

(The plain Ctrl+O branch must remain unchanged and must not fire when shift is held — placing the shift branch first guarantees that.)

In the shutdown effect (lines ~310-333), alongside both `removeAllServers()` calls add `killClaudeSidecar()`:

```tsx
import { killClaudeSidecar } from "@/features/claude-config/hooks/useClaudeChat";
// in handleBeforeUnload:
      void killClaudeSidecar();
// in onCloseRequested (after removeAllServers):
      await killClaudeSidecar();
```

- [ ] **Step 3: Full check**

Run: `npx tsc --noEmit && npm test && npm run build:sidecar`
Expected: all clean. Then `cargo check` in `src-tauri/`.

- [ ] **Step 4: Manual smoke test (requires claude CLI + node on the machine)**

Run: `npm run tauri dev`, open a folder, then verify in order:
1. Claude activity-bar icon appears; Ctrl+Shift+O opens the panel; Ctrl+O still opens opencode.
2. Chat tab connects (no error banner) — send "このフォルダのファイル一覧を教えて".
3. Streaming text appears, a tool card (e.g. Bash/Glob) appears, a permission card appears (permissionMode default); Allow → tool runs, result text arrives, turn completes.
4. Stop button interrupts a running turn.
5. New chat resets; restart the app → sending a message resumes the previous session (check continuity by asking "さっき何を聞いた?" — requires NOT pressing New chat).
6. Settings tab: model/permission mode persist per folder; Rules loads/saves project CLAUDE.md; MCP/Skills tabs list entries from `~/.claude.json` / `.claude/skills`.
7. Close the folder/app → `node.exe` sidecar process disappears from Task Manager.

Record any deviations; fix before the final commit.

- [ ] **Step 5: Final commit**

```bash
git add src/features/file-tree/components/LeftPanel.tsx src/app/App.tsx
git commit -m "feat(claude): mount Claude panel in activity bar with shortcut and shutdown"
```

---

## Post-plan notes for the implementer

- The Agent SDK typings may drift from the structural types used here (verified against v0.3.201, 2026-07). All SDK-shape assumptions are quarantined in `sidecar/claude-sidecar.ts` (options) and `claude-message-mapper.ts` (events) — fix drift there only.
- `session_closed` arriving while a turn renders means the query loop ended (SDK error or CLI exit); the UI unlocks input. Real error text will have arrived via `error` or stderr diag lines.
- Deferred (spec "後続フェーズ"): images, completion, session list, usage display, preview-driven commands, "always allow" persistence.
