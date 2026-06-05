# opencode Built-in Plugins Section — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Plugins" section to the opencode settings tab that lists superpowers / oh-my-opencode as toggleable built-in plugins and lets users add custom plugin entries, writing to the global `opencode.jsonc` `plugin` array.

**Architecture:** Mirror the existing `builtin-registry` + section + store pattern. A new `builtin-plugins.ts` holds the catalog and pure array helpers (unit-tested). The config store gains `addPlugin`/`removePlugin` that manipulate the global config's `plugin` string array. A new `PluginsSection.tsx` renders built-in toggles + a custom list + a restart action. Built-ins are opt-in (default OFF). Global scope only.

**Tech Stack:** React + TypeScript (Tauri app), Zustand store, react-i18next, Vitest (node env, pure-logic tests only — no React component tests in this codebase).

**Reference spec:** `.superpowers/specs/2026-06-05-opencode-builtin-plugins-design.md`

**Testing convention (important):** This repo's tests target pure logic functions under `lib/__tests__/*.test.ts` (Vitest, node env, no jsdom/testing-library). TDD applies to the registry + array helpers. UI/tab/i18n changes are verified by `npm run build` (tsc typecheck) + manual app check — consistent with the codebase (no component tests exist).

---

### Task 1: Add config + tab types

**Files:**
- Modify: `src/shared/types/index.ts:170-184`

- [ ] **Step 1: Add `plugin` field to `OpencodeConfig`**

In `src/shared/types/index.ts`, change the `OpencodeConfig` interface to add a `plugin` field (place it after `webui`):

```typescript
/** Opencode configuration */
export interface OpencodeConfig {
  model?: string;
  rules?: string[];
  tools?: Record<string, boolean>;
  agents?: Record<string, OpencodeAgent>;
  command?: Record<string, OpencodeCommand>;
  mcp?: Record<string, OpencodeMcpServer>;
  skills?: Record<string, OpencodeSkill>;
  customTools?: Record<string, OpencodeCustomTool>;
  webui?: OpencodeWebUi;
  /** opencode native plugin array: package specs (npm name / git URL / local path) */
  plugin?: string[];
}
```

- [ ] **Step 2: Add `"plugins"` to `OpencodeConfigTab`**

In the same file, update the tab union:

```typescript
/** Opencode config tab */
export type OpencodeConfigTab = "rules" | "tools" | "agents" | "commands" | "mcp" | "skills" | "custom-tools" | "webui" | "plugins";
```

- [ ] **Step 3: Typecheck**

Run: `npm run build`
Expected: Compiles, OR fails only at `OpencodeConfigPanel.tsx`'s `TAB_SECTIONS` (a `Record<OpencodeConfigTab, ...>` that does not yet include `plugins`). That specific error is expected and is fixed in Task 6. Any other new errors must be investigated.

- [ ] **Step 4: Commit**

```bash
git add src/shared/types/index.ts
git commit -m "feat(opencode-plugins): add plugin config field and plugins tab type"
```

---

### Task 2: Built-in plugins catalog + pure helpers (TDD)

