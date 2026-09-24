# UI Improvements (Part 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement Part 1 of `.superpowers/specs/2026-09-24-agent-workflows-design.md`: confirm-dialog overlay option, scrollable MCP server list, theme-aware switches, compact opencode usage display, and multiple terminal sessions.

**Architecture:** Each feature is a small, independent change to existing React components, CSS, Zustand stores, and (for terminals) one Rust command. Shared switch coloring moves into one global stylesheet (`src/shared/styles/switch.css`) keyed on a `data-switch` attribute; feature stylesheets keep only geometry and motion. Terminal sessions become an explicit list in `ui-store`, and PTYs outlive their xterm views until the user closes the session or its folder.

**Tech Stack:** React 19 + TypeScript, Zustand, react-i18next, Tauri v2 (`invoke`), Rust (`portable_pty`), Vitest 4 + happy-dom.

## Global Constraints

- All code comments in English.
- No hardcoded UI-facing strings: every user-visible label, `title`, and `aria-label` goes through i18n. Add every new key to both `src/shared/i18n/locales/en/*.json` and `src/shared/i18n/locales/ja/*.json`.
- Do not change base colors of any theme preset in `src/shared/themes/presets/`.
- Switch colors come only from theme variables `--bg-surface`, `--primary`, `--border`, `--bg-base`. Feature CSS switch rules must not contain `white`, `#fff`, `#ffffff`, `var(--accent…)`, `var(--text-muted)`, or a `var()` with a fallback.
- `tsconfig.json` has `noUnusedLocals` / `noUnusedParameters`: remove imports and variables that become unused.
- Component tests use `// @vitest-environment happy-dom` on the first line and set `IS_REACT_ACT_ENVIRONMENT = true`.
- Commands (run from the repo root `C:\Users\mtmar\source\repos\mdium`):
  - Single test file: `npx vitest run <path>`
  - Type check: `npx tsc --noEmit`
  - Full suite: `npm test`
  - Rust: `cargo check --manifest-path src-tauri/Cargo.toml` (if it fails because `resources/claude-sidecar` is missing, run `npm run build:sidecar` first)

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `src/stores/dialog-store.ts` | `closeOnOverlayClick` option on confirm entries | 1 |
| `src/shared/components/AppDialog.tsx` (+ `AppDialog.test.tsx`) | Honor the option on overlay mousedown | 1 |
| `src/features/opencode-config/components/sections/McpServersSection.tsx` (+ test) | Wrap cards in a scrollable list container | 2 |
| `src/features/opencode-config/components/OpencodeConfigDialog.css` | List scroll rules; checkbox switch geometry | 2, 4 |
| `src/shared/styles/switch.css` (new) | Global theme-aware switch colors, focus, disabled | 3 |
| `src/shared/styles/switch-contract.test.ts` (new) | Static CSS/markup contract for all switches | 3, 4, 5 |
| `src/shared/themes/apply-theme.test.ts` (new) | Every preset publishes the switch variables | 3 |
| `src/main.tsx` | Import `switch.css` globally | 3 |
| Settings / opencode sections / Claude plugins / opencode chat TSX + CSS | Mark checkbox switches with `data-switch role="switch"` | 4 |
| `PreviewPanel.tsx/.css`, `SceneEditForm.tsx`, `VideoSettingsBar.tsx`, `VideoPanel.css` (+ tests) | Mark span switches, i18n `aria-label` | 5 |
| `OpencodeUsagePopover.tsx` (+ test), `OpencodeChat.tsx/.css` | Cost-only usage button above the input | 6 |
| `src/features/terminal/terminal-session.ts` (new, + test) | Terminal kinds, launch commands, theme rule | 7 |
| `src/stores/ui-store.ts` (+ `__tests__/ui-store-terminal-sessions.test.ts`) | Session list, per-folder active session, pruning | 7 |
| `src-tauri/src/commands/pty.rs` | Reuse an existing PTY for the same id | 8 |
| `src/features/terminal/components/Terminal.tsx` | Stop killing the PTY on unmount | 8 |
| `src/app/App.tsx`, `src/app/App.css`, `common.json` (en/ja) | Session tabs, add dropdown, close buttons | 8 |

---

### Task 1: Confirm dialog overlay option

**Files:**
- Modify: `src/stores/dialog-store.ts` (interface `DialogEntry` and `showConfirm`)
- Modify: `src/shared/components/AppDialog.tsx:26` (overlay `onMouseDown`)
- Create: `src/shared/components/AppDialog.test.tsx`

**Interfaces:**
- Produces: `showConfirm(text: string, options?: { title?: string; kind?: DialogKind; closeOnOverlayClick?: boolean }): Promise<boolean>`. When `closeOnOverlayClick === false`, clicking the overlay does nothing; the default (undefined) keeps today's behavior (overlay click resolves `false`).

- [ ] **Step 1: Write the failing test**

Create `src/shared/components/AppDialog.test.tsx`:

```tsx
// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import "@/shared/i18n";
import { showConfirm, useDialogStore } from "@/stores/dialog-store";
import { AppDialog } from "./AppDialog";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("AppDialog overlay", () => {
  let root: ReturnType<typeof createRoot> | undefined;

  afterEach(async () => {
    await act(async () => root?.unmount());
    root = undefined;
    useDialogStore.setState({ dialogs: [], _nextId: 1 });
  });

  it("keeps an explicit-decision confirm open when its overlay is clicked", async () => {
    const container = document.createElement("div");
    root = createRoot(container);
    const confirmation = showConfirm("Apply the change?", { closeOnOverlayClick: false });
    let settled = false;
    void confirmation.finally(() => { settled = true; });

    await act(async () => { root?.render(<AppDialog />); });
    const overlay = container.querySelector(".app-dialog__overlay");
    await act(async () => {
      overlay?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      await Promise.resolve();
    });

    expect(settled).toBe(false);
    expect(useDialogStore.getState().dialogs).toHaveLength(1);

    const cancel = container.querySelectorAll<HTMLButtonElement>(".app-dialog__btn")[1];
    await act(async () => { cancel.click(); });
    await expect(confirmation).resolves.toBe(false);
  });

  it("cancels a confirm when its overlay is clicked by default", async () => {
    const container = document.createElement("div");
    root = createRoot(container);
    const confirmation = showConfirm("Continue?");

    await act(async () => { root?.render(<AppDialog />); });
    const overlay = container.querySelector(".app-dialog__overlay");
    await act(async () => {
      overlay?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });

    expect(container.querySelector(".app-dialog__overlay")).toBeNull();
    await expect(confirmation).resolves.toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/shared/components/AppDialog.test.tsx`
Expected: the first test FAILS (`settled` is `true` / dialogs length is 0); `tsc` would also reject the unknown `closeOnOverlayClick` option.

- [ ] **Step 3: Implement**

In `src/stores/dialog-store.ts`, add the field to `DialogEntry` (after `kind?: DialogKind;`):

```ts
  closeOnOverlayClick?: boolean;
```

and change `showConfirm` to:

```ts
/** Show a confirm dialog (OK / Cancel). Resolves to true if confirmed. */
export function showConfirm(
  text: string,
  options?: { title?: string; kind?: DialogKind; closeOnOverlayClick?: boolean },
): Promise<boolean> {
  return new Promise((resolve) => {
    useDialogStore.getState()._push({
      type: "confirm",
      text,
      title: options?.title,
      kind: options?.kind,
      closeOnOverlayClick: options?.closeOnOverlayClick,
      resolve: (v) => resolve(v as boolean),
    });
  });
}
```

In `src/shared/components/AppDialog.tsx`, make the first line of the overlay `onMouseDown` handler:

```tsx
    <div className="app-dialog__overlay" onMouseDown={() => {
      if (entry.closeOnOverlayClick === false) return;
      if (entry.type === "message") handleResolve(true);
      else handleResolve(entry.type === "confirm" ? false : null);
    }}>
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/shared/components/AppDialog.test.tsx`
Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add src/stores/dialog-store.ts src/shared/components/AppDialog.tsx src/shared/components/AppDialog.test.tsx
git commit -m "feat(dialog): allow confirms that ignore overlay clicks"
```

---

### Task 2: Scrollable MCP server list

**Files:**
- Modify: `src/features/opencode-config/components/sections/McpServersSection.tsx` (list render, ~lines 734-812)
- Modify: `src/features/opencode-config/components/OpencodeConfigDialog.css` (add rules after the `.oc-section__toggle` switch block, ~line 340)
- Create: `src/features/opencode-config/components/sections/McpServersSection.test.tsx`

**Interfaces:**
- Produces: DOM contract — all `.oc-section__item` cards live inside `.oc-mcp-servers__list`; the add/built-in button row is the next sibling `.oc-mcp-servers__actions`.

- [ ] **Step 1: Write the failing test**

Create `src/features/opencode-config/components/sections/McpServersSection.test.tsx`:

```tsx
// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { McpServersSection } from "./McpServersSection";
import { useOpencodeConfigStore } from "@/stores/opencode-config-store";
import { useTabStore } from "@/stores/tab-store";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => new Promise(() => {})) }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/stores/dialog-store", () => ({
  showConfirm: vi.fn().mockResolvedValue(true),
  showChoice: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/features/opencode-config/hooks/useOpencodeChat", () => ({
  getOpencodeClient: vi.fn(() => null),
}));

const initialState = useOpencodeConfigStore.getState();

