# Intake, Issue Tracker and Attachments — UI (Part 4b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the user interface for spec Part 4 on top of the Part 4a backend: a separate requirement-intake window (start form, conversation with question options, free text, voice input, pasted/attached images and files, proposal editing, document-update review, resumable finalize with Issue handling), intake session management from the Workflows panel (new task always goes through intake), and task-detail additions for attachments, Issue links, Issue-sync failures and Issue closing.

**Architecture:** A Rust command opens (or focuses) a webview window labelled `intake-<id>` (or `intake-new-<nonce>` before a session exists) that loads the same `index.html` with `?view=intake&root=…&intake=…`. `src/main.tsx` routes that query to a lightweight `IntakeRoot` (theme, i18n, dialogs, its own store) instead of `App`. Both windows talk to the backend through `workflowApi` and react to `workflow://intake-changed` / `workflow://workflows-changed`. The main window gains an intake list and routes "new task" to the intake window; task detail gains attachment and Issue sections. Settings changes propagate between windows through the `storage` event.

**Tech Stack:** React 19 + TypeScript, Zustand, react-i18next, `diff` (existing), `@tauri-apps/api` (window, event, core), `@tauri-apps/plugin-fs` (read-only use for thumbnails and current doc contents), `@tauri-apps/plugin-dialog` (file picker), existing speech hook, Rust (Tauri v2).

**Spec:** `.superpowers/specs/2026-09-24-agent-workflows-design.md` Part 4 (4.1–4.5), 3.12, 3.13. Backend: `src/shared/types/workflow.ts`, `src/features/workflow/lib/workflow-api.ts`, `src-tauri/src/commands/workflow.rs`.

## Global Constraints

- All code comments in English; every user-visible string via i18n (`workflow` namespace unless stated), ja/en key parity (the parity test enforces it).
- Agent-written Markdown (questions, proposals, doc updates) is rendered only through `SafeMarkdown` / `renderMarkdownSafe`; everything else is text.
- No polling: the intake window and panel refresh on `workflow://intake-changed` (for their intake/project) and after their own commands; `workflow://workflows-changed` refreshes workflow lists in both windows.
- Command failures: `formatCommandError` + `showMessage(..., { kind: "error" })` (each window mounts `<AppDialog/>`); `TRANSITION_CONFLICT` refreshes silently. Buttons that trigger backend actions are disabled while their request is in flight (no double submits).
- Project identity: compare roots with `sameRoot`; the intake window receives the normalized root from the query string (the main window passes the value returned by `workflow_attach_project`).
- Security: the intake window's capability grants only what it uses (see Task 1); images/files are read for display with `@tauri-apps/plugin-fs` `readFile` into blob URLs (revoked on unmount); the asset protocol stays disabled.
- Styling: plain CSS per component, BEM, theme variables only; toggles use `data-switch` and are listed in `switch-contract.test.ts`; dialogs use `DialogShell`.
- Tests: Vitest + happy-dom as in Part 3c (mock `@tauri-apps/api/*`, `@tauri-apps/plugin-*`, and the `workflow-api` client); `npx vitest run src/features/workflow src/features/intake src/app`, `npx tsc --noEmit`, `npm test` before commits. Rust: `cargo test --manifest-path src-tauri/Cargo.toml commands::workflow`.
- Never run `cargo fmt`; never stage the unrelated rustfmt-only files in `src-tauri/src/commands/*`, `file_watcher.rs`, `http_bridge.rs`, `lib.rs` (stage only your hunks via `git show HEAD:<file>` + edit → `git hash-object -w` → `git update-index --cacheinfo`). Specs/plans/commits describe this as new work. Commit trailer: `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.

## Review Focus

1. The user sends a message and immediately closes/reopens the intake window, or opens the same intake from two places → one window per intake (focus existing), the busy state and pending reply are shown correctly after reopening, no duplicate sends. (Tasks 1, 4, 5.)
2. Finalize fails midway (Issue tracking unavailable, network error after the Issue was created) → the window explains the state and offers exactly the valid next steps (retry, continue without Issue only while no Issue exists, reopen/abandon only when allowed); nothing is lost. (Task 6.)
3. A doc-update proposal whose file changed since the proposal, or a very large diff → the diff is shown against the current file, apply surfaces `INTAKE_DOC_CHANGED_SINCE_PROPOSAL` clearly, and applied docs are listed with a reminder to commit them before the run starts. (Task 6.)
4. The main window is closed while an intake window is open → the app exits cleanly (intake windows close too, running turns are cancelled by the backend). (Task 1.)
5. Theme or language changed in one window → the other window follows without restart. (Task 2.)

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `src-tauri/src/commands/workflow.rs`, `lib.rs` (hunks), `src-tauri/capabilities/intake.json` | open/focus intake window; close aux windows with main | 1 |
| `src/features/workflow/lib/workflow-api.ts` (+test) | `openIntakeWindow` wrapper | 1 |
| `src/main.tsx`, `src/features/intake/IntakeRoot.tsx`, `src/shared/lib/settings-sync.ts` | window routing, bootstrap, cross-window settings sync | 2 |
| `src/shared/i18n/locales/{ja,en}/workflow.json` (+ `intake` group) | codes and strings for Part 4 | 3 |
| `src/features/intake/intake-store.ts`, `components/IntakeStartForm.tsx`, `lib/provider-options.ts` (extracted from WorkflowEditDialog) | per-window intake state, start form | 4 |
| `src/features/intake/components/{IntakeConversation,MessageList,ComposeBox,DraftStrip}.tsx` | conversation UI | 5 |
| `src/features/intake/components/{ProposalCard,DocUpdateList,FinalizePanel}.tsx` | proposal edit, doc updates, finalize | 6 |
| `src/features/workflow/{workflow-store.ts,components/WorkflowPanel.tsx,components/IntakeList.tsx}`, remove `CreateTaskDialog.tsx` | main-window integration | 7 |
| `src/features/workflow/components/{TaskDetailModal,TaskActions,MergeSection,AttachmentList,IssueSection}.tsx` | detail additions | 8 |
| smoke checklist | verification | 9 |

---

### Task 1: Intake window lifecycle (Rust + client)

**Files:** `src-tauri/src/commands/workflow.rs`, `src-tauri/src/lib.rs` (registration + main-window close hunk only), `src-tauri/capabilities/intake.json` (new), `src/features/workflow/lib/workflow-api.ts` (+ test).

**Interfaces:**
- `#[tauri::command] async fn workflow_open_intake_window(app: AppHandle, project_root: String, intake_id: Option<String>, workflow_id: Option<String>) -> Result<String /* label */, CommandError>`:
  - validates `project_root` like other commands (existing directory, absolute) and, when given, that the intake exists (`intake::get_session`);
  - label `intake-<intakeId>` or, without an id, `intake-new-<16 hex nonce>`;
  - if a window with that label exists: `unminimize`, `show`, `set_focus`, return the label;
  - else `WebviewWindowBuilder::new(&app, label, WebviewUrl::App("index.html?view=intake&root=<enc>&intake=<id or empty>&workflow=<id or empty>"))`, title `"MDium"` (no UI strings in Rust; the window sets its localized title via `setTitle`), size 900×760, min 640×480, `decorations(true)`;
  - returns the label.
