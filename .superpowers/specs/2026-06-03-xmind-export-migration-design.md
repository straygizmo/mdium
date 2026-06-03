# Design: Migrate mindmap save format from KityMinder (.km) to XMind (.xmind)

- **Date**: 2026-06-03
- **Status**: Approved (design)
- **Author**: brainstorming session

## 1. Goal & Scope

Replace the mindmap module's native save format. Currently mindmaps are saved as
KityMinder JSON (`.km`); reading already supports both `.km` and `.xmind`
(read-only, via `xmind-parser.ts`). We will make `.xmind` the **only** format the
module reads and writes.

### Decisions (from brainstorming)

1. **`.xmind` is the only native (editable) format.** The mindmap editor reads and
   writes `.xmind` exclusively. `.km` is NOT an editable format anymore. However,
   `.km` is retained as a **one-way import source** (see Section 8): opening a `.km`
   file auto-converts it to `.xmind`. (User confirmed `.km` is otherwise unused.)
2. **Write both `content.json` (XMind 2020/Zen) and `content.xml` (XMind 8)** into
   the ZIP for maximum interoperability.
3. **Preserve layout and theme on round-trip.**
   - Layout (`template`) maps to the root topic's `structureClass` (native XMind,
     renders correctly in XMind too).
   - Theme name is stored in `metadata.json` under an `mdium` extension key and
     restored on load.
   - The parser is extended to read `structureClass → layout` and
     `metadata.mdium.theme → theme`.
4. Images, notes, hyperlinks, priority, progress, and collapse state round-trip.

### Non-goals (YAGNI)

- No multi-sheet support (single sheet, matching current model).
- No XMind theme/style mapping beyond storing our own theme name.
- No `.mm` (Freemind) support.

### Legal note

Implementing the open, ZIP/JSON-based `.xmind` format with our own serializer is a
standard interoperability use and is fine. Constraints: use the "XMind" name only
descriptively in UI (no logos / no implied endorsement), do not copy XMind source
or bundled assets, and document that compatibility is best-effort (no warranty).

## 2. Architecture & Components

```
src/features/mindmap/lib/
  xmind-parser.ts        (existing, extended)  .xmind -> KityMinderJson
  xmind-serializer.ts    (new)                 KityMinderJson -> Uint8Array (.xmind ZIP)
  xmind-structure.ts     (new)                 layout <-> structureClass mapping
  types.ts               (existing)            shared types

src/shared/lib/constants.ts        (modified)  remove ".km" from MINDMAP_EXTENSIONS
src/app/App.tsx                    (modified)  save via binary writeFile; SaveAs filter -> xmind
src/features/mindmap/components/MindmapEditor.tsx (modified) save path adjustments
```

### Responsibilities

- **`xmind-serializer.ts`** — single responsibility: take a `KityMinderJson` and
  return the `.xmind` ZIP as `Uint8Array`. Internally builds `content.json`,
  `content.xml`, `metadata.json`, `manifest.json`, `META-INF/manifest.xml`, and
  stores images under `resources/`. Uses `JSZip.generateAsync`.
- **`xmind-structure.ts`** — the single source of truth for the bidirectional map
  between mdium layouts (`right/left/mind/bottom/filetree`) and XMind
  `structureClass` identifiers. Consumed by both parser and serializer.
- **`xmind-parser.ts`** — extended to read back `structureClass` and the
  `metadata.mdium` block so layout/theme survive a round-trip.

The internal model (`layout.ts`, ReactFlow, theme rendering) is **unchanged**.
`KityMinderJson` remains the sole boundary interface (returned by `getJson()`).

### Editability change

Currently `MindmapEditor` sets `readOnly = fileType === ".xmind"`, i.e. `.xmind`
opens read-only and `.km` was the editable format. After migration `.xmind` is the
editable native format, so this becomes `readOnly = false` and all editing handlers
(add/edit/delete/drag) apply to `.xmind`. The obsolete `mindmap.xmindReadOnly`
string may remain unused (harmless).

## 3. Data Flow

### Save (export)

