# Tab Scroll/View State Preservation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve Monaco code-editor view state (scroll/cursor/selection) and CSV preview view state (scroll position + header-mode toggle) per tab, so switching tabs and returning restores the previous viewport.

**Architecture:** Store per-tab view state directly on the `Tab` object in `useTabStore` (mirroring the existing `imageCanvasJson` pattern). `CodeEditorPanel` subscribes to Monaco scroll/cursor/selection events and writes throttled view state back to the store; on remount it restores via `editor.restoreViewState()`. `CsvPreviewPanel` derives `headerMode` from the store, restores `scrollTop` on tab change inside an `rAF`, and writes throttled scroll updates back.

**Tech Stack:** TypeScript, React 19, Zustand 5, `@monaco-editor/react` 4.7, `monaco-editor` 0.55, `@tanstack/react-virtual` 3, Vitest 4 (happy-dom).

**Spec:** `.superpowers/specs/2026-04-27-tab-scroll-preservation-design.md`

---

## File Structure

- **Modify** `src/stores/tab-store.ts` — add 3 optional fields to `Tab` interface, 2 actions to `TabState`. View state is session-only (already excluded from `partialize`).
- **Modify** `src/features/code-editor/components/CodeEditorPanel.tsx` — extend `onMount` to restore Monaco view state and subscribe to view-state-changing events with a throttled writeback. Add a small inline `throttle` helper.
- **Modify** `src/features/preview/components/CsvPreviewPanel.tsx` — replace local `headerMode` `useState` with store-derived value, add a `useEffect` keyed on `activeTab.id` to restore `scrollTop` via `requestAnimationFrame`, add an `onScroll` handler with throttled writeback.

No new files. No CSS or i18n changes.

---

## Task 1: Add Tab fields and store actions

**Files:**
- Modify: `src/stores/tab-store.ts`

- [ ] **Step 1: Add monaco-editor type import at the top of `tab-store.ts`**

Insert after the existing imports (around line 5):

```ts
import type { editor } from "monaco-editor";
```

- [ ] **Step 2: Add three optional fields to the `Tab` interface**

In `src/stores/tab-store.ts`, locate the `Tab` interface (starts at line 7). Add the following fields immediately before the closing brace at line 48 (right after `diffStatus?: string;`):

```ts
  /** Monaco view state (scroll/cursor/selection). Set by CodeEditorPanel; restored on remount. */
  editorViewState?: editor.ICodeEditorViewState | null;
  /** CSV preview scroll position in pixels. */
  csvPreviewScrollTop?: number;
  /** CSV preview "treat first row as header" toggle. Defaults to true when undefined. */
  csvHeaderMode?: boolean;
```

- [ ] **Step 3: Add the two action signatures to `TabState`**

In the `TabState` interface (starts at line 50), add the following two action signatures immediately after `updateImageCanvasState` (line 69):

```ts
  updateTabEditorViewState: (id: string, state: editor.ICodeEditorViewState | null) => void;
  updateTabCsvPreview: (id: string, partial: { scrollTop?: number; headerMode?: boolean }) => void;
```

- [ ] **Step 4: Implement the two actions in the store body**

In the store implementation, find `updateImageCanvasState` (starts at line 243). Add the two new actions immediately after its closing `},`:

```ts
  updateTabEditorViewState: (id, state) => {
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === id ? { ...t, editorViewState: state } : t)),
    }));
  },

  updateTabCsvPreview: (id, partial) => {
    set((s) => ({
      tabs: s.tabs.map((t) => {
        if (t.id !== id) return t;
        const next = { ...t };
        if (partial.scrollTop !== undefined) next.csvPreviewScrollTop = partial.scrollTop;
        if (partial.headerMode !== undefined) next.csvHeaderMode = partial.headerMode;
        return next;
      }),
    }));
  },
```