**Files:**
- Create: `src/features/opencode-config/lib/builtin-plugins.ts`
- Test: `src/features/opencode-config/lib/__tests__/builtin-plugins.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/features/opencode-config/lib/__tests__/builtin-plugins.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import {
  BUILTIN_PLUGINS,
  isBuiltinPlugin,
  addPluginSpec,
  removePluginSpec,
} from "../builtin-plugins";

describe("BUILTIN_PLUGINS catalog", () => {
  it("contains superpowers and oh-my-opencode entries with spec/descriptionKey/docsUrl", () => {
    expect(Object.keys(BUILTIN_PLUGINS)).toEqual(
      expect.arrayContaining(["superpowers", "oh-my-opencode"]),
    );
    for (const entry of Object.values(BUILTIN_PLUGINS)) {
      expect(entry.spec).toBeTruthy();
      expect(entry.descriptionKey).toBeTruthy();
      expect(entry.docsUrl).toMatch(/^https?:\/\//);
    }
  });

  it("pins the superpowers spec to a git tag", () => {
    expect(BUILTIN_PLUGINS.superpowers.spec).toMatch(/git\+https:\/\/github\.com\/obra\/superpowers\.git#v/);
  });
});

describe("isBuiltinPlugin", () => {
  it("returns true for a built-in spec", () => {
    expect(isBuiltinPlugin(BUILTIN_PLUGINS.superpowers.spec)).toBe(true);
  });

  it("returns false for an unknown spec", () => {
    expect(isBuiltinPlugin("some-random-plugin")).toBe(false);
  });
});

describe("addPluginSpec", () => {
  it("appends a new spec", () => {
    expect(addPluginSpec(["a"], "b")).toEqual(["a", "b"]);
  });

  it("does not duplicate an existing spec", () => {
    expect(addPluginSpec(["a", "b"], "b")).toEqual(["a", "b"]);
  });

  it("does not mutate the input array", () => {
    const input = ["a"];
    addPluginSpec(input, "b");
    expect(input).toEqual(["a"]);
  });
});

describe("removePluginSpec", () => {
  it("removes the given spec", () => {
    expect(removePluginSpec(["a", "b"], "a")).toEqual(["b"]);
  });

  it("is a no-op when spec absent", () => {
    expect(removePluginSpec(["a", "b"], "c")).toEqual(["a", "b"]);
  });

  it("does not mutate the input array", () => {
    const input = ["a", "b"];
    removePluginSpec(input, "a");
    expect(input).toEqual(["a", "b"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/features/opencode-config/lib/__tests__/builtin-plugins.test.ts`
Expected: FAIL — cannot resolve `../builtin-plugins` (module does not exist yet).

- [ ] **Step 3: Write minimal implementation**

Create `src/features/opencode-config/lib/builtin-plugins.ts`:

```typescript
export interface BuiltinPluginEntry {
  /** Canonical package spec written to the opencode `plugin` array. */
  spec: string;
  /** i18n key (in the "opencode-config" namespace) for the UI description. */
  descriptionKey: string;
  /** Documentation URL opened from the 🔗 link. */
  docsUrl: string;
}

// NOTE (Task 3 step): confirm the installable npm package name for oh-my-opencode
// (`oh-my-openagent` vs `oh-my-opencode`) with `npm view` and update the spec below
// if needed. Default is `oh-my-openagent`.
export const BUILTIN_PLUGINS: Record<string, BuiltinPluginEntry> = {
  superpowers: {
    spec: "superpowers@git+https://github.com/obra/superpowers.git#v5.1.0",
    descriptionKey: "pluginDesc_superpowers",
    docsUrl: "https://github.com/obra/superpowers/blob/main/docs/README.opencode.md",
  },
  "oh-my-opencode": {
    spec: "oh-my-openagent",
    descriptionKey: "pluginDesc_oh-my-opencode",
    docsUrl: "https://ohmyopencode.com/",
  },
};

/** True if the given spec string belongs to a built-in plugin. */
export function isBuiltinPlugin(spec: string): boolean {
  return Object.values(BUILTIN_PLUGINS).some((e) => e.spec === spec);
}

/** Return a new array with `spec` appended if not already present (dedup). */
export function addPluginSpec(list: string[], spec: string): string[] {
  return list.includes(spec) ? [...list] : [...list, spec];
}

/** Return a new array with all occurrences of `spec` removed. */
export function removePluginSpec(list: string[], spec: string): string[] {
  return list.filter((p) => p !== spec);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/features/opencode-config/lib/__tests__/builtin-plugins.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/features/opencode-config/lib/builtin-plugins.ts src/features/opencode-config/lib/__tests__/builtin-plugins.test.ts
git commit -m "feat(opencode-plugins): add built-in plugin catalog and array helpers"
```

---

### Task 3: Confirm oh-my-opencode package name + re-export from registry