- Main-window close: in `lib.rs`, when the `main` window is destroyed (`WindowEvent::Destroyed` for label `main`), close every window whose label starts with `intake-` and call `app.exit(0)` (the existing Exit hook then cancels intake turns and shuts down the orchestrator).
- `src-tauri/capabilities/intake.json`: `"windows": ["intake-*"]`, permissions: `core:default`, `core:window:allow-set-title`, `core:window:allow-close`, `core:window:allow-set-focus`, `dialog:allow-open`, `fs:allow-read-file`, `fs:allow-read-text-file` with the same `fs:scope` as the main capability (read only), `core:event:default`. No shell/opener, no write permissions; `core:webview:allow-create-webview-window` is not needed because windows are created from Rust. External links open through the existing `open_external_url` command.
- TS: `workflowApi.openIntakeWindow(root: string, intakeId: string | null, workflowId?: string | null): Promise<string>`.

- [ ] Tests first: Rust unit test for label/URL construction (pure helper `intake_window_spec(root, id) -> (label, url)`: URL-encodes the root, rejects invalid ids); TS wrapper test (command name/args). Manual verification is covered by Task 9 smoke.
- [ ] Implement; `cargo test ... commands::workflow`, `cargo check`, `npx tsc --noEmit`, `npm test`. Commit `feat(intake): open intake windows`.

---

### Task 2: Window routing and bootstrap

**Files:** `src/main.tsx`, `src/features/intake/IntakeRoot.tsx` (+ `.css`, test), `src/shared/lib/settings-sync.ts` (+ test), `src/app/App.tsx` (start settings sync).

