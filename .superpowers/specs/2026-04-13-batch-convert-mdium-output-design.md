# Batch Convert: Save Output to `.mdium/` Folder

Date: 2026-04-13
Status: Approved

## Problem

The batch convert dialog (`BatchConvertModal`) converts `.docx` / `.xlsx` / `.pdf` files to Markdown and writes both the `.md` and its asset folder next to the source file, cluttering the user's folders. Users want to keep generated artifacts out of their working directories while still co-locating them with the source for navigation purposes.

The `.mdium/` hidden folder convention is already used elsewhere in the project (e.g., RAG databases are stored per-folder under `.mdium/`), making it a natural place for generated outputs.

## Goals

- Add a new checkbox "保存先を.mdium内にする" (Save to .mdium folder) to the batch convert dialog.
- When enabled, write the `.md` and its asset folder to `{source_dir}/.mdium/` instead of `{source_dir}/`.
- Reconcile the new option with the existing "既存.mdをスキップ" (Skip existing .md) option so that "existing" is judged against the effective save location.

## Non-Goals

- Moving or migrating previously converted `.md` files already sitting in source folders.
- Changing where the RAG databases or other `.mdium/` contents live.
- Centralizing outputs to a workspace-root `.mdium/` (option A from brainstorming — rejected in favor of per-folder `.mdium/`, matching RAG DB placement).

## Design

### 1. UI

In `BatchConvertModal.tsx`, add a second checkbox next to "既存.mdをスキップ":

```
[All] [Docx] [Xlsx] [Pdf] | [全選択] [全解除]  ☐ 保存先を.mdium内にする  ☐ 既存.mdをスキップ
```

- New React state: `saveToMdium: boolean` — **defaults to `false`** to preserve existing behavior for users who upgrade.
- New i18n key `batchConvertSaveToMdium`:
  - ja: `"保存先を.mdium内にする"`
  - en: `"Save to .mdium folder"`

### 2. Output Path Logic

Each converter currently derives its output path like this:

```ts
const dir = sourcePath.replace(/[\\/][^\\/]*$/, "");
const baseName = /* strip extension */;
const mdPath = `${dir}/${baseName}.md`;
const imagesDir = `${dir}/${baseName}_images`; // or _assets for xlsx
```

Change each converter (`docxToMarkdown`, `xlsxToMarkdown`, `pdfToMarkdown`) to accept a new boolean parameter `saveToMdium` and derive paths from an `outputDir` that conditionally nests into `.mdium/`:

```ts
export async function docxToMarkdown(
  data: Uint8Array,
  docxPath: string,
  saveToMdium: boolean,
): Promise<ConvertResult> {
  const dir = docxPath.replace(/[\\/][^\\/]*$/, "");
  const baseName = docxPath.replace(/^.*[\\/]/, "").replace(/\.docx$/i, "");
  const outputDir = saveToMdium ? `${dir}/.mdium` : dir;
  if (saveToMdium) {
    await mkdir(outputDir, { recursive: true });
  }
  const mdPath = `${outputDir}/${baseName}.md`;
  const imagesDir = `${outputDir}/${baseName}_images`;
  // ...rest unchanged
}
```

Because the `.md` and its asset folder end up at the same level (both inside `.mdium/` when the option is on), the existing relative image references inside the Markdown (`${baseName}_images/image1.png`) resolve correctly with **no rewriting needed**.

`useBatchConvert.convert` receives an additional `saveToMdium` argument and threads it through to each converter call.

### 3. Existing `.md` Detection

Currently, `buildConvertibleTree` in `collectConvertibleFiles.ts` computes `hasExistingMd` from sibling file names in the front-end `FileEntry` tree. That tree excludes hidden directories (the backend `build_tree_filtered` / `build_tree_all` both skip entries starting with `.`), so `.mdium/` contents are not visible from the front-end tree.

Extend `ConvertibleFile` and `ConvertibleTreeNode` with **two** existence flags:

```ts
export interface ConvertibleFile {
  name: string;
  path: string;
  type: "docx" | "pdf" | "xlsx";
  hasExistingMdSibling: boolean;    // renamed from hasExistingMd
  hasExistingMdInMdium: boolean;    // new
}
```

- `hasExistingMdSibling` is computed as today, walking sibling file names in the `FileEntry` tree.
- `hasExistingMdInMdium` is populated by calling a **new Tauri command**:

```rust
#[tauri::command]
pub fn check_mdium_md_exists(paths: Vec<String>) -> HashMap<String, bool> {
    // For each source path, check whether {parent_dir}/.mdium/{base_name}.md exists.
}
```