describe("McpServersSection", () => {
  afterEach(() => {
    useTabStore.setState({ activeFolderPath: null });
    useOpencodeConfigStore.setState({
      config: initialState.config,
      projectMcpServers: initialState.projectMcpServers,
      loadConfig: initialState.loadConfig,
      loadProjectMcpServers: initialState.loadProjectMcpServers,
    });
  });

  it("keeps all MCP cards in the scrollable list and can edit the last card", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    const mcp = Object.fromEntries(
      Array.from({ length: 11 }, (_, index) => [
        `server-${index + 1}`,
        { type: "local" as const, command: ["npx", `server-${index + 1}`], enabled: false },
      ]),
    );
    useTabStore.setState({ activeFolderPath: "C:/project" });
    useOpencodeConfigStore.setState({
      config: { mcp },
      projectMcpServers: {},
      loadConfig: vi.fn().mockResolvedValue(undefined),
      loadProjectMcpServers: vi.fn().mockResolvedValue(undefined),
    });

    await act(async () => { root.render(<McpServersSection />); });

    const list = container.querySelector(".oc-mcp-servers__list");
    const actions = container.querySelector(".oc-mcp-servers__actions");
    const cards = container.querySelectorAll(".oc-section__item");
    expect(cards).toHaveLength(11);
    expect(list?.nextElementSibling).toBe(actions);
    expect(list?.contains(cards[10])).toBe(true);

    await act(async () => {
      cards[10].querySelector<HTMLButtonElement>(".oc-section__edit-btn")?.click();
    });
    expect(container.querySelector<HTMLInputElement>(".oc-section__input")?.value).toBe("server-11");
    await act(async () => root.unmount());
  });

  it("defines the MCP list scroll and actions shrink rules", async () => {
    const css = await readFile(
      resolve(process.cwd(), "src/features/opencode-config/components/OpencodeConfigDialog.css"),
      "utf8",
    );
    expect(css).toMatch(/\.oc-mcp-servers__list\s*\{[^}]*flex:\s*1;[^}]*min-height:\s*0;[^}]*overflow-y:\s*auto;/s);
    expect(css).toMatch(/\.oc-mcp-servers__actions\s*\{[^}]*flex-shrink:\s*0;/s);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/features/opencode-config/components/sections/McpServersSection.test.tsx`
Expected: both tests FAIL (`.oc-mcp-servers__list` not found; CSS rules missing).

- [ ] **Step 3: Implement**

In `McpServersSection.tsx`, inside the `: ( <> ... </> )` branch of the list view, wrap the empty-state line and the `scopedEntries.map(...)` in a list container, and give the existing button row a class. The branch becomes (card markup inside `map` is unchanged, only re-indented):

```tsx
        <>
          <div className="oc-mcp-servers__list">
            {scopedEntries.length === 0 && <div className="oc-section__empty">{t("mcpEmpty")}</div>}
            {scopedEntries.map(({ scope: itemScope, data: { name, server } }) => {
              /* ...existing card body, unchanged... */
            })}
          </div>
          <div className="oc-mcp-servers__actions" style={{ display: "flex", alignItems: "center", marginTop: 4, position: "relative" }}>
            {/* ...existing add button and built-in menu, unchanged... */}
          </div>
        </>
```

(The previous button row was `<div style={{ display: "flex", alignItems: "center", marginTop: 4, position: "relative" }}>`; only the `className` is added.)

In `OpencodeConfigDialog.css`, add before the `/* Scope color variables */` comment:

```css
.oc-mcp-servers__list {
  flex: 1;
  min-height: 0;
  overflow-x: hidden;
  overflow-y: auto;
}

.oc-mcp-servers__actions {
  flex-shrink: 0;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/features/opencode-config/components/sections/McpServersSection.test.tsx`
Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add src/features/opencode-config/components/sections/McpServersSection.tsx src/features/opencode-config/components/sections/McpServersSection.test.tsx src/features/opencode-config/components/OpencodeConfigDialog.css
git commit -m "fix(opencode-config): scroll MCP server list"
```

---

### Task 3: Global theme-aware switch stylesheet

**Files:**
- Create: `src/shared/styles/switch.css`
- Create: `src/shared/styles/switch-contract.test.ts`
- Create: `src/shared/themes/apply-theme.test.ts`
- Modify: `src/main.tsx` (add import)

**Interfaces:**
- Produces: CSS contract. Any `input[data-switch]` or `[data-switch][role="switch"]` gets track colors; `input[data-switch]::after` and `[data-switch-thumb]` get thumb colors. Feature CSS owns size, radius, thumb position, and transitions.
- Produces: `switch-contract.test.ts` exports nothing but defines two arrays that Tasks 4 and 5 extend: `targetStylesheets` and `keyboardSwitchComponents` (both start empty here).

- [ ] **Step 1: Write the failing tests**

Create `src/shared/styles/switch-contract.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const switchStylesheet = resolve(root, "src/shared/styles/switch.css");

// Feature stylesheets that style switches. Extended as features adopt data-switch.
const targetStylesheets: string[] = [];

// Components that render span-based switches. Extended as features adopt data-switch.
const keyboardSwitchComponents: string[] = [];

// Components whose every checkbox is a switch.
const checkboxSwitchComponents: string[] = [];

function cssRules(css: string): Array<[selector: string, body: string]> {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => [selector.replace(/\s+/g, " ").trim(), body]);
}

function switchRules(css: string): string[] {
  return cssRules(css)
    .filter(([selector]) => /input\[data-switch\]|__switch/.test(selector))
    .map(([selector, body]) => `${selector}{${body}}`);
}

function switchThumbBaseRules(css: string): string[] {
  return cssRules(css)
    .filter(([selector]) =>
      (/input\[data-switch\]::after/.test(selector) && !selector.includes(":checked")) ||
      (/__switch-thumb/.test(selector) && !selector.includes("__switch--on")))
    .map(([selector, body]) => `${selector}{${body}}`);
}

describe("switch CSS contract", () => {
  it("defines only theme-token colors and shared state behavior", () => {
    const css = readFileSync(switchStylesheet, "utf8");
    expect(css).toContain("background: var(--bg-surface)");
    expect(css).toContain("background: var(--primary)");
    expect(css).toContain("input[data-switch]:not(:checked)");
    expect(css).toContain("border: 1px solid var(--primary)");
    expect(css).toContain("background: var(--bg-base)");
    expect(css).toContain("border: 1px solid var(--border)");
    expect(css).toContain("opacity: 0.5");
    expect(css).not.toMatch(/var\([^)]*,/);
  });

  it("does not keep hard-coded switch colors in feature styles", () => {
    for (const relativePath of targetStylesheets) {
      const css = readFileSync(resolve(root, relativePath), "utf8");
      // Toggle containers must select switches by data-switch, not by checkbox type.
      expect(css, relativePath).not.toMatch(/__(?:toggle|scope-toggle|md-toggle-bar)\s+input\[type="checkbox"\]/);
      for (const rule of switchRules(css)) {
        expect(rule, relativePath).not.toMatch(/#(?:fff|ffffff)\b|\bwhite\b|var\([^)]*,|var\(--accent(?:-|\b)|var\(--text-muted\b/);
      }
    }
  });

  it("centers switch thumbs within their feature-owned tracks", () => {
    for (const relativePath of targetStylesheets) {
      const css = readFileSync(resolve(root, relativePath), "utf8");
      for (const rule of switchThumbBaseRules(css)) {
        expect(rule, relativePath).toContain("top: 50%");
        expect(rule, relativePath).toMatch(/margin-top:\s*-\d+px/);
      }
    }
  });

  it("marks every checkbox in switch components as a switch", () => {
    for (const relativePath of checkboxSwitchComponents) {
      const source = readFileSync(resolve(root, relativePath), "utf8");
      const checkboxes = source.match(/type="checkbox"/g)?.length ?? 0;
      const switches = source.match(/data-switch\b(?!-)/g)?.length ?? 0;
      expect(checkboxes, relativePath).toBeGreaterThan(0);
      expect(switches, relativePath).toBe(checkboxes);
    }
  });

  it("keeps span switches keyboard-operable and labelled", () => {
    for (const relativePath of keyboardSwitchComponents) {
      const source = readFileSync(resolve(root, relativePath), "utf8");
      for (const token of ["data-switch", 'role="switch"', "aria-checked", "aria-label", "tabIndex={0}", "onClick", "onKeyDown", "preventDefault()", "data-switch-thumb"]) {
        expect(source, `${relativePath} ${token}`).toContain(token);
      }
    }
  });
});
```

Create `src/shared/themes/apply-theme.test.ts`:

```ts
// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { applyTheme } from "./apply-theme";
import { themePresets } from "./index";

const switchVariables = {
  primary: "--primary",
  bgBase: "--bg-base",
  bgSurface: "--bg-surface",
  border: "--border",
} as const;

describe("applyTheme switch variables", () => {
  afterEach(() => {
    document.documentElement.removeAttribute("data-theme-type");
    document.documentElement.removeAttribute("data-theme-id");
    document.documentElement.style.cssText = "";
  });

  it("publishes the switch variables for every registered preset", () => {
    for (const theme of themePresets) {
      applyTheme(theme);
      for (const [key, variable] of Object.entries(switchVariables)) {
        const value = theme.colors[key as keyof typeof theme.colors];
        expect(value, `${theme.id}.${key}`).toBeTruthy();
        expect(document.documentElement.style.getPropertyValue(variable), `${theme.id} ${variable}`).toBe(value);
      }
    }
  });
});
```

- [ ] **Step 2: Run the tests to verify the contract test fails**

Run: `npx vitest run src/shared/styles/switch-contract.test.ts src/shared/themes/apply-theme.test.ts`
Expected: "defines only theme-token colors" FAILS with ENOENT for `switch.css`. `apply-theme.test.ts` should already PASS (it documents an existing guarantee); if it fails, stop and report — do not change presets.

- [ ] **Step 3: Implement**

Create `src/shared/styles/switch.css`:

```css
/* Theme-aware switch contract. Feature styles own geometry and motion. */
[data-switch] {
  box-sizing: border-box;
}

input[data-switch],
[data-switch][role="switch"] {
  background: var(--bg-surface);
  border: 1px solid var(--border);
}

input[data-switch]:checked,
[data-switch][role="switch"][aria-checked="true"] {
  background: var(--primary);
  border-color: var(--primary);
}

input[data-switch]:not(:checked),
[data-switch][role="switch"][aria-checked="false"] {
  border: 1px solid var(--primary);
}

input[data-switch]::after,
[data-switch-thumb] {
  box-sizing: border-box;
  background: var(--bg-base);
  border: 1px solid var(--border);
}

input[data-switch]:focus-visible,
[data-switch][role="switch"]:focus-visible {
  outline: 2px solid var(--primary);
  outline-offset: 2px;
}

input[data-switch]:disabled {
  cursor: not-allowed;
  border-color: var(--primary);
  opacity: 0.5;
}
```

In `src/main.tsx`, add after `import "./shared/i18n";`:

```ts
import "./shared/styles/switch.css";
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/shared/styles/switch-contract.test.ts src/shared/themes/apply-theme.test.ts`
Expected: all passed (loops over empty lists pass trivially; Tasks 4 and 5 fill them).

- [ ] **Step 5: Commit**

```bash
git add src/shared/styles/switch.css src/shared/styles/switch-contract.test.ts src/shared/themes/apply-theme.test.ts src/main.tsx
git commit -m "feat(theme): add theme-aware switch stylesheet"
```

---

### Task 4: Checkbox switches adopt `data-switch`

**Files:**
- Modify: `src/features/settings/components/SettingsDialog.tsx` (9 checkboxes), `SettingsDialog.css:111-145`
- Modify: `src/features/opencode-config/components/OpencodeConfigDialog.css` (`.oc-section__toggle` block ~282-316, `.oc-section__scope-toggle` block ~400-434)
- Modify: `src/features/opencode-config/components/sections/{AgentsSection,McpServersSection,PluginsSection,SkillsSection,ToolsSection,WebUiSection}.tsx`, `src/features/opencode-config/components/shared/ScopeToggle.tsx`
- Modify: `src/features/claude-config/components/PluginsTab.tsx`, `PluginsTab.css:89-123`
- Modify: `src/features/opencode-config/components/OpencodeChat.tsx` (MD context toggle, ~line 636), `OpencodeChat.css:126-190`
- Modify: `src/shared/styles/switch-contract.test.ts` (fill lists)

**Interfaces:**
- Consumes: `switch.css` from Task 3.
- Produces: `.oc-chat__md-toggle-bar` now contains `input[data-switch]` directly (the `.oc-chat__md-toggle-slider` span is removed). Task 6 wraps this label in `.oc-chat__md-toggle-row`.

- [ ] **Step 1: Extend the contract test (failing)**

In `switch-contract.test.ts`, replace the `targetStylesheets` and `checkboxSwitchComponents` declarations with:

```ts
const targetStylesheets: string[] = [
  "src/features/settings/components/SettingsDialog.css",
  "src/features/opencode-config/components/OpencodeConfigDialog.css",
  "src/features/opencode-config/components/OpencodeChat.css",
  "src/features/claude-config/components/PluginsTab.css",
];
```

```ts
const checkboxSwitchComponents: string[] = [
  "src/features/settings/components/SettingsDialog.tsx",
  "src/features/opencode-config/components/OpencodeChat.tsx",
  "src/features/opencode-config/components/sections/AgentsSection.tsx",
  "src/features/opencode-config/components/sections/McpServersSection.tsx",
  "src/features/opencode-config/components/sections/PluginsSection.tsx",
  "src/features/opencode-config/components/sections/SkillsSection.tsx",
  "src/features/opencode-config/components/sections/ToolsSection.tsx",
  "src/features/opencode-config/components/sections/WebUiSection.tsx",
  "src/features/opencode-config/components/shared/ScopeToggle.tsx",
  "src/features/claude-config/components/PluginsTab.tsx",
];
```

Run: `npx vitest run src/shared/styles/switch-contract.test.ts`
Expected: FAIL — stylesheets still contain `input[type="checkbox"]` / `white`, and components have 0 `data-switch`.

- [ ] **Step 2: Mark every checkbox**

In each of the 10 components listed above, add `data-switch` and `role="switch"` right after `type="checkbox"` on every checkbox input. Example (SettingsDialog, `autoSave`):

```tsx
                  <input
                    type="checkbox"
                    data-switch
                    role="switch"
                    checked={localAutoSave}
                    onChange={(e) => setLocalAutoSave(e.target.checked)}
                  />
```

Inline form (AgentsSection):

```tsx
<input type="checkbox" data-switch role="switch" checked={formHidden} onChange={(e) => setFormHidden(e.target.checked)} />
```

Counts to reach: SettingsDialog 9, AgentsSection 2, McpServersSection 2, every other file 1.

For `OpencodeChat.tsx`, replace the MD context `<label>` with (the slider span is removed; the input is the switch):

```tsx
          <label
            className={`oc-chat__md-toggle-bar${canUseMdContext ? "" : " oc-chat__md-toggle-bar--disabled"}`}
            title={t("ocChatMdContext")}
          >
            <input
              type="checkbox"
              data-switch
              role="switch"
              checked={mdContextActive}
              disabled={!canUseMdContext}
              onChange={(e) => setUseMdContext(e.target.checked)}
            />
            <span className="oc-chat__md-toggle-label">
              {t("ocChatMdToggleLabel", { name: canUseMdContext ? (activeTabName ?? "MD") : "MD" })}
            </span>
          </label>
```

- [ ] **Step 3: Replace the feature CSS switch blocks**

`SettingsDialog.css` — replace the three `.settings-dialog__toggle input[type="checkbox"]…` rules and the `:checked` background rule with:

```css
.settings-dialog__toggle input[data-switch] {
  appearance: none;
  -webkit-appearance: none;
  width: 36px;
  height: 20px;
  border-radius: 10px;
  position: relative;
  cursor: pointer;
  transition: background 0.2s;
  flex-shrink: 0;
}

.settings-dialog__toggle input[data-switch]::after {
  content: "";
  position: absolute;
  top: 50%;
  margin-top: -8px;
  left: 2px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  transition: transform 0.2s;
}

.settings-dialog__toggle input[data-switch]:checked::after {
  transform: translateX(16px);
}
```

Apply the identical pattern (same declarations, only the selector prefix differs) in:
- `PluginsTab.css` with prefix `.plugins-tab__toggle input[data-switch]`
- `OpencodeConfigDialog.css` with prefix `.oc-section__toggle input[data-switch]`
- `OpencodeConfigDialog.css` with prefix `.oc-section__scope-toggle input[data-switch]` (this block has no `position: relative` on the input in the current file; keep whatever non-color declarations exist and drop `background`, `background: white`, and the `:checked { background: … }` rule)

In each case delete: the base `background: var(--text-muted);`, the thumb `background: white;`, and the whole `…:checked { background: … }` rule; change thumb `top: 2px;` to `top: 50%; margin-top: -8px;`.

`OpencodeChat.css` — replace everything from the `.oc-chat__md-toggle-bar input { display: none; }` rule through the `.oc-chat__md-toggle-bar--disabled` rule with:

```css
.oc-chat__md-toggle-bar input[data-switch] {
  appearance: none;
  -webkit-appearance: none;
  position: relative;
  width: 26px;
  height: 14px;
  border-radius: 7px;
  cursor: pointer;
  transition: background 0.2s;
  flex-shrink: 0;
}

.oc-chat__md-toggle-bar input[data-switch]::after {
  content: "";
  position: absolute;
  top: 50%;
  margin-top: -5px;
  left: 1px;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  transition: transform 0.2s, background 0.2s;
}

.oc-chat__md-toggle-bar input[data-switch]:checked::after {
  transform: translateX(12px);
}

.oc-chat__md-toggle-bar .oc-chat__md-toggle-label {
  font-size: 11px;
  color: var(--text-muted);
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.oc-chat__md-toggle-bar--disabled {
  cursor: not-allowed;
}
```

(The `.oc-chat__md-toggle-bar { display:flex; … }` base rule above it stays unchanged. The `input:checked ~ .oc-chat__md-toggle-label` green-label rule is deleted; the disabled opacity now comes from `switch.css`.)

- [ ] **Step 4: Run tests and type check**

Run: `npx vitest run src/shared/styles/switch-contract.test.ts src/features/opencode-config`
Expected: all passed.
Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/shared/styles/switch-contract.test.ts src/features/settings src/features/opencode-config src/features/claude-config
git commit -m "feat(theme): use shared switch styling for checkbox toggles"
```

---

### Task 5: Span switches adopt `data-switch` with i18n labels

**Files:**
- Modify: `src/features/preview/components/PreviewPanel.tsx:~1311` and `PreviewPanel.css:~742-778`
- Modify: `src/features/video/components/SceneEditForm.tsx:~214` (image switch) and `~288` (captions switch)
- Modify: `src/features/video/components/VideoSettingsBar.tsx:~221`
- Modify: `src/features/video/components/VideoPanel.css:~415-446`
- Modify: `src/shared/i18n/locales/en/video.json`, `src/shared/i18n/locales/ja/video.json`
- Modify: `src/shared/styles/switch-contract.test.ts`
- Create: `src/features/preview/components/PreviewPanel.test.tsx`, `src/features/video/components/Switches.test.tsx`

**Interfaces:**
- Consumes: `switch.css` (Task 3), existing i18n keys `editor:allowLlmVbaImport`, `video:captions`.
- Produces: new i18n key `video:showImage` = `"Show {{name}}"` / `"{{name}} を表示"`.

- [ ] **Step 1: Write the failing tests**

In `switch-contract.test.ts`, add to `targetStylesheets`:

```ts
  "src/features/video/components/VideoPanel.css",
  "src/features/preview/components/PreviewPanel.css",
```

and set:

```ts
const keyboardSwitchComponents: string[] = [
  "src/features/video/components/SceneEditForm.tsx",
  "src/features/video/components/VideoSettingsBar.tsx",
  "src/features/preview/components/PreviewPanel.tsx",
];
```

Create `src/features/preview/components/PreviewPanel.test.tsx`:

```tsx
// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PreviewPanel } from "./PreviewPanel";
import { useSettingsStore } from "@/stores/settings-store";
import { useTabStore, type Tab } from "@/stores/tab-store";
import { useUiStore } from "@/stores/ui-store";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(false) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn(), open: vi.fn() }));
vi.mock("@tauri-apps/plugin-fs", () => ({ readFile: vi.fn(), exists: vi.fn().mockResolvedValue(false) }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));
vi.mock("./OfficePreview", () => ({ OfficePreview: () => null }));

