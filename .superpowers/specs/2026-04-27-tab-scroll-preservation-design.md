# Tab Scroll/View State Preservation Design

Date: 2026-04-27

## Problem

When the user switches between tabs and returns, the following state is lost:

1. **Code editor (Monaco) view state** — scroll position, cursor position, selection. Caused by `key={activeTab.id}` in `CodeEditorPanel.tsx:49`, which destroys the Monaco instance on every tab switch and recreates it from `defaultValue` only.
2. **CSV preview scroll position** — `CsvPreviewPanel`'s `parentRef` scroll container retains DOM scrollTop, but content swaps when `activeTab` changes, leaving the wrong row visible (or scrollTop reset on remount).
3. **CSV preview "treat first row as header" toggle** — `headerMode` is `useState` local to `CsvPreviewPanel`, so it resets to `true` whenever the component remounts.

This affects all code-editor tabs (CSV, JSON, Python, YAML, etc.) and all CSV/TSV preview tabs.

## Goals

- Preserve Monaco view state (scroll + cursor + selection) across tab switches for every tab using `CodeEditorPanel`.
- Preserve CSV preview scroll position and `headerMode` toggle per CSV/TSV tab.
- Mirror the existing `imageCanvasJson` pattern (per-tab view state stored on the `Tab` object).

## Non-Goals

- Persisting view state across app restarts. Tabs themselves are not persisted (`tabs` is excluded from `partialize` in `tab-store.ts:452`), so view state is session-only by design.
- Preserving Markdown editor scroll (out of scope per user; that uses a different component).
- Multi-model Monaco refactor (would be cleaner Monaco-wise but is a much larger change).

## Approach

Store per-tab view state directly on the `Tab` interface, following the existing precedent of `imageCanvasJson` (`tab-store.ts:28-29`).

### Data model additions to `Tab`

```ts
import type { editor } from "monaco-editor";

interface Tab {
  // ...existing fields
  /** Monaco view state (scroll/cursor/selection). Set by CodeEditorPanel; restored on remount. */
  editorViewState?: editor.ICodeEditorViewState | null;
  /** CSV preview scroll position (px). */
  csvPreviewScrollTop?: number;
  /** CSV preview "treat first row as header" toggle. Defaults to true when undefined. */
  csvHeaderMode?: boolean;
}
```

### Store actions added to `useTabStore`

```ts
updateTabEditorViewState: (id: string, state: editor.ICodeEditorViewState | null) => void;
updateTabCsvPreview: (id: string, partial: { scrollTop?: number; headerMode?: boolean }) => void;
```

Both perform a shallow merge into the matching tab. They do not mark the tab dirty (view state is not user content).

`partialize` is unchanged — view state is intentionally session-only.

### `CodeEditorPanel` changes

`key={activeTab.id}` is preserved (Monaco still remounts on tab switch). The `onMount` callback is extended to:

1. **Restore** — read the active tab's `editorViewState` from the store at mount time and call `editor.restoreViewState(state)` if present.
2. **Subscribe to view-state-changing events** and write back to the store with a 200 ms throttle:
   - `editor.onDidScrollChange`
   - `editor.onDidChangeCursorPosition`
   - `editor.onDidChangeCursorSelection`

   The handler captures `tabId` from the closure (the tab id at mount time), so it always writes to the correct tab even if the user switches away mid-throttle.

This avoids the unmount-time race (calling `saveViewState()` on a disposed editor) and keeps the store continuously up to date.

The throttle utility is small and inline (no need for lodash); a `setTimeout`-based trailing throttle is sufficient.

### `CsvPreviewPanel` changes

- Replace `const [headerMode, setHeaderMode] = useState(true)` with a derived value: `const headerMode = activeTab?.csvHeaderMode ?? true`. The toggle's `onChange` calls `updateTabCsvPreview(activeTab.id, { headerMode: e.target.checked })`.
- Restore scroll on mount and on tab switch via `useEffect([activeTab?.id])`. Inside the effect, queue a `requestAnimationFrame` and set `parentRef.current.scrollTop = activeTab.csvPreviewScrollTop ?? 0`. The rAF gate ensures `useVirtualizer` has measured rows before we scroll.
- Add an `onScroll` handler on the scroll container that writes `scrollTop` to the store with a 200 ms throttle.

### Edge cases

- **Stale view state schema** — Monaco's `restoreViewState` accepts `null` and ignores incompatible payloads. No try/catch needed.
- **CSV row count shrinks externally** — restored `scrollTop` may exceed the new content height; the browser clamps it automatically. No-op.
- **Header mode toggle changes row count** — restored scroll position no longer corresponds to the same row. Acceptable: the user actively chose to toggle, and the scroll change is bounded.
- **Tab close** — view state lives on the `Tab` object and is garbage-collected when the tab is removed. No extra cleanup needed.
- **First-time open of a tab** — `editorViewState` is `undefined`; `restoreViewState(undefined)` is a no-op (we guard with a truthiness check anyway). Monaco starts at top-left. Same for `csvPreviewScrollTop` (defaults to 0).

## Files to change

- `src/stores/tab-store.ts` — add 3 fields to `Tab`, add 2 actions.
- `src/features/code-editor/components/CodeEditorPanel.tsx` — extend `onMount` with restore + event subscriptions + throttled save.
- `src/features/preview/components/CsvPreviewPanel.tsx` — switch `headerMode` to store-backed, add restore effect and throttled `onScroll` save.

No new files. No i18n changes (no new user-visible strings). No CSS changes.

## Testing

Manual verification (no automated UI tests exist for these panels):

1. Open two CSV tabs, scroll each to a different row, toggle header mode on one. Switch between them and confirm scroll + toggle state are preserved.
2. Open two JSON (or Python) tabs in the code editor, place cursor at different positions and scroll. Switch between them and confirm cursor + scroll restore.
3. Open a CSV tab, scroll deep, edit content via the editor side, ensure preview scroll position is restored after switching away and back.
4. Close a tab and reopen it (same path) — fresh state expected (since `openTab` reuses the existing tab if found, but a closed-then-reopened tab is a new tab object → fresh state).
5. Restart the app — view state is not persisted (intentional). Tabs themselves are also not persisted, so this is consistent.
