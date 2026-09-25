# Workflow Foundation (Part 3b-1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Rust building blocks of the development workflow (spec Part 3, sections 3.2–3.7, 3.8 output contract, 3.11 git operations): data model and persistence, the task state machine, git worktree operations, stage-outcome parsing, input screening (guard layer 1), integrity checks (guard layer 4), the containment environment (guard layer 3), and a Rust client for the agent runner. The orchestrator that ties them together, the builtin workflow template, and the Tauri commands/events are Part 3b-2.

**Architecture:** A new `src-tauri/src/workflow/` module with small, independently testable units. Persistence is plain files under the project's `.mdium/` (JSON for workflows and runs, Markdown with YAML frontmatter for tasks), always written atomically. All state changes go through one `transition()` function guarded by a per-project in-process lock. Git operations shell out to the user's `git` with MDium's normal environment; the agent runner is spawned by Rust with the containment environment and spoken to over the JSON-line protocol from Part 2/3a without involving the WebView.

**Tech Stack:** Rust (Tauri v2 app crate), serde / serde_json, `serde_yaml_ng` (new), `chrono` (new), `sha2`, `rand`, `dirs`, `regex` (existing), `tempfile` (new, dev only), the system `git` CLI, Node agent runner (`resources/agent-runner/agent-runner.mjs`).

## Global Constraints

