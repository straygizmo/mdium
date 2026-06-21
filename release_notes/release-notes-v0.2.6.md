# Release Notes — v0.2.6

## Highlights

This release expands MDium's document support. It adds **PowerPoint (.pptx) support** — batch conversion to Markdown, a read-only in-app preview, and opt-in AI semantic enrichment of slide layouts. It introduces **Markdown → Excel (.xlsx) export** with a new preview panel that embeds images and Mermaid diagrams. It also ships an **in-app image editor** with crop and numeric resize tools, plus several responsiveness fixes that move heavy file-system scans off the main thread.

---

## New Features

### PowerPoint (.pptx) Support
- Batch-convert `.pptx` files to Markdown, preserving presentation order
- Extracts slide headings, bullets (scoped to `txBody`), tables (`a:tbl`) in appearance order, speaker notes, and grouped/nested shapes
- Resolves `p:pic` images via slide relationships with de-duplication of shared images
- Open `.pptx` as a preview-only tab that renders as Markdown with inline data-URL images (editor hidden, save guarded)
- Opt-in **AI diagram interpretation**: extracts slide layout (shape positions and connectors) and assembles AI-enriched preview Markdown per slide, with preview/layout parses run in parallel
- New `.pptx` filter button with a tree icon in the file tree, plus a visibility setting
- i18n labels (ja/en) for PPTX features

### Markdown → Excel (.xlsx) Export
- New **XLSX export tab** in the preview toolbar, backed by the vendored `miku-md2xlsx` engine
- `XlsxPreviewPanel` renders an in-app preview of the workbook and saves to `.xlsx`
- Images are embedded in the workbook and rendered in the preview via the workbook model, including Mermaid diagrams
- Bare-filename image paths are resolved against the current directory
- Sheet names are escaped in the preview HTML to prevent injection

### In-App Image Editor
- **Crop tool** with real-pixel cropping
- **Numeric resize dialog** with aspect-ratio lock and presets
- Edits use real-pixel scene coordinates with a viewport-fit display
- Replaced images persist via blob URL with a self-edit guard
- Crop/resize captured in undo snapshots (including dimensions), with a capped redo/undo stack

### Dependencies
- Users are now notified when Node or opencode is missing

---

## Bug Fixes

### XLSX
- Images placed in column A at native size; image rows sized to the image height so text isn't hidden behind images
- Embeds images that lazily follow a list item
- Aligned image resolution and embedded Mermaid diagrams; fixed tab order and toolbar

### Image Editor
- Restored undo after crop/resize and excluded them from autosave
- Hardened the resize source rect, capped the redo/undo stack, and reordered the crop guard

### Responsiveness
- `get_file_tree` scan and folder-open file-system probes now run off the main thread
- RAG build badge shows a "preparing" phase to avoid a frozen "Scanning N/N" badge

---

## Chores & Docs
- Vendored the `miku-md2xlsx` markdown-to-xlsx engine
- Design specs and implementation plans added for PPTX → Markdown batch convert, PPTX preview, PPTX AI semantic enrichment, the preview XLSX export, and the image crop/resize feature
- Added webp/svg content types; tests covering PPTX shared-image replacement, `grpSp`/missing-xfrm/default-size handling, and the missing-rels error case