const tab: Tab = {
  id: "xlsm-tab",
  filePath: "C:/project/book.xlsm",
  folderPath: "C:/project",
  fileName: "book.xlsm",
  content: "",
  dirty: false,
  undoStack: [],
  redoStack: [],
  binaryData: new Uint8Array([1]),
  officeFileType: ".xlsm",
};

describe("PreviewPanel VBA import switch", () => {
  beforeEach(() => {
    useTabStore.setState({ tabs: [tab], activeTabId: tab.id, activeFolderPath: tab.folderPath });
    useUiStore.setState({ activeViewTab: "preview" });
    useSettingsStore.setState({ allowLlmVbaImport: false });
  });

  afterEach(() => {
    useTabStore.setState({ tabs: [], activeTabId: null, activeFolderPath: null });
    useSettingsStore.setState({ allowLlmVbaImport: false });
  });

  it("toggles once per click, Enter, and Space", async () => {
    const original = useSettingsStore.getState().setAllowLlmVbaImport;
    const setAllowLlmVbaImport = vi.fn(original);
    useSettingsStore.setState({ setAllowLlmVbaImport });
    const container = document.createElement("div");
    const root = createRoot(container);

    await act(async () => root.render(<PreviewPanel previewRef={{ current: null }} />));
    const getSwitch = () => container.querySelector<HTMLElement>('[role="switch"]')!;
    const expectState = (enabled: boolean) => {
      expect(getSwitch().getAttribute("aria-checked")).toBe(String(enabled));
      expect(getSwitch().classList.contains("preview-panel__switch--on")).toBe(enabled);
    };

    expect(getSwitch().hasAttribute("data-switch")).toBe(true);
    expect(getSwitch().getAttribute("aria-label")).toBeTruthy();
    expect(getSwitch().querySelector("[data-switch-thumb]")).not.toBeNull();
    expectState(false);

    await act(async () => getSwitch().click());
    expect(setAllowLlmVbaImport).toHaveBeenCalledTimes(1);
    expectState(true);

    await act(async () => getSwitch().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(setAllowLlmVbaImport).toHaveBeenCalledTimes(2);
    expectState(false);

    await act(async () => getSwitch().dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true })));
    expect(setAllowLlmVbaImport).toHaveBeenCalledTimes(3);
    expectState(true);

    await act(async () => root.unmount());
  });
});
```

Create `src/features/video/components/Switches.test.tsx`:

```tsx
// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/shared/i18n";
import type { Scene, VideoProject } from "@/features/video/types";
import { useVideoStore } from "@/stores/video-store";
import { SceneEditForm } from "./SceneEditForm";
import { VideoSettingsBar } from "./VideoSettingsBar";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("./SceneContentEditor", () => ({ SceneContentEditor: () => null }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(false) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@tauri-apps/plugin-fs", () => ({ readFile: vi.fn() }));

const baseProject: VideoProject = {
  meta: { title: "Switches", width: 1920, height: 1080, fps: 30, aspectRatio: "16:9" },
  audio: { tts: { provider: "voicevox", volume: 1, speed: 1 } },
  scenes: [],
};

function makeScene(id = "scene-1"): Scene {
  return {
    id,
    narration: "Narration",
    transition: { type: "fade", durationInFrames: 30 },
    elements: [{ type: "image", src: "data:image/png;base64,AA==", position: "center", animation: "none", enabled: true }],
    captions: { enabled: false },
  };
}

const originalActions = {
  updateImageElement: useVideoStore.getState().updateImageElement,
  updateScene: useVideoStore.getState().updateScene,
  setAllCaptions: useVideoStore.getState().setAllCaptions,
};

function resetVideoStore() {
  useVideoStore.setState({ videoProject: null, ...originalActions });
}

const switches = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLElement>('[data-switch][role="switch"]')];
const press = (element: HTMLElement, key: string) =>
  element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));

