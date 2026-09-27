# Intake, Issue Tracker and Attachments — Backend (Part 4a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the backend of spec Part 4: requirements-intake sessions driven by a read-only agent (with images and document-update proposals), a resumable finalize pipeline that turns an intake into a root task (optionally creating a GitHub/GitLab Issue and committing attachments), task attachments stored immutably under `.mdium/task-attachments/`, and Issue synchronization at stage boundaries and on merge (comments with duplicate protection, close on merge, attention with retry/skip on failure). The UI (intake window, attachment and Issue views) is Part 4b.

**Architecture:** New Rust modules in `src-tauri/src/workflow/`: `attachments.rs` (drafts, commit, metadata, path safety), `forge.rs` (origin detection, `gh`/`glab` API client behind a `ForgeCli` trait with a fake for tests), `issue_sync.rs` (entry bodies, marker-based dedupe, stage hooks), `intake.rs` (session model/store, turn execution through `RunnerApi`, output contract parser, doc-update proposals, finalize pipeline). The orchestrator's attempt thread performs Issue sync *outside* the project lock after a stage completes and before `finish_attempt` advances; a sync failure turns the stage result into `ATTENTION_ISSUE_SYNC_FAILED` without advancing. The runner protocol's `send` gains optional image paths for providers that accept images.

**Tech Stack:** Rust (existing crates only; `mime_guess` only if already present — otherwise a small extension table), Node agent runner (TypeScript), system `git`, `gh` / `glab` CLIs with the user's normal environment.

**Spec:** `.superpowers/specs/2026-09-24-agent-workflows-design.md` Part 4 (4.1–4.4), plus 3.8 (inputs), 3.10 (advance), 3.11 (merge), 3.13 (codes). Previous plans: `2026-09-25-workflow-foundation.md`, `2026-09-25-workflow-orchestrator.md`, `2026-09-26-workflow-ui.md`.

## Global Constraints

- All code comments in English. No UI strings in Rust: reasons/errors are codes (`AttentionReason { code, params }`, `{ code, message }`).
- New attention code: `ATTENTION_ISSUE_SYNC_FAILED` (params `code`, `message` ≤ 160 chars, `entry` = entry kind `design|implement|review`). New command/action codes are prefixed `INTAKE_*`, `ATTACHMENT_*`, `FORGE_*`, `ISSUE_*`. Every new code is added to the spec 3.13 tables in Task 10 (Japanese).
- Files (all atomic writes, `schemaVersion: 1`):
  - `.mdium/intakes/<intakeId>.json` — intake session.
  - `.mdium/task-attachments/<rootTaskId>/<attachmentId>/{meta.json, <sanitized original name>}` — committed attachments, immutable after commit.
  - `.mdium/task-attachments/_drafts/<intakeId>/<draftId>/{meta.json, <name>}` — drafts.
  - Ids are 16 lowercase hex (`fsutil::new_id`); every path is built through `MdiumPaths` helpers that validate ids and reject escapes; attachment file names are sanitized (basename only, no `..`, no reserved Windows names, ≤ 120 chars, control chars removed) and the final path must stay under the attachments root after canonicalization.
