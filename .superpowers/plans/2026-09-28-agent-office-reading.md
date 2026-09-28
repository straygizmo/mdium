# Agent Office/PDF Reading — Plan

Spec: `.superpowers/specs/2026-09-28-agent-office-reading-design.md`

1. Extract pure converter core into `src/features/export/lib/core/`; make the
   frontend wrappers delegate to it (behaviour unchanged).
2. Node environment + file converter in `sidecar/doc-converter/`; tests with
   generated docx/xlsx/pptx/pdf fixtures.
3. Stdio MCP server `mdium-docs` (`convert_to_markdown`), esbuild bundle step in
   `build:sidecar`, builtin MCP entry.
4. Agent runner: `convert_document` protocol message, RunnerCore handler,
   worker-thread implementation in `main.ts`; tests.
5. Rust: `RunnerClient::convert_document`, `RunnerApi::convert_document`,
   `workflow/doc_markdown.rs`, dispatch pre-pass, prompt rendering; tests.
6. Run `npm run test`, `cargo test`, build the bundles and smoke-test them.
