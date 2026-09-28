# Agent Office/PDF Reading — Design

Date: 2026-09-28 · Milestone: M1

## Problem

Office/PDF → Markdown conversion (`docx`/`xlsx`/`pptx`/`pdf`) only exists in the
frontend (`src/features/export/lib/*ToMarkdown.ts`), bound to `@tauri-apps/plugin-fs`
and Vite-only imports. Workflow agents receive task attachments as raw binary
paths (`attachments_block` in `prompt.rs`) and cannot read them.

## Goals

1. One converter implementation usable from the browser *and* from Node.
2. Workflow stage prompts point agents at a Markdown rendition of every
   convertible attachment, generated automatically by MDium.
3. Any MCP-capable agent can convert an arbitrary file on demand
   (`convert_to_markdown` tool).

Non-goals: OCR of scanned PDFs, intake-session prompts (drafts are mutable;
follow-up), RAG indexing of Office files (follow-up, can reuse the same core).

## Design

### Shared converter core — `src/features/export/lib/core/`

Pure functions, no file I/O, no Tauri, no Vite-specific imports:

- `convertDocx(data, baseName)`, `convertXlsx(data, baseName)`,
  `convertPptx(data, baseName, labels)`, `convertPdf(data, pdfjs)`
- `convertDocument(data, fileName, env)` dispatches on the extension and returns
  `{ markdown, assets: { path, data }[] }`; asset paths are relative to the `.md`.
- `pdfjs` is injected: the browser passes pdfjs-dist with a `?url` worker, Node
  passes the legacy build with an in-process worker.

The existing frontend wrappers keep their signatures and only do the writes.

### Node side — `sidecar/doc-converter/`

- `node-env.ts`: installs an XML `DOMParser` (`@xmldom/xmldom`, already a
  mammoth dependency, plus an `Element.children` polyfill) and loads pdfjs.
- `convert-file.ts`: `convertFileToMarkdown(input, outputMd)` writes the `.md`
  and its assets next to it.
- `mcp-server.ts` + `mcp-main.ts`: a dependency-free stdio MCP server (JSON-RPC
  `initialize` / `tools/list` / `tools/call`) with one tool,
  `convert_to_markdown { path, max_chars? }`, returning the Markdown text.
  Bundled to `resources/mcp-servers/mdium-docs/dist/index.js` and listed as a
  builtin MCP server (`mdium-docs`) for opencode.

### Agent runner — new request

`convert_document { requestId, inputPath, outputPath }` →
`document_converted { requestId, markdownPath }` or `error { requestId }`.
Conversion runs in a `worker_thread` (same bundle) so a large PDF does not
stall running agent sessions. Both paths must be local absolute paths and the
input must have a convertible extension.

### Rust side

- `RunnerApi::convert_document(input, output, timeout)` (default impl:
  unsupported, so test fakes need no change); `RunnerClient` sends the request.
- `workflow/doc_markdown.rs`: for a committed attachment with a convertible
  extension, the rendition lives in
  `.mdium/task-attachments/<root>/<att>/markdown/<stem>.md`. It is produced in
  `markdown.tmp/` and renamed into place, so a present `markdown/` is always
  complete. A converter-side failure writes `markdown/conversion-failed.txt`
  (never retried); runner unavailability/timeouts are retried on a later pass.
  Stored names always end in a convertible extension, so they never collide
  with `markdown` / `markdown.tmp`.
- The orchestrator's dispatch pass prepares renditions for inbox workflow
  tasks **before** taking the project guard (no lock held during conversion).
- `AttachmentView.markdown_path` is filled by `root_attachments`, and
  `attachments_block` adds a `Markdown version: <path>` line plus a note to read
  it instead of the binary file.

## Testing

- vitest: core converters (docx/xlsx/pptx/pdf with generated fixtures) under
  Node with the xmldom shim; MCP server request handling; runner protocol
  parsing and RunnerCore `convert_document` handling.
- cargo: `doc_markdown` (success, failure marker, retry on unavailability,
  non-convertible skip, tmp cleanup), prompt rendering, runner client request.
