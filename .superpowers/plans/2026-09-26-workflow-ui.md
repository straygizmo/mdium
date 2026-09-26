# Workflow UI (Part 3c) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the workflow orchestrator (Part 3b) its user interface: a "Workflows" activity-bar panel (workflow list, filters), a workspace in the main area (kanban and stage × status matrix), a task detail modal with every state-dependent operation (approve, request revision, answer, retry with acknowledgements, hold/resume/cancel, mark complete), the merge/discard flow, the workflow edit dialog, task creation, and the first-use safety explanation — all driven by push events, localized, and sanitized.

**Architecture:** New feature folder `src/features/workflow/` with a typed command client (`lib/workflow-api.ts`), an event bridge, one Zustand store (`workflow-store.ts`) keyed by the normalized project root, and components. The left panel id `"workflow"` is added to `ui-store`; while it is selected, `App.tsx` renders the workspace instead of the editor area. Shared building blocks added first: a sanitized Markdown renderer (DOMPurify), a unified-diff view extracted from the existing external-change dialog, task-status theme tokens, and a `workflow` i18n namespace with a code → message formatter.

**Tech Stack:** React 19 + TypeScript, Zustand, react-i18next, `marked` + `dompurify` (new), `diff` (existing), Vitest + happy-dom, Tauri `invoke`/`listen`. Small Rust addition for `.gitignore` guidance.

**Spec:** `.superpowers/specs/2026-09-24-agent-workflows-design.md` (3.2 gitignore guidance, 3.3, 3.7 first-enable explanation, 3.9, 3.11, 3.12, 3.13). Backend contract: `src/shared/types/workflow.ts` and `src-tauri/src/commands/workflow.rs`.

## Global Constraints