**Interfaces:**
- `main.tsx`: `const params = new URLSearchParams(location.search); params.get("view") === "intake" ? <IntakeRoot root={params.get("root")!} intakeId={params.get("intake") || null} /> : <App />` (keep existing imports; Monaco setup is not needed for intake but harmless — skip importing it for the intake view if it is cheap to split).
- `IntakeRoot`: calls `useSettingsStore.getState().initializeTheme()` once; mounts `<AppDialog/>`; starts `startSettingsSync()`; sets the window title with `getCurrentWindow().setTitle(t("intake.windowTitle"))`; renders `IntakeApp` (Task 4) — in this task a placeholder showing the title.
- `settings-sync.ts`: `startSettingsSync(): () => void` — listens to `window` `storage` events for keys `mdium-settings` and `mdium-lang`; on change rehydrates the persisted settings store (`useSettingsStore.persist.rehydrate()`) and re-applies theme (`applyTheme(getThemeById(themeId))`) and language (`i18n.changeLanguage`). Main `App` starts it too (Review Focus 5).

- [ ] Tests first: routing (query → IntakeRoot vs App, using a small exported `selectRoot(search)` helper); settings-sync applies theme/lang on a synthetic `StorageEvent` and ignores other keys; IntakeRoot mounts AppDialog and applies the theme.
- [ ] Implement, test, commit `feat(intake): boot the intake window`.

---

### Task 3: Translations for Part 4

**Files:** `src/shared/i18n/locales/{ja,en}/workflow.json` (+ `src/features/workflow/lib/format.ts` only if new param shapes need formatting).

- Add `codes.*` for every Part 4 backend code (list them by grepping `src-tauri/src/workflow/{intake,attachments,forge,issue_sync,actions,flow}.rs` and `commands/workflow.rs` for `"(INTAKE|ATTACHMENT|FORGE|ISSUE|WORKFLOW_ISSUE)_[A-Z_]+"` and `ATTENTION_ISSUE_SYNC_FAILED`) plus runner-level codes that reach the UI as intake errors (`INVALID_IMAGES`, `RUNNER_*` already present? check), with placeholders matching params (`ATTENTION_ISSUE_SYNC_FAILED`: `{{codeText}} {{message}}` and `entry`; add `entry.<design|implement|review>` labels and make `formatAttention` localize `params.entry`).
- Add an `intake` group of UI strings used by Tasks 4–8 (window title, start form, kinds, conversation, compose, drafts, proposal, doc updates, finalize stages, issue section, attachments section). Later tasks may add keys but must keep parity.

- [ ] Tests first: parity test passes; `formatAttention` for `ATTENTION_ISSUE_SYNC_FAILED` shows localized entry and code; a test that every code string found in the Rust sources (read files in the test via `fs` from the repo — or a checked-in list generated in this task) has a `codes.*` key.
- [ ] Implement, test, commit `feat(workflow): translate intake, attachment and issue codes`.

---

### Task 4: Intake store and start form

**Files:** `src/features/intake/intake-store.ts` (+ test), `src/features/intake/components/{IntakeApp,IntakeStartForm}.tsx` (+ css, tests), `src/features/workflow/lib/provider-options.ts` (extract `PROVIDERS`, availability helpers, `providerLabel` from `WorkflowEditDialog.tsx` and reuse them there).