- All code comments in English. No UI strings in Rust: user-visible reasons are machine codes (`AttentionReason { code, params }`) localized by the UI later.
- Files live under `<project>/.mdium/`: `workflows.json`, `tasks/<taskId>.md`, `runs/<rootTaskId>.json`, `runs/<rootTaskId>/<taskId>/<attemptId>.md` (attempt output) and `.log` (attempt log). Every file carries `schemaVersion: 1` (task docs: in frontmatter).
- Every write is atomic: write a uniquely named temp file in the same directory, then rename over the target.
- A corrupt or unreadable task document never breaks listing: it is skipped and reported as a warning.
- Worktrees live outside the repository: `<dirs::data_local_dir()>/mdium/worktrees/<first 16 hex of sha256(canonical common git dir, i.e. `git rev-parse --git-common-dir`)>/<rootTaskId>` (so linked worktrees, submodules and `--separate-git-dir` repos of one repository share one location). Branch name: `mdium/<first 8 chars of rootTaskId>-<slug>`.
- Git commands MDium runs itself use the user's normal environment (not the containment env) and `CREATE_NO_WINDOW` on Windows, like `commands/git.rs`.
- Containment env (for the workflow runner process only): `GIT_CONFIG_COUNT=7` with `GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n` = `protocol.allow=never` (0), `protocol.file.allow=always` (1), `protocol.https.allow=never` (2), `protocol.http.allow=never` (3), `protocol.ssh.allow=never` (4), `protocol.git.allow=never` (5), `protocol.ext.allow=never` (6) (each remote transport is denied explicitly so a repo-local `protocol.<name>.allow` cannot re-enable it), `GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never`, `GH_TOKEN`, `GITHUB_TOKEN`, `GITLAB_TOKEN`, `GH_ENTERPRISE_TOKEN`, `GITHUB_ENTERPRISE_TOKEN`, `GITLAB_ACCESS_TOKEN` = `mdium-blocked`, `GH_CONFIG_DIR` and `GLAB_CONFIG_DIR` = empty directories under the app's local data dir.
- Task statuses (snake_case on disk): `inbox`, `running`, `awaiting_user`, `attention`, `on_hold`, `completed`, `cancelled`. Allowed transitions are exactly the table in Task 5.
- Workflow shape: exactly three stages with roles `design`, `implement`, `review` in that order; `reviewReturnTo` ∈ {`design`, `implement`} (default `design`); `maxReentryCount` default 5; `maxConcurrentRuns` default 1; `timeoutMinutes` default 60; `requiresApproval` only allowed on the implement stage (default false); `designDocPath` optional, repo-relative, must not escape the repo or point into `.git/` or `.mdium/`; `issueTracking` ∈ {`auto`, `off`}; `provider` ∈ {`codex`, `copilot`, `opencode`, `claude`}.
- On-disk JSON/YAML field names are camelCase (`#[serde(rename_all = "camelCase")]`).
- Tests: `cargo test --manifest-path src-tauri/Cargo.toml workflow::` (unit tests in each file's `#[cfg(test)] mod tests`). Git-based tests create repos in `tempfile::TempDir` with `git init -b main`, set `user.name`/`user.email` locally, and must not depend on global git config.
- Commit trailer: `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `src-tauri/Cargo.toml` | Add `serde_yaml_ng`, `chrono`; dev `tempfile` | 1 |
| `src-tauri/src/workflow/mod.rs` | Module root, re-exports | 1 |
| `src-tauri/src/workflow/model.rs` | Types + workflow validation | 1 |
| `src-tauri/src/workflow/fsutil.rs` | Atomic write, ids, timestamps, `.mdium` paths | 2 |
| `src-tauri/src/workflow/store.rs` | workflows.json, tasks, runs, attempt artifacts | 2, 3, 4 |
| `src-tauri/src/workflow/state.rs` | Transition table, `transition()`, per-project locks | 5 |
| `src-tauri/src/workflow/outcome.rs` | Parse stage outcome frontmatter | 6 |
| `src-tauri/src/workflow/gitops.rs` | Worktree create/diff/commits/commit/merge/discard | 7 |
| `src-tauri/src/workflow/integrity.rs` | Repo integrity snapshot/compare, agent-config diff | 8 |
| `src-tauri/src/workflow/screening.rs` | Input screening findings | 9 |
| `src-tauri/src/workflow/containment.rs` | Containment env builder | 10 |
| `src-tauri/src/commands/node_sidecar.rs` | Spawn with env + in-process line/exit handlers | 10 |
| `src-tauri/src/workflow/runner_client.rs` | Rust client for the agent runner protocol | 11 |

---

### Task 1: Dependencies, module skeleton, model types

**Files:** `src-tauri/Cargo.toml`, `src-tauri/src/lib.rs` (add `mod workflow;`), `src-tauri/src/workflow/{mod.rs,model.rs}`

**Interfaces (all `pub`, serde camelCase, `Debug + Clone + PartialEq` where sensible):**

```rust
pub enum Role { Design, Implement, Review }                 // "design" | "implement" | "review"
pub enum Provider { Codex, Copilot, Opencode, Claude }       // lowercase
pub enum IssueTracking { Auto, Off }
pub struct Stage { id: String, role: Role, name: String, prompt: String, completion_criteria: String,
                   provider: Provider, model: Option<String>, requires_approval: bool, timeout_minutes: u32 }
pub struct Workflow { id: String, name: String, enabled: bool, archived: bool, stages: Vec<Stage>,
                      review_return_to: Role, max_reentry_count: u32, max_concurrent_runs: u32,
                      design_doc_path: Option<String>, issue_tracking: IssueTracking }
pub struct WorkflowsFile { schema_version: u32, workflows: Vec<Workflow> }
pub enum TaskStatus { Inbox, Running, AwaitingUser, Attention, OnHold, Completed, Cancelled } // snake_case
pub struct AttentionReason { code: String, params: std::collections::BTreeMap<String, String> }
pub struct HistoryEntry { at: String, from: Option<TaskStatus>, to: TaskStatus, reason: Option<AttentionReason> }
pub struct TaskMeta { schema_version: u32, id: String, title: String, status: TaskStatus, root_id: String,
                      parent_id: Option<String>, workflow_id: Option<String>, stage_id: Option<String>,
                      role: Option<Role>, auto_generated: bool, archived: bool, created_at: String,
                      updated_at: String, attention: Option<AttentionReason>, history: Vec<HistoryEntry> }
pub struct Task { meta: TaskMeta, body: String }
pub struct WorktreeInfo { path: String, branch: String, base_branch: String, base_commit: String }
pub enum RunStatus { Active, AwaitingMerge, Attention, Cancelled, Merged, Discarded }
pub struct AttemptRecord { attempt_id: String, task_id: String, stage_id: String, session_id: String,
                           runner_pid: Option<u32>, started_at: String, finished_at: Option<String>,
                           outcome: Option<String> }
pub struct PendingTransition { from_task_id: String, to_stage_id: String, child_task_id: String }
pub struct WorkflowRun { schema_version: u32, root_task_id: String, workflow: Workflow /* snapshot */,
                         status: RunStatus, current_task_id: String, reentry_count: u32,
                         worktree: Option<WorktreeInfo>, attempts: Vec<AttemptRecord>,
                         pending_transition: Option<PendingTransition>,
                         integrity_baseline: Option<crate::workflow::integrity::IntegritySnapshot>,
                         created_at: String, updated_at: String }
pub enum ValidationError { /* one variant per rule, each with a stable `code()` string */ }
impl Workflow { pub fn validate(&self) -> Result<(), Vec<ValidationError>>; pub fn stage(&self, role: Role) -> &Stage; }
```

`IntegritySnapshot` is defined in Task 8; in this task declare it as a placeholder `pub struct IntegritySnapshot {}` in `integrity.rs` (with `Serialize/Deserialize/Clone/Debug/PartialEq/Default`) so the model compiles; Task 8 fills it in.

Validation rules and codes: `STAGE_ROLES` (not exactly design/implement/review in order), `STAGE_ID_DUPLICATE`, `REVIEW_RETURN_TO` (not design/implement), `TIMEOUT` (0), `MAX_REENTRY` (0), `MAX_CONCURRENT` (0), `APPROVAL_ROLE` (requires_approval on a non-implement stage), `DESIGN_DOC_PATH` (absolute, contains `..` escaping, or first segment `.git`/`.mdium`), `NAME_EMPTY`.

- [ ] **Step 1 (tests first):** In `model.rs` tests: serde round-trip of a full `Workflow` and `TaskMeta` to JSON with camelCase keys and snake_case statuses (assert exact JSON for one small value); `validate()` passes for a valid workflow and returns each code for a crafted invalid one (one test per code).
- [ ] **Step 2:** Add deps: `serde_yaml_ng = "0.10"`, `chrono = { version = "0.4", default-features = false, features = ["clock", "std"] }`; `[dev-dependencies] tempfile = "3"`. Create the modules; implement. Run `cargo test --manifest-path src-tauri/Cargo.toml workflow::` → pass; `cargo check` clean (no new warnings; `#[allow(dead_code)]` on the module root is acceptable until 3b-2 wires it).
- [ ] **Step 3:** Commit `feat(workflow): add workflow data model and validation`.

---

### Task 2: File utilities and workflows.json store

**Files:** `workflow/fsutil.rs`, `workflow/store.rs`

**Interfaces:**
- `fsutil::atomic_write(path: &Path, bytes: &[u8]) -> io::Result<()>` — creates parent dirs; temp name `.<file>.<random hex>.tmp` in the same dir; `rename` over target (on Windows, retry once after removing the target if rename fails with access denied / already exists).
- `fsutil::new_id() -> String` — 16 lowercase hex chars from `rand`.
- `fsutil::now() -> String` — RFC 3339 UTC with millis (`chrono::Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)`).
- `fsutil::MdiumPaths::new(project_root)` with methods `root()`, `workflows_file()`, `tasks_dir()`, `task_file(id)`, `runs_dir()`, `run_file(root_id)`, `attempt_output(root_id, task_id, attempt_id)`, `attempt_log(root_id, task_id, attempt_id)`. Ids are validated (`^[0-9a-f]{16}$`) before building paths; invalid → error (no path traversal).
- `store::WorkflowStore::new(project_root: PathBuf)`; `load_workflows() -> Result<WorkflowsFile, StoreError>` (missing file → empty file with schemaVersion 1; unsupported schemaVersion → `StoreError::UnsupportedSchema`); `save_workflows(&WorkflowsFile) -> Result<(), StoreError>` (validates every workflow first; returns `StoreError::Invalid(Vec<ValidationError>)`).

- [ ] Tests first: atomic write replaces content and leaves no temp files; concurrent writers from two threads never produce a partially written file (write 200 times each with distinct content, final content is one of them and parses); `MdiumPaths` rejects `../x` ids; load of missing file; save/load round-trip; save rejects invalid workflow; unsupported schema.
- [ ] Implement, run tests, commit `feat(workflow): add atomic file utilities and workflow store`.

---

### Task 3: Task documents

**Files:** `workflow/store.rs` (extend)

Format:

```
---
<YAML of TaskMeta>
---

<body markdown>
```

**Interfaces:**
- `WorkflowStore::create_task(meta: TaskMeta, body: &str) -> Result<Task, StoreError>` — fails if the file exists.
- `get_task(id) -> Result<Task, StoreError>` (`NotFound`, `Corrupt(String)`).
- `put_task(&Task) -> Result<(), StoreError>` — atomic overwrite; sets `updated_at = now()`.
- `list_tasks() -> Result<TaskList, StoreError>` where `TaskList { tasks: Vec<Task>, warnings: Vec<StoreWarning { file: String, message: String }> }`; unreadable/corrupt files become warnings; results sorted by `created_at` then id.
- `delete_task(id)`.
- Body text is stored verbatim; a body beginning with `---` must round-trip (the parser only treats the FIRST frontmatter block as metadata).

- [ ] Tests first: round-trip with multi-line body and Japanese text; body starting with `---` round-trips; corrupt YAML → warning, other tasks still listed; missing closing `---` → warning; `create_task` twice → error; CRLF files (written by an editor) parse.
- [ ] Implement, test, commit `feat(workflow): persist task documents with YAML frontmatter`.

---

### Task 4: Workflow runs and attempt artifacts

**Files:** `workflow/store.rs` (extend)

**Interfaces:**
- `create_run(&WorkflowRun)`, `get_run(root_id) -> Result<WorkflowRun, StoreError>`, `put_run(&WorkflowRun)` (sets `updated_at`), `list_runs() -> Result<(Vec<WorkflowRun>, Vec<StoreWarning>), StoreError>`.
- `write_attempt_output(root_id, task_id, attempt_id, text: &str)`, `read_attempt_output(...) -> Result<String, StoreError>`.
- `append_attempt_log(root_id, task_id, attempt_id, line: &str)` — appends one line (not atomic-replace; opens in append mode) — and `read_attempt_log(...)`.

- [ ] Tests first: run round-trip (including a nested `Workflow` snapshot and `PendingTransition`); list skips corrupt run files with a warning; attempt output write/read; log append keeps order across 100 appends.
- [ ] Implement, test, commit `feat(workflow): persist workflow runs and attempt artifacts`.

---

### Task 5: State machine

**Files:** `workflow/state.rs`

Allowed transitions (anything else → `TransitionError::NotAllowed { from, to }`):

| from | to |
|---|---|
| inbox | running, cancelled |
| running | completed, attention, awaiting_user, on_hold, cancelled |
| awaiting_user | inbox, cancelled |
| attention | inbox, completed, cancelled |
| on_hold | inbox, cancelled |

**Interfaces:**
- `pub fn is_allowed(from: TaskStatus, to: TaskStatus) -> bool`.
- `pub struct ProjectLocks` — a global `OnceLock<Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>>`; `ProjectLocks::lock(project_root) -> MutexGuard` (canonicalized key; case-insensitive on Windows).
- `pub fn transition(store: &WorkflowStore, task_id: &str, expected_from: TaskStatus, to: TaskStatus, reason: Option<AttentionReason>) -> Result<Task, TransitionError>` — takes the project lock, reloads the task, fails with `TransitionError::Conflict { actual }` if `status != expected_from`, validates with `is_allowed`, sets status, sets `attention = reason` when `to == Attention` (clears it otherwise), appends a `HistoryEntry { at: now(), from: Some(expected_from), to, reason }`, writes atomically, returns the new task.
- `TransitionError` variants: `NotFound`, `Conflict { actual }`, `NotAllowed { from, to }`, `Store(StoreError)`; each has a stable `code()` (`TASK_NOT_FOUND`, `STATUS_CONFLICT`, `TRANSITION_NOT_ALLOWED`, `STORE_ERROR`).

- [ ] Tests first: exhaustive table test over all 7×7 pairs against the allowed set; conflict when `expected_from` differs (file unchanged); history appended with from/to/reason; attention reason set and later cleared on `attention → inbox`; two threads racing the same `inbox → running` transition: exactly one succeeds, the other gets `Conflict`.
- [ ] Implement, test, commit `feat(workflow): add task state machine with optimistic transitions`.

---

### Task 6: Stage outcome parser

**Files:** `workflow/outcome.rs`

The LLM's final response must start with YAML frontmatter:

```
---
outcome: completed | attention | awaiting_user
reason: <short text, required for attention/awaiting_user>
question: <optional, for awaiting_user>
---
<markdown body>
```

**Interfaces:** `pub enum StageOutcomeKind { Completed, Attention, AwaitingUser }`; `pub struct StageOutcome { kind, reason: Option<String>, question: Option<String>, body: String }`; `pub fn parse_outcome(text: &str) -> Result<StageOutcome, OutcomeError>` with `OutcomeError::{MissingFrontmatter, InvalidYaml(String), InvalidOutcome(String), MissingReason}` and `code()` (`OUTCOME_MISSING_FRONTMATTER`, `OUTCOME_INVALID_YAML`, `OUTCOME_INVALID_VALUE`, `OUTCOME_MISSING_REASON`).
Tolerate: leading whitespace/blank lines before the first `---`, CRLF, a wrapping ```` ```markdown ```` / ```` ``` ```` code fence around the whole response, unknown extra keys (ignored). Case-insensitive `outcome` values; `awaiting-user` accepted as an alias.

- [ ] Tests first for each accepted form and each error; body preserved exactly (after the closing `---` and one optional blank line).
- [ ] Implement, test, commit `feat(workflow): parse stage outcomes`.

---

### Task 7: Git worktree operations

**Files:** `workflow/gitops.rs`

**Interfaces** (all blocking; callers run them off the main thread):
- `pub fn git(repo: &Path, args: &[&str]) -> Result<String, GitError>` — like `commands/git.rs::run_git` (`-c core.quotePath=false`, CREATE_NO_WINDOW), returns stdout; `GitError { code: String, stderr: String }`.
- `pub fn is_git_repo(path) -> bool`; `pub fn repo_root(path) -> Result<PathBuf, GitError>` (`rev-parse --show-toplevel`).
- `pub fn worktree_path_for(repo_root: &Path, root_task_id: &str) -> PathBuf` (per Global Constraints; uses `dirs::data_local_dir()`, falls back to `std::env::temp_dir()`).
- `pub fn branch_name(root_task_id: &str, title: &str) -> String` — slug: lowercase ASCII letters/digits, other runs → `-`, trimmed, max 40 chars, empty → `task`.
- `pub fn create_worktree(repo_root, root_task_id, title) -> Result<WorktreeInfo, GitError>` — errors `NOT_A_REPO`, `DETACHED_HEAD` (base branch must be a named branch), `WORKTREE_EXISTS`; runs `git worktree add -b <branch> <path> HEAD`; records `base_branch` and `base_commit`.
- `pub fn diff_against_base(info: &WorktreeInfo) -> Result<String, GitError>` — `git -C <wt> diff <base_commit>` (committed + uncommitted, excluding untracked) followed by a list of untracked files (`ls-files --others --exclude-standard`).
- `pub fn commits_since_base(info) -> Result<Vec<CommitSummary { hash: String, subject: String }>, GitError>`.
- `pub fn commit_paths(info, paths: &[&str], message: &str) -> Result<Option<String>, GitError>` — `add -- <paths>` then commit if anything is staged; returns the new hash or None. Uses a local identity if none is configured (`-c user.name=MDium -c user.email=mdium@localhost` only when `git config user.email` is empty).
- `pub fn merge_into_base(repo_root, info) -> Result<String, GitError>` — checks: current branch in the user's repo equals `base_branch` (`NOT_ON_BASE_BRANCH`), `status --porcelain` is empty (`DIRTY_WORKTREE`); then `merge --no-ff --no-edit <branch>`; on failure run `merge --abort` and return `MERGE_CONFLICT`; returns the merge commit hash.
- `pub fn discard(repo_root, info) -> Result<(), GitError>` — `worktree remove --force <path>` then `branch -D <branch>`; missing worktree/branch is not an error.

- [ ] Tests first (real git in TempDir): create worktree on a named branch; detached HEAD → `DETACHED_HEAD`; branch slug cases (Japanese title → `task`, `Fix: Login Bug!` → `fix-login-bug`); diff shows a committed change, an uncommitted change and an untracked file; commits_since_base; commit_paths commits only the given path; merge success creates a merge commit on base; merge refuses on a dirty tree and on another branch; conflicting change → `MERGE_CONFLICT` and the user repo is left clean (no MERGE_HEAD); discard removes worktree and branch; worktree path is outside the repo.
- [ ] Implement, test, commit `feat(workflow): add git worktree operations`.

---

### Task 8: Integrity snapshot and agent-config diff (guard layer 4)

**Files:** `workflow/integrity.rs`

What is checked (deliberately NOT the user's working-tree file contents, which the user may edit while a workflow runs):

**Interfaces:**
- `pub struct IntegritySnapshot { head_ref: String /* symbolic ref or "detached:<commit>" */, head_commit: String, base_branch_commit: Option<String>, git_config_hash: String /* sha256 of <common-dir>/config */, hooks_hash: String /* sha256 over sorted (relative path, content) of <common-dir>/hooks */, hooks_path: Option<String> /* git config core.hooksPath */ }` (serde camelCase, `Default`).
- `pub fn snapshot(repo_root: &Path, base_branch: Option<&str>) -> Result<IntegritySnapshot, GitError>` — uses `git rev-parse --git-common-dir`.
- `pub fn compare(before: &IntegritySnapshot, after: &IntegritySnapshot) -> Vec<IntegrityChange>` with `IntegrityChange { code: String /* HEAD_MOVED, BRANCH_SWITCHED, BASE_BRANCH_MOVED, GIT_CONFIG_CHANGED, HOOKS_CHANGED, HOOKS_PATH_CHANGED */, detail: String }`. `HEAD_MOVED` only when the user's branch changed commit AND the change was not made by MDium (callers pass the latest snapshot after their own merges, so plain compare is enough here).
- `pub const AGENT_CONFIG_PATTERNS: &[&str]` — `.claude/**`, `.opencode/**`, `opencode.json`, `opencode.jsonc`, `.mcp.json`, `.codex/**`, `.copilot/**`, `.vscode/settings.json`, `.vscode/tasks.json`, `.vscode/mcp.json`, `.gitmodules`, `.github/hooks/**`, `.mdium/**` (matching at any depth).
- `pub const MERGE_REVIEW_PATTERNS: &[&str]` — the above plus `.github/**`, `AGENTS.md`, `CLAUDE.md`, `.husky/**`, `.githooks/**`, `.devcontainer/**`.
- `pub fn changed_paths_matching(info: &WorktreeInfo, patterns: &[&str]) -> Result<Vec<String>, GitError>` — committed changes since base (`diff --name-only <base>`) plus uncommitted and untracked files in the worktree, filtered by the patterns (case-insensitive on Windows, `/` separators).

- [ ] Tests first (real git): snapshot stable when nothing changes; writing `.git/config` (e.g. `git config core.pager x` in the main repo) → `GIT_CONFIG_CHANGED`; adding a hook file → `HOOKS_CHANGED`; `core.hooksPath` set → `HOOKS_PATH_CHANGED` (and config changed); checking out another branch → `BRANCH_SWITCHED`; a new commit on base → `BASE_BRANCH_MOVED`; a worktree in the same repo shares the common dir (hooks changed from inside the worktree's common dir is detected); `changed_paths_matching` finds `.claude/settings.local.json` (untracked), `sub/.mcp.json` (committed), ignores `src/a.ts`, and `MERGE_REVIEW_PATTERNS` also finds `.github/workflows/ci.yml` and `AGENTS.md`.
- [ ] Implement (replace the Task 1 placeholder struct), test, commit `feat(workflow): add repository integrity checks`.

---

### Task 9: Input screening (guard layer 1)

**Files:** `workflow/screening.rs`

**Interfaces:** `pub struct Finding { kind: FindingKind, excerpt: String /* ≤ 160 chars around the match, one line */, line: usize }`, `pub enum FindingKind { InjectionPhrase, InvisibleCharacters, EncodedPayload, SecretRequest }` (with `code()`), `pub fn screen(text: &str) -> Vec<Finding>`.

Detect (case-insensitive, EN + JA):
- Injection phrases: "ignore (all|any|the)? ?(previous|prior|above|earlier) (instructions|prompts|messages)", "disregard (the )?(system|previous|above)", "you are now (a|an|the)", "new instructions:", "system prompt", "developer mode", "act as (root|admin|the system)"; JA: 「(以前|前|上記|これまで)の指示を無視」「指示を(すべて)?無視」「システムプロンプト」「制限を解除」.
- Secret requests: "(send|post|upload|exfiltrate|leak|print|reveal|output) … (token|password|secret|credential|api key|ssh key|environment variables?|\.env)" within one sentence; JA 「(トークン|パスワード|秘密鍵|認証情報|環境変数|APIキー).{0,20}(送信|送って|表示|出力|アップロード)」.
- Invisible/bidi characters: U+200B–U+200F, U+202A–U+202E, U+2060–U+2064, U+2066–U+2069, U+FEFF (except at offset 0) — one finding per line.
- Encoded payloads: a run of ≥ 400 chars from `[A-Za-z0-9+/=]` or ≥ 400 hex chars.

- [ ] Tests first: each detector positive (EN and JA) and negatives on ordinary engineering text (a normal feature request, code blocks with base64 < 400, a Japanese bug report mentioning 「環境変数を設定する」 without a send verb, a commit hash).
- [ ] Implement (compile regexes once with `OnceLock`), test, commit `feat(workflow): screen agent inputs for injection patterns`.

---

### Task 10: Containment environment and in-process sidecar spawning

**Files:** `workflow/containment.rs`, `commands/node_sidecar.rs`

**Interfaces:**
- `pub fn containment_env(data_dir: &Path) -> io::Result<Vec<(String, String)>>` — exactly the variables in Global Constraints; creates `<data_dir>/containment/gh` and `<data_dir>/containment/glab` empty dirs (clearing any content) and points `GH_CONFIG_DIR`/`GLAB_CONFIG_DIR` at them.
- `node_sidecar::spawn_with_handlers(script_path: &str, env: &[(String, String)], on_line: Box<dyn Fn(String) + Send>, on_stderr: Box<dyn Fn(String) + Send>, on_exit: Box<dyn FnOnce(Option<i32>) + Send>) -> Result<u32, String>` — same spawn semantics as `spawn` (cmd /C node on Windows, CREATE_NO_WINDOW, script-dir cwd, stdin registered in the shared map so `write`/`kill` work) but delivers lines to the callbacks instead of emitting Tauri events, and applies `env` on top of the inherited environment. Refactor `spawn` to share the implementation (keep its behavior and events identical).

- [ ] Tests first: `containment_env` returns the expected keys/values and creates empty dirs; integration test (Windows and posix) — spawn `node -e "process.stdin.on('data',d=>process.stdout.write(d)); console.log(process.env.GIT_CONFIG_VALUE_0)"`-style script written to a temp `.cjs` file, with the containment env: the first line is `never`, a line written via `write()` is echoed back through `on_line`, and `kill()` triggers `on_exit`. Also run `git -c protocol.file.allow=always` under that env from Rust (`Command::envs`) against an `https://` remote URL and assert failure text contains `transport 'https' not allowed` (proves the env blocks remotes without network).
- [ ] Implement, test (`cargo test workflow::` and `commands::node_sidecar`), commit `feat(workflow): spawn the workflow runner with containment env`.

---

### Task 11: Agent runner client

**Files:** `workflow/runner_client.rs`

Mirrors the protocol in `src/shared/types/agent-runner.ts` (read it and `sidecar/agent-runner/protocol.ts`).

**Interfaces:**
- `pub trait RunnerTransport: Send + Sync { fn write_line(&self, line: &str) -> Result<(), String>; fn kill(&self); }` with `SidecarTransport { id: u32 }` implemented over `node_sidecar::write/kill`.
- `pub enum RunnerEvent { Event(serde_json::Value /* AgentEvent */), PermissionRequest { permission_id: String, request: serde_json::Value }, GuardViolation { rule: String, summary: String }, TurnCompleted { final_response: String, native_session_id: Option<String> }, TurnFailed { message: String }, TurnCancelled, Exited }`.
- `pub struct RunnerClient` with:
  - `pub fn new(transport: Arc<dyn RunnerTransport>) -> Arc<Self>`; `pub fn handle_line(&self, line: &str)`; `pub fn handle_exit(&self)` (fails pending requests with `RUNNER_EXITED`, sends `RunnerEvent::Exited` to every session subscriber, marks the client dead).
  - `pub fn wait_ready(&self, timeout: Duration) -> Result<(), RunnerError>`.
  - `pub fn probe(&self, provider: Provider, timeout) -> Result<serde_json::Value, RunnerError>`.
  - `pub fn start_session(&self, params: StartSessionParams, timeout) -> Result<(std::sync::mpsc::Receiver<RunnerEvent>, Option<String> /* native id */), RunnerError>` — `StartSessionParams { session_id, provider, working_directory, permission: "read-only" | "full-access", model: Option<String>, resume_native_id: Option<String>, guard_workspace_root: Option<String> /* required: None → RunnerError::Protocol("GUARD_REQUIRED") */, timeout_ms: Option<u64> }`; registers the event channel before sending; returns on `session_started`, or `RunnerError::Remote(message)` on an `error` reply with the same requestId.
  - `pub fn send(&self, session_id, text) -> Result<(), RunnerError>`, `cancel(session_id)`, `respond_permission(session_id, permission_id, allow)`, `close_session(session_id)` (unregisters the channel).
  - `RunnerError::{Timeout, Exited, Remote(String), Transport(String), Protocol(String)}` with `code()`.
- Unknown message types are ignored; malformed JSON lines are ignored (logged via `eprintln!` with a `[workflow-runner]` prefix).

- [ ] Tests first with a fake transport that records written lines and lets the test feed lines: ready wait (and timeout); probe request/response matched by requestId (concurrent probes resolve independently); start_session success returns the receiver and native id; start_session error reply → `Remote`; events routed to the right session only; `guard_violation` / `turn_completed` / `turn_failed` mapping; close_session stops delivery; `handle_exit` fails pending requests and delivers `Exited`; after exit every call returns `Exited`.
- [ ] Implement, test, commit `feat(workflow): add agent runner client`.

---

### Task 12: Verification

- [ ] `cargo test --manifest-path src-tauri/Cargo.toml` (all), `cargo check` (no new warnings beyond allowed dead-code on unwired items), `npx tsc --noEmit`, `npm test`. Report counts.
