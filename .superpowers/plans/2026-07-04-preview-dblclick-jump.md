# Preview Double-Click → Editor Line Jump Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Double-clicking any rendered block in the Markdown preview scrolls the editor textarea to the corresponding source line (centered), places the caret at that line's start, and focuses the editor.

**Architecture:** The preview already annotates every top-level block with `data-source-line` (1-indexed, front-matter aware) via `renderMarkdownWithSourceLines`. We add: (1) a pure jump helper in the editor feature that converts a line number into caret offset + centered scrollTop and applies it to the textarea, (2) a pure resolver in the preview feature that maps a double-clicked DOM node to a source line (excluding images, which already have their own dblclick action), (3) wiring: a `dblclick` listener on the preview `contentRef` div and an `onJumpToLine` callback defined in `App.tsx` (which owns `editorRef`).

**Tech Stack:** React 18 + TypeScript, plain `<textarea>` editor, `marked` preview, Vitest (per-file `// @vitest-environment happy-dom` pragma for DOM tests).

**Spec:** `.superpowers/specs/2026-07-04-preview-dblclick-jump-design.md`

## Global Constraints

- All code comments in English (CLAUDE.md).
- No hardcoded UI-facing strings — this feature adds none (no new buttons/tooltips), keep it that way.
- Jump must work regardless of the `scrollSync` setting (explicit user action).
- Multi-line blocks jump to the block's **first** line (approved; no deeper renderer annotation).
- Line numbers out of range are clamped to the last line; missing/invalid `data-source-line` is a no-op.
- Use `focus({ preventScroll: true })` and set `scrollTop` manually.

---

### Task 1: Editor jump helper (`jumpEditorToLine`)

**Files:**
- Create: `src/features/editor/lib/jumpToLine.ts`
- Test: `src/features/editor/lib/__tests__/jumpToLine.test.ts`

**Interfaces:**
- Consumes: nothing (leaf module).
- Produces:
  - `lineStartOffset(content: string, line: number): number` — char offset of the start of 1-indexed `line`, clamped to `[1, totalLines]`.
  - `centeredScrollTop(line: number, totalLines: number, lineHeight: number, clientHeight: number): number` — scrollTop that vertically centers `line`, `>= 0`, line clamped.
  - `jumpEditorToLine(editor: HTMLTextAreaElement, line: number): void` — focuses (preventScroll), sets caret to line start, sets `scrollTop`. Task 3 imports `jumpEditorToLine` from `@/features/editor/lib/jumpToLine`.

- [ ] **Step 1: Write the failing test**

Create `src/features/editor/lib/__tests__/jumpToLine.test.ts`:

```ts
// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import {
  centeredScrollTop,
  jumpEditorToLine,
  lineStartOffset,
} from "../jumpToLine";

describe("lineStartOffset", () => {
  const content = "alpha\nbravo\ncharlie\n\ndelta";

  it("returns 0 for line 1", () => {
    expect(lineStartOffset(content, 1)).toBe(0);
  });

  it("returns the offset just after the previous newline", () => {
    expect(lineStartOffset(content, 2)).toBe(6); // after "alpha\n"
    expect(lineStartOffset(content, 3)).toBe(12); // after "bravo\n"
    expect(lineStartOffset(content, 4)).toBe(20); // the empty line
    expect(lineStartOffset(content, 5)).toBe(21); // "delta"
  });

  it("clamps lines beyond the end to the last line", () => {
    expect(lineStartOffset(content, 99)).toBe(21);
  });

  it("clamps lines below 1 to the first line", () => {
    expect(lineStartOffset(content, 0)).toBe(0);
    expect(lineStartOffset(content, -5)).toBe(0);
  });

  it("handles empty content", () => {
    expect(lineStartOffset("", 3)).toBe(0);
  });
});

describe("centeredScrollTop", () => {
  it("centers the target line in the viewport", () => {
    // line 50, lineHeight 20, clientHeight 400:
    // top of line = 49*20 = 980; center it: 980 - 200 + 10 = 790
    expect(centeredScrollTop(50, 100, 20, 400)).toBe(790);
  });

  it("never returns a negative scrollTop", () => {
    expect(centeredScrollTop(1, 100, 20, 400)).toBe(0);
    expect(centeredScrollTop(5, 100, 20, 400)).toBe(0);
  });

  it("clamps the line to totalLines", () => {
    expect(centeredScrollTop(999, 100, 20, 400)).toBe(
      centeredScrollTop(100, 100, 20, 400),
    );
  });
});

describe("jumpEditorToLine", () => {
  it("focuses the editor and places the caret at the line start", () => {
    const editor = document.createElement("textarea");
    editor.value = "one\ntwo\nthree";
    document.body.appendChild(editor);

    jumpEditorToLine(editor, 3);

    expect(editor.selectionStart).toBe(8); // start of "three"
    expect(editor.selectionEnd).toBe(8);
    expect(editor.scrollTop).toBeGreaterThanOrEqual(0);
    editor.remove();
  });

  it("clamps out-of-range lines instead of throwing", () => {
    const editor = document.createElement("textarea");
    editor.value = "one\ntwo";
    document.body.appendChild(editor);

    jumpEditorToLine(editor, 42);

    expect(editor.selectionStart).toBe(4); // start of "two" (last line)
    editor.remove();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/features/editor/lib/__tests__/jumpToLine.test.ts`
Expected: FAIL — cannot resolve `../jumpToLine`.

- [ ] **Step 3: Write the implementation**

Create `src/features/editor/lib/jumpToLine.ts`:

```ts
/**
 * Helpers to jump the Markdown editor textarea to a given 1-indexed source
 * line: caret at the line start, line vertically centered in the viewport.
 */

function clampLine(line: number, totalLines: number): number {
  return Math.min(Math.max(1, Math.floor(line)), Math.max(1, totalLines));
}

export function lineStartOffset(content: string, line: number): number {
  const lines = content.split("\n");
  const target = clampLine(line, lines.length);
  let offset = 0;
  for (let i = 0; i < target - 1; i++) {
    offset += lines[i].length + 1; // +1 for the newline
  }
  return offset;
}

export function centeredScrollTop(
  line: number,
  totalLines: number,
  lineHeight: number,
  clientHeight: number,
): number {
  const target = clampLine(line, totalLines);
  const lineTop = (target - 1) * lineHeight;
  return Math.max(0, lineTop - clientHeight / 2 + lineHeight / 2);
}

// Same measurement strategy as useScrollSync: computed line-height with a
// font-size fallback when it resolves to "normal".
function measureLineHeight(editor: HTMLTextAreaElement): number {
  const computed = getComputedStyle(editor);
  const lh = parseFloat(computed.lineHeight);
  if (!Number.isNaN(lh) && lh > 0) return lh;
  const fs = parseFloat(computed.fontSize);
  return Number.isFinite(fs) && fs > 0 ? fs * 1.4 : 20;
}

export function jumpEditorToLine(editor: HTMLTextAreaElement, line: number): void {
  const content = editor.value;
  const offset = lineStartOffset(content, line);
  editor.focus({ preventScroll: true });
  editor.setSelectionRange(offset, offset);
  const totalLines = content.split("\n").length;
  editor.scrollTop = centeredScrollTop(
    line,
    totalLines,
    measureLineHeight(editor),
    editor.clientHeight,
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/features/editor/lib/__tests__/jumpToLine.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add src/features/editor/lib/jumpToLine.ts src/features/editor/lib/__tests__/jumpToLine.test.ts
git commit -m "feat(editor): add jump-to-line helper for textarea"
```

---

### Task 2: Preview source-line resolver

**Files:**
- Create: `src/features/preview/lib/resolve-source-line.ts`
- Test: `src/features/preview/lib/__tests__/resolve-source-line.test.ts`