**Interfaces:**
```ts
interface IntakeWindowState {
  root: string; intakeId: string | null; session: IntakeSessionView | null; drafts: AttachmentMeta[];
  workflows: Workflow[]; providers: Partial<Record<Provider, string | null>>; forge: ForgeProbe | null;
  loading: boolean; sending: boolean; error: string | null;
  init(root: string, intakeId: string | null): Promise<void>;           // attach, load workflows/providers/forge, session+drafts when id
  create(input: { workflowId: string; kind: IntakeKind; provider: Provider; model: string | null }): Promise<void>; // intakeCreate → openIntakeWindow(root, id) → close this window (see below)
  reload(): Promise<void>; send(text: string, draftIds: string[]): Promise<void>; retry(): Promise<void>; cancelTurn(): Promise<void>;
  addDraftFromPath(path: string): Promise<void>; addDraftFromBytes(name: string, base64: string): Promise<void>; removeDraft(id: string): Promise<void>;
  // proposal/doc/finalize actions in Task 6
}
export const useIntakeStore; export function startIntakeEvents(): Promise<() => void>; // intake-changed for this root+id → reload; workflows-changed → reload workflows
```
- Start form (shown when no session): workflow select (enabled, not archived; default from `?workflow=` query if present — Task 7 passes it), kind radio (feature/bug), provider select with availability (defaults to the workflow's design stage provider/model), model text, Issue status line when the workflow's `issueTracking` is `auto` (from `forgeProbe`: "will create an Issue on <host>/<path>" / "Issue tracking unavailable: <reason> — you can continue without an Issue when finalizing"), Start button → `create`.
- Window identity after `create`: windows are keyed by label, so the `intake-new-*` window must not keep serving the new session (the main window would open a second `intake-<id>` window for it). After `create` it calls `workflowApi.openIntakeWindow(root, id)` and closes itself; the backend opens `intake-<id>`, which loads the session (Review Focus 1). Document this in the component.

- [ ] Tests first (mock workflowApi + window APIs): init with/without id; start form lists only usable workflows, defaults provider/model from the design stage, shows forge status texts; create → openIntakeWindow(id) then close current window; events for another intake ignored; workflows-changed reloads.
- [ ] Implement, test, commit `feat(intake): start intake sessions`.

---

### Task 5: Conversation

**Files:** `src/features/intake/components/{IntakeConversation,MessageList,ComposeBox,DraftStrip}.tsx` (+ css, tests).

**Behavior:**
- Message list: user messages (text + draft chips), assistant messages rendered with `SafeMarkdown`, the latest question (`session.lastQuestion`) shown with option buttons (clicking sends that option as the answer), error messages localized via `formatCode(message.text)` with the `detail` (if any) in a collapsible `<pre>` (text), and a "retry" button on the last error. Busy state (`session.busy`) shows a thinking indicator with a Cancel button (`cancelTurn`). Scroll to bottom on new messages.
- Compose box: textarea (Enter = newline, Ctrl+Enter = send), Send (disabled while busy/sending or empty), always visible even after errors (spec 4.1); voice button using `useSpeechToText(settings.speechModel)` when `speechEnabled` (append transcript to the textarea); paste handler: images from the clipboard → base64 → `addDraftFromBytes(name, base64)` (text paste untouched); "attach file" button → `@tauri-apps/plugin-dialog` `open({ multiple: true })` → `addDraftFromPath` for each.
- Draft strip: pending drafts (not yet sent) as chips; images show a thumbnail via `readFile(await workflowApi.intakeDraftPath(...))` → blob URL (revoke on unmount); remove button. Sending includes the current draft ids and clears the strip on success.
- Disabled states when `session.status !== "active"`.

- [ ] Tests first: renders each message kind; option click sends the option; error retry calls retry; busy shows cancel; Ctrl+Enter sends with draft ids; paste image adds a draft (mock FileReader/clipboard); attach file via dialog; thumbnails use blob URLs and revoke on unmount; send disabled while busy; XSS in assistant text inert.
- [ ] Implement, test, commit `feat(intake): converse in the intake window`.

---

### Task 6: Proposal, document updates and finalize

**Files:** `src/features/intake/components/{ProposalCard,DocUpdateList,FinalizePanel}.tsx` (+ css, tests), store actions.

**Behavior:**
- Proposal card (when `session.proposal`): rendered Markdown with an Edit toggle → title input + body textarea → `intakeUpdateProposal` (validation errors shown inline via codes); a "Continue refining" hint (the user can keep chatting).
- Doc updates: for each proposal entry show path, status, reason (localized) for rejected ones; for pending ones a diff (`createTwoFilesPatch` from `diff` between the current file content — `readTextFile(join(root, path))`, missing file = empty — and the proposed content) rendered with `UnifiedDiffView`; Apply / Reject buttons → `intakeApplyDocUpdate`; `INTAKE_DOC_CHANGED_SINCE_PROPOSAL` shown inline with a "reload diff" action. When `appliedDocPaths` is non-empty show a notice listing them: "These files were changed in your working tree. Commit them before the workflow starts so the agents see them."
- Finalize panel (when a proposal exists): shows the planned steps (Issue creation if tracking auto and available, attachments count, task creation) and a Finalize button → `intakeFinalize(root, id, skipIssue=false)`. State handling from `session.finalize` and `status`:
  - `finalizing` with `lastError`: error text (localized) + Retry (same call), "Continue without Issue" (only when `finalize.issue` is null and the workflow tracks Issues) → `intakeFinalize(..., true)`, Reopen (only when stage `ready`, no issue, `!issueCreating`) → `intakeReopen`, Abandon (same condition) → confirm → `intakeAbandon`.
  - `ISSUE_TRACKING_UNAVAILABLE` returned before switching (backend now checks early): show the forge reason and the "Continue without Issue" button.
  - `done`: success view with the Issue link (if any; opens via `open_external_url`), "Open task" → `emitTo("main", "workflow://open-task", { projectRoot, taskId })` and close the window.
- Abandon button for active sessions (confirm).
- Pending doc updates are hidden once the session is `done`/`abandoned`.

- [ ] Tests first (Review Focus 2, 3): proposal edit saves; doc diff against current content; apply error CHANGED_SINCE_PROPOSAL shown; applied notice; finalize success → open-task emitted and window closed; each finalize failure state shows exactly the allowed buttons; buttons disabled in flight; skip-issue path.
- [ ] Implement, test, commit `feat(intake): review proposals and finalize intakes`.

---

### Task 7: Main-window integration

**Files:** `src/features/workflow/workflow-store.ts` (+ tests), `src/features/workflow/components/{WorkflowPanel.tsx,IntakeList.tsx}` (+ css, tests), delete `CreateTaskDialog.tsx` (+ its test/css) and remove its uses, `src/app/App.tsx` (open-task listener).

**Behavior:**
- Store: `ProjectState.intakes: IntakeSessionView[]` (+ warnings) loaded with the lists; the bridge also handles `intake-changed` (debounced refresh of intakes for that root) and `workflows-changed` (refresh workflows).
- WorkflowPanel: "New task" → `workflowApi.openIntakeWindow(activeRoot, null, filters.workflowId)` (the start form preselects it); an "Intakes" section (`IntakeList`) listing active/finalizing sessions (title = proposal title or first user message, kind, status, busy indicator, updated time) with Open (opens/focuses the window) and Abandon (confirm; hidden when not allowed).
- App: listen for `workflow://open-task` (from intake windows) → activate that project if it is the active folder (else ignore) → switch left panel to workflow → `openTask(taskId)`.
- Remove CreateTaskDialog and its entry points; spec 4.1 requires intake for every new task.

- [ ] Tests first: new task opens the intake window with the root; intake list renders from store and refreshes on intake-changed; abandon confirm; open-task event opens the task detail; workflows-changed refreshes workflows; CreateTaskDialog gone (no references).
- [ ] Implement, test, commit `feat(workflow): route new tasks through intake`.

---

### Task 8: Task detail — attachments and Issues

**Files:** `src/features/workflow/components/{AttachmentList,IssueSection}.tsx` (+ css, tests), `TaskDetailModal.tsx`, `TaskActions.tsx`, `MergeSection.tsx` (or the run `<dl>`).

**Behavior:**
- AttachmentList (root task, and child tasks show the root's attachments): `listAttachments(root, rootTaskId)`; each item: name, size (localized units), mime; image thumbnails via `attachmentPath` + `readFile` → blob URL; "Show in folder" → `open_external_url` with the attachment's directory (allowed: existing directory).
- IssueSection: Issue link (`#number` + host/path, opens via `open_external_url`), for runs: closed state; when `run.status === "merged" && run.issue && !run.issueClosed` show "Retry closing the Issue" (+ `issueCloseError` localized when present) → `retryIssueClose`. Place it in the run section so it renders even after the worktree was removed.
- TaskActions: for attention with `ATTENTION_ISSUE_SYNC_FAILED` show "Retry Issue sync" and "Continue without syncing" (confirm) instead of the generic Retry/Mark complete; cancel stays. Buttons disabled while in flight.
- The attention section shows the entry kind (localized) for Issue-sync failures.

- [ ] Tests first: attachments listed with thumbnails (blob URLs revoked); show-in-folder calls the command with the directory; Issue link opens; retry close visible exactly when merged+issue+!closed; sync-failure actions call the right API; generic retry hidden for sync failures.
- [ ] Implement, test, commit `feat(workflow): show attachments and issue status in task details`.

---

### Task 9: Verification and smoke checklist

- [ ] `npm test`, `npx tsc --noEmit`, `cargo test --manifest-path src-tauri/Cargo.toml`, `cargo check`, `npm run build:sidecar`, `npm run build` — report counts.
- [ ] Write `.superpowers/sdd/part4-smoke.md` (Japanese, not committed): intake window open/focus/close; start form; feature and bug conversations with options, free text, voice, pasted image, attached file; proposal edit; doc update apply/reject/changed-since; finalize with GitHub Issue (and GitLab if available: verify glab flags), without Issue, unavailable tracking → continue without Issue, failure resume; open task from intake; stage Issue comments (design/implement/review), sync failure retry/skip, merge closes Issue, retry close; attachments visible to agents from the worktree under each provider (note any permission prompts), OneDrive file attach; opencode/Copilot image handling; close main with an intake window open; theme/language sync between windows.