**Files:**
- Modify: `src/features/opencode-config/lib/builtin-plugins.ts` (only if the package name needs changing)
- Modify: `src/features/opencode-config/lib/builtin-registry.ts:199` (end of file)

- [ ] **Step 1: Confirm the oh-my-opencode installable package name**

Run: `npm view oh-my-openagent name version 2>&1; echo "---"; npm view oh-my-opencode name version 2>&1`
Expected: one (or both) prints a name + version. Choose the package that is documented as the opencode `plugin` array entry (per the spec research, `oh-my-openagent` is the renamed package). If `oh-my-openagent` resolves, keep the default. If only `oh-my-opencode` resolves, update `BUILTIN_PLUGINS["oh-my-opencode"].spec` to `"oh-my-opencode"`.
If the network is restricted and neither resolves, keep the default `oh-my-openagent` and note it in the commit message.

- [ ] **Step 2: Re-export the catalog and helper from builtin-registry**

Append to the end of `src/features/opencode-config/lib/builtin-registry.ts`:

```typescript
// Built-in plugins (opencode `plugin` array entries). Re-exported here so
// sections import all built-in catalogs from one module, matching BUILTIN_MCP etc.
export { BUILTIN_PLUGINS, isBuiltinPlugin } from "./builtin-plugins";
export type { BuiltinPluginEntry } from "./builtin-plugins";
```

- [ ] **Step 3: Typecheck + run plugin tests**

Run: `npx vitest run src/features/opencode-config/lib/__tests__/builtin-plugins.test.ts`
Expected: PASS (unchanged).

- [ ] **Step 4: Commit**

```bash
git add src/features/opencode-config/lib/builtin-plugins.ts src/features/opencode-config/lib/builtin-registry.ts
git commit -m "feat(opencode-plugins): confirm package name and re-export catalog from registry"
```

---

### Task 4: Store methods `addPlugin` / `removePlugin`

**Files:**
- Modify: `src/stores/opencode-config-store.ts:1-11` (imports), `:63-65` (interface), `:338-343` (implementation, after `setWebUi`)

- [ ] **Step 1: Import the pure helpers**

In `src/stores/opencode-config-store.ts`, add an import after the existing type import block (after line 11):

```typescript
import { addPluginSpec, removePluginSpec } from "@/features/opencode-config/lib/builtin-plugins";
```

- [ ] **Step 2: Declare the two methods on the state interface**

In the `OpencodeConfigState` interface, add after the `setWebUi` line (after line 64):

```typescript
  // Plugins (Global only)
  addPlugin: (spec: string) => Promise<void>;
  removePlugin: (spec: string) => Promise<void>;
```

- [ ] **Step 3: Implement the methods**

In the store object, add after the `setWebUi` implementation (after line 343, before the closing `}))`):

```typescript
  addPlugin: async (spec) => {
    const fresh = await readConfig();
    fresh.plugin = addPluginSpec(fresh.plugin ?? [], spec);
    await writeConfig(fresh);
    set({ config: fresh });
  },

  removePlugin: async (spec) => {
    const fresh = await readConfig();
    fresh.plugin = removePluginSpec(fresh.plugin ?? [], spec);
    await writeConfig(fresh);
    set({ config: fresh });
  },
```

- [ ] **Step 4: Typecheck**

Run: `npm run build`
Expected: Compiles, OR still fails only at the `TAB_SECTIONS` exhaustiveness error from Task 1 (fixed in Task 6). No new errors in the store.

- [ ] **Step 5: Commit**

```bash
git add src/stores/opencode-config-store.ts
git commit -m "feat(opencode-plugins): add addPlugin/removePlugin store actions"
```

---

### Task 5: PluginsSection component

**Files:**
- Create: `src/features/opencode-config/components/sections/PluginsSection.tsx`

- [ ] **Step 1: Create the section component**

Create `src/features/opencode-config/components/sections/PluginsSection.tsx`:

```tsx
import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { showConfirm } from "@/stores/dialog-store";
import { useOpencodeConfigStore } from "@/stores/opencode-config-store";
import { useTabStore } from "@/stores/tab-store";
import { useOpencodeServerStore } from "@/stores/opencode-server-store";
import { BUILTIN_PLUGINS, isBuiltinPlugin } from "../../lib/builtin-registry";

const subtitleStyle: React.CSSProperties = {
  fontWeight: 600,
  marginTop: 12,
  marginBottom: 4,
};

export function PluginsSection() {
  const { t } = useTranslation("opencode-config");
  const config = useOpencodeConfigStore((s) => s.config);
  const loadConfig = useOpencodeConfigStore((s) => s.loadConfig);
  const addPlugin = useOpencodeConfigStore((s) => s.addPlugin);
  const removePlugin = useOpencodeConfigStore((s) => s.removePlugin);
  const activeFolderPath = useTabStore((s) => s.activeFolderPath);
  const removeServer = useOpencodeServerStore((s) => s.removeServer);

  const [globalConfigPath, setGlobalConfigPath] = useState("");
  const [adding, setAdding] = useState(false);
  const [formSpec, setFormSpec] = useState("");
  const [restarting, setRestarting] = useState(false);

  useEffect(() => { loadConfig(); }, [loadConfig]);

  useEffect(() => {
    invoke<string>("get_home_dir").then((home) => {
      const sep = home.includes("\\") ? "\\" : "/";
      setGlobalConfigPath(`${home}${sep}.config${sep}opencode${sep}opencode.jsonc`);
    }).catch(() => {});
  }, []);

  const plugins = config.plugin ?? [];
  const customPlugins = plugins.filter((spec) => !isBuiltinPlugin(spec));

  const openUrl = (url: string) => invoke("open_external_url", { url });

  const handleToggle = async (spec: string, enabled: boolean) => {
    if (enabled) await addPlugin(spec);
    else await removePlugin(spec);
  };

  const handleAdd = async () => {
    const spec = formSpec.trim();
    if (!spec) return;
    await addPlugin(spec);
    setFormSpec("");
    setAdding(false);
  };

  const handleDelete = async (spec: string) => {
    const confirmed = await showConfirm(t("pluginDeleteConfirm", { name: spec }), { kind: "warning" });
    if (!confirmed) return;
    await removePlugin(spec);
  };

  const handleRestart = async () => {
    if (!activeFolderPath) return;
    setRestarting(true);
    try {
      // Stop the running opencode server for the active folder. It will relaunch
      // with the updated `plugin` array (reading opencode.jsonc afresh) on the
      // next chat connection via ensureOpencodeServer().
      await removeServer(activeFolderPath);
    } finally {
      setRestarting(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, overflowY: "auto" }}>
      <div className="oc-section__hint">
        {t("pluginsDescription")}{" "}
        <a
          href="#"
          onClick={(e) => { e.preventDefault(); openUrl(t("pluginsDocsUrl")); }}
          style={{ textDecoration: "none", cursor: "pointer" }}
          title={t("pluginsDocsUrl")}
        >
          🔗
        </a>
      </div>

      {/* Restart notice + action */}
      <div className="oc-section__hint">
        {t("pluginRestartNotice")}
        <button
          className="oc-section__test-btn"
          style={{ marginLeft: 8 }}
          onClick={handleRestart}
          disabled={restarting || !activeFolderPath}
        >
          {restarting ? t("pluginRestarting") : t("pluginRestart")}
        </button>
      </div>

      {/* Built-in plugins */}
      <div style={subtitleStyle}>{t("pluginsBuiltinTitle")}</div>
      {Object.entries(BUILTIN_PLUGINS).map(([id, entry]) => {
        const enabled = plugins.includes(entry.spec);
        return (
          <div
            key={id}
            className={`oc-section__item${!enabled ? " oc-section__item--disabled" : ""}`}
            style={{ marginBottom: 4 }}
          >
            <div className="oc-section__item-info">
              <span className="oc-section__item-name">
                {id}
                <span className="oc-section__builtin-badge">Built-in</span>
                <a
                  href="#"
                  onClick={(e) => { e.preventDefault(); openUrl(entry.docsUrl); }}
                  style={{ textDecoration: "none", cursor: "pointer", marginLeft: 6 }}
                  title={entry.docsUrl}
                >
                  🔗
                </a>
              </span>
              <span className="oc-section__item-detail">{t(entry.descriptionKey)}</span>
              <span className="oc-section__item-detail" style={{ opacity: 0.6 }}>{entry.spec}</span>
            </div>
            <div className="oc-section__item-actions">
              <label className="oc-section__toggle" style={{ padding: 0 }}>
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={(e) => handleToggle(entry.spec, e.target.checked)}
                />
              </label>
            </div>
          </div>
        );
      })}

      {/* Custom plugins */}
      <div style={subtitleStyle}>{t("pluginsCustomTitle")}</div>
      {customPlugins.length === 0 && <div className="oc-section__empty">{t("pluginsEmpty")}</div>}
      {customPlugins.map((spec) => (
        <div key={spec} className="oc-section__item" style={{ marginBottom: 4 }}>
          <div className="oc-section__item-info">
            <span className="oc-section__item-detail">{spec}</span>
          </div>
          <div className="oc-section__item-actions">
            <button className="oc-section__delete-btn" onClick={() => handleDelete(spec)}>×</button>
          </div>
        </div>
      ))}

      {adding ? (
        <div className="oc-section__field" style={{ marginTop: 8 }}>
          <label className="oc-section__label">{t("pluginSpec")}</label>
          <input
            className="oc-section__input"
            value={formSpec}
            onChange={(e) => setFormSpec(e.target.value)}
            placeholder={t("pluginSpecPlaceholder")}
          />
          <div className="oc-section__form-actions" style={{ marginTop: 8 }}>
            <button className="oc-section__save-btn" onClick={handleAdd}>{t("save")}</button>
            <button
              className="oc-section__cancel-btn"
              onClick={() => { setAdding(false); setFormSpec(""); }}
            >
              {t("cancel")}
            </button>
          </div>
        </div>
      ) : (
        <div style={{ marginTop: 4 }}>
          <button className="oc-section__add-btn" onClick={() => setAdding(true)}>+ {t("pluginAdd")}</button>
        </div>
      )}

      {globalConfigPath && (
        <div className="oc-section__path-hint">{t("mcpSavePath")}: {globalConfigPath}</div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run build`