**Interfaces:**
- Consumes: nothing (leaf module). Relies on the `data-source-line` attribute contract from `src/shared/lib/markdown/render-with-source-lines.ts` (1-indexed positive integers on top-level blocks).
- Produces: `resolveSourceLine(target: HTMLElement): number | null` — walks up from the double-clicked node; returns the nearest ancestor's source line, or `null` when the click is on an openable image (`img[data-filepath]`, which has its own dblclick action) or no valid annotation exists. Task 3 imports it from `@/features/preview/lib/resolve-source-line`.

- [ ] **Step 1: Write the failing test**

Create `src/features/preview/lib/__tests__/resolve-source-line.test.ts`:

```ts
// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { resolveSourceLine } from "../resolve-source-line";

function render(html: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = html;
  return root;
}

describe("resolveSourceLine", () => {
  it("returns the line of the annotated element itself", () => {
    const root = render('<p data-source-line="7">hello</p>');
    const p = root.querySelector<HTMLElement>("p")!;
    expect(resolveSourceLine(p)).toBe(7);
  });

  it("resolves nested nodes to the nearest annotated ancestor", () => {
    const root = render(
      '<ul data-source-line="12"><li><strong>bold</strong></li></ul>',
    );
    const strong = root.querySelector<HTMLElement>("strong")!;
    expect(resolveSourceLine(strong)).toBe(12);
  });

  it("returns null when no ancestor is annotated", () => {
    const root = render("<p>plain</p>");
    const p = root.querySelector<HTMLElement>("p")!;
    expect(resolveSourceLine(p)).toBeNull();
  });

  it("returns null for openable images (handled by the open-as-tab action)", () => {
    const root = render(
      '<p data-source-line="3"><img data-filepath="C:/x.png"></p>',
    );
    const img = root.querySelector<HTMLElement>("img")!;
    expect(resolveSourceLine(img)).toBeNull();
  });

  it("still resolves images without data-filepath", () => {
    const root = render('<p data-source-line="3"><img src="x"></p>');
    const img = root.querySelector<HTMLElement>("img")!;
    expect(resolveSourceLine(img)).toBe(3);
  });

  it("returns null for non-positive or non-integer line values", () => {
    const zero = render('<p data-source-line="0">x</p>');
    expect(resolveSourceLine(zero.querySelector<HTMLElement>("p")!)).toBeNull();
    const nan = render('<p data-source-line="abc">x</p>');
    expect(resolveSourceLine(nan.querySelector<HTMLElement>("p")!)).toBeNull();
    const neg = render('<p data-source-line="-1">x</p>');
    expect(resolveSourceLine(neg.querySelector<HTMLElement>("p")!)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/features/preview/lib/__tests__/resolve-source-line.test.ts`
Expected: FAIL — cannot resolve `../resolve-source-line`.

- [ ] **Step 3: Write the implementation**

Create `src/features/preview/lib/resolve-source-line.ts`:

```ts
/**
 * Maps a double-clicked node inside the rendered Markdown preview to the
 * 1-indexed source line of its nearest annotated block, using the
 * `data-source-line` attributes emitted by renderMarkdownWithSourceLines.
 */
export function resolveSourceLine(target: HTMLElement): number | null {
  // Openable images have their own dblclick action (open as tab); let it win.
  if (target.closest("img[data-filepath]")) return null;
  const el = target.closest<HTMLElement>("[data-source-line]");
  if (!el) return null;
  const line = Number(el.dataset.sourceLine);
  if (!Number.isInteger(line) || line < 1) return null;
  return line;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/features/preview/lib/__tests__/resolve-source-line.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add src/features/preview/lib/resolve-source-line.ts src/features/preview/lib/__tests__/resolve-source-line.test.ts
git commit -m "feat(preview): resolve double-clicked preview node to source line"
```

---