describe("video span switches", () => {
  beforeEach(resetVideoStore);
  afterEach(resetVideoStore);

  it("toggles the image switch once per Enter and Space and labels it", async () => {
    const scene = makeScene();
    useVideoStore.setState({ videoProject: { ...baseProject, scenes: [scene] } });
    const updateImageElement = vi.fn(originalActions.updateImageElement);
    useVideoStore.setState({ updateImageElement });
    const container = document.createElement("div");
    const root = createRoot(container);
    const render = (s: Scene) => root.render(<SceneEditForm scene={s} onRegenerateAudio={vi.fn().mockResolvedValue(undefined)} audioGenerating={false} />);

    await act(async () => render(scene));
    expect(switches(container)[0].getAttribute("aria-checked")).toBe("true");
    expect(switches(container)[0].getAttribute("aria-label")).toBeTruthy();

    await act(async () => press(switches(container)[0], "Enter"));
    expect(updateImageElement).toHaveBeenCalledTimes(1);
    await act(async () => render(useVideoStore.getState().videoProject!.scenes[0]));
    expect(switches(container)[0].getAttribute("aria-checked")).toBe("false");

    await act(async () => press(switches(container)[0], " "));
    expect(updateImageElement).toHaveBeenCalledTimes(2);
    await act(async () => render(useVideoStore.getState().videoProject!.scenes[0]));
    expect(switches(container)[0].getAttribute("aria-checked")).toBe("true");

    await act(async () => root.unmount());
  });

  it("keeps the captions switch aria state and visual state in sync", async () => {
    const scene = makeScene();
    useVideoStore.setState({ videoProject: { ...baseProject, scenes: [scene] } });
    const updateScene = vi.fn(originalActions.updateScene);
    useVideoStore.setState({ updateScene });
    const container = document.createElement("div");
    const root = createRoot(container);
    const render = (s: Scene) => root.render(<SceneEditForm scene={s} onRegenerateAudio={vi.fn().mockResolvedValue(undefined)} audioGenerating={false} />);
    const captionsLabel = i18n.t("captions", { ns: "video" });
    const captions = () => switches(container).find((el) => el.getAttribute("aria-label") === captionsLabel)!;

    await act(async () => render(scene));
    expect(captions().getAttribute("aria-checked")).toBe("false");

    await act(async () => press(captions(), " "));
    expect(updateScene).toHaveBeenCalledTimes(1);
    await act(async () => render(useVideoStore.getState().videoProject!.scenes[0]));
    expect(captions().getAttribute("aria-checked")).toBe("true");
    expect(captions().className).toContain("--on");

    await act(async () => press(captions(), "Enter"));
    expect(updateScene).toHaveBeenCalledTimes(2);
    await act(async () => root.unmount());
  });

  it("updates all captions once for Enter and Space", async () => {
    useVideoStore.setState({ videoProject: { ...baseProject, scenes: [makeScene(), makeScene("scene-2")] } });
    const setAllCaptions = vi.fn(originalActions.setAllCaptions);
    useVideoStore.setState({ setAllCaptions });
    const container = document.createElement("div");
    const root = createRoot(container);

    await act(async () => root.render(
      <VideoSettingsBar onGenerateAudio={vi.fn()} generating={false} generatingStatus="" onDecorateWithLLM={vi.fn()} decorating={false} />,
    ));
    expect(switches(container)[0].getAttribute("aria-checked")).toBe("false");
    await act(async () => press(switches(container)[0], "Enter"));
    expect(setAllCaptions).toHaveBeenCalledTimes(1);
    expect(useVideoStore.getState().videoProject?.scenes.every((s) => s.captions?.enabled)).toBe(true);
    expect(switches(container)[0].className).toContain("--on");

    await act(async () => press(switches(container)[0], " "));
    expect(setAllCaptions).toHaveBeenCalledTimes(2);
    expect(useVideoStore.getState().videoProject?.scenes.every((s) => !s.captions?.enabled)).toBe(true);
    await act(async () => root.unmount());
  });
});
```

Run: `npx vitest run src/shared/styles/switch-contract.test.ts src/features/preview/components/PreviewPanel.test.tsx src/features/video/components/Switches.test.tsx`
Expected: FAIL (no `data-switch` / `aria-label` on span switches; hard-coded colors in `VideoPanel.css` and `PreviewPanel.css`). If `PreviewPanel.test.tsx` fails for a missing mock rather than the assertion, add a `vi.mock` for the reported module and re-run before moving on.

- [ ] **Step 2: Add the i18n key**

`src/shared/i18n/locales/en/video.json` — add after `"captions"`:

```json
  "showImage": "Show {{name}}",
```

`src/shared/i18n/locales/ja/video.json` — add after `"captions"`:

```json
  "showImage": "{{name}} を表示",
