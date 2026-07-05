# Claude Plugins Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Plugins" tab to the Claude settings panel that lists installed Claude Code plugins and toggles each one enabled/disabled.

**Architecture:** Pure logic (parse/merge/toggle) lives in a tested lib module. A thin Zustand store method reads `~/.claude/plugins/installed_plugins.json` + `~/.claude/settings.json` via existing Rust commands, merges them, and writes the `enabledPlugins` map back. A React component renders the list with checkbox toggles. No new Rust commands.

**Tech Stack:** React + TypeScript, Zustand, react-i18next, Tauri v2 (`invoke`), Vitest.

## Global Constraints

- All code comments in English.
- No hardcoded UI-facing strings — every user-visible label goes through i18n (`claude-config` namespace).
- Reuse existing Rust commands `get_home_dir`, `read_json_file`, `write_json_file` — do NOT add Rust commands.
- Plugin enable/disable state lives ONLY in user-global `~/.claude/settings.json` under `enabledPlugins` (object of `"name@marketplace": boolean`). A missing key means enabled.
- `read_json_file` returns `"{}"` for a missing file (never throws for absence).
- Plugin config file is `~/.claude/settings.json` — NOT `~/.claude.json` (that is the MCP file).

---

### Task 1: Pure plugin logic lib + tests

**Files:**
- Create: `src/features/claude-config/lib/plugins.ts`
- Test: `src/features/claude-config/lib/__tests__/plugins.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface InstalledPluginRecord { scope: string; installPath: string; version: string; installedAt: string; lastUpdated: string; gitCommitSha: string }`
  - `interface PluginListItem { key: string; name: string; marketplace: string; version: string; enabled: boolean }`
  - `parsePluginKey(key: string): { name: string; marketplace: string }`
  - `isPluginEnabled(enabledPlugins: Record<string, boolean>, key: string): boolean`
  - `mergePluginList(installed: Record<string, InstalledPluginRecord[]>, enabledPlugins: Record<string, boolean>): PluginListItem[]`
  - `toggleEnabledPlugins(enabledPlugins: Record<string, boolean>, key: string, enabled: boolean): Record<string, boolean>`
  - `extractInstalledPlugins(raw: string): Record<string, InstalledPluginRecord[]>`
  - `extractEnabledPlugins(raw: string): Record<string, boolean>`

- [ ] **Step 1: Write the failing test**

Create `src/features/claude-config/lib/__tests__/plugins.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  parsePluginKey,
  isPluginEnabled,
  mergePluginList,
  toggleEnabledPlugins,
  extractInstalledPlugins,
  extractEnabledPlugins,
  type InstalledPluginRecord,
} from "../plugins";

const rec = (over: Partial<InstalledPluginRecord> = {}): InstalledPluginRecord => ({
  scope: "user",
  installPath: "/p",
  version: "1.0.0",
  installedAt: "",
  lastUpdated: "",
  gitCommitSha: "",
  ...over,
});

describe("parsePluginKey", () => {
  it("splits name and marketplace on the last @", () => {
    expect(parsePluginKey("superpowers@claude-plugins-official")).toEqual({
      name: "superpowers",
      marketplace: "claude-plugins-official",
    });
  });
  it("handles a key without @", () => {
    expect(parsePluginKey("foo")).toEqual({ name: "foo", marketplace: "" });
  });
});

describe("isPluginEnabled", () => {
  it("treats a missing key as enabled", () => {
    expect(isPluginEnabled({}, "a@m")).toBe(true);
  });
  it("treats explicit false as disabled", () => {
    expect(isPluginEnabled({ "a@m": false }, "a@m")).toBe(false);
  });
  it("treats explicit true as enabled", () => {
    expect(isPluginEnabled({ "a@m": true }, "a@m")).toBe(true);
  });
});

describe("mergePluginList", () => {
  it("lists installed plugins with enabled state, sorted by name", () => {
    const installed = {
      "superpowers@claude-plugins-official": [rec({ version: "6.1.1" })],
      "aaa@m": [rec({ version: "2.0.0" })],
    };
    const enabled = { "superpowers@claude-plugins-official": false };
    expect(mergePluginList(installed, enabled)).toEqual([
      { key: "aaa@m", name: "aaa", marketplace: "m", version: "2.0.0", enabled: true },
      {
        key: "superpowers@claude-plugins-official",
        name: "superpowers",
        marketplace: "claude-plugins-official",
        version: "6.1.1",
        enabled: false,
      },
    ]);
  });
  it("prefers the user-scope record for version", () => {
    const installed = {
      "a@m": [rec({ scope: "project", version: "9.9.9" }), rec({ scope: "user", version: "1.2.3" })],
    };
    expect(mergePluginList(installed, {})[0].version).toBe("1.2.3");
  });
});

describe("toggleEnabledPlugins", () => {
  it("sets only the target key and keeps others, without mutating input", () => {
    const input = { "other@m": true };
    const out = toggleEnabledPlugins(input, "a@m", false);
    expect(out).toEqual({ "other@m": true, "a@m": false });
    expect(input).toEqual({ "other@m": true });
  });
});

describe("extractInstalledPlugins / extractEnabledPlugins", () => {
  it("extracts the plugins map", () => {
    const raw = JSON.stringify({ version: 2, plugins: { "a@m": [rec()] } });
    expect(Object.keys(extractInstalledPlugins(raw))).toEqual(["a@m"]);
  });
  it("extracts the enabledPlugins map", () => {
    expect(extractEnabledPlugins(JSON.stringify({ enabledPlugins: { "a@m": false } }))).toEqual({
      "a@m": false,
    });
  });
  it("returns empty objects for empty/invalid json", () => {
    expect(extractInstalledPlugins("{}")).toEqual({});
    expect(extractEnabledPlugins("not json")).toEqual({});
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/features/claude-config/lib/__tests__/plugins.test.ts`
Expected: FAIL — cannot find module `../plugins`.