Note: the partial-action keys (`scrollTop`, `headerMode`) deliberately do not match the Tab field names (`csvPreviewScrollTop`, `csvHeaderMode`) — the action provides a friendlier API, so the body maps them explicitly rather than spreading.

- [ ] **Step 5: Verify TypeScript compiles**

Run: `npm run build`
Expected: Build succeeds (no TS errors). If you see import-cycle warnings related to `monaco-editor`, that's expected since it's `import type` and gets erased at runtime.

If the full build is too slow, run just type-checking: `npx tsc --noEmit`

- [ ] **Step 6: Commit**

```bash
git add src/stores/tab-store.ts
git commit -m "feat(tab-store): add per-tab view state fields and actions"
```

---

## Task 2: CodeEditorPanel — restore + save Monaco view state

**Files:**
- Modify: `src/features/code-editor/components/CodeEditorPanel.tsx`

- [ ] **Step 1: Replace the file with the updated version**

Open `src/features/code-editor/components/CodeEditorPanel.tsx` and replace its entire contents with:

```tsx
// src/features/code-editor/components/CodeEditorPanel.tsx

import { useCallback, useRef } from "react";
import Editor, { type OnMount, type OnChange } from "@monaco-editor/react";
import type { editor } from "monaco-editor";
import { useTabStore } from "@/stores/tab-store";
import { useSettingsStore } from "@/stores/settings-store";
import { getThemeById } from "@/shared/themes";
import { getMonacoLanguage } from "../lib/language-map";
import "./CodeEditorPanel.css";

const VIEW_STATE_THROTTLE_MS = 200;

function makeThrottle<T extends (...args: never[]) => void>(fn: T, ms: number) {
  let pending: ReturnType<typeof setTimeout> | null = null;
  let lastArgs: Parameters<T> | null = null;
  return (...args: Parameters<T>) => {
    lastArgs = args;
    if (pending !== null) return;
    pending = setTimeout(() => {
      pending = null;
      if (lastArgs) fn(...lastArgs);
    }, ms);
  };
}

export function CodeEditorPanel() {
  const activeTab = useTabStore((s) => s.getActiveTab());
  const updateTabContent = useTabStore((s) => s.updateTabContent);
  const themeId = useSettingsStore((s) => s.themeId);
  const themeType = getThemeById(themeId).type;

  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);

  const language = activeTab?.filePath
    ? getMonacoLanguage(activeTab.filePath)
    : "plaintext";

  const isCsv = !!activeTab?.csvFileType;
  const theme = themeType === "dark"
    ? (isCsv ? "mdium-csv-dark" : "vs-dark")
    : (isCsv ? "mdium-csv-light" : "vs");

  const handleEditorDidMount: OnMount = useCallback((ed) => {
    editorRef.current = ed;

    // Capture tabId at mount; the editor instance is keyed on activeTab.id,
    // so this closure is stable for the lifetime of this Monaco instance.
    const tabId = useTabStore.getState().activeTabId;
    if (tabId) {
      const saved = useTabStore.getState().tabs.find((t) => t.id === tabId)?.editorViewState;
      if (saved) ed.restoreViewState(saved);

      const save = makeThrottle(() => {
        const state = ed.saveViewState();
        useTabStore.getState().updateTabEditorViewState(tabId, state);
      }, VIEW_STATE_THROTTLE_MS);

      ed.onDidScrollChange(save);
      ed.onDidChangeCursorPosition(save);
      ed.onDidChangeCursorSelection(save);
    }

    ed.focus();
  }, []);

  const handleChange: OnChange = useCallback(
    (value) => {
      if (activeTab && value !== undefined) {
        updateTabContent(activeTab.id, value);
      }
    },
    [activeTab, updateTabContent]
  );

  if (!activeTab) return null;

  return (
    <div className="code-editor-panel">
      <div className="code-editor-panel__editor">
        <Editor
          key={activeTab.id}
          defaultValue={activeTab.content}
          language={language}
          theme={theme}
          onChange={handleChange}
          onMount={handleEditorDidMount}
          options={{
            fontSize: 14,
            minimap: { enabled: !isCsv },
            wordWrap: isCsv ? "off" : "on",
            automaticLayout: true,
            scrollBeyondLastLine: false,
            lineNumbers: "on",
            renderLineHighlight: "line",
            bracketPairColorization: { enabled: !isCsv },
            tabSize: 4,
            insertSpaces: true,
          }}
        />
      </div>
    </div>
  );
}
```