```

- [ ] **Step 3: Mark the span switches**

`PreviewPanel.tsx` (VBA import switch):

```tsx
                <span
                  className={`preview-panel__switch${allowLlmVbaImport ? " preview-panel__switch--on" : ""}`}
                  data-switch
                  role="switch"
                  aria-label={t("allowLlmVbaImport")}
                  aria-checked={allowLlmVbaImport}
                  tabIndex={0}
```

and its thumb: `<span className="preview-panel__switch-thumb" data-switch-thumb />`.

`SceneEditForm.tsx` image switch:

```tsx
                    <span
                      className={`scene-edit-form__switch${enabled ? " scene-edit-form__switch--on" : ""}`}
                      data-switch
                      role="switch"
                      aria-label={t("showImage", { name: fileName })}
                      aria-checked={enabled}
                      tabIndex={0}
```

`SceneEditForm.tsx` captions switch and `VideoSettingsBar.tsx` captions switch: add `data-switch` before `role="switch"` and `aria-label={t("captions")}` after it. In all three video switches, change the thumb to `<span className="scene-edit-form__switch-thumb" data-switch-thumb />`.

- [ ] **Step 4: Remove hard-coded colors from the span switch CSS**

`PreviewPanel.css` — the switch rules become (the `.preview-panel__switch:focus-visible` and `.preview-panel__switch--on` rules are deleted; focus ring and on-color now come from `switch.css`):

```css
.preview-panel__switch {
  position: relative;
  display: inline-block;
  width: 28px;
  height: 16px;
  border-radius: 8px;
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s;
  flex-shrink: 0;
}

.preview-panel__switch-thumb {
  position: absolute;
  top: 50%;
  margin-top: -5px;
  left: 2px;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  transition: transform 0.15s, background 0.15s;
}

.preview-panel__switch--on .preview-panel__switch-thumb {
  transform: translateX(12px);
}
```

`VideoPanel.css` — the switch rules become (the `.scene-edit-form__switch--on` rule is deleted):

```css
.scene-edit-form__switch {
  position: relative;
  display: inline-block;
  width: 28px;
  height: 16px;
  border-radius: 8px;
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s;
}

.scene-edit-form__switch-thumb {
  position: absolute;
  top: 50%;
  margin-top: -5px;
  left: 2px;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  transition: transform 0.15s, background 0.15s;
}

.scene-edit-form__switch--on .scene-edit-form__switch-thumb {
  transform: translateX(12px);
}
```

- [ ] **Step 5: Run tests and type check**

Run: `npx vitest run src/shared/styles/switch-contract.test.ts src/features/preview/components/PreviewPanel.test.tsx src/features/video/components/Switches.test.tsx`
Expected: all passed.
Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/shared/styles/switch-contract.test.ts src/features/preview src/features/video src/shared/i18n/locales/en/video.json src/shared/i18n/locales/ja/video.json
git commit -m "feat(theme): use shared switch styling for span switches"
```

---

### Task 6: Cost-only opencode usage display above the input

**Files:**
- Modify: `src/features/opencode-config/components/OpencodeUsagePopover.tsx` (effect ~line 65, label ~line 83, button ~line 102)
- Modify: `src/features/opencode-config/components/OpencodeChat.tsx` (remove from toolbar ~line 447; add to the MD toggle row ~line 636)
- Modify: `src/features/opencode-config/components/OpencodeChat.css` (usage rules ~1228-1262; add row rules near the MD toggle rules)
- Create: `src/features/opencode-config/components/OpencodeUsagePopover.test.tsx`

**Interfaces:**
- Consumes: `.oc-chat__md-toggle-bar` label from Task 4.
- Produces: `OpencodeUsagePopover` renders `null` unless the current session's `cost > 0`; otherwise a borderless `button.oc-chat__usage-btn` whose text is `formatUsageCost(cost)`, with `aria-expanded`.

- [ ] **Step 1: Write the failing test**

Create `src/features/opencode-config/components/OpencodeUsagePopover.test.tsx`:

```tsx
// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@/shared/i18n";
import { useChatUIStore } from "../hooks/useOpencodeChat";
import { useOpencodeUsageStore } from "@/stores/opencode-usage-store";
import { emptyTotals, type UsageTotals } from "@/stores/opencode-usage-core";
import { OpencodeUsagePopover } from "./OpencodeUsagePopover";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SESSION_ID = "session-1";

function setUsage(sessionId: string | null, totals = emptyTotals()) {
  useChatUIStore.setState({ currentSessionId: sessionId });
  useOpencodeUsageStore.setState({ days: {}, sessions: sessionId ? { [sessionId]: totals } : {}, messageContrib: {} });
}

describe("OpencodeUsagePopover", () => {
  let root: ReturnType<typeof createRoot> | undefined;
  let container: HTMLDivElement;

  beforeEach(() => {
    localStorage.removeItem("mdium-opencode-usage");
    setUsage(null);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root?.unmount());
    root = undefined;
    container.remove();
    setUsage(null);
    localStorage.removeItem("mdium-opencode-usage");
  });

  const render = () => act(async () => root?.render(<OpencodeUsagePopover />));

  it.each([
    ["no current session", null, emptyTotals()],
    ["zero cost", SESSION_ID, emptyTotals()],
    ["negative cost", SESSION_ID, { ...emptyTotals(), cost: -0.01 }],
    ["non-finite cost", SESSION_ID, { ...emptyTotals(), cost: Number.NaN }],
    ["tokens but zero cost", SESSION_ID, { ...emptyTotals(), input: 120, output: 45 }],
  ])("renders nothing for %s", async (_name, sessionId, totals) => {
    setUsage(sessionId, totals as UsageTotals);
    await render();
    expect(container.querySelector(".oc-chat__usage")).toBeNull();
    expect(container.textContent).toBe("");
  });

  it("shows only the formatted amount and opens the details popover", async () => {
    setUsage(SESSION_ID, { ...emptyTotals(), cost: 0.014, input: 120 });
    await render();

    const button = container.querySelector<HTMLButtonElement>(".oc-chat__usage-btn")!;
    expect(button.textContent).toBe("$0.014");
    expect(button.querySelector("svg")).toBeNull();
    expect(button.classList.contains("oc-chat__toolbar-btn")).toBe(false);
    expect(button.type).toBe("button");
    expect(button.getAttribute("aria-expanded")).toBe("false");

    await act(async () => button.click());
    expect(container.querySelector(".oc-chat__usage-popover")?.textContent).toContain("120");
    expect(button.getAttribute("aria-expanded")).toBe("true");

    await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
    expect(container.querySelector(".oc-chat__usage-popover")).toBeNull();
  });

  it("closes and stays closed when the cost becomes non-positive", async () => {
    setUsage(SESSION_ID, { ...emptyTotals(), cost: 0.014 });
    await render();
    await act(async () => container.querySelector<HTMLButtonElement>(".oc-chat__usage-btn")?.click());
    expect(container.querySelector(".oc-chat__usage-popover")).not.toBeNull();

    await act(async () => { useOpencodeUsageStore.setState({ sessions: { [SESSION_ID]: { ...emptyTotals(), output: 200 } } }); });
    expect(container.querySelector(".oc-chat__usage")).toBeNull();

    await act(async () => { useOpencodeUsageStore.setState({ sessions: { [SESSION_ID]: { ...emptyTotals(), cost: 0.014 } } }); });
    expect(container.querySelector(".oc-chat__usage-popover")).toBeNull();
    expect(container.querySelector(".oc-chat__usage-btn")?.getAttribute("aria-expanded")).toBe("false");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/features/opencode-config/components/OpencodeUsagePopover.test.tsx`
Expected: FAIL (icon/token label rendered for zero cost; button has `oc-chat__toolbar-btn`; no `aria-expanded`).

- [ ] **Step 3: Implement the popover**

In `OpencodeUsagePopover.tsx`, after the `sessionTotals` declaration add:

```ts
  const hasPositiveCost = sessionTotals.cost > 0;
```

Change the outside-click/Escape effect to close and detach when the cost is not positive:

```ts
  useEffect(() => {
    if (!hasPositiveCost) {
      if (open) setOpen(false);
      return;
    }
    if (!open) return;
    /* ...existing onMouseDown / onKeyDown listeners and cleanup, unchanged... */
  }, [hasPositiveCost, open]);
```

Replace the `// Compact toolbar label…` comment and the `const label = …` expression with:

```ts
  if (!hasPositiveCost) return null;
```

Replace the button with:

```tsx
      <button
        type="button"
        className="oc-chat__usage-btn"
        onClick={() => setOpen((v) => !v)}
        title={t("ocUsageTitle")}
        aria-expanded={open}
      >
        {formatUsageCost(sessionTotals.cost)}
      </button>
```

(`tokenSum` and `formatTokenCount` are still used by `ModelBreakdown` / `TotalsRows`; keep the imports.)

- [ ] **Step 4: Move the control above the input**

In `OpencodeChat.tsx`, delete `<OpencodeUsagePopover />` from the toolbar (between the connection status `<span>` and the new-session button). Wrap the MD context label (from Task 4) in a row that also holds the popover:

```tsx
          {/* MD context toggle and session usage */}
          <div className="oc-chat__md-toggle-row">
            <label
              className={`oc-chat__md-toggle-bar${canUseMdContext ? "" : " oc-chat__md-toggle-bar--disabled"}`}
              title={t("ocChatMdContext")}
            >
              {/* ...input and label span from Task 4, unchanged... */}
            </label>
            <OpencodeUsagePopover />
          </div>
```

In `OpencodeChat.css`, change the `/* MD context toggle bar (above input area) */` comment line to the block below (keep the existing `.oc-chat__md-toggle-bar { … }` rule right after it):