### Task 3: Wire preview dblclick to editor jump

**Files:**
- Modify: `src/features/preview/components/PreviewPanel.tsx` (props at ~219-225; add an effect right after the image-dblclick effect at ~874-884)
- Modify: `src/app/App.tsx` (callback near other handlers; pass prop at the Markdown `<PreviewPanel>` usage, ~1200)

**Interfaces:**
- Consumes: `jumpEditorToLine(editor, line)` from Task 1; `resolveSourceLine(target)` from Task 2.
- Produces: `PreviewPanelProps.onJumpToLine?: (line: number) => void` (optional; when absent, no listener is attached).

- [ ] **Step 1: Add the prop and dblclick effect in `PreviewPanel.tsx`**

Add the import near the other `@/features` imports:

```ts
import { resolveSourceLine } from "@/features/preview/lib/resolve-source-line";
```

Extend the props interface (currently at lines 219-225):

```ts
interface PreviewPanelProps {
  previewRef: React.RefObject<HTMLDivElement | null>;
  onOpenFile?: (path: string) => void;
  onRefreshFileTree?: () => void;
  onJumpToLine?: (line: number) => void;
}

export function PreviewPanel({ previewRef, onOpenFile, onRefreshFileTree, onJumpToLine }: PreviewPanelProps) {
```

Add a new effect directly below the existing image-dblclick effect (after line 884), mirroring its pattern:

```ts
  // Double-click a rendered block to jump the editor to its source line
  useEffect(() => {
    const div = contentRef.current;
    if (!div || !onJumpToLine) return;
    const handler = (e: MouseEvent) => {
      const line = resolveSourceLine(e.target as HTMLElement);
      if (line !== null) onJumpToLine(line);
    };
    div.addEventListener("dblclick", handler);
    return () => div.removeEventListener("dblclick", handler);
  }, [onJumpToLine]);
```

- [ ] **Step 2: Add the callback in `App.tsx` and pass the prop**

Add the import near the other feature imports (after line 26):

```ts
import { jumpEditorToLine } from "@/features/editor/lib/jumpToLine";
```

Add the callback near the other `useCallback` handlers (e.g. after the `useScrollSync` call at line 95). It works regardless of the `scrollSync` setting; when the editor pane is hidden or unmounted it is a no-op:

```ts
  const handleJumpToEditorLine = useCallback((line: number) => {
    const editor = editorRef.current;
    if (!editor) return;
    jumpEditorToLine(editor, line);
  }, []);
```

Pass the prop ONLY at the Markdown-preview usage (~line 1200) — the office-file usage (~line 1178) has no editable Markdown source, leave it unchanged:

```tsx
                    <PreviewPanel
                      previewRef={previewRef}
                      onOpenFile={handleFileSelect}
                      onRefreshFileTree={loadFileTree}
                      onJumpToLine={handleJumpToEditorLine}
                    />
```

- [ ] **Step 3: Typecheck and run the full test suite**

Run: `npx tsc --noEmit`
Expected: no errors.

Run: `npm test`
Expected: PASS, including the two new test files.

- [ ] **Step 4: Manual smoke test (Tauri dev app)**

Run: `npm run tauri dev` (or ask the user to run it if the environment can't).
Verify with a Markdown file containing front matter, headings, paragraphs, a long code block, and an image:

1. Double-click a heading → editor scrolls so that line is near-center, caret at line start, editor focused.
2. Double-click a paragraph deep in the document → same, exact line.
3. Double-click mid-code-block → jumps to the code block's first line.
4. Double-click an image → opens as a tab (existing behavior preserved), no jump.
5. Toggle scroll sync OFF → double-click jump still works.
6. Double-click preview padding (outside any block) → nothing happens.

- [ ] **Step 5: Commit**

```bash
git add src/features/preview/components/PreviewPanel.tsx src/app/App.tsx
git commit -m "feat(preview): double-click preview block to jump editor to source line"
```