- All code comments in English. No hardcoded UI strings: every visible text comes from i18n (`workflow` namespace for this feature; ja and en files must have identical key sets).
- Every Markdown string that comes from a task, an agent, or the repository is rendered with `renderMarkdownSafe` (marked → DOMPurify). Never pass unsanitized HTML to `dangerouslySetInnerHTML`. Plain-text fields (titles, reasons, questions, summaries) are rendered as text nodes.
- The UI never polls. It loads lists once per attach and refreshes from `workflow://task-changed` / `run-changed` (debounced ≤ 150 ms per project) and shows `workflow://progress` as the latest progress line per task.
- Project identity: call `workflow_attach_project(activeFolderPath)` and keep the returned normalized root; compare event `projectRoot` values with `sameRoot(a, b)` (exact match, or case-insensitive on Windows — detect with `navigator.userAgent.includes("Windows")`).
- Command failures: the client rejects with `CommandError { code, message }`. Show them with `showMessage(formatCommandError(err), { kind: "error" })` from `@/stores/dialog-store`, except `TRANSITION_CONFLICT`, which triggers a silent refresh (the state changed underneath).
- Attention reasons and error codes are localized with `formatAttention(reason)` / `formatCode(code, params)`: known codes have keys `workflow:codes.<CODE>`; unknown codes fall back to `workflow:codes.unknown` with the raw code shown. `items` params (JSON arrays) are rendered as a list (max 20).
- Styling: plain CSS per component with BEM class names and theme variables only; toggles use `<input type="checkbox" data-switch>` and new CSS/TSX files are added to `src/shared/styles/switch-contract.test.ts` lists.
- Tests: Vitest; DOM tests start with `// @vitest-environment happy-dom`, set `IS_REACT_ACT_ENVIRONMENT`, `await i18n.changeLanguage("en")`, render with `createRoot` + `act`; mock `@tauri-apps/api/core` / `event` or the feature client module (`vi.mock`). Run `npx vitest run src/features/workflow` while iterating and `npx tsc --noEmit` + `npm test` before committing.
- Commit trailer: `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. Never run `cargo fmt` (use `rustfmt --edition 2021 <file>`); never stage files you did not change.

## Review Focus

1. An agent's final answer or a task body contains `<img src=x onerror=...>`, `<script>`, `javascript:` links or raw HTML → rendered inert in the task detail (no script execution, no event handlers), Markdown formatting still works. (Test in Task 1 and Task 8.)
2. The user switches folders while a workflow panel is open, or events for another project arrive → the workspace shows only the active project's tasks; no cross-project updates, no stale list after switching back. (Test in Task 5.)
3. Hold/cancel races with a task finishing (`TRANSITION_CONFLICT`) → no error dialog, the task simply refreshes to its real state. (Test in Task 5/8.)
4. A brand-new code the UI has no translation for (future backend version) → a readable fallback with the code visible, never a blank or a raw i18n key path. (Test in Task 3.)
5. Very long bodies/diffs (hundreds of KB) and many tasks (≥ 300) → the modal and board stay responsive: diff rendering is capped with a "truncated" note, and cards render without per-card expensive work (no Markdown on cards). (Test in Tasks 7/9.)

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `package.json` | add `dompurify` (+ `@types/dompurify` if needed) | 1 |
| `src/shared/lib/markdown/render-markdown-safe.ts` | marked → DOMPurify helper | 1 |
| `src/shared/components/UnifiedDiffView.tsx/.css` | unified diff renderer (extracted) | 1 |
| `src/features/editor/components/ExternalChangeDialog.tsx` | use `UnifiedDiffView` | 1 |
| `src/shared/themes/{types.ts,apply-theme.ts}` (+test) | `taskStatus*Background` tokens with derived defaults | 2 |
| `src/shared/i18n/locales/{ja,en}/workflow.json`, `src/shared/i18n/index.ts` | `workflow` namespace | 3 |
| `src/shared/i18n/__tests__/locale-parity.test.ts` | ja/en key parity | 3 |
| `src/features/workflow/lib/format.ts` | code/attention formatting, `sameRoot` | 3 |
| `src/features/workflow/lib/workflow-api.ts` | typed command + event client | 4 |
| `src/features/workflow/workflow-store.ts` | per-project state, event refresh, actions | 5 |
| `src/stores/ui-store.ts`, `src/stores/tab-store.ts` (restore), `src/features/file-tree/components/LeftPanel.tsx`, `src/app/App.tsx` | panel id, activity button, main-area switch | 6 |
| `src/features/workflow/components/WorkflowPanel.tsx/.css` | left panel: workflows, filters | 6 |
| `src/features/workflow/components/{Workspace,KanbanBoard,MatrixView,TaskCard}.tsx/.css` | main area | 7 |
| `src/features/workflow/components/{TaskDetailModal,TaskActions,RetryDialog}.tsx/.css` | task detail + operations | 8 |
| `src/features/workflow/components/MergeSection.tsx/.css` | merge preview/merge/discard | 9 |
| `src/features/workflow/components/{WorkflowEditDialog,CreateTaskDialog}.tsx/.css` | editing and creation | 10 |
| `src-tauri/src/commands/workflow.rs` (+ `lib.rs` registration), `src/features/workflow/components/SafetyNoticeDialog.tsx` | gitignore status command; first-enable notice | 11 |

---

### Task 1: Sanitized Markdown and unified diff view

**Files:** `package.json`, `src/shared/lib/markdown/render-markdown-safe.ts` (+ `__tests__/render-markdown-safe.test.ts`), `src/shared/components/UnifiedDiffView.tsx` + `.css` (+ test), `src/features/editor/components/ExternalChangeDialog.tsx`.

**Interfaces:**
- `export function renderMarkdownSafe(markdown: string): string` — `marked.parse(markdown, { async: false })` then `DOMPurify.sanitize(html, { USE_PROFILES: { html: true }, FORBID_TAGS: ["style", "iframe", "form", "input", "button"], FORBID_ATTR: ["style"] })`; links get `rel="noopener noreferrer"` and `target="_blank"` via a DOMPurify `afterSanitizeAttributes` hook registered once. Non-string input → `""`.
- `export function UnifiedDiffView(props: { diff: string; maxLines?: number /* default 5000 */ }): JSX.Element` — renders each line in a `<pre>`-like block with classes `unified-diff__line--added|removed|header|meta|context` (`+`, `-`, `@@`, `diff `/`index `/`---`/`+++` lines, rest); shows `t("common:truncatedLines", { count })` when lines exceed `maxLines` (add that key to `common` ja/en). `ExternalChangeDialog` builds its unified text as today and renders it through `UnifiedDiffView` (its old classes are removed; visual parity via the new CSS).

- [ ] **Step 1 (tests first):** helper test (happy-dom): `**b**` → `<strong>`; `<img src=x onerror=alert(1)>` → no `onerror`; `<script>` removed; `[x](javascript:alert(1))` → no `javascript:` href; external link gets `rel` and `target`. Diff view test: classes per line kind; truncation note when `maxLines` exceeded; existing `ExternalChangeDialog` tests still pass.
- [ ] **Step 2:** `npm install dompurify` (types are bundled in dompurify ≥ 3; add `@types/dompurify` only if tsc needs it). Implement. `npx vitest run src/shared src/features/editor`, `npx tsc --noEmit`.
- [ ] **Step 3:** Commit `feat(ui): add sanitized markdown rendering and a unified diff view`.

---

### Task 2: Task status theme tokens

**Files:** `src/shared/themes/types.ts`, `src/shared/themes/apply-theme.ts`, `src/shared/themes/apply-theme.test.ts`.

**Interfaces:**
- `ThemeColors` gains optional `taskStatusInboxBackground`, `taskStatusRunningBackground`, `taskStatusAwaitingUserBackground`, `taskStatusAttentionBackground`, `taskStatusOnHoldBackground`, `taskStatusCompletedBackground`, `taskStatusCancelledBackground` (all `?: string`).
- `CSS_VAR_MAP` maps them to `--task-status-inbox-background` etc.
- `export function taskStatusDefaults(colors: ThemeColors): Required<Pick<ThemeColors, ...those 7>>` — derives from existing tokens with `color-mix(in srgb, <accent> <pct>%, <bgSurface>)`: inbox ← `textMuted` 10%, running ← `accentBlue` 18%, awaiting_user ← `primary` 18%, attention ← `accentRed` 20%, on_hold ← `textSecondary` 12%, completed ← `accentGreen` 18%, cancelled ← `textMuted` 6%. `applyTheme` publishes a preset's explicit value or the derived default, so every preset has all seven variables.

- [ ] Tests first: for every preset in `themePresets`, after `applyTheme`, all seven CSS variables are non-empty; an explicit value in a preset overrides the default; `taskStatusDefaults` output contains the preset's accent color string.
- [ ] Implement, `npx vitest run src/shared/themes`, tsc, commit `feat(theme): add task status background tokens`.

---

### Task 3: `workflow` i18n namespace, parity test, formatters

**Files:** `src/shared/i18n/locales/{ja,en}/workflow.json`, `src/shared/i18n/index.ts`, `src/shared/i18n/__tests__/locale-parity.test.ts`, `src/features/workflow/lib/format.ts` (+ `__tests__/format.test.ts`).

**Interfaces:**
- Namespace `"workflow"` registered like `"agent-chat"`. Key groups (flat camelCase within nested objects is allowed by i18next; use nesting for `status.*`, `role.*`, `codes.*`, `outcome.*`, `mode.*`, `provider.*`, `guardRule.*`):
  - `title` ("WORKFLOWS"), `status.<TaskStatus>`, `runStatus.<RunStatus>`, `role.<Role>`, `mode.<AttemptMode>`, `outcome.<completed|attention|awaiting_user|failed|timeout|cancelled|guard_blocked|interrupted|output_invalid>`, `provider.<Provider>`, `guardRule.<git-remote|forge-cli|outside-workspace|credentials|network-send|system-config|agent-config|opaque-tool|unknown>`.
  - `codes.<CODE>` for: every `ATTENTION_*` in spec 3.13 (with `{{param}}` placeholders matching the params), `INTEGRITY_*` item codes, `SCREENING_*` finding kinds, and command/action codes `TRANSITION_CONFLICT`, `TRANSITION_NOT_ALLOWED`, `TASK_NOT_FOUND`, `WORKFLOW_PROJECT_INVALID`, `WORKFLOW_INTEGRITY_CHANGED`, `WORKFLOW_INTEGRITY_ACK_REQUIRED`, `WORKFLOW_RUN_IN_PROGRESS`, `WORKFLOW_MERGE_REVIEW_CHANGED`, `WORKFLOW_MERGE_INTEGRITY_CHANGED`, `WORKFLOWS_HAVE_WARNINGS`, `WORKFLOW_DESIGN_DOC_FAILED`, `WORKFLOW_WORKTREE_PATH_NOT_UTF8`, `INTEGRITY_FILE_TOO_LARGE`, `GIT_NOT_ON_BASE_BRANCH`, `GIT_DIRTY_WORKTREE`, `GIT_MERGE_CONFLICT`, `GIT_MERGE_FAILED`, `GIT_MERGE_ABORT_FAILED`, `GIT_WORKTREE_LINK_TAMPERED`, `GIT_NOT_A_REPO`, `RUNNER_TURN_CANCELLED`, `RUNNER_UNAVAILABLE`, `AGENT_RUNNER_MISSING`, `STORE_INVALID`, `STORE_CORRUPT`, `STORE_IO_FAILED`, `WORKFLOW_ATTEMPT_PANICKED`, and `WORKFLOW_INVALID_*` validation codes from `model.rs` (read `src-tauri/src/workflow/model.rs` and `errors`-bearing modules to list exact codes and params), plus `codes.unknown` ("{{code}}").
  - UI strings for later tasks may be added by those tasks (they must keep ja/en parity).
- `format.ts`:
  - `export function formatCode(code: string, params?: Record<string, string>): string` — `i18n.exists("workflow:codes." + code)` ? `t` with params : `t("workflow:codes.unknown", { code })`.
  - `export function formatAttention(reason: AttentionReason): { text: string; items: string[] }` — `items` from `params.items` parsed as a JSON array (strings, or objects rendered as `formatCode(o.code) + (o.detail ? ": " + o.detail : "")` for `{code,detail}`, `kind/line/excerpt` for screening findings: `formatCode(kind) + " (L" + line + "): " + excerpt`), max 20, invalid JSON → `[]`.
  - `export function formatCommandError(err: unknown): string` — `CommandError` → `formatCode(code)` + (message ? `\n${message}` : ""); `Error` → message; else `String(err)`.
  - `export function sameRoot(a: string, b: string): boolean` and `export function isCommandError(e: unknown): e is CommandError`.
- `locale-parity.test.ts`: for every namespace file pair under `locales/ja` and `locales/en`, the flattened key sets are equal (if an existing namespace fails today, fix the missing keys in that JSON with a sensible translation rather than exempting it — report which).

- [ ] Tests first: parity test; `formatCode` known/unknown (Review Focus 4: unknown shows the code, never `workflow:codes.X`); `formatAttention` with `ATTENTION_SCREENING_FLAGGED` items, `ATTENTION_INTEGRITY_CHANGED` items, invalid JSON; `formatCommandError` for CommandError/Error/string; `sameRoot` case handling.
- [ ] Implement, `npx vitest run src/shared/i18n src/features/workflow`, tsc, commit `feat(workflow): add workflow translations and message formatting`.

---

### Task 4: Command and event client

**Files:** `src/features/workflow/lib/workflow-api.ts` (+ `lib/__tests__/workflow-api.test.ts`).

**Interfaces** (thin typed wrappers; argument names exactly as the Rust command parameters in camelCase — read `src-tauri/src/commands/workflow.rs` for each command's parameter list and return type):
```ts
export const workflowApi = {
  attach(projectRoot: string): Promise<string>,
  listWorkflows(projectRoot: string): Promise<WorkflowList>,
  saveWorkflows(projectRoot: string, file: WorkflowsFileInput): Promise<void>,
  addStandard(projectRoot: string, name: string, provider: Provider): Promise<Workflow>,
  activeRunCount(projectRoot: string, workflowId: string): Promise<number>,
  listTasks(projectRoot: string): Promise<TaskList>,
  listRuns(projectRoot: string): Promise<RunList>,
  taskDetail(projectRoot: string, taskId: string): Promise<TaskDetail>,
  createTask(projectRoot: string, title: string, body: string, workflowId: string): Promise<Task>,
  cancelTask / holdTask / resumeTask / markComplete / approvePlan / archiveTask (projectRoot, taskId): Promise<Task>,
  deleteTask(projectRoot: string, taskId: string): Promise<void>,
  retryTask(projectRoot: string, taskId: string, opts: { acceptScreening: boolean; acceptAgentConfig: boolean; acceptIntegrity: boolean }): Promise<Task>,
  requestRevision(projectRoot: string, taskId: string, instruction: string): Promise<Task>,
  answerQuestion(projectRoot: string, taskId: string, answer: string): Promise<Task>,
  mergePreview(projectRoot: string, rootTaskId: string): Promise<MergePreview>,
  mergeRun(projectRoot: string, rootTaskId: string, acknowledgedPaths: string[], acknowledgeIntegrity: boolean): Promise<WorkflowRun>,
  discardRun(projectRoot: string, rootTaskId: string): Promise<WorkflowRun>,
  probeProviders(): Promise<ProviderProbe[]>,
  gitignoreStatus(projectRoot: string): Promise<GitignoreStatus>, // added in Task 11; declare now, command lands in Task 11
};
export function subscribeWorkflowEvents(handlers: {
  onTaskChanged?(e: TaskChangedEvent): void; onRunChanged?(e: RunChangedEvent): void; onProgress?(e: ProgressEvent): void;
}): Promise<() => void>;
```
Errors from `invoke` are normalized to `CommandError` when the rejection value is an object with `code`/`message` (or a JSON string of one); anything else is rethrown unchanged. Add `AttemptOutcome` string union and `GitignoreStatus { missing: string[] }` to `src/shared/types/workflow.ts` (type `AttemptRecord.outcome` as `AttemptOutcome | null`).

- [ ] Tests first (mock `@tauri-apps/api/core`/`event` as in `agent-runner-client.test.ts`): each wrapper calls the right command with the right camelCase args (table-driven); CommandError normalization (object, JSON string, plain string); `subscribeWorkflowEvents` registers three listeners and the returned function unlistens all.
- [ ] Implement, test, tsc, commit `feat(workflow): add the workflow command client`.

---

### Task 5: Workflow store

**Files:** `src/features/workflow/workflow-store.ts` (+ `__tests__/workflow-store.test.ts`).

**Interfaces:**
```ts
interface ProjectState { root: string; workflows: Workflow[]; workflowWarnings: StoreWarning[]; tasks: Task[]; taskWarnings: StoreWarning[]; runs: WorkflowRun[]; progress: Record<string /*taskId*/, { text: string; kind: "message" | "tool"; at: number }>; loading: boolean; error: string | null }
interface WorkflowState {
  activeRoot: string | null;               // normalized root of the active folder
  projects: Record<string /*normalized root*/, ProjectState>;
  selectedTaskId: string | null;           // task detail modal
  filters: { workflowId: string | null; showArchived: boolean; showCancelled: boolean; view: "kanban" | "matrix" };
  activate(folderPath: string | null): Promise<void>;   // attach + initial load; null clears activeRoot
  refresh(root: string): Promise<void>;                   // reload workflows, tasks, runs
  openTask(taskId: string | null): void;
  setFilters(p: Partial<WorkflowState["filters"]>): void;
  run<T>(label: string, fn: (root: string) => Promise<T>): Promise<T | undefined>; // executes an action for activeRoot, shows errors (TRANSITION_CONFLICT → silent refresh), refreshes after success
}
export const useWorkflowStore;
export function startWorkflowEventBridge(): Promise<() => void>; // subscribes once; task/run events for a known project schedule a debounced refresh (150 ms); progress updates `progress[taskId]` only for known projects (sameRoot)
```
- `activate` ignores stale completions: if the active folder changed while attaching/loading, the result is stored under its own root but `activeRoot` is not overwritten (Review Focus 2).
- `run` uses `formatCommandError` + `showMessage(..., { kind: "error" })`; `TRANSITION_CONFLICT` → no dialog, refresh (Review Focus 3).

- [ ] Tests first (mock `../lib/workflow-api` and `@/stores/dialog-store`): activate loads lists; switching folders mid-load keeps `activeRoot` on the latest folder; events for another root are ignored; two task events within 150 ms cause one refresh (fake timers); progress events update only known projects; `run` shows an error dialog for a CommandError and refreshes silently for TRANSITION_CONFLICT; `activate(null)` clears the active root.
- [ ] Implement, test, tsc, commit `feat(workflow): add the workflow store`.

---

### Task 6: Activity bar entry, left panel, main-area switch

**Files:** `src/stores/ui-store.ts` (+ its test), `src/stores/tab-store.ts` (only if the restore path needs the new id — it uses `normalizeLeftPanel`), `src/features/file-tree/components/LeftPanel.tsx`, `src/app/App.tsx`, `src/features/workflow/components/WorkflowPanel.tsx` + `.css` (+ test), `src/main.tsx` or App mount point for `startWorkflowEventBridge()` (start once at app startup; keep the unsubscribe for HMR cleanup).

**Behavior:**
- `LeftPanel` union and `LEFT_PANELS` gain `"workflow"`; activity button (inline SVG: three stacked cards/kanban glyph, 20px, same pattern as others) placed after AGENT CHAT; header title `t("title", { ns: "workflow" })`.
- When `leftPanel === "workflow"`, `App.tsx` renders `<Workspace />` in `.app__editor-area` instead of the tab content (the tab bar stays; switching to another panel restores the editor unchanged — editor components must not unmount their state; keep the existing tab tree mounted and hide it with `display: none`, mirroring the AGENT CHAT keep-alive approach).
- `WorkflowPanel` (left panel):
  - No folder → `t("workflow:noFolder")`. Not a git repository is reported by the backend when a run starts; the panel itself only lists.
  - On mount / active folder change: `useWorkflowStore.getState().activate(activeFolderPath)`.
  - Workflow list: name, provider of each stage (compact), enabled switch (`<input type="checkbox" data-switch>`), "edit", "archive"/"delete" (archive/delete confirm with `showConfirm` including `activeRunCount`: "N runs in progress will continue with their snapshot" when N > 0), "add standard workflow" button (asks for a name via `showPrompt`, default `t("workflow:template.standardName")`, provider picker default `codex` — a small inline select), "new task" button (opens CreateTaskDialog from Task 10; until then a disabled placeholder is not allowed — wire it in Task 10 and keep the button hidden here behind `onCreateTask` prop absent).
  - Warnings (`workflowWarnings`, `taskWarnings`) shown as a collapsible list with file + formatted message.
  - Filters: workflow selector (all / each), show archived, show cancelled, view toggle kanban/matrix.
  - Enabling a workflow for the first time goes through the safety notice (Task 11) — in this task, call a `confirmEnable(workflow)` prop/hook that resolves true (Task 11 replaces it).
- Save path for toggles/archive: build `WorkflowsFileInput` from the current `workflows` (`{ schemaVersion: 1, workflows }`) with the change applied and call `saveWorkflows` through `store.run`.

- [ ] Tests first: `normalizeLeftPanel("workflow")` → `"workflow"` (extend existing test); LeftPanel renders the button and switches panel; App renders the workspace placeholder when the panel is selected and keeps the editor mounted (test via a mocked Workspace and a data-testid on the editor area — follow existing App tests if any; otherwise test the switch in a small extracted component `MainArea` if App is too heavy, and note it); WorkflowPanel: lists workflows, toggling calls saveWorkflows with the flipped flag, archive asks confirmation mentioning the run count, warnings rendered, filters update the store; add `WorkflowPanel.tsx/.css` to `switch-contract.test.ts` lists.
- [ ] Implement, `npx vitest run src/features/workflow src/stores src/features/file-tree`, tsc, `npm test`, commit `feat(workflow): add the workflows panel`.

---

### Task 7: Workspace — kanban and matrix

**Files:** `src/features/workflow/components/{Workspace,KanbanBoard,MatrixView,TaskCard}.tsx` + `.css` (+ tests).

**Behavior:**
- `Workspace`: header (project name = last path segment, view toggle mirror of the filter), then `KanbanBoard` or `MatrixView` from `filters.view`; empty state with `t("workflow:emptyBoard")`.
- Visible tasks = active project tasks filtered by workflow id (tasks whose `meta.workflowId` matches), `archived` unless `showArchived`, `cancelled` unless `showCancelled`.
- Kanban columns in status order `inbox, running, awaiting_user, attention, on_hold, completed` (+ `cancelled` when shown), header = localized status + count badge; cards sorted by `updatedAt` desc.
- Matrix: rows = roles (design/implement/review), columns = statuses (same set), cells list cards compactly (title only) with counts.
- `TaskCard`: background `var(--task-status-<status>-background)`; title (text), role badge, relative/absolute `updatedAt` (use `Intl.DateTimeFormat` with the current i18n language, `dateStyle: "short", timeStyle: "short"`), attention line `formatAttention(meta.attention).text` for attention tasks, awaiting kind label for awaiting_user, latest progress line (from store `progress`, single line, ellipsized) for running tasks, a small badge when the task's run is Active and the task is attention/awaiting ("holds a concurrency slot" tooltip). Click → `openTask(id)`. Keyboard: cards are buttons (Enter/Space open).
- Performance (Review Focus 5): cards never render Markdown; list rendering is plain (300 cards must render in one `act` under 1 s in the test).

- [ ] Tests first: columns and counts; filters (archived/cancelled/workflow); card shows attention text and progress line; matrix placement by role/status; click opens task; 300 tasks render within the time bound; card background uses the status CSS variable.
- [ ] Implement, test, tsc, commit `feat(workflow): add the kanban and matrix workspace`.

---

### Task 8: Task detail modal and operations

**Files:** `src/features/workflow/components/{TaskDetailModal,TaskActions,RetryDialog}.tsx` + `.css` (+ tests).

**Behavior:**
- Modal (overlay + dialog, `role="dialog"`, `aria-modal`, Escape closes, overlay click closes) loads `taskDetail` for `selectedTaskId` and reloads when a task/run event for that task arrives (store refresh bumps a `detailVersion` counter or the modal subscribes to store changes for the task's `updatedAt`).
- Sections: title + status chip; body (`renderMarkdownSafe`); attention reason (`formatAttention` text + items list); awaiting info (plan approval or the question as plain text); latest output (`renderMarkdownSafe`, collapsible, with the attempt's mode/outcome labels); attempts table (started/finished, mode, outcome, stage) newest first; history (at, from → to, formatted reason); run info (status, re-entry count/max, branch, base, current stage name; for the latest transition show "from <stage name> to <stage name>" derived from history of the run's tasks — use stage names from the run snapshot); log tail in a collapsible `<pre>` (text).
- `TaskActions` shows buttons by state (each via `store.run`):
  - inbox: cancel. running: hold, cancel. on_hold: resume, cancel. attention: retry (opens RetryDialog), mark complete (confirm), cancel. awaiting_user(plan_approval): approve, request revision (textarea required), cancel. awaiting_user(question): answer (textarea required), cancel. completed/cancelled: archive, delete (confirm; delete errors like `WORKFLOW_RUN_IN_PROGRESS` are shown).
- `RetryDialog`: checkboxes shown only when relevant to the attention code: `ATTENTION_SCREENING_FLAGGED` → "accept flagged input" (acceptScreening), `ATTENTION_AGENT_CONFIG_CHANGED` → acceptAgentConfig, `ATTENTION_INTEGRITY_CHANGED` with config/hooks items → acceptIntegrity (explanatory text: a new baseline is taken; branch/HEAD-only changes need no acknowledgement). Each has an explanation string. If the backend replies `WORKFLOW_INTEGRITY_ACK_REQUIRED`, the dialog re-opens with that checkbox visible.
- Review Focus 1: a body/output containing `<img src=x onerror=...>` renders without the handler; Review Focus 3: TRANSITION_CONFLICT on hold refreshes silently.

- [ ] Tests first: sections render from a TaskDetail fixture; XSS fixture is inert; each status shows exactly the expected buttons; approve/revision/answer call the API with the text; retry dialog shows the right checkboxes per code and passes flags; ACK_REQUIRED path; delete error shown via dialog; Escape closes.
- [ ] Implement, test, tsc, commit `feat(workflow): add the task detail modal and task operations`.

---

### Task 9: Merge and discard

**Files:** `src/features/workflow/components/MergeSection.tsx` + `.css` (+ test); rendered inside `TaskDetailModal` for the run's root task (and for any task of a run in `awaiting_merge`, `cancelled`, `merged`).

**Behavior:**
- `awaiting_merge`: "preview" loads `mergePreview`: branch, base branch/commit (short), commits list (hash short + subject), `UnifiedDiffView` of `diff` (cap 5000 lines, note when capped), `reviewPaths` as a checklist the user must tick all of (explicit confirmation of configuration-type files: `.github/`, `AGENTS.md`, `CLAUDE.md`, …), `integrityChanges` (formatted) with an "acknowledge repository changes" checkbox. When `integrityChanges` is non-empty the preview has no diff/paths yet: show the explanation and a "acknowledge and re-check" button that calls `mergeRun(..., [], true)`; expect `WORKFLOW_MERGE_REVIEW_CHANGED` or success; on `WORKFLOW_MERGE_REVIEW_CHANGED` silently re-run the preview (two-step flow).
- "Merge locally" enabled only when every review path is ticked; calls `mergeRun(root, rootTaskId, reviewPaths, false)`. Errors `GIT_NOT_ON_BASE_BRANCH`, `GIT_DIRTY_WORKTREE`, `GIT_MERGE_CONFLICT`, `GIT_MERGE_FAILED`, `GIT_MERGE_ABORT_FAILED` shown via `formatCommandError`. After success show `t("workflow:merge.done")` and offer "remove worktree" (= `discardRun`, confirm).
- `cancelled` / `merged` runs with a worktree: "discard" (confirm; for cancelled: "worktree and branch will be deleted").
- No push/PR buttons.

- [ ] Tests first: preview renders commits/diff/paths; merge disabled until all paths ticked; merge called with the ticked paths; integrity two-step flow (first call → re-preview); each git error code shows the localized text; discard confirm then API call; large diff capped (Review Focus 5).
- [ ] Implement, test, tsc, commit `feat(workflow): add the merge and discard flow`.

---

### Task 10: Workflow edit dialog and task creation

**Files:** `src/features/workflow/components/{WorkflowEditDialog,CreateTaskDialog}.tsx` + `.css` (+ tests); wire into `WorkflowPanel` (edit button, new-task button).

**Behavior:**
- `WorkflowEditDialog(workflow)`: name, enabled (switch), per stage (design/implement/review, fixed order; role labels localized): name, provider (select; each option shows availability from `probeProviders`, unavailable ones marked with the reason via `formatCode` of the probe detail), model (optional text), prompt (textarea), completion criteria (textarea), timeout minutes (number ≥ 1), requires approval (implement only); review return target (design/implement); max re-entry (≥ 1); max concurrent runs (≥ 1); design doc path (switch "save design doc" — enabling fills `docs/designs/{date}-{slug}-design.md`; text field when enabled); issue tracking (auto/off; show that it applies from Part 4 — just the select, no extra text required). Save builds a `WorkflowsFileInput` replacing that workflow and calls `saveWorkflows`; `STORE_INVALID` errors are shown inside the dialog as a list (`formatCode` of each validation code; parse the CommandError message if the backend packs codes there — read `commands/workflow.rs`/`store.rs` to see how `Invalid(Vec<ValidationError>)` serializes and display each code), not only as a global dialog. Enabling (false → true) goes through `confirmEnable` (Task 11).
- `CreateTaskDialog`: title (required), body (Markdown textarea with a preview toggle using `renderMarkdownSafe`), workflow select listing only enabled, non-archived workflows (none → message + button to add the standard workflow); create → `createTask`, close, open the new task's detail.

- [ ] Tests first: edit dialog renders all fields from a workflow; approval checkbox only on implement; enabling doc path fills the default; validation errors shown inline; save sends the modified workflow; provider options show unavailability; create dialog lists only enabled workflows, requires title, calls createTask and opens detail.
- [ ] Implement, test, tsc, commit `feat(workflow): add workflow editing and task creation`.

---

### Task 11: First-enable safety notice and `.gitignore` guidance

**Files:** `src-tauri/src/commands/workflow.rs` (+ `lib.rs` registration — note `lib.rs` may have unrelated uncommitted formatting changes: stage only your hunk), `src/features/workflow/components/SafetyNoticeDialog.tsx` + `.css` (+ test), `WorkflowPanel.tsx`/`WorkflowEditDialog.tsx` wiring.

**Interfaces:**
- Rust: `#[tauri::command] async fn workflow_gitignore_status(state, project_root: String) -> Result<GitignoreStatus, CommandError>` with `#[derive(Serialize)] #[serde(rename_all = "camelCase")] struct GitignoreStatus { missing: Vec<String> }` — for each of `.mdium/tasks/`, `.mdium/runs/`, `.mdium/task-attachments/`, `.mdium/intakes/`, report it missing unless `git check-ignore -q <path>/x` (run from the project root with the user's environment, via the existing gitops helpers; non-git project → all listed). Validate `project_root` like other commands. Unit test with a temp repo (.gitignore covering `.mdium/` → none missing; empty → four).
- `SafetyNoticeDialog`: shown when enabling a workflow while `localStorage["mdium-workflow-safety-ack"] !== "1"` (wrap storage access in try/catch). Text explains (i18n, from spec 3.7): implementation stages run with full access inside an isolated worktree; the guard layers; that detection cannot be complete (obfuscated commands, network sends); nothing is pushed. Buttons: cancel / "I understand, enable". On accept store the flag and enable.
- After enabling (or on panel activation for a project with any enabled workflow), call `gitignoreStatus`; if `missing` is non-empty show a dismissible notice in the panel with the lines to add (copy-to-clipboard button using `navigator.clipboard.writeText`) — no automatic edit.

- [ ] Tests first: Rust command test; dialog shows on first enable and not after acceptance; cancel keeps the workflow disabled; storage exceptions don't break enabling (treated as not acknowledged → dialog shown); gitignore notice lists missing lines and copies them.
- [ ] Implement, full checks (`cargo test` for the new command module, `cargo check`, `npx tsc --noEmit`, `npm test`), commit `feat(workflow): explain workflow safety and suggest ignore rules`.

---

### Task 12: Verification and smoke checklist

- [ ] `npm test`, `npx tsc --noEmit`, `cargo test --manifest-path src-tauri/Cargo.toml`, `cargo check`, `npm run build:sidecar`, `npm run build` (vite build) — report counts.
- [ ] Write `.superpowers/sdd/part3c-smoke.md` (Japanese) with a manual GUI smoke procedure for the user: open a git project, add the standard workflow, enable it (safety notice), create a task, watch design → implement → review (with a real CLI), approve a plan (with requiresApproval), answer a question, hold/resume/cancel, retry after an attention, merge preview/merge, discard; theme switch shows status colors; language switch ja/en.
- [ ] (`.superpowers/sdd/` is git-ignored; the checklist is not committed.) Report the path to the controller.