```css
/* MD context toggle and session usage row (above input area) */
.oc-chat__md-toggle-row {
  display: flex;
  align-items: center;
  flex-shrink: 0;
}

.oc-chat__md-toggle-row .oc-chat__md-toggle-bar {
  flex: 1;
  min-width: 0;
}

.oc-chat__md-toggle-row .oc-chat__usage {
  margin-right: 10px;
}
```

Replace the `.oc-chat__usage-btn` and `.oc-chat__usage-label` rules with:

```css
.oc-chat__usage-btn {
  display: inline-flex;
  align-items: center;
  padding: 0;
  border: none;
  border-radius: 0;
  background: transparent;
  color: var(--text-secondary);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}

.oc-chat__usage-btn:hover {
  color: var(--text-primary);
}

.oc-chat__usage-btn:focus-visible {
  outline: 2px solid var(--accent-blue);
  outline-offset: 2px;
}
```

and add after the `.oc-chat__usage-popover { … }` rule (the popover opens upward because the row sits above the input):

```css
.oc-chat__md-toggle-row .oc-chat__usage-popover {
  top: auto;
  right: 0;
  bottom: calc(100% + 4px);
  left: auto;
}
```

- [ ] **Step 5: Run tests and type check**

Run: `npx vitest run src/features/opencode-config src/shared/styles/switch-contract.test.ts`
Expected: all passed.
Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/features/opencode-config
git commit -m "feat(opencode): show session cost above the chat input"
```

---

### Task 7: Terminal session model

**Files:**
- Create: `src/features/terminal/terminal-session.ts`
- Create: `src/features/terminal/__tests__/terminal-session.test.ts`
- Modify: `src/stores/ui-store.ts` (imports, `BottomTerminalTab` type, state fields, actions)
- Create: `src/stores/__tests__/ui-store-terminal-sessions.test.ts`

**Interfaces:**
- Produces (`terminal-session.ts`):
  - `TERMINAL_KINDS: readonly ["claude-code", "codex", "github-copilot", "opencode", "terminal"]`
  - `type TerminalKind`
  - `interface TerminalSession { id: string; kind: TerminalKind; folderPath: string }`
  - `getTerminalCommand(kind: TerminalKind): string | undefined`
  - `getTerminalThemeType(kind: TerminalKind, appThemeType: "light" | "dark"): "light" | "dark"`
- Produces (`ui-store`): state `terminalSessions: TerminalSession[]`, `activeTerminalSessionId: string | null`, `activeTerminalSessionIdsByFolder: Record<string, string>`; actions `initializeTerminalSessions(folderPath: string): void`, `addTerminalSession(kind: TerminalKind, folderPath: string): void`, `setActiveTerminalSession(id: string): void`, `removeTerminalSession(id: string): void`, `pruneTerminalSessions(openFolderPaths: string[]): string[]` (removes sessions whose non-empty `folderPath` is not open; returns removed ids).
- Removes: `bottomTerminalTab`, `bottomTerminalOpenTabs`, `setBottomTerminalTab`, `openBottomTerminalTab`, `closeBottomTerminalTab` (only `App.tsx` uses them; Task 8 updates it — `tsc` will fail between Task 7 and Task 8, which is expected).

- [ ] **Step 1: Write the failing tests**

Create `src/features/terminal/__tests__/terminal-session.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { TERMINAL_KINDS, getTerminalCommand, getTerminalThemeType } from "../terminal-session";

describe("terminal session definitions", () => {
  it("lists every supported kind in dropdown order", () => {
    expect(TERMINAL_KINDS).toEqual(["claude-code", "codex", "github-copilot", "opencode", "terminal"]);
  });

  it("maps CLI kinds to their launch command", () => {
    expect(getTerminalCommand("claude-code")).toBe("claude");
    expect(getTerminalCommand("codex")).toBe("codex");
    expect(getTerminalCommand("github-copilot")).toBe("copilot");
    expect(getTerminalCommand("opencode")).toBe("opencode");
    expect(getTerminalCommand("terminal")).toBeUndefined();
  });

  it("uses a dark palette for Codex regardless of the app theme", () => {
    expect(getTerminalThemeType("codex", "light")).toBe("dark");
    expect(getTerminalThemeType("codex", "dark")).toBe("dark");
    expect(getTerminalThemeType("terminal", "light")).toBe("light");
    expect(getTerminalThemeType("opencode", "dark")).toBe("dark");
  });
});
```

Create `src/stores/__tests__/ui-store-terminal-sessions.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { useUiStore } from "../ui-store";

