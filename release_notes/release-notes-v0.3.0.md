# Release Notes — v0.3.0

## Highlights

This release introduces the **Claude Code panel** — an in-app chat and settings surface backed by the Claude Agent SDK, running the installed `claude` CLI through a bundled Node sidecar. It adds a **Replacement (masking) feature** that applies user-defined rules to files and to opencode/RAG traffic, with CSV import/export. It also ships an **opencode usage/cost display**, **double-click jump from preview to the editor line**, a **consolidated RAG index database**, and a fix for UI freezes when opening large or UNC-path folders.

---

## New Features

### Claude Code Panel

- New activity-bar entry (with keyboard shortcut) opening a Claude chat panel with tool-use cards and interactive permission prompts
- Powered by the Claude Agent SDK via an esbuild-bundled Node sidecar over a Rust stdio bridge; resolves the installed `claude` CLI executable
- opencode-style toolbar with session history and a CLI-missing status indicator
- Per-folder persistence of sessions and model/permission settings
- Settings tab with **General / Rules / MCP / Skills / Plugins** sections; Plugins tab matches the opencode UI (toggle switches, hint boxes, save path)
- All config writes go through a shared `guardWrite` helper so save failures are reported instead of silently dropped
- Robustness: chat state recovery on sidecar crash, queued permission requests, connect-race guards, stale rules-load protection, and clean shutdown
- Sidecar no longer inherits the untrusted project folder as its working directory
- Japanese/English i18n for the whole panel

### Replacement (Masking)

- New replacement panel in the activity bar for managing find/replace masking rules
- Rules persist in settings; CSV import/export and bulk replace/reverse buttons
- Masks opencode chat traffic and RAG QA traffic on the way out, and unmasks responses (including session titles and fallback content) on the way back
- Bulk file replace logic scoped to file contents (file paths/names excluded)

### opencode Usage & Cost Display

- Usage readout in the opencode chat toolbar with a detail popover (per-day breakdown)
- Aggregates tokens and cost from `message.updated` events, with persisted state guards and compact token formatting

### Preview → Editor Jump

- Double-click a block in the Markdown preview to jump the editor to the corresponding source line
- Wrap-aware jumping that keeps the preview scroll position in place; table cells and inputs are excluded
- Image double-click listener survives preview content re-creation

### RAG

- Consolidated the RAG index into a single root `.mdium` database instead of per-folder indexes

---

## Bug Fixes

- Fixed UI freeze when opening large folders or UNC network paths
- PPTX AI-interpret button now themed with app CSS variables
- Usage popover: guarded persisted state, capped the day list, dropped empty-session buckets; token counts roll over to `M` at the rounding boundary
- Replacement panel styles use theme CSS variables

---

## Chores & Docs

- `npm run dev` now builds the Claude sidecar first via a `predev` hook
- Bumped `@opencode-ai/sdk` to 1.17.13; superpowers to v6.1.1 with version-insensitive builtin matching
- Design specs and implementation plans for the Claude SDK panel, the replacement feature, the usage/cost display, the preview double-click jump, and the Plugins tab
