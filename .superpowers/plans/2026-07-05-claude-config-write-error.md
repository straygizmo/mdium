# Claude Config Write-Error Display Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface Claude settings write failures to the user via one shared, centralized error modal across the MCP, Skills, and Plugins tabs.

**Architecture:** A shared `guardWrite` helper wraps a write operation, and on failure shows the app-wide error modal (`showMessage(..., {kind:"error"})`) once, then re-throws. Every write method in `claude-config-store` wraps its body in `guardWrite`; the tab components add a thin try/catch so they skip success-only side effects and avoid unhandled rejections.

**Tech Stack:** React + TypeScript, Zustand, react-i18next, Tauri v2 (`invoke`), Vitest.

## Global Constraints

- All code comments in English.
- No hardcoded UI-facing strings — reuse the existing `saveFailed` i18n key in the `claude-config` namespace. Do NOT add new i18n keys.
- Error display lives ONLY in the store layer (`guardWrite`). Components must NOT contain error-message display code — they only guard success side effects.
- Reuse the existing `showMessage` (named export from `src/stores/dialog-store.ts`) and the default i18n instance (`import i18n from "@/shared/i18n"`). Do NOT introduce a new toast/notification system.
- Avoid double-reporting: report at the store method layer only; do NOT add a catch inside `writeMcpToFile`.
- RulesSection.tsx and GeneralSection.tsx are OUT OF SCOPE — do not modify them.

---

### Task 1: Shared `guardWrite` helper + tests

**Files:**
- Create: `src/stores/claude-config-write-guard.ts`
- Test: `src/stores/__tests__/claude-config-write-guard.test.ts`

**Interfaces:**
- Consumes: `showMessage` from `@/stores/dialog-store`; default i18n instance from `@/shared/i18n`.
- Produces: `guardWrite<T>(fn: () => Promise<T>): Promise<T>` — runs `fn`; on rejection, calls `showMessage(\`${i18n.t("claude-config:saveFailed")}: ${String(e)}\`, { kind: "error" })` then re-throws the original error; on success, returns `fn`'s resolved value and never calls `showMessage`.

- [ ] **Step 1: Write the failing test**

Create `src/stores/__tests__/claude-config-write-guard.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the app-wide error modal and the i18n instance the guard depends on.
const showMessage = vi.fn(() => Promise.resolve());
vi.mock("@/stores/dialog-store", () => ({
  showMessage: (...args: unknown[]) => showMessage(...args),
}));
vi.mock("@/shared/i18n", () => ({
  default: { t: (key: string) => key },
}));

import { guardWrite } from "../claude-config-write-guard";

beforeEach(() => {
  showMessage.mockClear();
});

describe("guardWrite", () => {
  it("returns the value and does not report on success", async () => {
    const result = await guardWrite(async () => 42);
    expect(result).toBe(42);
    expect(showMessage).not.toHaveBeenCalled();
  });

  it("reports an error modal once and re-throws on failure", async () => {
    const err = new Error("disk full");
    await expect(guardWrite(async () => { throw err; })).rejects.toBe(err);
    expect(showMessage).toHaveBeenCalledTimes(1);
    const [text, opts] = showMessage.mock.calls[0];
    expect(text).toContain("claude-config:saveFailed");
    expect(text).toContain("disk full");
    expect(opts).toEqual({ kind: "error" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/stores/__tests__/claude-config-write-guard.test.ts`
Expected: FAIL — cannot find module `../claude-config-write-guard`.

- [ ] **Step 3: Write the implementation**

Create `src/stores/claude-config-write-guard.ts`:

```ts
import { showMessage } from "@/stores/dialog-store";
import i18n from "@/shared/i18n";

// Wrap a write operation so any failure is reported to the user once, via the
// app-wide error modal, and then re-thrown for the caller to react to. This is
// the single place Claude-config write failures are surfaced.
export async function guardWrite<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    await showMessage(`${i18n.t("claude-config:saveFailed")}: ${String(e)}`, { kind: "error" });
    throw e;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/stores/__tests__/claude-config-write-guard.test.ts`
Expected: PASS — both cases green.

- [ ] **Step 5: Commit**

```bash
git add src/stores/claude-config-write-guard.ts src/stores/__tests__/claude-config-write-guard.test.ts
git commit -m "feat(claude): shared guardWrite helper for write-failure reporting"
```

---

### Task 2: Wrap store write methods in `guardWrite`

**Files:**
- Modify: `src/stores/claude-config-store.ts` (the 11 write methods listed below; add one import)

**Interfaces:**
- Consumes: `guardWrite` from `./claude-config-write-guard` (Task 1).
- Produces: no signature changes — the 11 write methods keep their exact existing signatures and return types (`Promise<void>`), but now report + re-throw on failure instead of rejecting silently.