- [ ] **Step 3: Write the implementation**

Create `src/features/claude-config/lib/plugins.ts`:

```ts
// Pure helpers for the Claude "Plugins" settings tab. No I/O here — the store
// wires these to Tauri file commands. Kept side-effect-free for unit testing.

export interface InstalledPluginRecord {
  scope: string;
  installPath: string;
  version: string;
  installedAt: string;
  lastUpdated: string;
  gitCommitSha: string;
}

export interface PluginListItem {
  key: string; // "name@marketplace"
  name: string;
  marketplace: string;
  version: string;
  enabled: boolean;
}

/** Split a "name@marketplace" key on the last "@". */
export function parsePluginKey(key: string): { name: string; marketplace: string } {
  const at = key.lastIndexOf("@");
  if (at <= 0) return { name: key, marketplace: "" };
  return { name: key.slice(0, at), marketplace: key.slice(at + 1) };
}

/** A key absent from enabledPlugins is enabled by default; only explicit false disables. */
export function isPluginEnabled(enabledPlugins: Record<string, boolean>, key: string): boolean {
  return enabledPlugins[key] !== false;
}

/** Merge the installed set with the enabled map into a sorted display list. */
export function mergePluginList(
  installed: Record<string, InstalledPluginRecord[]>,
  enabledPlugins: Record<string, boolean>,
): PluginListItem[] {
  return Object.entries(installed)
    .map(([key, records]) => {
      const { name, marketplace } = parsePluginKey(key);
      const record = records.find((r) => r.scope === "user") ?? records[0];
      return {
        key,
        name,
        marketplace,
        version: record?.version ?? "",
        enabled: isPluginEnabled(enabledPlugins, key),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Return a new enabledPlugins map with `key` set to `enabled`, other keys preserved. */
export function toggleEnabledPlugins(
  enabledPlugins: Record<string, boolean>,
  key: string,
  enabled: boolean,
): Record<string, boolean> {
  return { ...enabledPlugins, [key]: enabled };
}

/** Read the `plugins` map out of installed_plugins.json raw text. */
export function extractInstalledPlugins(raw: string): Record<string, InstalledPluginRecord[]> {
  try {
    const json = JSON.parse(raw);
    return json?.plugins ?? {};
  } catch {
    return {};
  }
}

/** Read the `enabledPlugins` map out of settings.json raw text. */
export function extractEnabledPlugins(raw: string): Record<string, boolean> {
  try {
    const json = JSON.parse(raw);
    return json?.enabledPlugins ?? {};
  } catch {
    return {};
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/features/claude-config/lib/__tests__/plugins.test.ts`
Expected: PASS — all cases green.

- [ ] **Step 5: Commit**

```bash
git add src/features/claude-config/lib/plugins.ts src/features/claude-config/lib/__tests__/plugins.test.ts
git commit -m "feat(claude): pure logic for plugins tab (parse/merge/toggle)"
```

---

### Task 2: Store — load plugins and persist enable/disable

**Files:**
- Modify: `src/stores/claude-config-store.ts` (interface block near lines 5-38; implementation object near lines 91-207; helper functions near lines 40-64)

**Interfaces:**
- Consumes: `mergePluginList`, `toggleEnabledPlugins`, `extractInstalledPlugins`, `extractEnabledPlugins`, `PluginListItem` from `@/features/claude-config/lib/plugins`.
- Produces (on `useClaudeConfigStore`):
  - state `claudePlugins: PluginListItem[]`
  - `loadClaudePlugins: () => Promise<void>`
  - `setClaudePluginEnabled: (key: string, enabled: boolean) => Promise<void>`