Expected: Compiles, OR still fails only at the `TAB_SECTIONS` exhaustiveness error from Task 1 (fixed next in Task 6). No new errors in `PluginsSection.tsx` itself.

- [ ] **Step 3: Commit**

```bash
git add src/features/opencode-config/components/sections/PluginsSection.tsx
git commit -m "feat(opencode-plugins): add PluginsSection UI component"
```

---

### Task 6: Wire the tab into the panel + badge

**Files:**
- Modify: `src/features/opencode-config/components/OpencodeConfigPanel.tsx:8-16` (imports), `:20-29` (TABS), `:60-69` (TAB_SECTIONS)
- Modify: `src/features/opencode-config/components/OpencodeConfigBadges.tsx:34-61`

- [ ] **Step 1: Import PluginsSection**

In `OpencodeConfigPanel.tsx`, add the import alongside the other section imports (after the `WebUiSection` import on line 15):

```typescript
import { PluginsSection } from "./sections/PluginsSection";
```

- [ ] **Step 2: Add the tab entry**

In the `TABS` array (lines 20-29), add the plugins tab after the `custom-tools` entry:

```typescript
  { key: "custom-tools", labelKey: "tabCustomTools" },
  { key: "plugins", labelKey: "tabPlugins" },
```

- [ ] **Step 3: Add to TAB_SECTIONS map**

In the `TAB_SECTIONS` record (lines 60-69), add the plugins entry:

```typescript
    "custom-tools": <CustomToolsSection />,
    plugins: <PluginsSection />,
    webui: <WebUiSection />,
```

- [ ] **Step 4: Add a plugins badge**