The 11 methods to wrap: `setClaudePluginEnabled`, `saveGlobalMcpServer`, `deleteGlobalMcpServer`, `toggleGlobalMcpServer`, `saveProjectMcpServer`, `deleteProjectMcpServer`, `toggleProjectMcpServer`, `saveGlobalSkill`, `deleteGlobalSkill`, `saveProjectSkill`, `deleteProjectSkill`. Do NOT wrap the read methods (`loadGlobalMcp`, `loadProjectMcp`, `loadGlobalSkills`, `loadProjectSkills`, `loadClaudePlugins`) or the helper `writeMcpToFile`.

- [ ] **Step 1: Add the import**

At the top of `src/stores/claude-config-store.ts`, after the existing `import type { McpServer, SkillInfo } ...` line, add:

```ts
import { guardWrite } from "./claude-config-write-guard";
```

- [ ] **Step 2: Wrap each write method body**

For each of the 11 methods, wrap the existing body in `return guardWrite(async () => { ... })`. The bodies are unchanged except for the wrapper. Apply exactly these replacements.

`setClaudePluginEnabled`:

```ts
  setClaudePluginEnabled: async (key, enabled) => {
    return guardWrite(async () => {
      const home = await getHomePath();
      const path = `${home}/.claude/settings.json`;
      const raw = await invoke<string>("read_json_file", { path });
      let json: Record<string, unknown>;
      try {
        json = JSON.parse(raw);
      } catch {
        json = {};
      }
      const enabledPlugins = extractEnabledPlugins(raw);
      json.enabledPlugins = toggleEnabledPlugins(enabledPlugins, key, enabled);
      await invoke("write_json_file", { path, content: JSON.stringify(json, null, 2) });
      await get().loadClaudePlugins();
    });
  },
```

`saveGlobalMcpServer`:

```ts
  saveGlobalMcpServer: async (name, server) => {
    return guardWrite(async () => {
      const home = await getHomePath();
      const path = `${home}/.claude.json`;
      const servers = { ...get().globalMcpServers, [name]: server };
      await writeMcpToFile(path, servers);
      set({ globalMcpServers: servers });
    });
  },
```

`deleteGlobalMcpServer`:

```ts
  deleteGlobalMcpServer: async (name) => {
    return guardWrite(async () => {
      const home = await getHomePath();
      const path = `${home}/.claude.json`;
      const servers = { ...get().globalMcpServers };
      delete servers[name];
      await writeMcpToFile(path, servers);
      set({ globalMcpServers: servers });
    });
  },
```

`toggleGlobalMcpServer`:

```ts
  toggleGlobalMcpServer: async (name) => {
    return guardWrite(async () => {
      const home = await getHomePath();
      const path = `${home}/.claude.json`;
      const servers = { ...get().globalMcpServers };
      if (servers[name]) {
        servers[name] = { ...servers[name], disabled: !servers[name].disabled };
      }
      await writeMcpToFile(path, servers);
      set({ globalMcpServers: servers });
    });
  },
```

`saveProjectMcpServer`:

```ts
  saveProjectMcpServer: async (folderPath, name, server) => {
    return guardWrite(async () => {
      const path = `${folderPath}/.mcp.json`;
      const servers = { ...get().projectMcpServers, [name]: server };
      await writeMcpToFile(path, servers);
      set({ projectMcpServers: servers });
    });
  },
```

`deleteProjectMcpServer`:

```ts
  deleteProjectMcpServer: async (folderPath, name) => {
    return guardWrite(async () => {
      const path = `${folderPath}/.mcp.json`;
      const servers = { ...get().projectMcpServers };
      delete servers[name];
      await writeMcpToFile(path, servers);
      set({ projectMcpServers: servers });
    });
  },
```

`toggleProjectMcpServer`:

```ts
  toggleProjectMcpServer: async (folderPath, name) => {
    return guardWrite(async () => {
      const path = `${folderPath}/.mcp.json`;
      const servers = { ...get().projectMcpServers };
      if (servers[name]) {
        servers[name] = { ...servers[name], disabled: !servers[name].disabled };
      }
      await writeMcpToFile(path, servers);
      set({ projectMcpServers: servers });
    });
  },
```

`saveGlobalSkill`:

```ts
  saveGlobalSkill: async (skill) => {
    return guardWrite(async () => {
      const home = await getHomePath();
      const baseDir = `${home}/.claude`;
      const content = buildSkillContent(skill);
      await invoke("write_skill", { baseDir, dirName: skill.dirName, content });
      await get().loadGlobalSkills();
    });
  },
```

`deleteGlobalSkill`:

```ts
  deleteGlobalSkill: async (dirName) => {
    return guardWrite(async () => {
      const home = await getHomePath();
      const baseDir = `${home}/.claude`;
      await invoke("delete_skill", { baseDir, dirName });
      await get().loadGlobalSkills();
    });
  },
```

`saveProjectSkill`:

```ts
  saveProjectSkill: async (folderPath, skill) => {
    return guardWrite(async () => {
      const baseDir = `${folderPath}/.claude`;
      const content = buildSkillContent(skill);
      await invoke("write_skill", { baseDir, dirName: skill.dirName, content });
      await get().loadProjectSkills(folderPath);
    });
  },
```

`deleteProjectSkill`:

```ts
  deleteProjectSkill: async (folderPath, dirName) => {
    return guardWrite(async () => {
      const baseDir = `${folderPath}/.claude`;
      await invoke("delete_skill", { baseDir, dirName });
      await get().loadProjectSkills(folderPath);
    });
  },
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS — no new type errors. (`guardWrite` returns `Promise<T>`; each wrapped body resolves to `void`, so the methods stay `Promise<void>`.)

- [ ] **Step 4: Run the guard test to confirm nothing regressed**

Run: `npx vitest run src/stores/__tests__/claude-config-write-guard.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/stores/claude-config-store.ts
git commit -m "feat(claude): route all config write methods through guardWrite"
```

---

### Task 3: Thin guards in the tab components

**Files:**
- Modify: `src/features/claude-config/components/McpServersTab.tsx` (handlers at lines 28-37; toggle onClick at line 70)
- Modify: `src/features/claude-config/components/SkillsTab.tsx` (handlers at lines 25-34)
- Modify: `src/features/claude-config/components/PluginsTab.tsx` (toggle onChange)

**Interfaces:**
- Consumes: the store methods from Task 2 (now report + re-throw on failure). No new symbols.
- Produces: no exported interface changes; internal handler behavior only.

Components must NOT display any error message themselves (the store already did). They only prevent success-only side effects from running and prevent unhandled rejections.

- [ ] **Step 1: McpServersTab — guard save and delete handlers**

In `src/features/claude-config/components/McpServersTab.tsx`, replace the `handleSave` and `handleDelete` functions (currently lines 28-37):

```tsx
  const handleSave = async (name: string, server: McpServer) => {
    try {
      await saveGlobalMcpServer(name, server);
    } catch {
      return; // store already reported the error
    }
    setEditing(null);
    setAdding(false);
  };

  const handleDelete = async (name: string) => {
    if (!(await showConfirm(t("mcpDeleteConfirm"), { kind: "warning" }))) return;
    try {
      await deleteGlobalMcpServer(name);
    } catch {
      // store already reported the error
    }
  };
```

- [ ] **Step 2: McpServersTab — guard the toggle**

In the same file, replace the toggle button's `onClick` (currently line 70, `onClick={() => toggleGlobalMcpServer(name)}`) with a guarded async handler:

```tsx
                  onClick={async () => {
                    try {
                      await toggleGlobalMcpServer(name);
                    } catch {
                      // store already reported the error
                    }
                  }}
```

- [ ] **Step 3: SkillsTab — guard save and delete handlers**

In `src/features/claude-config/components/SkillsTab.tsx`, replace the `handleSave` and `handleDelete` functions (currently lines 25-34):

```tsx
  const handleSave = async (skill: SkillInfo) => {
    try {
      await saveGlobalSkill(skill);
    } catch {
      return; // store already reported the error
    }
    setEditing(null);
    setAdding(false);
  };

  const handleDelete = async (dirName: string) => {
    if (!(await showConfirm(t("skillDeleteConfirm"), { kind: "warning" }))) return;
    try {
      await deleteGlobalSkill(dirName);
    } catch {
      // store already reported the error
    }
  };
```

- [ ] **Step 4: PluginsTab — guard the toggle**

In `src/features/claude-config/components/PluginsTab.tsx`, replace the checkbox `onChange` (currently `onChange={(e) => setClaudePluginEnabled(p.key, e.target.checked)}`) with a guarded async handler:

```tsx
                  onChange={async (e) => {
                    try {
                      await setClaudePluginEnabled(p.key, e.target.checked);
                    } catch {
                      // store already reported the error
                    }
                  }}
```

- [ ] **Step 5: Typecheck and run the full suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS — no type errors; all tests green (including the new guard test).

- [ ] **Step 6: Commit**

```bash
git add src/features/claude-config/components/McpServersTab.tsx src/features/claude-config/components/SkillsTab.tsx src/features/claude-config/components/PluginsTab.tsx
git commit -m "feat(claude): guard config tab write handlers against reported failures"
```

---

### Task 4: Build verification

**Files:** none (verification only).

- [ ] **Step 1: Build the frontend**

Run: `npx vite build`
Expected: build succeeds with no errors.

- [ ] **Step 2: Manual smoke (deferred to user)**

Not automatable here. The user can verify by making `~/.claude/settings.json` (or `~/.claude.json`) read-only and toggling a plugin / saving an MCP server / saving a skill: an error modal should appear with the failure detail, the toggle/form should not falsely show success, and no unhandled promise rejection should appear in the console.

---

## Notes for the implementer

- The error modal text comes from `i18n.t("claude-config:saveFailed")` + `: <error>` — do not hardcode any message in the store or components.
- Do not add a catch inside `writeMcpToFile` — reporting happens once, at the method layer, via `guardWrite`.
- The `try { await ... } catch { return; }` pattern in form handlers must run the success side effects (`setEditing(null)`, `setAdding(false)`) only AFTER the await resolves without throwing — keep them outside/after the try block as shown.
- Do not touch RulesSection.tsx or GeneralSection.tsx.
