# Batch Convert: Save Output to `.mdium/` Folder — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a checkbox to the batch convert dialog that writes each generated `.md` (and its asset folder) into the source file's sibling `.mdium/` directory, with the "skip existing" option judged against the effective save location.

**Architecture:** A new `saveToMdium` boolean state in `BatchConvertModal` flows through the conversion pipeline. Each converter accepts `saveToMdium` and derives its `outputDir` as `{sourceDir}/.mdium` instead of `{sourceDir}`. The existing-`.md` check is replaced with a pair of flags (`hasExistingMdSibling` + `hasExistingMdInMdium`) populated once at dialog open; `hasExistingMdInMdium` comes from a new Tauri command that walks each source file's parent `.mdium/` folder. A single `effectiveHasExistingMd` helper drives every skip/selection/badge decision.

**Tech Stack:** TypeScript, React 19, Tauri 2, Rust (backend command), i18next.

**Spec:** `.superpowers/specs/2026-04-13-batch-convert-mdium-output-design.md`

**Test Strategy Note:** This project has `vitest` installed but no unit tests exist under `src/`. Setting up vitest infrastructure (config file, tsconfig, test helpers) is out of scope for this feature. Verification relies on **TypeScript (`pnpm run build` / `tsc --noEmit`)**, **Rust (`cargo check` under `src-tauri/`)**, and **a manual test plan** at the end. Each task still ends with a discrete verification command and a commit.

**File Structure:**

| File | Role | Action |
|---|---|---|
| `src/shared/i18n/locales/ja/common.json` | ja strings | add 1 key |
| `src/shared/i18n/locales/en/common.json` | en strings | add 1 key |
| `src-tauri/src/commands/file.rs` | Tauri file commands | add `check_mdium_md_exists` |
| `src-tauri/src/lib.rs` | command registration | register new command |
| `src/features/export/lib/collectConvertibleFiles.ts` | tree/file model | rename `hasExistingMd` → `hasExistingMdSibling`; add `hasExistingMdInMdium` |
| `src/features/export/lib/docxToMarkdown.ts` | docx converter | add `saveToMdium` param, derive `outputDir` |
| `src/features/export/lib/xlsxToMarkdown.ts` | xlsx converter | same |
| `src/features/export/lib/pdfToMarkdown.ts` | pdf converter | same |
| `src/features/export/hooks/useBatchConvert.ts` | convert driver | accept `saveToMdium`, thread through, effective skip calc |
| `src/features/export/components/BatchConvertModal.tsx` | dialog UI | new state, checkbox, effective helper, mdium merge, useEffects |
| `src/features/export/components/BatchConvertTree.tsx` | tree container | forward `saveToMdium` |
| `src/features/export/components/BatchConvertTreeNode.tsx` | tree row | use effective helper for checkstate/disabled/badge |
| `src/features/export/components/BatchConvertModal.css` | styling | (only if spacing breaks) |

---

## Task 1: Add i18n Strings

**Files:**
- Modify: `src/shared/i18n/locales/ja/common.json`
- Modify: `src/shared/i18n/locales/en/common.json`

- [ ] **Step 1: Add Japanese string**

In `src/shared/i18n/locales/ja/common.json`, find the line:

```json
  "batchConvertSkipExisting": "既存.mdをスキップ",
```

Insert a new key immediately above it:

```json
  "batchConvertSaveToMdium": "保存先を.mdium内にする",
  "batchConvertSkipExisting": "既存.mdをスキップ",
```

- [ ] **Step 2: Add English string**

In `src/shared/i18n/locales/en/common.json`, find:

```json
  "batchConvertSkipExisting": "Skip existing .md files",
```

Insert above it:

```json
  "batchConvertSaveToMdium": "Save to .mdium folder",
  "batchConvertSkipExisting": "Skip existing .md files",
```

- [ ] **Step 3: Verify JSON validity**

Run: `node -e "JSON.parse(require('fs').readFileSync('src/shared/i18n/locales/ja/common.json','utf8')); JSON.parse(require('fs').readFileSync('src/shared/i18n/locales/en/common.json','utf8')); console.log('ok')"`

Expected output: `ok`

- [ ] **Step 4: Commit**

```bash
git add src/shared/i18n/locales/ja/common.json src/shared/i18n/locales/en/common.json
git commit -m "feat(i18n): add batchConvertSaveToMdium key"
```

---

## Task 2: Add Tauri Command `check_mdium_md_exists`

**Files:**
- Modify: `src-tauri/src/commands/file.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Add the command in `commands/file.rs`**

Open `src-tauri/src/commands/file.rs`. At the top near the other `use` imports, confirm `std::collections::HashMap` is usable (if not already imported, add `use std::collections::HashMap;`). Then append this function at the bottom of the file (just before the final closing of the module, i.e., after the last existing `#[tauri::command]` function):

```rust
/// For each source file path, check whether
/// `{parent_dir}/.mdium/{file_stem}.md` exists on disk.
///
/// Returns a map keyed by the input path strings. Paths whose parent
/// directory cannot be determined are reported as `false`.
#[tauri::command]
pub fn check_mdium_md_exists(paths: Vec<String>) -> HashMap<String, bool> {
    let mut result = HashMap::with_capacity(paths.len());
    for raw in paths {
        let src = Path::new(&raw);
        let exists = match (src.parent(), src.file_stem()) {
            (Some(parent), Some(stem)) => {
                let mut md_path = parent.join(".mdium");
                md_path.push(format!("{}.md", stem.to_string_lossy()));
                md_path.is_file()
            }
            _ => false,
        };
        result.insert(raw, exists);
    }
    result
}
```