In `OpencodeConfigBadges.tsx`, inside the `useMemo` body, compute the plugin count before the `return [` (after line 34):

```typescript
    // Plugins (global plugin array)
    const allPlugins = config.plugin ?? [];
```

Then add a badge object to the returned array (after the `custom-tools` badge object, before the closing `]`):

```typescript
      {
        key: "plugins",
        label: t("tabPlugins"),
        count: allPlugins.length,
        items: allPlugins,
      },
```

- [ ] **Step 5: Typecheck**

Run: `npm run build`
Expected: PASS (the Task 1 exhaustiveness error is now resolved). No errors.

- [ ] **Step 6: Commit**

```bash
git add src/features/opencode-config/components/OpencodeConfigPanel.tsx src/features/opencode-config/components/OpencodeConfigBadges.tsx
git commit -m "feat(opencode-plugins): wire Plugins tab into config panel and badges"
```

---

### Task 7: i18n strings (ja + en)

**Files:**
- Modify: `src/shared/i18n/locales/ja/opencode-config.json`
- Modify: `src/shared/i18n/locales/en/opencode-config.json`

- [ ] **Step 1: Add Japanese keys**

In `src/shared/i18n/locales/ja/opencode-config.json`, add `tabPlugins` next to the other `tab*` keys (after `"tabCustomTools": "カスタムツール",` on line 33):

```json
  "tabPlugins": "プラグイン",
```

Then add the remaining plugin keys before the closing `}` (after the last existing key `"ocChatReasoning"`):

```json
  "pluginsDescription": "opencode のプラグインを管理します。プラグインはサーバ起動時にロードされ、エージェント・ツール・スキルなどを追加できます。",
  "pluginsDocsUrl": "https://opencode.ai/docs/plugins/",
  "pluginsEmpty": "カスタムプラグインがありません",
  "pluginsBuiltinTitle": "ビルトインプラグイン",
  "pluginsCustomTitle": "カスタムプラグイン",
  "pluginAdd": "追加",
  "pluginSpec": "パッケージ仕様（npm名 / git URL / ローカルパス）",
  "pluginSpecPlaceholder": "例: my-plugin または my-plugin@git+https://github.com/user/repo.git",
  "pluginDeleteConfirm": "「{{name}}」を削除しますか？",
  "pluginRestartNotice": "プラグインの変更を反映するには opencode サーバの再起動が必要です。再起動するとサーバが停止し、次回チャット時に新しいプラグイン構成で再起動します。",
  "pluginRestart": "再起動",
  "pluginRestarting": "再起動中...",
  "pluginDesc_superpowers": "Superpowers — TDD・デバッグ・ブレインストーミングなどのスキル群で opencode を拡張します。",
  "pluginDesc_oh-my-opencode": "Oh My OpenCode — キュレートされたエージェント・ツール・MCP を同梱したオールインワンプラグインです。"
```

(Add a comma after `"ocChatReasoning": "思考内容"` so the JSON stays valid.)

- [ ] **Step 2: Add English keys**

In `src/shared/i18n/locales/en/opencode-config.json`, add `tabPlugins` after `"tabCustomTools": "Custom Tools",` (line 33):

```json
  "tabPlugins": "Plugins",
```

Then add the remaining plugin keys before the closing `}` (after the last existing key; add a comma after the previous last key to keep JSON valid):

```json
  "pluginsDescription": "Manage opencode plugins. Plugins are loaded at server startup and can add agents, tools, and skills.",
  "pluginsDocsUrl": "https://opencode.ai/docs/plugins/",
  "pluginsEmpty": "No custom plugins",
  "pluginsBuiltinTitle": "Built-in plugins",
  "pluginsCustomTitle": "Custom plugins",
  "pluginAdd": "Add",
  "pluginSpec": "Package spec (npm name / git URL / local path)",
  "pluginSpecPlaceholder": "e.g. my-plugin or my-plugin@git+https://github.com/user/repo.git",
  "pluginDeleteConfirm": "Delete \"{{name}}\"?",
  "pluginRestartNotice": "Restarting the opencode server is required to apply plugin changes. Restarting stops the server; it relaunches with the new plugin configuration on your next chat.",
  "pluginRestart": "Restart",
  "pluginRestarting": "Restarting...",
  "pluginDesc_superpowers": "Superpowers — extends opencode with a library of skills (TDD, debugging, brainstorming, and more).",
  "pluginDesc_oh-my-opencode": "Oh My OpenCode — a batteries-included plugin bundling curated agents, tools, and MCPs."
```