- [ ] **Step 1: Add the import**

At the top of `src/stores/claude-config-store.ts`, after the existing `import type { McpServer, SkillInfo } ...` line, add:

```ts
import {
  mergePluginList,
  toggleEnabledPlugins,
  extractInstalledPlugins,
  extractEnabledPlugins,
  type PluginListItem,
} from "@/features/claude-config/lib/plugins";
```

- [ ] **Step 2: Extend the state interface**

In `interface ClaudeConfigState`, add these members (place after the `projectSkills: SkillInfo[];` line and alongside the load/mutation groups):

```ts
  // Claude plugins (user-global ~/.claude/settings.json)
  claudePlugins: PluginListItem[];
  loadClaudePlugins: () => Promise<void>;
  setClaudePluginEnabled: (key: string, enabled: boolean) => Promise<void>;
```

- [ ] **Step 3: Implement the store methods**

In the `create<ClaudeConfigState>()(...)` object, add the initial state next to the other initial fields (after `projectSkills: [],`):

```ts
  claudePlugins: [],
```

Then add these two methods (place after `loadProjectSkills`, before the MCP mutations):

```ts
  loadClaudePlugins: async () => {
    const home = await getHomePath();
    const installedRaw = await invoke<string>("read_json_file", {
      path: `${home}/.claude/plugins/installed_plugins.json`,
    });
    const settingsRaw = await invoke<string>("read_json_file", {
      path: `${home}/.claude/settings.json`,
    });
    const installed = extractInstalledPlugins(installedRaw);
    const enabled = extractEnabledPlugins(settingsRaw);
    set({ claudePlugins: mergePluginList(installed, enabled) });
  },

  setClaudePluginEnabled: async (key, enabled) => {
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
  },
```

Note: `getHomePath` and `invoke` are already imported/defined in this file — reuse them.

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS — no new type errors.

- [ ] **Step 5: Commit**

```bash
git add src/stores/claude-config-store.ts
git commit -m "feat(claude): store methods to load and toggle plugins"
```

---

### Task 3: PluginsTab component, tab registration, i18n

**Files:**
- Create: `src/features/claude-config/components/PluginsTab.tsx`
- Create: `src/features/claude-config/components/PluginsTab.css`
- Modify: `src/shared/types/index.ts:195` (`ClaudeSettingsTab` union)
- Modify: `src/features/claude-config/components/ClaudeSettings.tsx` (TABS array + body render)
- Modify: `src/shared/i18n/locales/en/claude-config.json`
- Modify: `src/shared/i18n/locales/ja/claude-config.json`

**Interfaces:**
- Consumes: `useClaudeConfigStore` state `claudePlugins`, `loadClaudePlugins`, `setClaudePluginEnabled` (from Task 2).
- Produces: `PluginsTab` React component.

- [ ] **Step 1: Add the tab to the type union**

In `src/shared/types/index.ts`, change the `ClaudeSettingsTab` type (line ~195) to:

```ts
export type ClaudeSettingsTab = "general" | "rules" | "mcp" | "skills" | "plugins";
```

- [ ] **Step 2: Add i18n keys (English)**

In `src/shared/i18n/locales/en/claude-config.json`, add these keys (insert after `"tabSkills": "Skills",`):

```json
  "tabPlugins": "Plugins",
  "pluginsDescription": "Enable or disable installed Claude Code plugins. This edits enabledPlugins in ~/.claude/settings.json.",
  "pluginsEmpty": "No plugins installed.",
  "pluginApplyNotice": "Changes apply to new chat sessions.",
```

- [ ] **Step 3: Add i18n keys (Japanese)**

In `src/shared/i18n/locales/ja/claude-config.json`, add the matching keys (place them at the same logical position — after the `tabSkills` key):

```json
  "tabPlugins": "プラグイン",
  "pluginsDescription": "インストール済みの Claude Code プラグインの有効/無効を切り替えます。~/.claude/settings.json の enabledPlugins を編集します。",
  "pluginsEmpty": "インストール済みのプラグインはありません。",
  "pluginApplyNotice": "変更は新しいチャットセッションから反映されます。",
```

Note: verify the `ja/claude-config.json` file already has a `tabSkills` key to anchor to; if the key names differ, still add the four keys above at the top level of the JSON object.

- [ ] **Step 4: Create the component CSS**

Create `src/features/claude-config/components/PluginsTab.css`:

```css
.plugins-tab {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 12px;
}

.plugins-tab__desc {
  margin: 0;
  font-size: 12px;
  opacity: 0.75;
}

.plugins-tab__empty {
  opacity: 0.6;
  font-size: 13px;
  padding: 16px 0;
  text-align: center;
}

.plugins-tab__list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.plugins-tab__item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid var(--border-color, rgba(128, 128, 128, 0.3));
  border-radius: 6px;
  cursor: pointer;
}

.plugins-tab__item-name {
  font-weight: 600;
}

.plugins-tab__item-market {
  font-size: 11px;
  opacity: 0.6;
  border: 1px solid rgba(128, 128, 128, 0.4);
  border-radius: 4px;
  padding: 1px 6px;
}

.plugins-tab__item-version {
  margin-left: auto;
  font-size: 11px;
  opacity: 0.6;
}

.plugins-tab__notice {
  margin: 0;
  font-size: 11px;
  opacity: 0.6;
}
```

- [ ] **Step 5: Create the component**

Create `src/features/claude-config/components/PluginsTab.tsx`:

```tsx
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useClaudeConfigStore } from "@/stores/claude-config-store";
import "./PluginsTab.css";

export function PluginsTab() {
  const { t } = useTranslation("claude-config");
  const plugins = useClaudeConfigStore((s) => s.claudePlugins);
  const loadClaudePlugins = useClaudeConfigStore((s) => s.loadClaudePlugins);
  const setClaudePluginEnabled = useClaudeConfigStore((s) => s.setClaudePluginEnabled);

  useEffect(() => {
    loadClaudePlugins();
  }, [loadClaudePlugins]);

  return (
    <div className="plugins-tab">
      <p className="plugins-tab__desc">{t("pluginsDescription")}</p>
      {plugins.length === 0 ? (
        <div className="plugins-tab__empty">{t("pluginsEmpty")}</div>
      ) : (
        <div className="plugins-tab__list">
          {plugins.map((p) => (
            <label key={p.key} className="plugins-tab__item">
              <input
                type="checkbox"
                checked={p.enabled}
                onChange={(e) => setClaudePluginEnabled(p.key, e.target.checked)}
              />
              <span className="plugins-tab__item-name">{p.name}</span>
              {p.marketplace && <span className="plugins-tab__item-market">{p.marketplace}</span>}
              {p.version && <span className="plugins-tab__item-version">v{p.version}</span>}
            </label>
          ))}
        </div>
      )}
      <p className="plugins-tab__notice">{t("pluginApplyNotice")}</p>
    </div>
  );
}
```

- [ ] **Step 6: Register the tab in ClaudeSettings**

In `src/features/claude-config/components/ClaudeSettings.tsx`:

Add the import after the `SkillsTab` import:

```ts
import { PluginsTab } from "./PluginsTab";
```

Add to the `TABS` array (after the skills entry):

```ts
  { key: "plugins", labelKey: "tabPlugins" },
```

Add to the body render block (after the skills line):

```tsx
        {tab === "plugins" && <PluginsTab />}
```

- [ ] **Step 7: Typecheck and run tests**

Run: `npx tsc --noEmit && npx vitest run src/features/claude-config/lib/__tests__/plugins.test.ts`
Expected: PASS — no type errors, plugin lib tests green.

- [ ] **Step 8: Commit**

```bash
git add src/features/claude-config/components/PluginsTab.tsx src/features/claude-config/components/PluginsTab.css src/features/claude-config/components/ClaudeSettings.tsx src/shared/types/index.ts src/shared/i18n/locales/en/claude-config.json src/shared/i18n/locales/ja/claude-config.json
git commit -m "feat(claude): add Plugins tab to Claude settings panel"
```

---

### Task 4: Manual smoke verification

**Files:** none (verification only).

- [ ] **Step 1: Build the frontend**

Run: `npx vite build` (or the project's build script)
Expected: build succeeds with no errors.

- [ ] **Step 2: Launch the app and verify the tab**

Launch the Tauri app (dev), open the Claude panel → Settings → Plugins tab. Verify:
- The installed plugins appear (e.g. `superpowers`, `rust-analyzer-lsp`) with marketplace badge and version.
- Each checkbox reflects the current enabled state (all enabled by default).
- Unchecking a plugin writes `false` into `~/.claude/settings.json` `enabledPlugins` (confirm by opening the file); re-checking writes `true`. Other keys in `settings.json` are preserved.
- With no plugins installed (or the file missing), the empty state message shows and no error is thrown.

- [ ] **Step 3: Commit (if any fixup needed)**

Only if the smoke test surfaced a fix — commit it with a clear message. Otherwise no commit.

---

## Notes for the implementer

- The MCP file (`~/.claude.json`) and the plugins/settings file (`~/.claude/settings.json`) are DIFFERENT files. Do not confuse them.
- Never write to project or local scope in this feature — user-global only.
- `read_json_file` already returns `"{}"` for a missing file, so no existence checks are needed before reading.
- Keep all logic that can be tested without I/O inside `lib/plugins.ts`; the store method should stay a thin I/O wrapper.