`BatchConvertModal` calls this command once when the dialog opens (after `buildConvertibleTree`), merges the result into the tree nodes / flat file list, and then uses the merged data for all subsequent in-memory operations. The dialog does not re-query the backend when the checkbox toggles — both flags are already in memory.

### 4. "Effective Existing" Helper and Reactive Selection

Introduce a single helper used everywhere the old `hasExistingMd` was read:

```ts
const effectiveHasExistingMd = (f: ConvertibleFile): boolean =>
  saveToMdium ? f.hasExistingMdInMdium : f.hasExistingMdSibling;
```

Replace every usage of `hasExistingMd` in `BatchConvertModal.tsx` and `BatchConvertTree` / `BatchConvertTreeNode` with this helper (or a prop derived from it). Concretely:

- Initial selection: select files where `!effectiveHasExistingMd(f)`.
- `handleSelectAll` / `handleToggleFolder`: when `skipExisting` is on, exclude files where `effectiveHasExistingMd(f)` is true.
- `useEffect([skipExisting])`: when it fires with `skipExisting === true`, deselect files where `effectiveHasExistingMd(f)` is true.
- Tree node badge/icon indicating "already has .md": driven by `effectiveHasExistingMd`.

Add a second `useEffect` that reacts to `saveToMdium` changes. When the checkbox toggles (and `skipExisting` is on), recompute the selection: re-add files that were skipped under the old mode but aren't "existing" under the new mode, and remove files that are "existing" under the new mode. The simplest formulation is "re-run the initial selection rule" gated on `skipExisting`.

### 5. Skip Semantics in `useBatchConvert`

`useBatchConvert.convert(files, skipExisting, saveToMdium)` computes the skip set using `effectiveHasExistingMd` as well — not `hasExistingMdSibling` — so that the conversion loop skips whichever files already have an `.md` at the effective destination. The summary's "skipped" count reflects the effective location.

## Architecture Summary

```
BatchConvertModal
  ├── open → buildConvertibleTree (sibling check)
  ├── open → invoke("check_mdium_md_exists", paths) → merge into tree
  ├── state: saveToMdium, skipExisting
  ├── derives: effectiveHasExistingMd(f)
  └── on convert → useBatchConvert.convert(files, skipExisting, saveToMdium)
                     └── docx/xlsx/pdfToMarkdown(data, path, saveToMdium)
                           └── writes to {dir}/.mdium/ or {dir}/
```

## Data Flow

1. User opens batch convert dialog.
2. Front end builds `ConvertibleTreeNode` from the in-memory `FileEntry` tree (sibling-based `hasExistingMdSibling`).
3. Front end collects all convertible file paths and calls `check_mdium_md_exists` once; backend walks each unique parent directory's `.mdium/` folder and returns a `{path → bool}` map.
4. Front end merges `hasExistingMdInMdium` into the tree and flat list.
5. User toggles filter / selection / `saveToMdium` / `skipExisting`; all decisions use `effectiveHasExistingMd`.
6. User clicks convert; `useBatchConvert` passes `saveToMdium` to each converter, which writes to the effective location.

## Error Handling

- If `check_mdium_md_exists` fails (e.g., permission error), log the error and treat all `hasExistingMdInMdium` as `false`. The dialog still works; the user just doesn't get accurate skip detection for the `.mdium` mode.
- If `mkdir` for `.mdium/` fails during conversion, the error is recorded in the per-file `BatchConvertFileResult` as today (via the surrounding try/catch in `useBatchConvert`).

## Testing

- **Manual**: toggle `saveToMdium` with various combinations of `skipExisting`; verify selection updates correctly; verify `.md` and asset folder land in `.mdium/` and images resolve.
- **Cross-file-type**: test docx, xlsx (with images in assets), and pdf paths.
- **Edge case**: source folder that already has both a sibling `.md` and a `.mdium/{name}.md` — each mode should skip only its own target.
- **Edge case**: `.mdium/` folder does not exist yet — conversion creates it.

## Open Questions

None.

## Decisions Log

- **Per-folder `.mdium/` vs workspace-root `.mdium/`**: chose per-folder to match RAG DB placement conventions already in the project.
- **Assets location when `saveToMdium` is on**: chose "assets also go into `.mdium/`" so the source folder stays clean and relative image paths in the generated Markdown need no rewriting.
- **"Existing" judgment**: chose "check the effective save location only" — more intuitive than always checking both locations.
- **Default state**: `saveToMdium` defaults to `false` to preserve current behavior on upgrade.