Key changes from the original:
- New `makeThrottle` helper (trailing-throttle, no leading call) and `VIEW_STATE_THROTTLE_MS` constant.
- `onMount` captures `tabId` from the store at mount time, restores saved view state if present, and registers three Monaco event listeners (`onDidScrollChange`, `onDidChangeCursorPosition`, `onDidChangeCursorSelection`) that throttle-save the view state back to the store.
- The Monaco instance is still keyed by `activeTab.id`, so on every tab switch a fresh editor mounts with its own captured `tabId` closure.

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 3: Run the dev app and manually verify Monaco view state preservation**

Run: `npm run dev`

Then in the running app:

1. Open a folder, open two non-Markdown text files (e.g. a `.json` and a `.py`, or two CSVs).
2. In tab A: scroll to ~line 50, place cursor on line 50, select 2-3 characters.
3. Switch to tab B; scroll to a different position; place cursor on a different line.
4. Switch back to tab A. **Expected:** scroll position, cursor position, and selection are exactly where you left them.
5. Switch back to tab B. **Expected:** same — fully restored.
6. Type a few characters in tab A (modify content), switch to B, switch back. **Expected:** modifications are preserved (existing behavior) AND view state restores correctly.

If the view state does NOT restore, check the browser devtools console for errors and inspect `useTabStore.getState().tabs.find(t => t.id === ...).editorViewState` to confirm it is being written.

- [ ] **Step 4: Commit**

```bash
git add src/features/code-editor/components/CodeEditorPanel.tsx
git commit -m "feat(code-editor): preserve Monaco view state across tab switches"
```

---

## Task 3: CsvPreviewPanel — store-backed headerMode + scroll preservation

**Files:**
- Modify: `src/features/preview/components/CsvPreviewPanel.tsx`

- [ ] **Step 1: Replace the file with the updated version**

Open `src/features/preview/components/CsvPreviewPanel.tsx` and replace its entire contents with:

```tsx
import { useEffect, useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useTranslation } from "react-i18next";
import { useTabStore } from "@/stores/tab-store";
import { useCsvParse } from "../hooks/useCsvParse";
import "./CsvPreviewPanel.css";

const HEADER_HEIGHT = 30;
const SCROLL_THROTTLE_MS = 200;

function makeThrottle<T extends (...args: never[]) => void>(fn: T, ms: number) {
  let pending: ReturnType<typeof setTimeout> | null = null;
  let lastArgs: Parameters<T> | null = null;
  return (...args: Parameters<T>) => {
    lastArgs = args;
    if (pending !== null) return;
    pending = setTimeout(() => {
      pending = null;
      if (lastArgs) fn(...lastArgs);
    }, ms);
  };
}

export function CsvPreviewPanel() {
  const { t } = useTranslation("csv");
  const activeTab = useTabStore((s) => s.getActiveTab());
  const updateTabCsvPreview = useTabStore((s) => s.updateTabCsvPreview);

  const headerMode = activeTab?.csvHeaderMode ?? true;

  const delimiter: "," | "\t" = activeTab?.csvFileType === ".tsv" ? "\t" : ",";
  const { rows, errors, maxColumns } = useCsvParse(
    activeTab?.content ?? "",
    delimiter,
  );

  const { headerRow, bodyRows } = useMemo(() => {
    if (rows.length === 0) return { headerRow: null, bodyRows: [] as string[][] };
    if (headerMode) {
      return { headerRow: rows[0], bodyRows: rows.slice(1) };
    }
    const synthetic = Array.from({ length: maxColumns }, (_, i) => t("columnLabel", { index: i + 1 }));
    return { headerRow: synthetic, bodyRows: rows };
  }, [rows, maxColumns, headerMode, t]);

  const parentRef = useRef<HTMLDivElement>(null);
  const rowVirtualizer = useVirtualizer({
    count: bodyRows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 26,
    overscan: 12,
  });

  // Restore scroll position after the virtualizer has measured rows for this tab.
  // Re-runs whenever the active tab id changes.
  const tabId = activeTab?.id;
  useEffect(() => {
    if (!tabId || !parentRef.current) return;
    const target = useTabStore.getState().tabs.find((t) => t.id === tabId)?.csvPreviewScrollTop ?? 0;
    const el = parentRef.current;
    const raf = requestAnimationFrame(() => {
      el.scrollTop = target;
    });
    return () => cancelAnimationFrame(raf);
  }, [tabId]);

  // Throttled scroll writeback. Re-create when the active tab changes so the closure
  // captures the correct tabId.
  const onScroll = useMemo(() => {
    if (!tabId) return undefined;
    const save = makeThrottle((scrollTop: number) => {
      useTabStore.getState().updateTabCsvPreview(tabId, { scrollTop });
    }, SCROLL_THROTTLE_MS);
    return (e: React.UIEvent<HTMLDivElement>) => save(e.currentTarget.scrollTop);
  }, [tabId]);

  if (!activeTab) return null;

  if (rows.length === 0) {
    return <div className="csv-preview csv-preview--empty">{t("empty")}</div>;
  }

  const columnCount = maxColumns;
  const gridTemplate = `repeat(${columnCount}, minmax(80px, 1fr))`;

  return (
    <div className="csv-preview">
      <div className="csv-preview__toolbar">
        <label className="csv-preview__toggle">
          <input
            type="checkbox"
            checked={headerMode}
            onChange={(e) => updateTabCsvPreview(activeTab.id, { headerMode: e.target.checked })}
          />
          {t("treatFirstRowAsHeader")}
        </label>
        <span className="csv-preview__count">
          {t("rows", { count: bodyRows.length })} ×{" "}
          {t("columns", { count: columnCount })}
        </span>
      </div>
      {errors.length > 0 && (
        <div
          className="csv-preview__warning"
          title={errors.map((e) => `row ${e.row}: ${e.message}`).join("\n")}
        >
          ⚠ {t("parseWarning", { count: errors.length })}
        </div>
      )}
      <div className="csv-preview__scroll" ref={parentRef} onScroll={onScroll}>
        <div
          className="csv-preview__grid"
          style={{ height: rowVirtualizer.getTotalSize() + HEADER_HEIGHT }}
        >
          {headerRow && (
            <div
              className="csv-preview__row csv-preview__row--header"
              style={{ gridTemplateColumns: gridTemplate }}
            >
              {Array.from({ length: columnCount }, (_, i) => (
                <div
                  key={i}
                  className="csv-preview__cell"
                  data-col-index={i % 10}
                >
                  {headerRow[i] ?? ""}
                </div>
              ))}
            </div>
          )}
          {rowVirtualizer.getVirtualItems().map((v) => {
            const row = bodyRows[v.index];
            return (
              <div
                key={v.key}
                className="csv-preview__row csv-preview__row--virtual"
                style={{
                  gridTemplateColumns: gridTemplate,
                  transform: `translateY(${v.start + HEADER_HEIGHT}px)`,
                }}
                ref={rowVirtualizer.measureElement}
                data-index={v.index}
              >
                {Array.from({ length: columnCount }, (_, c) => {
                  const cell = row[c];
                  return (
                    <div
                      key={c}
                      className={
                        cell === undefined || cell === ""
                          ? "csv-preview__cell csv-preview__cell--empty"
                          : "csv-preview__cell"
                      }
                      data-col-index={c % 10}
                    >
                      {cell === undefined || cell === "" ? "—" : cell}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
```