- [ ] **Step 3: Validate JSON**

Run: `node -e "require('./src/shared/i18n/locales/ja/opencode-config.json'); require('./src/shared/i18n/locales/en/opencode-config.json'); console.log('json ok')"`
Expected: prints `json ok` (no JSON parse errors from a stray/missing comma).

- [ ] **Step 4: Commit**

```bash
git add src/shared/i18n/locales/ja/opencode-config.json src/shared/i18n/locales/en/opencode-config.json
git commit -m "feat(opencode-plugins): add i18n strings for plugins section (ja/en)"
```

---

### Task 8: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `npm run test`
Expected: PASS, including `builtin-plugins.test.ts`. No regressions.

- [ ] **Step 2: Typecheck + build**

Run: `npm run build`
Expected: `tsc` passes and `vite build` succeeds with no errors.

- [ ] **Step 3: Manual smoke test (dev app)**

Run: `npm run tauri dev`
Then in the app:
1. Open a folder (the opencode settings tab requires an active folder).
2. Open the opencode panel → Settings → "プラグイン"/"Plugins" tab.
3. Verify superpowers and oh-my-opencode appear under "Built-in plugins", both OFF, each with a Built-in badge, description, spec line, and 🔗 link.
4. Toggle superpowers ON. Open `~/.config/opencode/opencode.jsonc` and confirm its `spec` string was added to the `plugin` array.
5. Toggle it OFF and confirm the spec is removed.
6. Click "+ Add", enter a custom spec (e.g. `my-test-plugin`), Save. Confirm it appears under "Custom plugins" and in the `plugin` array. Delete it (×) and confirm removal.
7. Click "Restart" and confirm no error (the active folder's opencode server stops; it will relaunch on next chat).
8. Switch the app language (ja ↔ en) and confirm all labels are translated (no raw keys shown).

Expected: all steps behave as described. Record any deviations.

- [ ] **Step 4: Final integration commit (if any fixups were needed)**

```bash
git add -A
git commit -m "test(opencode-plugins): verify plugins section end-to-end"
```

(If Step 3 found no issues and produced no changes, skip this commit.)

---

## Self-Review Notes

- **Spec coverage:** §4 types → Task 1; §4.2/4.3 catalog + helpers → Tasks 2-3; §5 store → Task 4; §6 UI section → Task 5; §7 tab wiring → Task 6; §8 i18n → Task 7; §10 acceptance criteria → Task 8 manual smoke test. All spec sections map to a task.
- **Refinement vs spec:** The spec listed `getMissingBuiltinPlugins`, modeled on the MCP "+ Built-in" dropdown. The Plugins section instead always lists every built-in with a toggle (cleaner UX), so that helper is unnecessary and intentionally omitted. `isBuiltinPlugin` (used to separate custom entries) and the pure `addPluginSpec`/`removePluginSpec` helpers cover the real needs.
- **Type consistency:** `addPluginSpec`/`removePluginSpec`/`isBuiltinPlugin`/`BUILTIN_PLUGINS`/`BuiltinPluginEntry`/`descriptionKey`/`spec`/`docsUrl` names are used identically across Tasks 2-6. Store methods `addPlugin`/`removePlugin` consistent across Tasks 4-5.
- **No new CSS:** the component reuses existing `oc-section__*` classes (verified present) plus inline styles for subtitles, so no CSS file changes are required.
- **Open item:** oh-my-opencode package name is verified at Task 3 Step 1 (`npm view`); default `oh-my-openagent` with a documented fallback to `oh-my-opencode`.