- Limits: attachment ≤ 20 MiB each, ≤ 20 per task; intake message ≤ 64 KiB text; intake transcript sent to the agent ≤ 256 KiB (oldest turns summarized as "[earlier turns omitted]" beyond that).
- Intake agent sessions: provider/model from the session; `RunnerPermission::ReadOnly`; working directory and guard root = the project root; a **new session per turn** with the whole transcript in the prompt (stateless and resumable across restarts); built-in intake prompts are English and self-contained.
- Issue CLI calls run with the user's normal environment (not the containment env), `CREATE_NO_WINDOW` on Windows, bodies passed through temp files (`@file` / `--body-file` style — never on the command line), every call names the repository explicitly (`--hostname`/`-R`/API path). Temp files live under the OS temp dir and are removed after the call.
- Every comment body ends with `<!-- mdium:entry:<entryId> -->` where `entryId = <taskId>-<attemptId>`; before posting, existing comments are fetched and a comment containing the marker means "already posted" (success, no new post).
- Issue sync never happens while holding the `ProjectGuard`.
- Tests: `cargo test --manifest-path src-tauri/Cargo.toml workflow::` (and `commands::workflow`), real git in temp dirs where git is involved, `FakeForge` for all forge behavior (no network). Runner changes: `npx vitest run sidecar/agent-runner`.
- Never run `cargo fmt`; use `rustfmt --edition 2021 <file>` on files you changed that have no foreign uncommitted changes. The working tree may contain unrelated rustfmt-only changes in `src-tauri/src/commands/*`, `file_watcher.rs`, `http_bridge.rs`, `lib.rs`: never stage them; when you must edit such a file, stage only your hunk (blob from `git show HEAD:<file>` + your edit, `git hash-object -w`, `git update-index --cacheinfo`, verify `git diff --cached`).
- Specs/plans/commit messages describe this as new work. Commit trailer: `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.

## Review Focus

1. An Issue comment is posted, then the app crashes before the stage advances; on retry the comment is not posted twice (marker found), and the stage advances. (Tasks 4, 7.)
2. A pasted/attached file named `..\..\evil.exe`, `CON`, a symlink, or a path outside the project → rejected or sanitized; committed attachments never change afterwards (re-commit is idempotent). (Task 2.)
3. The finalize pipeline fails after the Issue was created (e.g. attachment copy fails) → retry resumes at the failed stage, does not create a second Issue, and the root task id stays the same. (Task 8.)
4. `gh`/`glab` missing, unauthenticated, or `origin` not a forge → intake still works; Issue tracking is reported as unavailable before the intake starts (probe) and finalize skips Issue creation only when tracking is `off`/unavailable-and-acknowledged, never silently. (Tasks 3, 8.)
5. The intake agent returns malformed output or a doc-update proposal for `../../outside.md` or `.git/config` → shown as a retryable error / proposal rejected; nothing is written outside the project or into `.git`/`.mdium`. (Tasks 6, 9.)

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `sidecar/agent-runner/{protocol.ts,runner-core.ts,*-adapter.ts}`, `src/shared/types/agent-runner.ts` | `send` with optional image paths | 1 |
| `src-tauri/src/workflow/runner_client.rs`, `runner_host.rs`, `attempt.rs` | pass images | 1 |
| `src-tauri/src/workflow/{fsutil.rs,attachments.rs}` | attachment paths, drafts, commit, metadata | 2 |
| `src-tauri/src/workflow/forge.rs` | origin detection, `ForgeCli` trait, gh/glab implementation, fake | 3 |
| `src-tauri/src/workflow/issue_sync.rs` | entry bodies, dedupe, post/close | 4 |
| `src-tauri/src/workflow/model.rs` | `IssueRef`, task/run fields, intake model | 5 |
| `src-tauri/src/workflow/intake.rs` | session store, contract parser, turn execution, doc proposals | 6 |
| `src-tauri/src/workflow/{orchestrator.rs,flow.rs,actions.rs,prompt.rs}` | stage-completion sync, retry/skip, merge close, attachments in prompts | 7 |
| `src-tauri/src/workflow/intake.rs` (finalize) , `actions.rs` | finalize pipeline | 8 |
| `src-tauri/src/commands/workflow.rs`, `lib.rs`, `src/shared/types/workflow.ts` | commands, events, TS types | 9 |
| spec | sync | 10 |

---

### Task 1: Images in runner turns

**Files:** `sidecar/agent-runner/protocol.ts`, `runner-core.ts`, adapters (`codex-adapter.ts`, `claude-adapter.ts`, `copilot-adapter.ts`, `opencode-adapter.ts`), `src/shared/types/agent-runner.ts`, tests; Rust `runner_client.rs` (`send(session_id, text, images: &[String])`), `runner_host.rs` (`RunnerApi::send` signature), `attempt.rs` (callers pass `&[]` for now), fakes in tests.

**Interfaces:**
- Protocol: `{ type: "send"; sessionId; text; images?: string[] }` — `parseInbound` validates: array of ≤ 10 non-empty absolute paths; each must be an existing regular file (`fs.statSync`) ending in `.png|.jpg|.jpeg|.gif|.webp`; invalid → `error` with `INVALID_IMAGES`.
- Adapters: Codex → SDK local image input items (read `@openai/codex-sdk` types for the exact input shape); Claude → user message content blocks `{ type: "image", source: { type: "base64", media_type, data } }` (read files, ≤ 5 MiB each, larger → skipped with a text note); Copilot and opencode → if the SDK supports attachments/file parts use them, otherwise append `\n\n[Images: <paths>]` to the text (the files are readable by the agent). Document per provider in the adapter file header.
- Image paths must be inside the session's guard `workspaceRoot` (intake sessions use the project root, so drafts qualify). Stage attempts pass no images in this plan: their working directory is the worktree, so committed attachments reach stage agents as absolute paths in the prompt (Task 7).

- [ ] Tests first: protocol parse (valid, too many, relative, missing file, wrong extension); each adapter builds the expected input with a fake SDK; Rust client serializes `images` only when non-empty.
- [ ] Implement; `npx vitest run sidecar/agent-runner`, `npx tsc --noEmit`, `npm run build:sidecar`, `cargo test ... workflow::`. Commit `feat(agent-runner): accept image paths in turns`.

---

### Task 2: Attachments

**Files:** `src-tauri/src/workflow/fsutil.rs` (paths), `src-tauri/src/workflow/attachments.rs` (+ `mod.rs`).

**Interfaces:**
```rust
pub struct AttachmentMeta { pub schema_version: u32, pub id: String, pub original_name: String, pub stored_name: String, pub mime: String, pub size: u64, pub sha256: String, pub created_at: String }
pub fn sanitize_file_name(name: &str) -> String;            // basename only; see Global Constraints; empty → "attachment"
pub fn mime_for(name: &str) -> &'static str;                // extension table (png, jpg/jpeg, gif, webp, pdf, txt, md, json, csv, log, zip; default application/octet-stream)
pub fn add_draft_from_path(paths: &MdiumPaths, intake_id: &str, source: &Path) -> Result<AttachmentMeta, AttachmentError>; // regular file only (no symlink), ≤ 20 MiB, copies content, computes sha256
pub fn add_draft_from_bytes(paths: &MdiumPaths, intake_id: &str, name: &str, bytes: &[u8]) -> Result<AttachmentMeta, AttachmentError>; // pasted images
pub fn list_drafts(paths, intake_id) -> Result<Vec<AttachmentMeta>, AttachmentError>;
pub fn remove_draft(paths, intake_id, draft_id) -> Result<(), AttachmentError>;
pub fn commit_drafts(paths, intake_id, root_task_id) -> Result<Vec<AttachmentMeta>, AttachmentError>; // idempotent: an already-committed id with the same sha256 is kept; copies (not moves) then removes the draft dir; ≤ 20 per task
pub fn list_attachments(paths, root_task_id) -> Result<Vec<AttachmentMeta>, AttachmentError>;
pub fn attachment_file(paths, root_task_id, attachment_id) -> Result<PathBuf, AttachmentError>; // canonical, verified under the attachments root
pub enum AttachmentError { InvalidId, NotAFile, TooLarge, TooMany, OutsideRoot, Io(String), Corrupt(String) } // codes ATTACHMENT_*
```
`MdiumPaths` gains `attachments_root()`, `attachment_dir(root_id, attachment_id)`, `drafts_dir(intake_id)`, `draft_dir(intake_id, draft_id)`, `intakes_dir()`, `intake_file(intake_id)`.

- [ ] Tests first (Review Focus 2): sanitize cases (`..\\..\\evil.exe` → `evil.exe`, `CON` → `_CON`, control chars, long names, empty); symlink source rejected (unix-only test + Windows junction/symlink when permitted); size limit; count limit; commit idempotent (same content twice → one attachment, metas unchanged); attachment_file rejects ids that escape; draft removal; sha256 and mime recorded.
- [ ] Implement, test, commit `feat(workflow): store task attachments`.

---

### Task 3: Forge detection and CLI client

**Files:** `src-tauri/src/workflow/forge.rs` (+ `mod.rs`).

**Interfaces:**
```rust
pub enum ForgeKind { GitHub, GitLab }                         // serde lowercase
pub struct ForgeRepo { pub kind: ForgeKind, pub host: String, pub path: String /* owner/repo or group/sub/project */ }
pub fn parse_remote_url(url: &str) -> Option<(String /*host*/, String /*path without .git*/)>; // https, ssh (git@host:path), ssh://
pub fn detect(repo_root: &Path, cli: &dyn ForgeCli) -> Result<Option<ForgeRepo>, ForgeError>; // origin url → github.com ⇒ GitHub; gitlab.com ⇒ GitLab; other host ⇒ cli.is_authenticated(GitHub, host) ⇒ GitHub, else GitLab probe ⇒ GitLab, else None
pub struct IssueRefData { pub number: u64, pub url: String }
pub struct Comment { pub body: String }
pub trait ForgeCli: Send + Sync {
    fn available(&self, kind: ForgeKind) -> bool;                                   // CLI on PATH
    fn is_authenticated(&self, kind: ForgeKind, host: &str) -> bool;
    fn create_issue(&self, repo: &ForgeRepo, title: &str, body: &str) -> Result<IssueRefData, ForgeError>;
    fn list_comments(&self, repo: &ForgeRepo, number: u64) -> Result<Vec<Comment>, ForgeError>; // all pages
    fn add_comment(&self, repo: &ForgeRepo, number: u64, body: &str) -> Result<(), ForgeError>;
    fn close_issue(&self, repo: &ForgeRepo, number: u64) -> Result<(), ForgeError>;
}
pub struct CliForge;       // real: GitHub via `gh api --hostname <host> ...` (POST repos/{path}/issues with -F title=… -F body=@<tmpfile>; GET .../issues/{n}/comments --paginate; POST .../comments -F body=@file; PATCH .../issues/{n} -f state=closed); GitLab via `glab api --hostname <host> ...` (projects/{url-encoded path}/issues, iid, notes, state_event=close). Verify flags with `gh api --help` / `glab api --help`; if glab lacks `@file` fields, send a JSON body via `--input <file>`. Parse JSON with serde_json.
#[cfg(test)] pub struct FakeForge { ... }   // records calls; configurable failures; stores comments
pub enum ForgeError { NotInstalled, NotAuthenticated, CommandFailed { code: i32, stderr: String }, BadResponse(String) } // FORGE_* codes; stderr capped at 500 chars
pub struct ForgeProbe { pub repo: Option<ForgeRepo>, pub cli_available: bool, pub authenticated: bool } ; pub fn probe(repo_root, cli) -> ForgeProbe;
```

- [ ] Tests first: `parse_remote_url` table (https with/without .git, ssh scp-like, ssh://, nested GitLab groups, ports, trailing slash, invalid); `detect` with FakeForge for github.com, gitlab.com, self-hosted resolved by auth probe, none; probe results; `CliForge` command lines built by a pure function `build_args(op) -> Vec<String>` tested for both kinds (no real CLI calls in tests); temp body files removed (test the helper).
- [ ] Implement, test, commit `feat(workflow): detect forges and talk to their CLIs`.

---

### Task 4: Issue sync entries

**Files:** `src-tauri/src/workflow/issue_sync.rs` (+ `mod.rs`).

**Interfaces:**
```rust
pub enum EntryKind { Design, Implement, Review }
pub fn entry_id(task_id: &str, attempt_id: &str) -> String;
pub fn marker(entry_id: &str) -> String;                        // "<!-- mdium:entry:<id> -->"
pub fn design_body(design_markdown: &str, entry: &str) -> String;
pub fn implement_body(summary_markdown: &str, branch: &str, commits: &[CommitSummary], entry: &str) -> String;
pub fn review_body(review_markdown: &str, returned: bool, entry: &str) -> String;   // returned = findings sent back
pub fn post_entry(cli: &dyn ForgeCli, repo: &ForgeRepo, number: u64, body: &str, entry: &str) -> Result<PostOutcome, ForgeError>; // list → marker found ⇒ AlreadyPosted, else add_comment ⇒ Posted
pub enum PostOutcome { Posted, AlreadyPosted }
```
Bodies are English headings (these are machine-generated records; not UI) — `## Design`, `## Implementation`, `## Review` + content; bodies capped at 60 000 chars with a truncation note before the marker (GitHub comment limit 65 536).