Key changes from the original:
- `useState` for `headerMode` removed; derived from `activeTab.csvHeaderMode ?? true`. Toggle calls `updateTabCsvPreview(activeTab.id, { headerMode: ... })`.
- New `useEffect([tabId])` restores `parentRef.current.scrollTop` to the saved value (or 0) after a `requestAnimationFrame`, ensuring the virtualizer has measured rows.
- New `onScroll` handler (memoized per tab id) writes throttled scroll position back to the store.
- New `makeThrottle` helper and `SCROLL_THROTTLE_MS` constant.
- Added `useEffect` to the imports.

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 3: Run the dev app and manually verify CSV preview state preservation**

Run (if not already running): `npm run dev`

Then in the running app:

1. Open two CSV/TSV files (one CSV + one TSV is good for variety).
2. In tab A's preview: scroll down to row ~200; toggle the "treat first row as header" checkbox to OFF.
3. Switch to tab B's preview; scroll to row ~50; leave the toggle ON.
4. Switch back to tab A. **Expected:** scroll position is restored to row ~200 AND the header-mode toggle is OFF (synthetic column labels visible).
5. Switch to tab B. **Expected:** scroll position restored to row ~50 AND toggle is ON (first row is header).
6. Edit tab A's CSV in the code editor side (e.g. add a row at the top). Switch tabs and back. **Expected:** preview scroll position is preserved (may shift slightly if rows above the viewport changed — that's acceptable browser-clamp behavior).
7. Toggle the header mode while scrolled mid-document. **Expected:** the toggle change persists; scroll position is preserved as best-effort (acceptable if it shifts due to row-count change).

- [ ] **Step 4: Cross-feature verification — switch between CSV and code-editor tabs**

In the same dev session:

1. Have at least one CSV tab and one non-CSV code tab (e.g. `.json`) open.
2. In the CSV tab: scroll the preview, scroll the editor, set cursor in editor.
3. Switch to the JSON tab; scroll the editor.
4. Switch back to the CSV tab. **Expected:** both the editor (left) and preview (right) view states are restored independently.

- [ ] **Step 5: Commit**

```bash
git add src/features/preview/components/CsvPreviewPanel.tsx
git commit -m "feat(csv-preview): preserve scroll position and header-mode toggle per tab"
```

---

## Task 4: Final verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: All existing tests pass. (No new automated tests are added; the changed components have no existing test coverage and the codebase reserves vitest for pure library functions.)

- [ ] **Step 2: Run the production build**

Run: `npm run build`
Expected: TypeScript type-check passes and Vite build succeeds with no errors.

- [ ] **Step 3: Confirm the spec scenarios end-to-end in dev**

Run: `npm run dev`

Walk through the full scenario list from the spec's "Testing" section:

1. Two CSV tabs with different scroll + different header-mode toggles → state preserved on switch.
2. Two non-Markdown code tabs (JSON, Python, etc.) with different cursor + scroll → state preserved on switch.
3. CSV tab where you edit content via the editor side, switch away, return → preview scroll restored.
4. Close a tab and re-open the same file → fresh state (since the reopened tab is a new `Tab` object with no saved view state — this is correct).
5. Restart the app (`Ctrl+C` then `npm run dev`) → tabs are not persisted, so view state is also gone. This is intentional and consistent.

- [ ] **Step 4: Final commit (only if there are uncommitted changes)**

If the manual verification surfaced no issues and there are no further changes, no commit is needed. If you made small fixes, commit them with a descriptive message.

```bash
git status
# If clean: done. If dirty:
git add <files>
git commit -m "fix(...): <what you fixed>"
```