```
MindmapEditor.getJson() -> KityMinderJson { root, theme, template }
  -> serializeToXmind(json)              // xmind-serializer.ts
       buildTopicTree(root)              // KityMinderNode -> XMind topic (recursive)
         text -> title
         note -> notes.plain.content
         hyperlink -> href
         priority/progress -> markers[]
         expandState=collapse -> branch:"folded"
         image(base64) -> resources/<uuid>.<ext> + reference
       structureClass = layoutToStructure(template)   // on root topic
       buildContentJson / buildContentXml
       buildMetadata({ theme, layout })
       buildManifests()
       JSZip.generateAsync -> Uint8Array
  -> App.tsx: writeFile(path, bytes)     // @tauri-apps/plugin-fs (binary)
```

### Load (extended)

```
fileData(.xmind) -> parseXmindFile()
  content.json/xml      -> KityMinderJson.root            (existing)
  rootTopic.structureClass -> template (structureToLayout) (new)
  metadata.mdium.theme  -> theme (fallback fresh-blue)     (new)
  images from resources/attachments -> base64              (existing)
```

Save/load become symmetric functions (`serializeToXmind` <-> `parseXmindFile`)
with `KityMinderJson` as the only boundary. The single IPC change is switching the
mindmap save from `write_text_file` (string) to `writeFile` (bytes); App.tsx
already uses `writeFile` elsewhere.

## 4. Field Mapping

### Node data (KityMinder <-> XMind topic)

| KityMinder | content.json | content.xml | Notes |
|---|---|---|---|
| `data.text` | `title` | `<title>` | complete |
| `children[]` | `children.attached[]` | `<children><topics type="attached">` | recursive |
| `note` | `notes.plain.content` | `<notes><plain>` | Markdown stored as-is |
| `hyperlink` | `href` | `xlink:href` attr | complete |
| `hyperlinkTitle` | `xlink:title` on topic | `xlink:title` attr | parser already reads `data["xlink:title"]`; round-trips |
| `priority` (1-5) | `markers:[{markerId:"priority-N"}]` | `<marker-ref marker-id="priority-N"/>` | complete |
| `progress` (1-9) | `markers:[{markerId:"task-<key>"}]` | `<marker-ref marker-id="task-<key>"/>` | index<->key via existing `TASK_MARKERS` |
| `image` (base64) | `image:{src:"xap:resources/<id>.<ext>", width, height}` | `<xhtml:img xhtml:src="xap:resources/...">` | base64 decoded into ZIP |
| `imageSize` | `image.width/height` | `svg:width`/`svg:height` | complete |
| `expandState:"collapse"` | `branch:"folded"` | `branch="folded"` attr | complete |

### Map-level (template / theme)

| KityMinder | Stored as | Restored via |
|---|---|---|
| `template: right` | root `structureClass: org.xmind.ui.logic.right` | structureToLayout |
| `template: left` | `org.xmind.ui.logic.left` | "" |
| `template: mind` | `org.xmind.ui.map.unbalanced` | "" |
| `template: bottom` | `org.xmind.ui.org-chart.down` | "" |
| `template: filetree` | `org.xmind.ui.tree.right` | "" |
| `theme: <name>` | `metadata.json` -> `mdium.theme` | metadata -> theme (else fresh-blue) |

`structureToLayout` reverse map: `logic.right->right`, `logic.left->left`,
`map.*->mind`, `org-chart.*->bottom`, `tree.*->filetree`, unknown -> `right`.

### Image storage policy

Images are stored once at `resources/<uuid>.<ext>` and referenced from both
`content.json` and `content.xml`. XMind 8 (which historically used `attachments/`)
may not preview these, but mdium round-trip and current XMind work. Documented as a
known limitation.

## 5. Error Handling

| Situation | Behavior |
|---|---|
| Corrupt/invalid base64 image | Validate `data:image/<ext>;base64,`; on mismatch drop the image, keep node as text, `console.warn`; do not abort |
| Serialize failure (per image) | Skip that image, continue |
| Binary write failure (`writeFile`) | Match existing save error handling: `console.error` + i18n user notification |
| Unknown `structureClass` on load | Fall back to `right` |
| Missing/corrupt metadata on load | `theme` falls back to `fresh-blue`; never throw |
| Opening a `.km` file | Not recognized as mindmap (treated as code file) — consistent with full removal |