**Note:** `std::path::Path` is already in use in this file (it's used by `get_file_tree`), so no additional import is needed. Confirm `HashMap` is in scope — if a `use std::collections::HashMap;` line isn't already present at the top of the file, add it.

- [ ] **Step 2: Register the command in `lib.rs`**

Open `src-tauri/src/lib.rs` and find the `invoke_handler(tauri::generate_handler![` block. Locate the `// File operations` section (around line 103) where `commands::file::*` entries are listed. Add a new line in that section:

```rust
            commands::file::check_mdium_md_exists,
```

Place it after `commands::file::open_in_default_app,` or any convenient spot inside the File operations group.

- [ ] **Step 3: Verify backend compiles**

Run: `cd src-tauri && cargo check`
Expected: `Finished ... dev [unoptimized + debuginfo] target(s) in ...` with no errors. Warnings about unused imports are acceptable but should be investigated if new.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands/file.rs src-tauri/src/lib.rs
git commit -m "feat(batch-convert): add check_mdium_md_exists Tauri command"
```

---

## Task 3: Extend `ConvertibleFile` Model with Two Existence Flags

**Files:**
- Modify: `src/features/export/lib/collectConvertibleFiles.ts`
- Modify: `src/features/export/components/BatchConvertModal.tsx` (type references)
- Modify: `src/features/export/components/BatchConvertTreeNode.tsx` (type references)

This is a pure rename + field addition. The new field starts as `false` everywhere and gets populated in Task 4.

- [ ] **Step 1: Update types in `collectConvertibleFiles.ts`**

In `src/features/export/lib/collectConvertibleFiles.ts`:

Replace the `ConvertibleFile` interface:

```ts
export interface ConvertibleFile {
  name: string;
  path: string;
  type: "docx" | "pdf" | "xlsx";
  hasExistingMdSibling: boolean;
  hasExistingMdInMdium: boolean;
}
```

Replace the `ConvertibleTreeNode` interface:

```ts
export interface ConvertibleTreeNode {
  name: string;
  path: string;
  isDir: boolean;
  children: ConvertibleTreeNode[] | null;
  fileType?: "docx" | "pdf" | "xlsx";
  hasExistingMdSibling?: boolean;
  hasExistingMdInMdium?: boolean;
}
```

- [ ] **Step 2: Update `walkTree` (flat collector) to emit both flags**

Replace the file-emitting block inside `walkTree` (the lines starting from `const baseName = entry.name.replace...` through `results.push({...})`) with:

```ts
    const baseName = entry.name.replace(/\.\w+$/i, "");
    const hasExistingMdSibling = siblingNames.has(`${baseName}.md`.toLowerCase());

    results.push({
      name: entry.name,
      path: entry.path,
      type,
      hasExistingMdSibling,
      hasExistingMdInMdium: false,
    });
```

- [ ] **Step 3: Update `buildConvertibleTree` to emit both flags**

In `buildConvertibleTree`, replace the file-emitting block (the lines starting from `const baseName = entry.name.replace...` through `result.push({...})` near the end of the for-loop) with:

```ts
    const baseName = entry.name.replace(/\.\w+$/i, "");
    const hasExistingMdSibling = siblingNames.has(`${baseName}.md`.toLowerCase());

    result.push({
      name: entry.name,
      path: entry.path,
      isDir: false,
      children: null,
      fileType,
      hasExistingMdSibling,
      hasExistingMdInMdium: false,
    });
```

- [ ] **Step 4: Update `BatchConvertModal.tsx` initial-selection references**

In `src/features/export/components/BatchConvertModal.tsx`, find the initial-selection block around line 28:

```ts
  const [selected, setSelected] = useState<Set<string>>(() => {
    // Initially select all files that don't have existing .md
    const set = new Set<string>();
    for (const f of files) {
      if (!f.hasExistingMd) {
        set.add(f.path);
      }
    }
    return set;
  });
```

Replace `f.hasExistingMd` with `f.hasExistingMdSibling`:

```ts
  const [selected, setSelected] = useState<Set<string>>(() => {
    const set = new Set<string>();
    for (const f of files) {
      if (!f.hasExistingMdSibling) {
        set.add(f.path);
      }
    }
    return set;
  });
```

Find `handleSelectAll` around line 48:

```ts
        if (skipExisting) {
          const file = files.find((f) => f.path === p);
          if (file?.hasExistingMd) continue;
        }
```

Replace `file?.hasExistingMd` with `file?.hasExistingMdSibling`.

Find `handleToggleFolder` around line 86:

```ts
          if (skipExisting) {
            const file = files.find((f) => f.path === p);
            if (file?.hasExistingMd) continue;
          }
```

Replace `file?.hasExistingMd` with `file?.hasExistingMdSibling`.

Find the `useEffect([skipExisting])` around line 122:

```ts
    if (skipExisting) {
      setSelected((prev) => {
        const next = new Set(prev);
        for (const f of files) {
          if (f.hasExistingMd) {
            next.delete(f.path);
          }
        }
        return next;
      });
    }
```

Replace `f.hasExistingMd` with `f.hasExistingMdSibling`.

(All of these `sibling` references are **temporary** — they will become `effectiveHasExistingMd(f)` in Task 7. This intermediate step preserves current behavior so the rename commit stays a pure refactor.)

- [ ] **Step 5: Update `BatchConvertTreeNode.tsx` references**

In `src/features/export/components/BatchConvertTreeNode.tsx`, update `getCheckState` (around line 30):

Replace:

```ts
function getCheckState(
  node: ConvertibleTreeNode,
  selected: Set<string>,
  skipExisting: boolean
): CheckState {
  if (!node.isDir) {
    if (skipExisting && node.hasExistingMd) return "unchecked";
    return selected.has(node.path) ? "checked" : "unchecked";
  }
  const files = collectDescendantFiles(node);
  const selectable = skipExisting
    ? files.filter((f) => !f.hasExistingMd)
    : files;
```

With:

```ts
function getCheckState(
  node: ConvertibleTreeNode,
  selected: Set<string>,
  skipExisting: boolean
): CheckState {
  if (!node.isDir) {
    if (skipExisting && node.hasExistingMdSibling) return "unchecked";
    return selected.has(node.path) ? "checked" : "unchecked";
  }
  const files = collectDescendantFiles(node);
  const selectable = skipExisting
    ? files.filter((f) => !f.hasExistingMdSibling)
    : files;
```

Further down in the component body (around line 65), replace:

```ts
  const isDisabled = !node.isDir && skipExisting && !!node.hasExistingMd;
```

With:

```ts
  const isDisabled = !node.isDir && skipExisting && !!node.hasExistingMdSibling;
```

And the badge (around line 122):

```tsx
        {!node.isDir && node.hasExistingMd && (
          <span className="batch-convert__item-badge">.md exists</span>
        )}
```

Replace with:

```tsx
        {!node.isDir && node.hasExistingMdSibling && (
          <span className="batch-convert__item-badge">.md exists</span>
        )}
```

- [ ] **Step 6: Typecheck**

Run: `pnpm tsc --noEmit` (or `npx tsc --noEmit` if pnpm is not the package manager of record).
Expected: zero errors. If errors appear about `hasExistingMd` missing on some other file, grep for it and update the reference to `hasExistingMdSibling`:

```bash
grep -rn "hasExistingMd[^SI]" src/features/export/
```

(Each hit should be either an `s` or `nM`, the full property name, not a broken reference.)

- [ ] **Step 7: Commit**

```bash
git add src/features/export/lib/collectConvertibleFiles.ts \
        src/features/export/components/BatchConvertModal.tsx \
        src/features/export/components/BatchConvertTreeNode.tsx
git commit -m "refactor(batch-convert): split hasExistingMd into sibling and mdium flags"
```

---

## Task 4: Populate `hasExistingMdInMdium` at Dialog Open

**Files:**
- Modify: `src/features/export/components/BatchConvertModal.tsx`

- [ ] **Step 1: Change `files` and `tree` to local state so they can be patched**

In `BatchConvertModal.tsx`, the component receives `files` and `tree` as props. Change them to be stored in local state, initialized from props, so we can merge in the mdium existence flags:

At the top of the component, just after `const { t } = useTranslation("common");`, add:

```ts
  const [files, setFiles] = useState<ConvertibleFile[]>(() => propFiles);
  const [tree, setTree] = useState<ConvertibleTreeNode[]>(() => propTree);
```

Rename the destructured props: change the props parameter from `{ files, tree, onClose, onComplete }` to `{ files: propFiles, tree: propTree, onClose, onComplete }`.

The existing code that reads `files` and `tree` will now read from state — no further changes needed in this step.

- [ ] **Step 2: Add the mdium check effect**

Immediately after the `useState` declarations, add a new effect that runs once on mount:

```ts
  useEffect(() => {
    let cancelled = false;
    const paths = propFiles.map((f) => f.path);
    if (paths.length === 0) return;
    (async () => {
      try {
        const existsMap = await invoke<Record<string, boolean>>(
          "check_mdium_md_exists",
          { paths }
        );
        if (cancelled) return;
        setFiles((prev) =>
          prev.map((f) => ({
            ...f,
            hasExistingMdInMdium: existsMap[f.path] ?? false,
          }))
        );
        setTree((prev) => patchTreeWithMdiumFlags(prev, existsMap));
      } catch (e) {
        console.error("check_mdium_md_exists failed", e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [propFiles]);
```

Add the corresponding imports / helper at the top of the file:

```ts
import { invoke } from "@tauri-apps/api/core";
```

And add this pure helper near the top of the file (above the component, below the imports):

```ts
function patchTreeWithMdiumFlags(
  nodes: ConvertibleTreeNode[],
  existsMap: Record<string, boolean>
): ConvertibleTreeNode[] {
  return nodes.map((node) => {
    if (node.isDir) {
      return {
        ...node,
        children: node.children
          ? patchTreeWithMdiumFlags(node.children, existsMap)
          : node.children,
      };
    }
    return {
      ...node,
      hasExistingMdInMdium: existsMap[node.path] ?? false,
    };
  });
}
```

- [ ] **Step 3: Typecheck**

Run: `pnpm tsc --noEmit`
Expected: zero errors.

- [ ] **Step 4: Commit**

```bash
git add src/features/export/components/BatchConvertModal.tsx
git commit -m "feat(batch-convert): fetch .mdium existence flags on dialog open"
```

---

## Task 5: Add `saveToMdium` State and Checkbox UI

**Files:**
- Modify: `src/features/export/components/BatchConvertModal.tsx`

- [ ] **Step 1: Add state**

Immediately after the existing `const [skipExisting, setSkipExisting] = useState(true);` line, add:

```ts
  const [saveToMdium, setSaveToMdium] = useState(false);
```

- [ ] **Step 2: Add the checkbox in the toolbar**

Locate the existing "skip existing" checkbox JSX around line 231:

```tsx
          <label className="batch-convert__skip-label">
            <input
              type="checkbox"
              checked={skipExisting}
              onChange={(e) => setSkipExisting(e.target.checked)}
            />
            {t("batchConvertSkipExisting")}
          </label>
```

Add a new label **immediately above** that block:

```tsx
          <label className="batch-convert__skip-label">
            <input
              type="checkbox"
              checked={saveToMdium}
              onChange={(e) => setSaveToMdium(e.target.checked)}
            />
            {t("batchConvertSaveToMdium")}
          </label>
```

**Note:** The existing `.batch-convert__skip-label` CSS uses `margin-left: auto`, which pushes the first labelled checkbox to the right edge of the toolbar. With two labels both having `margin-left: auto`, only the **first** label gets the auto margin; the second sits next to it. This is the desired layout (both checkboxes right-aligned as a group). Verify visually in Step 5.

- [ ] **Step 3: Typecheck**

Run: `pnpm tsc --noEmit`
Expected: zero errors.

- [ ] **Step 4: Quick visual verification**

Run: `pnpm run tauri dev` (start if not already running). Open the app, open a folder containing at least one `.docx`/`.pdf`/`.xlsx`, and open the batch convert dialog. Verify both checkboxes appear in the toolbar and are both clickable. The new "保存先を.mdium内にする" checkbox should be present but has no behavior yet.

- [ ] **Step 5: Commit**

```bash
git add src/features/export/components/BatchConvertModal.tsx
git commit -m "feat(batch-convert): add saveToMdium checkbox to toolbar"
```

---

## Task 6: Update Converters to Respect `saveToMdium`

**Files:**
- Modify: `src/features/export/lib/docxToMarkdown.ts`
- Modify: `src/features/export/lib/xlsxToMarkdown.ts`
- Modify: `src/features/export/lib/pdfToMarkdown.ts`

- [ ] **Step 1: Update `docxToMarkdown`**

In `src/features/export/lib/docxToMarkdown.ts`, change the function signature and path derivation. Replace lines 15–23 (the signature and the `dir` / `baseName` / `imagesDir` / `mdPath` declarations) with:

```ts
export async function docxToMarkdown(
  data: Uint8Array,
  docxPath: string,
  saveToMdium: boolean,
): Promise<ConvertResult> {
  // Derive output paths
  const dir = docxPath.replace(/[\\/][^\\/]*$/, "");
  const baseName = docxPath.replace(/^.*[\\/]/, "").replace(/\.docx$/i, "");
  const outputDir = saveToMdium ? `${dir}/.mdium` : dir;
  const imagesDir = `${outputDir}/${baseName}_images`;
  const mdPath = `${outputDir}/${baseName}.md`;
```

Then, immediately before `await writeTextFile(mdPath, markdown);` (around line 75), ensure the output dir exists when saving to `.mdium`. Find:

```ts
  // Save .md file
  await writeTextFile(mdPath, markdown);
```

Replace with:

```ts
  // Ensure output dir exists (needed when saving into .mdium/)
  if (saveToMdium) {
    await mkdir(outputDir, { recursive: true });
  }

  // Save .md file
  await writeTextFile(mdPath, markdown);
```

(`mkdir` is already imported at the top of the file.)

**Why the relative image paths are unchanged:** The markdown references `${baseName}_images/image1.png`. Since `imagesDir` now sits next to `mdPath` inside the same `outputDir`, the relative reference resolves identically to the previous (non-mdium) case.

- [ ] **Step 2: Update `xlsxToMarkdown`**

In `src/features/export/lib/xlsxToMarkdown.ts`, replace the signature and path derivation. Find lines 9–27:

```ts
export async function xlsxToMarkdown(
  data: Uint8Array,
  xlsxPath: string,
): Promise<ConvertResult> {
  const {
    parseWorkbook,
    convertWorkbookToMarkdownFiles,
    createCombinedMarkdownExportFile,
    createExportEntries,
  } = await import("@/vendor/xlsx2md");

  // ── Derive output paths ───────────────────────────────────────────────────
  const dir = xlsxPath.replace(/[\\/][^\\/]*$/, "");
  const baseName = xlsxPath
    .replace(/^.*[\\/]/, "")
    .replace(/\.(?:xlsx|xlsm|xls)$/i, "");
  const assetsDir = `${dir}/${baseName}_assets`;
  const imagesDir = `${assetsDir}/images`;
  const mdPath = `${dir}/${baseName}.md`;
```

Replace with:

```ts
export async function xlsxToMarkdown(
  data: Uint8Array,
  xlsxPath: string,
  saveToMdium: boolean,
): Promise<ConvertResult> {
  const {
    parseWorkbook,
    convertWorkbookToMarkdownFiles,
    createCombinedMarkdownExportFile,
    createExportEntries,
  } = await import("@/vendor/xlsx2md");

  // ── Derive output paths ───────────────────────────────────────────────────
  const dir = xlsxPath.replace(/[\\/][^\\/]*$/, "");
  const baseName = xlsxPath
    .replace(/^.*[\\/]/, "")
    .replace(/\.(?:xlsx|xlsm|xls)$/i, "");
  const outputDir = saveToMdium ? `${dir}/.mdium` : dir;
  const assetsDir = `${outputDir}/${baseName}_assets`;
  const imagesDir = `${assetsDir}/images`;
  const mdPath = `${outputDir}/${baseName}.md`;
```

Then ensure `outputDir` exists before writing. Find the block around line 85:

```ts
  // ── Save markdown ────────────────────────────────────────────────────────
  await writeTextFile(mdPath, markdown);
```

Replace with:

```ts
  // Ensure output dir exists (needed when saving into .mdium/)
  if (saveToMdium) {
    await mkdir(outputDir, { recursive: true });
  }

  // ── Save markdown ────────────────────────────────────────────────────────
  await writeTextFile(mdPath, markdown);
```

(`mkdir` is already imported.)

**Note:** The `mkdir(imagesDir, { recursive: true })` call that already exists around line 55 creates nested parents as needed, so when `saveToMdium` is true and there are assets, that call alone will also create the `.mdium` folder. The extra `mkdir(outputDir, …)` above handles the no-assets case where we'd otherwise try to write `mdPath` into a non-existent directory.

- [ ] **Step 3: Update `pdfToMarkdown`**

In `src/features/export/lib/pdfToMarkdown.ts`, replace the signature and path derivation. Find lines 11–25:

```ts
export async function pdfToMarkdown(
  data: Uint8Array,
  pdfPath: string
): Promise<ConvertResult> {
  const pdfjsLib = await import("pdfjs-dist");

  if (!workerConfigured) {
    const workerUrl = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
    pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
    workerConfigured = true;
  }

  const dir = pdfPath.replace(/[\\/][^\\/]*$/, "");
  const baseName = pdfPath.replace(/^.*[\\/]/, "").replace(/\.pdf$/i, "");
  const mdPath = `${dir}/${baseName}.md`;
```

Replace with:

```ts
export async function pdfToMarkdown(
  data: Uint8Array,
  pdfPath: string,
  saveToMdium: boolean,
): Promise<ConvertResult> {
  const pdfjsLib = await import("pdfjs-dist");

  if (!workerConfigured) {
    const workerUrl = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
    pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
    workerConfigured = true;
  }

  const dir = pdfPath.replace(/[\\/][^\\/]*$/, "");
  const baseName = pdfPath.replace(/^.*[\\/]/, "").replace(/\.pdf$/i, "");
  const outputDir = saveToMdium ? `${dir}/.mdium` : dir;
  const mdPath = `${outputDir}/${baseName}.md`;
```

Add `mkdir` to the top-level import. The file currently has:

```ts
import { writeTextFile } from "@tauri-apps/plugin-fs";
```

Replace with:

```ts
import { writeTextFile, mkdir } from "@tauri-apps/plugin-fs";
```

Finally, ensure the output dir exists before writing. Find the end of the function (around line 141):

```ts
  await writeTextFile(mdPath, markdown);

  return { mdPath };
}
```

Replace with:

```ts
  if (saveToMdium) {
    await mkdir(outputDir, { recursive: true });
  }

  await writeTextFile(mdPath, markdown);

  return { mdPath };
}
```

- [ ] **Step 4: Typecheck**

Run: `pnpm tsc --noEmit`
Expected: errors at the call sites in `useBatchConvert.ts` because the converter signatures now require a third argument. This is **expected** — it is fixed in Task 7. Do not commit yet.

Confirm the only errors are related to the missing `saveToMdium` argument at the `docxToMarkdown(...)`, `xlsxToMarkdown(...)`, and `pdfToMarkdown(...)` call sites.

- [ ] **Step 5: Stage (but do not commit yet)**

Do not commit in isolation — this change and Task 7 form a single atomic commit (signature change + caller update). Proceed immediately to Task 7.

---

## Task 7: Thread `saveToMdium` Through `useBatchConvert`

**Files:**
- Modify: `src/features/export/hooks/useBatchConvert.ts`

- [ ] **Step 1: Update the `convert` function signature**

In `src/features/export/hooks/useBatchConvert.ts`, find the `convert` callback around line 31:

```ts
  const convert = useCallback(
    async (files: ConvertibleFile[], skipExisting: boolean) => {
      setIsConverting(true);
      setSummary(null);
      abortRef.current = false;

      const targetFiles = skipExisting
        ? files.filter((f) => !f.hasExistingMd)
        : files;

      const results: BatchConvertFileResult[] = [];
      // Add skipped files to results
      if (skipExisting) {
        for (const f of files) {
          if (f.hasExistingMd) {
            results.push({ file: f, status: "skipped" });
          }
        }
      }
```

Replace with:

```ts
  const convert = useCallback(
    async (
      files: ConvertibleFile[],
      skipExisting: boolean,
      saveToMdium: boolean,
    ) => {
      setIsConverting(true);
      setSummary(null);
      abortRef.current = false;

      const isExisting = (f: ConvertibleFile) =>
        saveToMdium ? f.hasExistingMdInMdium : f.hasExistingMdSibling;

      const targetFiles = skipExisting
        ? files.filter((f) => !isExisting(f))
        : files;

      const results: BatchConvertFileResult[] = [];
      // Add skipped files to results
      if (skipExisting) {
        for (const f of files) {
          if (isExisting(f)) {
            results.push({ file: f, status: "skipped" });
          }
        }
      }
```

- [ ] **Step 2: Pass `saveToMdium` into each converter call**

Still in `useBatchConvert.ts`, find the conversion dispatch block around line 65:

```ts
          if (file.type === "docx") {
            const { docxToMarkdown } = await import("../lib/docxToMarkdown");
            const result = await docxToMarkdown(data, file.path);
            results.push({ file, status: "success", mdPath: result.mdPath });
          } else if (file.type === "xlsx") {
            const { xlsxToMarkdown } = await import("../lib/xlsxToMarkdown");
            const result = await xlsxToMarkdown(data, file.path);
            results.push({ file, status: "success", mdPath: result.mdPath });
          } else {
            const { pdfToMarkdown } = await import("../lib/pdfToMarkdown");
            const result = await pdfToMarkdown(data, file.path);
            results.push({ file, status: "success", mdPath: result.mdPath });
          }
```

Replace with:

```ts
          if (file.type === "docx") {
            const { docxToMarkdown } = await import("../lib/docxToMarkdown");
            const result = await docxToMarkdown(data, file.path, saveToMdium);
            results.push({ file, status: "success", mdPath: result.mdPath });
          } else if (file.type === "xlsx") {
            const { xlsxToMarkdown } = await import("../lib/xlsxToMarkdown");
            const result = await xlsxToMarkdown(data, file.path, saveToMdium);
            results.push({ file, status: "success", mdPath: result.mdPath });
          } else {
            const { pdfToMarkdown } = await import("../lib/pdfToMarkdown");
            const result = await pdfToMarkdown(data, file.path, saveToMdium);
            results.push({ file, status: "success", mdPath: result.mdPath });
          }
```

- [ ] **Step 3: Typecheck**

Run: `pnpm tsc --noEmit`
Expected: errors only at the `BatchConvertModal.tsx` call site (`convert(selectedFiles, skipExisting)` missing the new third argument). This will be fixed in Task 8.

- [ ] **Step 4: Stage (do not commit yet)**

Continue to Task 8 — atomic commit with the modal wire-up below.

---

## Task 8: Wire `saveToMdium` into `BatchConvertModal` Logic

**Files:**
- Modify: `src/features/export/components/BatchConvertModal.tsx`
- Modify: `src/features/export/components/BatchConvertTree.tsx`
- Modify: `src/features/export/components/BatchConvertTreeNode.tsx`

- [ ] **Step 1: Add `effectiveHasExistingMd` helper and use it in the modal**

In `BatchConvertModal.tsx`, define the helper inside the component, right after the `setSaveToMdium` state declaration and before `filteredTree`:

```ts
  const effectiveHasExistingMd = useCallback(
    (f: ConvertibleFile) =>
      saveToMdium ? f.hasExistingMdInMdium : f.hasExistingMdSibling,
    [saveToMdium]
  );
```

Now replace every `f.hasExistingMdSibling` / `file?.hasExistingMdSibling` reference inside the modal's selection logic with `effectiveHasExistingMd(f)` / `file ? effectiveHasExistingMd(file) : false`. Specifically:

Initial `useState<Set<string>>` initializer — change:

```ts
      if (!f.hasExistingMdSibling) {
        set.add(f.path);
      }
```

To:

```ts
      if (!effectiveHasExistingMd(f)) {
        set.add(f.path);
      }
```

**Wait** — `effectiveHasExistingMd` can't be referenced inside the `useState` initializer because that runs before the helper is defined. Instead, inline the initial-selection logic using the current `saveToMdium` value directly; since `saveToMdium` defaults to `false` and `hasExistingMdInMdium` is `false` at mount anyway, the simplest form is:

```ts
  const [selected, setSelected] = useState<Set<string>>(() => {
    const set = new Set<string>();
    for (const f of propFiles) {
      if (!f.hasExistingMdSibling) {
        set.add(f.path);
      }
    }
    return set;
  });
```

(No change needed from Task 3 — initial selection is based on the sibling flag at mount because `saveToMdium` is `false` and no mdium data has arrived yet.)

`handleSelectAll` — change:

```ts
        if (skipExisting) {
          const file = files.find((f) => f.path === p);
          if (file?.hasExistingMdSibling) continue;
        }
```

To:

```ts
        if (skipExisting) {
          const file = files.find((f) => f.path === p);
          if (file && effectiveHasExistingMd(file)) continue;
        }
```

Update the `useCallback` dependency array of `handleSelectAll` to include `effectiveHasExistingMd`.

`handleToggleFolder` — change:

```ts
          if (skipExisting) {
            const file = files.find((f) => f.path === p);
            if (file?.hasExistingMdSibling) continue;
          }
```

To:

```ts
          if (skipExisting) {
            const file = files.find((f) => f.path === p);
            if (file && effectiveHasExistingMd(file)) continue;
          }
```

Update its `useCallback` dependency array to include `effectiveHasExistingMd`.

`useEffect([skipExisting])` — change:

```ts
  useEffect(() => {
    if (skipExisting) {
      setSelected((prev) => {
        const next = new Set(prev);
        for (const f of files) {
          if (f.hasExistingMdSibling) {
            next.delete(f.path);
          }
        }
        return next;
      });
    }
  }, [skipExisting, files]);
```

To:

```ts
  useEffect(() => {
    if (skipExisting) {
      setSelected((prev) => {
        const next = new Set(prev);
        for (const f of files) {
          if (effectiveHasExistingMd(f)) {
            next.delete(f.path);
          }
        }
        return next;
      });
    }
  }, [skipExisting, saveToMdium, files, effectiveHasExistingMd]);
```

(Note: `saveToMdium` is now a dependency so the effect also re-runs on mode switch.)

- [ ] **Step 2: Pass `saveToMdium` into `convert`**

Still in `BatchConvertModal.tsx`, find the `handleConvert` callback:

```ts
  const handleConvert = useCallback(async () => {
    const selectedFiles = files.filter((f) => selected.has(f.path));
    if (selectedFiles.length === 0) return;
    await convert(selectedFiles, skipExisting);
  }, [files, selected, skipExisting, convert]);
```

Replace with:

```ts
  const handleConvert = useCallback(async () => {
    const selectedFiles = files.filter((f) => selected.has(f.path));
    if (selectedFiles.length === 0) return;
    await convert(selectedFiles, skipExisting, saveToMdium);
  }, [files, selected, skipExisting, saveToMdium, convert]);
```

- [ ] **Step 3: Pass `saveToMdium` into `BatchConvertTree`**

Find the `<BatchConvertTree ... />` usage around line 243:

```tsx
            <BatchConvertTree
              tree={filteredTree}
              selected={selected}
              onToggleFile={handleToggle}
              onToggleFolder={handleToggleFolder}
              skipExisting={skipExisting}
            />
```

Replace with:

```tsx
            <BatchConvertTree
              tree={filteredTree}
              selected={selected}
              onToggleFile={handleToggle}
              onToggleFolder={handleToggleFolder}
              skipExisting={skipExisting}
              saveToMdium={saveToMdium}
            />
```

- [ ] **Step 4: Update `BatchConvertTree` to forward `saveToMdium`**

In `src/features/export/components/BatchConvertTree.tsx`, update the props interface:

```ts
interface BatchConvertTreeProps {
  tree: ConvertibleTreeNode[];
  selected: Set<string>;
  onToggleFile: (path: string) => void;
  onToggleFolder: (paths: string[], select: boolean) => void;
  skipExisting: boolean;
  saveToMdium: boolean;
}
```

Destructure the new prop in the function parameters:

```ts
export function BatchConvertTree({
  tree,
  selected,
  onToggleFile,
  onToggleFolder,
  skipExisting,
  saveToMdium,
}: BatchConvertTreeProps) {
```

And forward it in the `<BatchConvertTreeNode />` usage:

```tsx
        <BatchConvertTreeNode
          key={node.path}
          node={node}
          depth={0}
          selected={selected}
          onToggleFile={onToggleFile}
          onToggleFolder={onToggleFolder}
          collapsed={collapsed}
          onToggleCollapse={handleToggleCollapse}
          skipExisting={skipExisting}
          saveToMdium={saveToMdium}
        />
```

- [ ] **Step 5: Update `BatchConvertTreeNode` to use effective flag**

In `src/features/export/components/BatchConvertTreeNode.tsx`, update the props interface:

```ts
interface BatchConvertTreeNodeProps {
  node: ConvertibleTreeNode;
  depth: number;
  selected: Set<string>;
  onToggleFile: (path: string) => void;
  onToggleFolder: (paths: string[], select: boolean) => void;
  collapsed: Set<string>;
  onToggleCollapse: (path: string) => void;
  skipExisting: boolean;
  saveToMdium: boolean;
}
```

Update `getCheckState` to accept `saveToMdium` and use it:

```ts
function getCheckState(
  node: ConvertibleTreeNode,
  selected: Set<string>,
  skipExisting: boolean,
  saveToMdium: boolean
): CheckState {
  const nodeExists = (n: ConvertibleTreeNode) =>
    saveToMdium ? !!n.hasExistingMdInMdium : !!n.hasExistingMdSibling;

  if (!node.isDir) {
    if (skipExisting && nodeExists(node)) return "unchecked";
    return selected.has(node.path) ? "checked" : "unchecked";
  }
  const files = collectDescendantFiles(node);
  const selectable = skipExisting
    ? files.filter((f) => !nodeExists(f))
    : files;
  if (selectable.length === 0) return "unchecked";
  const selectedCount = selectable.filter((f) => selected.has(f.path)).length;
  if (selectedCount === 0) return "unchecked";
  if (selectedCount === selectable.length) return "checked";
  return "indeterminate";
}
```

Update the component body to destructure and pass `saveToMdium`, and replace the `.hasExistingMdSibling` uses inside the component:

```tsx
export function BatchConvertTreeNode({
  node,
  depth,
  selected,
  onToggleFile,
  onToggleFolder,
  collapsed,
  onToggleCollapse,
  skipExisting,
  saveToMdium,
}: BatchConvertTreeNodeProps) {
  const checkboxRef = useRef<HTMLInputElement>(null);
  const isCollapsed = collapsed.has(node.path);

  const checkState = getCheckState(node, selected, skipExisting, saveToMdium);

  const effectiveExisting = saveToMdium
    ? !!node.hasExistingMdInMdium
    : !!node.hasExistingMdSibling;

  const isDisabled = !node.isDir && skipExisting && effectiveExisting;
```

Update the badge rendering to use `effectiveExisting`:

```tsx
        {!node.isDir && effectiveExisting && (
          <span className="batch-convert__item-badge">.md exists</span>
        )}
```

Forward `saveToMdium` in the recursive child `<BatchConvertTreeNode />` call inside the return JSX:

```tsx
            <BatchConvertTreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              selected={selected}
              onToggleFile={onToggleFile}
              onToggleFolder={onToggleFolder}
              collapsed={collapsed}
              onToggleCollapse={onToggleCollapse}
              skipExisting={skipExisting}
              saveToMdium={saveToMdium}
            />
```

- [ ] **Step 6: Typecheck**

Run: `pnpm tsc --noEmit`
Expected: zero errors.

- [ ] **Step 7: Commit (combined with Tasks 6 and 7)**

```bash
git add src/features/export/lib/docxToMarkdown.ts \
        src/features/export/lib/xlsxToMarkdown.ts \
        src/features/export/lib/pdfToMarkdown.ts \
        src/features/export/hooks/useBatchConvert.ts \
        src/features/export/components/BatchConvertModal.tsx \
        src/features/export/components/BatchConvertTree.tsx \
        src/features/export/components/BatchConvertTreeNode.tsx
git commit -m "feat(batch-convert): route output to .mdium when saveToMdium is on"
```

---

## Task 9: Full Build and Manual Verification

**Files:** none

- [ ] **Step 1: Full frontend build**

Run: `pnpm run build`
Expected: `vite v... building for production...` finishes with no TypeScript errors. A successful tsc + vite bundle is the gate.

- [ ] **Step 2: Backend compile**

Run: `cd src-tauri && cargo check && cd ..`
Expected: `Finished ...` with no errors.

- [ ] **Step 3: Start the dev app**

Run: `pnpm run tauri dev`
Wait for the window to open.

- [ ] **Step 4: Run the manual test matrix**

Use a folder that contains at least one `.docx`, one `.xlsx` (preferably with images), and one `.pdf`. Ensure neither the source folder nor a sibling `.mdium/` already contains matching `.md` files (clean state).

Open the batch convert dialog. For each scenario below, verify the outcome:

1. **Baseline (both checkboxes OFF):**
   - Select all, click 変換. Expect `.md` files next to the sources and assets in sibling `_images`/`_assets` folders (current behavior unchanged).
   - Close dialog. Confirm files exist at expected sibling paths.
   - Delete the generated `.md`s and asset folders before the next scenario.

2. **saveToMdium ON, skipExisting OFF:**
   - Open dialog. Toggle "保存先を.mdium内にする" ON. Toggle "既存.mdをスキップ" OFF.
   - Select all, click 変換.
   - Expect: `.md` files inside `{sourceDir}/.mdium/` alongside `{baseName}_images/` (for docx) and `{baseName}_assets/images/` (for xlsx) — all inside `.mdium/`.
   - Open one of the generated `.md` files and verify images render (relative path resolves).
   - Confirm the source folder itself is untouched (no `.md` or `_images` at the source level).

3. **saveToMdium ON, skipExisting ON, `.mdium/foo.md` exists from scenario 2:**
   - Reopen the dialog. Both checkboxes ON.
   - The files converted in scenario 2 should display the `.md exists` badge and be disabled.
   - A file that doesn't have a `.mdium/.md` yet should still be selectable.
   - Click 変換. Skipped count should match the previously-converted files.

4. **Toggle behaviour with mixed state:**
   - Pre-state: some files have sibling `.md` (left over from scenario 1), others have `.mdium/.md` (from scenario 2). Easiest way: run a partial convert in each mode.
   - Reopen the dialog with skipExisting ON.
   - Toggle saveToMdium OFF → disabled set should match files that have a **sibling** `.md`.
   - Toggle saveToMdium ON → disabled set should match files that have a **`.mdium/.md`**.
   - Selection count at the bottom button should update accordingly both ways.

5. **`.mdium/` folder does not yet exist:**
   - Pick a new clean folder. Toggle saveToMdium ON. Convert.
   - Expect: `.mdium/` is created automatically; `.md` and assets land inside it.

- [ ] **Step 5: If manual tests pass, commit any incidental fixes and tag the feature complete**

If any step revealed a bug, fix it, rerun the relevant manual step, and squash the fix into the Task 8 commit via a follow-up commit (do not amend published commits). If everything passes with no additional fixes:

```bash
git log --oneline -8
```

Expected: you should see the 5 commits from Tasks 1, 2, 3, 4, 5, and 8 (plus any earlier baseline commits).

No final commit is needed here — Task 9 is pure verification.

---

## Self-Review Notes

- **Spec coverage:** Each section of the spec maps to tasks — i18n (T1), backend command (T2), model extension (T3), mdium fetch (T4), UI checkbox (T5), converter path routing (T6), skip semantics (T7), effective helper / tree wiring / useEffect reactivity (T8), manual verification matrix (T9).
- **Type consistency:** Field names are consistent — `hasExistingMdSibling` / `hasExistingMdInMdium` throughout. `effectiveHasExistingMd` / `nodeExists` / `effectiveExisting` helpers all compute the same thing from the same two fields.
- **Signature consistency:** `docxToMarkdown(data, path, saveToMdium)`, `xlsxToMarkdown(data, path, saveToMdium)`, `pdfToMarkdown(data, path, saveToMdium)`, and `convert(files, skipExisting, saveToMdium)` all match their call sites in Task 8.
- **Atomic commits:** Task 6, 7, and 8 share one commit because the signature changes in 6/7 break the type check until 8 lands; splitting them would leave intermediate commits that don't compile.