- [ ] Tests first: marker at end; dedupe (marker present ⇒ no add_comment); truncation keeps the marker; list failure ⇒ error (no blind post).
- [ ] Implement, test, commit `feat(workflow): build issue entries with duplicate protection`.

---

### Task 5: Model additions

**Files:** `src-tauri/src/workflow/model.rs` (+ callers' test literals).

**Interfaces (`#[serde(default)]`, schema stays 1):**
```rust
pub struct IssueRef { pub kind: ForgeKind, pub host: String, pub path: String, pub number: u64, pub url: String }
// TaskMeta: pub issue: Option<IssueRef> (root tasks only), pub pending_issue_entry: Option<String> /* entry kind awaiting sync after ATTENTION_ISSUE_SYNC_FAILED */
// WorkflowRun: pub issue: Option<IssueRef>, pub issue_closed: bool, pub issue_close_error: Option<String>
// Intake model (used by Task 6/8):
pub enum IntakeKind { Feature, Bug }
pub enum IntakeStatus { Active, Finalizing, Done, Abandoned }
pub enum FinalizeStage { Ready, IssueCreated, AttachmentsCommitted, TaskCreated, Done }
pub struct IntakeMessage { pub id: String, pub role: String /* "user" | "assistant" | "error" */, pub text: String, pub draft_ids: Vec<String>, pub at: String }
pub struct IntakeProposal { pub title: String, pub body: String }
pub struct DocUpdateProposal { pub id: String, pub path: String, pub content: String, pub status: String /* "pending"|"applied"|"rejected" */ }
pub struct FinalizeState { pub stage: FinalizeStage, pub root_task_id: Option<String>, pub issue: Option<IssueRef>, pub attachment_ids: Vec<String>, pub skip_issue: bool, pub last_error: Option<String> }
pub struct IntakeSession { pub schema_version: u32, pub id: String, pub workflow_id: String, pub kind: IntakeKind, pub provider: Provider, pub model: Option<String>, pub status: IntakeStatus, pub messages: Vec<IntakeMessage>, pub last_question: Option<IntakeQuestion>, pub proposal: Option<IntakeProposal>, pub doc_updates: Vec<DocUpdateProposal>, pub finalize: FinalizeState, pub created_at: String, pub updated_at: String }
pub struct IntakeQuestion { pub text: String, pub options: Vec<String> }
```
- [ ] Tests first: old files load with defaults; round-trip camelCase (`pendingIssueEntry`, `issueClosed`, intake enums snake_case).
- [ ] Implement, test, commit `feat(workflow): model issues and intake sessions`.

---

### Task 6: Intake sessions and turns

**Files:** `src-tauri/src/workflow/intake.rs` (+ `mod.rs`), `src-tauri/src/workflow/template.rs` (intake prompt constants).

**Interfaces:**
```rust
pub fn create_session(store: &WorkflowStore, guard: &ProjectGuard, workflow_id: &str, kind: IntakeKind, provider: Provider, model: Option<String>) -> Result<IntakeSession, IntakeError>;
pub fn get_session / list_sessions (newest first; corrupt → warnings) / save_session(guard) / abandon_session(guard);
pub fn add_user_message(guard, store, id, text, draft_ids) -> Result<IntakeSession, IntakeError>; // ≤ 64 KiB; drafts must exist
pub fn run_turn(runner: &dyn RunnerApi, store: &WorkflowStore, id: &str, cancel: &CancelToken) -> Result<IntakeSession, IntakeError>;
    // builds the prompt (intake prompt for kind + transcript + draft image list) → new ReadOnly session in the project root with guard root = project root → images = draft image paths of the latest user message (Task 1) → parse contract → append assistant message, set last_question / proposal / doc_updates; on runner/contract failure append an "error" message (code) and return Ok (the UI shows retry). Never holds the guard while waiting on the runner: load under guard, release, run, reacquire and re-load, append, save.
pub fn parse_intake_output(text: &str) -> Result<IntakeReply, IntakeError>;
pub enum IntakeReply { Question(IntakeQuestion), Proposal { proposal: IntakeProposal, doc_updates: Vec<(String, String)> } }
pub fn apply_doc_update(store, guard, id, proposal_id, accept: bool) -> Result<IntakeSession, IntakeError>;
    // accept: path must be relative, normalized, inside the project, not under .git/.mdium/, text ≤ 256 KiB, not a symlink target outside → atomic write into the user's working tree; status applied/rejected
pub enum IntakeError { NotFound, InvalidState(&'static str), TooLarge, InvalidPath(String), Contract(String), Store(StoreError), Attachment(AttachmentError) } // INTAKE_* codes
```
Output contract (English, in the intake prompts): frontmatter `type: question` + `question:` + optional `options:` list (≤ 6 short strings) and a Markdown body with context; or `type: proposal` + `title:` (≤ 100 chars) + body = the full requirement document (feature: Goal, Constraints, Acceptance criteria, Open questions; bug: Symptoms, Expected, Actual, Steps to reproduce, Environment, Open questions) + optional `doc_updates:` list of `{ path, content }` for documentation files like `CONTEXT.md`. Prompts instruct: ask one question at a time; read the repository read-only to ground questions; never propose code changes; propose doc updates only for documentation files.

- [ ] Tests first: create/list/abandon; message size limit; parser (question with/without options, proposal with/without doc_updates, fenced output, malformed → Contract error, title too long truncated); run_turn with a scripted fake RunnerApi (ReadOnly, guard root = project root, images passed for drafts with image mime, transcript truncation at 256 KiB, runner failure → error message appended and session saved); doc update path validation (Review Focus 5: `../x`, `.git/config`, `.mdium/x`, absolute, symlinked dir) and accepted write lands in the project.
- [ ] Implement, test, commit `feat(workflow): run requirement intake sessions`.

---

### Task 7: Issue sync in the workflow and attachments in prompts

**Files:** `src-tauri/src/workflow/{orchestrator.rs,flow.rs,actions.rs,prompt.rs}`.

**Behavior:**
- Orchestrator gets an `Arc<dyn ForgeCli>` (constructor param; production `CliForge`, tests `FakeForge`).
- Attempt thread: after `post_attempt` passes and the attempt ended `Completed` with a parseable outcome of kind `Completed` (not plan mode) — or review `Attention` (returned findings) — and the run has `issue: Some(..)` and the run's workflow `issueTracking == auto`: build the entry body (design: outcome body; implement: outcome body + branch + `commits_since_base_in`; review: outcome body, `returned` for attention) and `post_entry` **before** taking the guard for `finish`. Failure → `finish` receives a new `FinishInput.issue_sync_error: Option<ForgeError>`; flow then transitions to attention `ATTENTION_ISSUE_SYNC_FAILED{code,message,entry}`, sets `meta.pending_issue_entry = Some(kind)`, persists the attempt output (already saved), and does **not** advance / re-enter / set AwaitingMerge.
- Ordering rule: the Issue sync happens before `finish`. On sync failure, `finish` performs no design-doc commit, no advance, no re-entry and no AwaitingMerge. Extract the "stage completed" logic of `finish_attempt` (design-doc commit + advance / review re-entry / AwaitingMerge) into `flow::complete_stage(guard, store, task, run, outcome, worktree_base)` so the normal path and the retry/skip actions share it.
- Actions: `retry_issue_sync(task_id)` — task must be attention with `ATTENTION_ISSUE_SYNC_FAILED`; re-parses the latest attempt output, re-posts (marker dedupe) outside the lock, then under the lock runs the integrity check (same filter as mark_complete) and `complete_stage` (attention → completed transition path, like mark_complete). `skip_issue_sync(task_id)` — same without posting. Both clear `pending_issue_entry`.
- Merge: after a successful `merge_run`, if `run.issue` exists and tracking auto → `close_issue` (outside the lock); failure sets `run.issue_close_error` (and emits run_changed) but the merge result stands; `retry_issue_close(root_task_id)` action.
- Prompt: `PromptInput` gains `attachments: &[AttachmentView { id, name, mime, size, path }]` rendered as `## Attachments` (plain list; paths absolute; "read these files if relevant"); flow passes the root task's committed attachments for every stage.

- [ ] Tests first (FakeForge, temp repo, fake runner): design completion posts one comment with the marker, then implement starts; comment list shows the marker → no duplicate on a second completion of the same attempt (Review Focus 1: simulate crash by posting via FakeForge before finish and ensure retry_issue_sync finds the marker and advances); sync failure → attention ISSUE_SYNC_FAILED, no child task, design doc not committed; retry succeeds → child created; skip → child created without post; review attention with findings posts a "returned" review entry then re-enters; merge closes the Issue; close failure recorded and retry works; tracking off or no issue → no forge calls; prompt contains attachments.
- [ ] Implement, test (orchestrator tests 3×), commit `feat(workflow): sync stage results to issues`.

---

### Task 8: Finalize pipeline

**Files:** `src-tauri/src/workflow/intake.rs`, `actions.rs`.

**Interfaces:**
```rust
pub fn finalize(orch: &Arc<Orchestrator>, project_root: &Path, intake_id: &str, opts: FinalizeOptions) -> Result<IntakeSession, IntakeError>;
pub struct FinalizeOptions { pub skip_issue: bool } // user chose to continue without an Issue after a failure/unavailable probe
```
Stages (spec 4.2), each persisted before moving on, each resumable:
1. `Ready` → requires `proposal`; assign `root_task_id = new_id()` once (kept on retries); status `Finalizing`.
2. If the workflow's `issueTracking == auto` and not `skip_issue` and forge detected+authenticated → create the Issue (title = proposal title, body = proposal body + attachments list names) **outside the guard** → store `issue` → stage `IssueCreated`. If tracking auto but forge unavailable and not `skip_issue` → fail with `ISSUE_TRACKING_UNAVAILABLE` (the UI offers "continue without Issue" = `skip_issue`). Tracking off → skip.
3. `commit_drafts(intake_id, root_task_id)` → `attachment_ids` → `AttachmentsCommitted`.
4. Create the root task with the fixed id (add `actions::create_root_task_with_id(orch, root, id, title, body, workflow_id, issue)` or extend `create_task` with an optional id; `AlreadyExists` with the same id = already done) → `TaskCreated`; the task body = proposal body + `## Attachments` list (names + ids); `meta.issue` = the Issue.
5. `Done`, status `Done`, kick.
Any failure records `finalize.last_error` (code) and returns the error; calling `finalize` again resumes from the recorded stage.

- [ ] Tests first (Review Focus 3/4): happy path with FakeForge (one Issue, attachments committed, task created with issue ref and body); failure at attachments after Issue created → retry does not create a second Issue and keeps the root id; tracking off → no forge calls; forge unavailable → ISSUE_TRACKING_UNAVAILABLE, then skip_issue path completes; finalize twice after Done is a no-op returning the session.
- [ ] Implement, test, commit `feat(workflow): finalize intakes into tasks`.

---

### Task 9: Commands, events, types

**Files:** `src-tauri/src/commands/workflow.rs`, `src-tauri/src/lib.rs` (registration hunk only), `src/shared/types/workflow.ts`, `src/features/workflow/lib/workflow-api.ts` (+ test).

**Commands** (same conventions as existing workflow commands: `with_project`, blocking, `CommandError`): `workflow_forge_probe(projectRoot)`, `workflow_intake_create(projectRoot, workflowId, kind, provider, model)`, `workflow_intake_list`, `workflow_intake_get(intakeId)`, `workflow_intake_send(intakeId, text, draftIds)` (appends then runs the turn in a background thread; returns the session with the user message; the assistant reply arrives by event), `workflow_intake_retry(intakeId)` (re-runs the last turn), `workflow_intake_cancel_turn(intakeId)`, `workflow_intake_abandon`, `workflow_intake_add_draft_path(intakeId, path)`, `workflow_intake_add_draft_bytes(intakeId, name, bytesBase64)`, `workflow_intake_remove_draft`, `workflow_intake_list_drafts`, `workflow_intake_apply_doc_update(intakeId, proposalId, accept)`, `workflow_intake_finalize(intakeId, skipIssue)`, `workflow_list_attachments(rootTaskId)`, `workflow_retry_issue_sync(taskId)`, `workflow_skip_issue_sync(taskId)`, `workflow_retry_issue_close(rootTaskId)`.
**Events:** `workflow://intake-changed` `{ projectRoot, intakeId, status, busy }` (emitted on every session change and turn start/end); `workflow://workflows-changed` `{ projectRoot }` (emitted by `save_workflows` / `add_standard` so other windows refresh).
**TS:** mirror all new types and events; client wrappers + table-driven test like the existing one.

- [ ] Tests first: command DTO serialization; TS api test for every new wrapper.
- [ ] Implement; full `cargo test`, `cargo check`, `npx tsc --noEmit`, `npm test`. Commit `feat(workflow): expose intake, attachment and issue commands`.

---

### Task 10: Spec sync and verification

- [ ] Update spec Part 4 and 3.13 (Japanese; no wording about bringing code over from elsewhere): new codes and params, per-turn stateless intake sessions, image handling per provider, sync-before-advance and retry/skip, Issue close failure handling, attachment limits and sanitization, finalize resumption details, events.
- [ ] Full verification: `cargo test`, `cargo check`, `npx tsc --noEmit`, `npm test`, `npm run build:sidecar`. Commit `docs: describe intake, issue and attachment decisions`.