describe("terminal sessions in ui store", () => {
  beforeEach(() => {
    useUiStore.setState({
      bottomTerminalVisible: false,
      terminalSessions: [],
      activeTerminalSessionId: null,
      activeTerminalSessionIdsByFolder: {},
    });
  });

  it("initializes one standard terminal per folder and restores it on revisit", () => {
    const store = useUiStore.getState();
    store.initializeTerminalSessions("C:/workspace");
    store.initializeTerminalSessions("C:/other");

    const { terminalSessions, activeTerminalSessionId } = useUiStore.getState();
    expect(terminalSessions).toHaveLength(2);
    expect(terminalSessions[0]).toMatchObject({ kind: "terminal", folderPath: "C:/workspace" });
    expect(terminalSessions[1]).toMatchObject({ kind: "terminal", folderPath: "C:/other" });
    expect(activeTerminalSessionId).toBe(terminalSessions[1].id);

    store.initializeTerminalSessions("C:/workspace");
    expect(useUiStore.getState().activeTerminalSessionId).toBe(terminalSessions[0].id);
    expect(useUiStore.getState().terminalSessions).toHaveLength(2);
  });

  it("appends duplicate kinds as separate sessions and shows the view", () => {
    const store = useUiStore.getState();
    store.addTerminalSession("codex", "C:/first");
    store.addTerminalSession("codex", "C:/second");

    const { terminalSessions, activeTerminalSessionId, bottomTerminalVisible } = useUiStore.getState();
    expect(terminalSessions.map((s) => s.kind)).toEqual(["codex", "codex"]);
    expect(new Set(terminalSessions.map((s) => s.id)).size).toBe(2);
    expect(activeTerminalSessionId).toBe(terminalSessions[1].id);
    expect(bottomTerminalVisible).toBe(true);
  });

  it("selects the right neighbor, then the left neighbor, when the active session closes", () => {
    const store = useUiStore.getState();
    store.addTerminalSession("claude-code", "C:/workspace");
    store.addTerminalSession("codex", "C:/workspace");
    store.addTerminalSession("opencode", "C:/workspace");
    const sessions = useUiStore.getState().terminalSessions;

    store.setActiveTerminalSession(sessions[1].id);
    store.removeTerminalSession(sessions[1].id);
    expect(useUiStore.getState().terminalSessions.map((s) => s.kind)).toEqual(["claude-code", "opencode"]);
    expect(useUiStore.getState().activeTerminalSessionId).toBe(sessions[2].id);

    store.removeTerminalSession(sessions[2].id);
    expect(useUiStore.getState().activeTerminalSessionId).toBe(sessions[0].id);

    store.removeTerminalSession(sessions[0].id);
    expect(useUiStore.getState().activeTerminalSessionId).toBeNull();
  });

  it("keeps each folder's selected terminal when switching folders", () => {
    const store = useUiStore.getState();
    store.addTerminalSession("terminal", "C:/first");
    store.addTerminalSession("codex", "C:/first");
    store.addTerminalSession("terminal", "C:/second");
    const sessions = useUiStore.getState().terminalSessions;

    store.setActiveTerminalSession(sessions[0].id);
    store.initializeTerminalSessions("C:/second");
    store.initializeTerminalSessions("C:/first");
    expect(useUiStore.getState().activeTerminalSessionId).toBe(sessions[0].id);
  });

  it("prunes sessions of closed folders and returns their ids", () => {
    const store = useUiStore.getState();
    store.addTerminalSession("terminal", "C:/kept");
    store.addTerminalSession("codex", "C:/closed");
    store.addTerminalSession("terminal", "");
    const [kept, closed, noFolder] = useUiStore.getState().terminalSessions;

    const removed = store.pruneTerminalSessions(["C:/kept"]);

    expect(removed).toEqual([closed.id]);
    expect(useUiStore.getState().terminalSessions.map((s) => s.id)).toEqual([kept.id, noFolder.id]);
    expect(useUiStore.getState().activeTerminalSessionIdsByFolder["C:/closed"]).toBeUndefined();
    expect(store.pruneTerminalSessions(["C:/kept"])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/features/terminal/__tests__/terminal-session.test.ts src/stores/__tests__/ui-store-terminal-sessions.test.ts`
Expected: FAIL (module `../terminal-session` not found; store actions undefined).

- [ ] **Step 3: Implement `terminal-session.ts`**

Create `src/features/terminal/terminal-session.ts`:

```ts
export const TERMINAL_KINDS = [
  "claude-code",
  "codex",
  "github-copilot",
  "opencode",
  "terminal",
] as const;

export type TerminalKind = (typeof TERMINAL_KINDS)[number];

export interface TerminalSession {
  id: string;
  kind: TerminalKind;
  /** Working directory captured when the session was created. */
  folderPath: string;
}

export type TerminalThemeType = "light" | "dark";

const TERMINAL_COMMANDS: Record<TerminalKind, string | undefined> = {
  "claude-code": "claude",
  codex: "codex",
  "github-copilot": "copilot",
  opencode: "opencode",
  terminal: undefined,
};

export function getTerminalCommand(kind: TerminalKind): string | undefined {
  return TERMINAL_COMMANDS[kind];
}

// Codex renders panels with dark ANSI background colors, so a light terminal
// palette produces a visually split screen. Keep its terminal palette dark.
export function getTerminalThemeType(
  kind: TerminalKind,
  appThemeType: TerminalThemeType,
): TerminalThemeType {
  return kind === "codex" ? "dark" : appThemeType;
}
```

- [ ] **Step 4: Implement the store changes**

In `src/stores/ui-store.ts`:

1. Add the import after the existing type import:

```ts
import type { TerminalKind, TerminalSession } from "@/features/terminal/terminal-session";
```

2. Delete `type BottomTerminalTab = "terminal" | "claude-code";` and add below the remaining type aliases:

```ts
function newTerminalSession(kind: TerminalKind, folderPath: string): TerminalSession {
  const suffix = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  return { id: `terminal-${kind}-${suffix}`, kind, folderPath };
}
```

3. In `interface UiState`, replace `bottomTerminalTab` / `bottomTerminalOpenTabs` with:

```ts
  terminalSessions: TerminalSession[];
  activeTerminalSessionId: string | null;
  /** Last selected terminal session for each folder. */
  activeTerminalSessionIdsByFolder: Record<string, string>;
```

and replace `setBottomTerminalTab` / `openBottomTerminalTab` / `closeBottomTerminalTab` with:

```ts
  initializeTerminalSessions: (folderPath: string) => void;
  addTerminalSession: (kind: TerminalKind, folderPath: string) => void;
  setActiveTerminalSession: (id: string) => void;
  removeTerminalSession: (id: string) => void;
  /** Remove sessions whose folder is no longer open. Returns the removed session ids. */
  pruneTerminalSessions: (openFolderPaths: string[]) => string[];
```

4. Change the store factory signature from `create<UiState>()((set) => ({` to `create<UiState>()((set, get) => ({`.

5. Replace the initial values `bottomTerminalTab: "terminal", bottomTerminalOpenTabs: ["terminal"],` with:

```ts
  terminalSessions: [],
  activeTerminalSessionId: null,
  activeTerminalSessionIdsByFolder: {},
```

6. Replace the `setBottomTerminalTab`, `openBottomTerminalTab`, and `closeBottomTerminalTab` implementations with:

```ts
  initializeTerminalSessions: (folderPath) =>
    set((s) => {
      const folderSessions = s.terminalSessions.filter((session) => session.folderPath === folderPath);
      if (folderSessions.length > 0) {
        const saved = s.activeTerminalSessionIdsByFolder[folderPath];
        const active = folderSessions.find((session) => session.id === saved) ?? folderSessions[0];
        return {
          activeTerminalSessionId: active.id,
          activeTerminalSessionIdsByFolder: { ...s.activeTerminalSessionIdsByFolder, [folderPath]: active.id },
        };
      }
      const session = newTerminalSession("terminal", folderPath);
      return {
        terminalSessions: [...s.terminalSessions, session],
        activeTerminalSessionId: session.id,
        activeTerminalSessionIdsByFolder: { ...s.activeTerminalSessionIdsByFolder, [folderPath]: session.id },
      };
    }),
  addTerminalSession: (kind, folderPath) =>
    set((s) => {
      const session = newTerminalSession(kind, folderPath);
      return {
        terminalSessions: [...s.terminalSessions, session],
        activeTerminalSessionId: session.id,
        activeTerminalSessionIdsByFolder: { ...s.activeTerminalSessionIdsByFolder, [folderPath]: session.id },
        bottomTerminalVisible: true,
      };
    }),
  setActiveTerminalSession: (id) =>
    set((s) => {
      const session = s.terminalSessions.find((candidate) => candidate.id === id);
      if (!session) return s;
      return {
        activeTerminalSessionId: id,
        activeTerminalSessionIdsByFolder: { ...s.activeTerminalSessionIdsByFolder, [session.folderPath]: id },
      };
    }),
  removeTerminalSession: (id) =>
    set((s) => {
      const index = s.terminalSessions.findIndex((session) => session.id === id);
      if (index < 0) return s;
      const removed = s.terminalSessions[index];
      const terminalSessions = s.terminalSessions.filter((session) => session.id !== id);
      const folderSessions = terminalSessions.filter((session) => session.folderPath === removed.folderPath);
      // Position of the removed session among its folder's sessions: the right
      // neighbor now occupies that index; fall back to the left neighbor.
      const folderIndex = s.terminalSessions
        .slice(0, index)
        .filter((session) => session.folderPath === removed.folderPath).length;
      const nextActive = folderSessions[folderIndex] ?? folderSessions[folderIndex - 1] ?? null;
      const activeTerminalSessionIdsByFolder = { ...s.activeTerminalSessionIdsByFolder };
      if (activeTerminalSessionIdsByFolder[removed.folderPath] === id) {
        if (nextActive) activeTerminalSessionIdsByFolder[removed.folderPath] = nextActive.id;
        else delete activeTerminalSessionIdsByFolder[removed.folderPath];
      }
      return {
        terminalSessions,
        activeTerminalSessionId: s.activeTerminalSessionId === id ? nextActive?.id ?? null : s.activeTerminalSessionId,
        activeTerminalSessionIdsByFolder,
      };
    }),
  pruneTerminalSessions: (openFolderPaths) => {
    const open = new Set(openFolderPaths);
    const s = get();
    const stale = s.terminalSessions.filter((session) => session.folderPath !== "" && !open.has(session.folderPath));
    if (stale.length === 0) return [];
    const staleIds = new Set(stale.map((session) => session.id));
    const activeTerminalSessionIdsByFolder = Object.fromEntries(
      Object.entries(s.activeTerminalSessionIdsByFolder).filter(([folder]) => folder === "" || open.has(folder)),
    );
    set({
      terminalSessions: s.terminalSessions.filter((session) => !staleIds.has(session.id)),
      activeTerminalSessionId: s.activeTerminalSessionId && staleIds.has(s.activeTerminalSessionId)
        ? null
        : s.activeTerminalSessionId,
      activeTerminalSessionIdsByFolder,
    });
    return [...staleIds];
  },
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/features/terminal/__tests__/terminal-session.test.ts src/stores/__tests__/ui-store-terminal-sessions.test.ts`
Expected: all passed. (`npx tsc --noEmit` reports errors in `src/app/App.tsx` for the removed fields until Task 8 — expected.)

- [ ] **Step 6: Commit**

```bash
git add src/features/terminal/terminal-session.ts src/features/terminal/__tests__/terminal-session.test.ts src/stores/ui-store.ts src/stores/__tests__/ui-store-terminal-sessions.test.ts
git commit -m "feat(terminal): model multiple terminal sessions per folder"
```

---

### Task 8: Terminal session UI and PTY lifecycle

**Files:**
- Modify: `src-tauri/src/commands/pty.rs:25-63` (`spawn_pty`)
- Modify: `src/features/terminal/components/Terminal.tsx:~136-144` (effect cleanup)
- Modify: `src/app/App.tsx` (imports ~line 31, constants ~line 48, store selectors ~lines 74-81, bottom terminal JSX ~lines 1257-1325)
- Modify: `src/app/App.css:~197-265` (terminal tab styles)
- Modify: `src/shared/i18n/locales/en/common.json`, `src/shared/i18n/locales/ja/common.json` (after `"terminal"`)

**Interfaces:**
- Consumes: everything produced by Task 7.
- Produces: Rust `spawn_pty` returns `Ok(())` without spawning when a PTY with the same `id` already exists. PTYs are killed only by `kill_pty(id)` from the close button or folder pruning.

- [ ] **Step 1: Keep PTYs alive across remounts (Rust)**

In `src-tauri/src/commands/pty.rs`, replace the "Kill existing PTY with same id" block with:

```rust
    // A remounted xterm reconnects with the same session id. Keep its process
    // alive instead of replacing it so closing and reopening the panel is safe.
    {
        let guard = pty_store().lock().unwrap();
        if guard.contains_key(&id) {
            return Ok(());
        }
    }
```

and replace the `let cmd = if let Some(ref command_str) = command { … } else { … };` expression with (cwd is applied once, and only when non-empty so the no-folder session starts in the default directory):

```rust
    let mut cmd = if let Some(ref command_str) = command {
        if cfg!(target_os = "windows") {
            let mut c = CommandBuilder::new("cmd.exe");
            c.args(["/C", command_str]);
            c
        } else {
            let mut c = CommandBuilder::new("bash");
            c.args(["-c", command_str]);
            c
        }
    } else {
        CommandBuilder::new_default_prog()
    };
    if !cwd.is_empty() {
        cmd.cwd(&cwd);
    }
```

Run: `cargo check --manifest-path src-tauri/Cargo.toml`
Expected: `Finished` with no new warnings in `pty.rs`.

- [ ] **Step 2: Stop killing the PTY on unmount**

In `src/features/terminal/components/Terminal.tsx`, delete `invoke("kill_pty", { id }).catch(() => {});` from the effect cleanup and replace the comment above the `eslint-disable` line with:

```tsx
  // folderPath is intentionally excluded: a session captures its working
  // directory at creation and its PTY survives when this view is unmounted.
```

(`invoke` is still used for `spawn_pty`/`resize_pty`; keep the import.)

- [ ] **Step 3: Add i18n keys**

`src/shared/i18n/locales/en/common.json`, after `"terminal": "Terminal",`:

```json
  "terminalAdd": "New Terminal",
  "terminalSessionLabel": "{{name}} {{number}}",
  "terminalClaudeCode": "Claude Code",
  "terminalCodex": "Codex",
  "terminalGitHubCopilot": "GitHub Copilot",
  "terminalOpencode": "opencode",
  "terminalCloseSession": "Close {{name}}",
```

`src/shared/i18n/locales/ja/common.json`, after `"terminal": "ターミナル",`:

```json
  "terminalAdd": "新しいターミナル",
  "terminalSessionLabel": "{{name}} {{number}}",
  "terminalClaudeCode": "Claude Code",
  "terminalCodex": "Codex",
  "terminalGitHubCopilot": "GitHub Copilot",
  "terminalOpencode": "opencode",
  "terminalCloseSession": "{{name}} を終了",
```

- [ ] **Step 4: Wire the store into `App.tsx`**

Add after the `Terminal` import:

```ts
import { TERMINAL_KINDS, getTerminalCommand, getTerminalThemeType, type TerminalKind } from "@/features/terminal/terminal-session";
```

Add after `const APP_TITLE = "MDium";`:

```ts
const TERMINAL_KIND_LABEL_KEYS: Record<TerminalKind, string> = {
  "claude-code": "terminalClaudeCode",
  codex: "terminalCodex",
  "github-copilot": "terminalGitHubCopilot",
  opencode: "terminalOpencode",
  terminal: "terminal",
};
```

Replace the four selectors `bottomTerminalTab`, `bottomTerminalOpenTabs`, `setBottomTerminalTab`, `closeBottomTerminalTab` with:

```ts
  const terminalSessions = useUiStore((s) => s.terminalSessions);
  const activeTerminalSessionId = useUiStore((s) => s.activeTerminalSessionId);
  const initializeTerminalSessions = useUiStore((s) => s.initializeTerminalSessions);
  const addTerminalSession = useUiStore((s) => s.addTerminalSession);
  const setActiveTerminalSession = useUiStore((s) => s.setActiveTerminalSession);
  const removeTerminalSession = useUiStore((s) => s.removeTerminalSession);
  const pruneTerminalSessions = useUiStore((s) => s.pruneTerminalSessions);
```

After `const themeType = getThemeById(themeId).type;` add:

```ts
  const activeFolderTerminalSessions = terminalSessions.filter(
    (session) => session.folderPath === (activeFolderPath ?? ""),
  );

  // Create the folder's first terminal lazily when the view is shown.
  useEffect(() => {
    if (bottomTerminalVisible) initializeTerminalSessions(activeFolderPath ?? "");
  }, [activeFolderPath, bottomTerminalVisible, initializeTerminalSessions]);

  // Closing a folder ends the terminal processes started in it.
  useEffect(() => {
    for (const id of pruneTerminalSessions(openFolderPaths)) {
      invoke("kill_pty", { id }).catch(() => {});
    }
  }, [openFolderPaths, pruneTerminalSessions]);

  const handleCloseTerminalSession = (id: string) => {
    void invoke("kill_pty", { id })
      .catch(() => {})
      .finally(() => removeTerminalSession(id));
  };
```

(If `activeFolderPath`, `openFolderPaths`, or `invoke` are declared/imported below this point in the current file, place this block after their declarations. `useEffect` and `invoke` are already imported in `App.tsx`.)

- [ ] **Step 5: Replace the bottom terminal toolbar and body JSX**

Replace the contents of `<div className="app__bottom-terminal-toolbar">…</div>` and `<div className="app__bottom-terminal-body">…</div>` with:

```tsx
                <div className="app__bottom-terminal-toolbar">
                  <div className="app__bottom-terminal-tabs">
                    {activeFolderTerminalSessions.map((session, index) => {
                      const number = activeFolderTerminalSessions
                        .slice(0, index + 1)
                        .filter((candidate) => candidate.kind === session.kind).length;
                      const label = t("terminalSessionLabel", {
                        name: t(TERMINAL_KIND_LABEL_KEYS[session.kind]),
                        number,
                      });
                      return (
                        <div
                          key={session.id}
                          className={`app__bottom-terminal-tab-item${activeTerminalSessionId === session.id ? " active" : ""}`}
                        >
                          <button
                            type="button"
                            className="app__bottom-terminal-tab"
                            onClick={() => setActiveTerminalSession(session.id)}
                          >
                            <span className="app__bottom-terminal-tab-label">{label}</span>
                          </button>
                          <button
                            type="button"
                            className="app__bottom-terminal-tab-close"
                            aria-label={t("terminalCloseSession", { name: label })}
                            title={t("terminalCloseSession", { name: label })}
                            onClick={() => handleCloseTerminalSession(session.id)}
                          >
                            ×
                          </button>
                        </div>
                      );
                    })}
                  </div>
                  <div className="app__bottom-terminal-actions">
                    <select
                      className="app__bottom-terminal-add-select"
                      aria-label={t("terminalAdd")}
                      value=""
                      onChange={(event) => {
                        const kind = event.target.value as TerminalKind;
                        if (TERMINAL_KINDS.includes(kind)) addTerminalSession(kind, activeFolderPath ?? "");
                      }}
                    >
                      <option value="" disabled>{t("terminalAdd")}</option>
                      {TERMINAL_KINDS.map((kind) => (
                        <option key={kind} value={kind}>{t(TERMINAL_KIND_LABEL_KEYS[kind])}</option>
                      ))}
                    </select>
                  </div>
                </div>
                <div className="app__bottom-terminal-body">
                  {terminalSessions.map((session) => {
                    const isActive = activeTerminalSessionId === session.id
                      && session.folderPath === (activeFolderPath ?? "");
                    return (
                      <div
                        key={session.id}
                        className="app__bottom-terminal-pane"
                        style={{ visibility: isActive ? "visible" : "hidden", zIndex: isActive ? 1 : 0 }}
                      >
                        <Terminal
                          id={session.id}
                          folderPath={session.folderPath}
                          themeType={getTerminalThemeType(session.kind, themeType)}
                          active={isActive}
                          command={getTerminalCommand(session.kind)}
                        />
                      </div>
                    );
                  })}
                </div>
```

(The controlled `value=""` keeps the placeholder selected after each pick, so choosing the same kind twice still fires `onChange`.)

- [ ] **Step 6: Update terminal tab CSS**

In `src/app/App.css`, replace the `.app__bottom-terminal-tab`, `.app__bottom-terminal-tab:hover`, `.app__bottom-terminal-tab.active`, and `.app__bottom-terminal-tab-close` rules with:

```css
.app__bottom-terminal-tab {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 4px 4px 12px;
  background: none;
  border: none;
  font-size: 12px;
  font-weight: 500;
  color: inherit;
  cursor: pointer;
  transition: color 0.15s;
  white-space: nowrap;
  height: 100%;
}

.app__bottom-terminal-tab-item {
  display: flex;
  align-items: center;
  border-bottom: 2px solid transparent;
  color: var(--text-secondary);
  transition: color 0.15s, border-color 0.15s;
  white-space: nowrap;
}

.app__bottom-terminal-tab-item:hover {
  color: var(--text);
}

.app__bottom-terminal-tab-item.active {
  color: var(--primary);
  border-bottom-color: var(--primary);
}

.app__bottom-terminal-tab-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border-radius: 3px;
  padding: 0;
  border: none;
  background: none;
  font-size: 14px;
  line-height: 1;
  color: inherit;
  cursor: pointer;
  margin-right: 6px;
}
```

(Keep the existing `.app__bottom-terminal-tab-close:hover` rule.) Add before `.app__bottom-terminal-body`:

```css
.app__bottom-terminal-add-select {
  height: 24px;
  min-width: 142px;
  padding: 2px 24px 2px 8px;
  background: var(--bg-base);
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--text-secondary);
  font-size: 11px;
  cursor: pointer;
}

.app__bottom-terminal-add-select:hover,
.app__bottom-terminal-add-select:focus {
  border-color: var(--primary);
  color: var(--text);
  outline: none;
}
```

- [ ] **Step 7: Type check and tests**

Run: `npx tsc --noEmit`
Expected: no errors.
Run: `npx vitest run src/features/terminal src/stores/__tests__/ui-store-terminal-sessions.test.ts`
Expected: all passed.

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/commands/pty.rs src/features/terminal/components/Terminal.tsx src/app/App.tsx src/app/App.css src/shared/i18n/locales/en/common.json src/shared/i18n/locales/ja/common.json
git commit -m "feat(terminal): add multiple terminal sessions with CLI launchers"
```

---

### Task 9: Full verification and manual smoke test

**Files:** none (verification only; fix regressions in the task that introduced them).

- [ ] **Step 1: Full automated checks**

Run: `npx tsc --noEmit`
Expected: no errors.
Run: `npm test`
Expected: all test files pass (report the pass count).
Run: `cargo check --manifest-path src-tauri/Cargo.toml`
Expected: `Finished`.

- [ ] **Step 2: Manual smoke test (`npm run tauri dev`)**

Check each item and report results:

1. Settings dialog, opencode settings (all sections), Claude plugins tab, preview VBA switch, video caption/image switches: switches render in the current theme's colors, thumbs are vertically centered; repeat after switching between a light and a dark theme.
2. opencode chat: the MD context switch works; with a paid model the cost appears right-aligned above the input and its popover opens upward; with a zero-cost session nothing is shown.
3. opencode settings → MCP servers with 10+ entries: the list scrolls and the "+ Add" row stays visible.
4. Terminal: open the bottom view → one "Terminal 1" tab. Add Codex twice → "Codex 1", "Codex 2". Hide and re-show the view → the Codex sessions keep running. Switch to another folder → its own tabs. Close the middle tab → the right neighbor is selected. Close the folder → its sessions disappear (no orphan processes in Task Manager).
5. A confirm dialog opened with default options still closes on overlay click.

- [ ] **Step 3: Record results**

Summarize automated results and each smoke item (pass / fail with details). Do not claim completion if any item failed.