i18n: any new user-facing strings use existing `t("mindmap.*")` keys. No hardcoded
UI strings (per CLAUDE.md).

## 6. Testing Strategy (TDD, vitest)

Runner: `vitest` (`npm test`). JSZip, xml-js, @tauri-apps/plugin-fs already present.

1. **Round-trip unit tests (core)** — `KityMinderJson -> serializeToXmind ->
   parseXmindFile -> KityMinderJson` equals the original.
   Cases: single node; deep tree; all fields (note, hyperlink, priority, progress,
   image, collapse); each of the 5 layouts; representative themes.
2. **structureClass mapping (bidirectional)** in `xmind-structure.ts` — 5 layouts
   round-trip; unknown identifier -> `right`.
3. **ZIP structure** — generated output contains `content.json`, `content.xml`,
   `metadata.json`, `manifest.json`, `META-INF/manifest.xml`.
4. **Images** — base64 image is stored under `resources/` and restored to identical
   base64; corrupt base64 is skipped.
5. **Regression** — keep/add `.xmind` read tests for the parser extensions.

## 8. KityMinder JSON Import Bridge (MD→mindmap command)

The opencode builtin command `convert-to-xmind-mindmap` generates a KityMinder JSON
file from Markdown. A text command cannot emit a binary `.xmind` ZIP, so the command
keeps generating KityMinder JSON (extension `.km`) as a transient intermediate, and
mdium converts it on open and then removes it.

**Flow when a `.km` file is opened:**

```
open .km
  -> read bytes -> TextDecoder -> JSON.parse  (KityMinderJson)
  -> serializeToXmind(json) -> Uint8Array
  -> writeFile(<dir>/<basename>.xmind, bytes)   // create sibling .xmind
  -> remove(<.km>)                              // delete the transient intermediate (guarded: only if path differs)
  -> open the new .xmind in the editor
  -> notify user (i18n: mindmap.kmConverted)
```

This keeps `.km` strictly a one-way, transient import source (no `.km` editing/
saving; the file is removed after a successful conversion). The KityMinder JSON shape
is the same one `getJson()` already returns, so parsing is a plain `JSON.parse` — no
separate schema code. Deletion happens inside the same try/catch, so a write/remove
failure surfaces via `mindmap.kmImportFailed` and does not proceed.

The command's description/instructions are updated to state the output is a temporary
intermediate that is auto-converted to `.xmind` (and removed) when opened in mdium.
Output path/extension stays `.km`.

**Error handling:** if JSON.parse fails or `root` is missing, show
`mindmap.kmImportFailed` and do not create an `.xmind`.

## 9. Affected Files (summary)

- New: `src/features/mindmap/lib/xmind-serializer.ts`
- New: `src/features/mindmap/lib/xmind-structure.ts`
- New: tests under `src/features/mindmap/lib/__tests__/`
- Edit: `src/features/mindmap/lib/xmind-parser.ts` (structureClass + metadata read)
- Edit: `src/shared/lib/constants.ts` (`.km` no longer a mindmap-edit ext; add helper
  to detect `.km` as import source)
- Edit: `src/app/App.tsx` (binary save via `serializeToXmind`+`writeFile` at all 3
  save sites; SaveAs filter `xmind`; `.km` open → convert-and-open bridge)
- Edit: `src/features/mindmap/components/MindmapEditor.tsx` (`readOnly=false`; load
  path always `parseXmindFile`; remove `.km` JSON.parse branch)
- Edit: `src/features/file-tree/components/FileTree.tsx` (`.xmind` icon)
- Edit: `src/features/file-tree/components/LeftPanel.tsx` (replace `.km` reference)
- Edit: `src/features/opencode-config/lib/builtin-commands.ts` (note auto-conversion)
- Edit: i18n `editor.json` (en/ja): add `mindmap.kmConverted`, `mindmap.kmImportFailed`,
  `mindmap.failedToSave`
