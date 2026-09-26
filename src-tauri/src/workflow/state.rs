//! Task state machine: the allowed status transitions and the
//! [`transition`] / [`transition_locked`] entry points that apply one under
//! a per-project lock.
//!
//! Transitions are optimistic: the caller states the status it believes the
//! task is in (`expected_from`), and the transition fails with
//! [`TransitionError::Conflict`] if the task on disk says otherwise. The
//! per-project lock makes the reload-check-write sequence atomic with
//! respect to other transitions in this process.
//!
//! Lock discipline: every task/run mutation in the store takes a
//! [`ProjectGuard`], which only [`ProjectLocks::lock`] can produce. A caller
//! that must combine several mutations atomically (e.g. create a child
//! task, transition its parent, and update the run) takes the guard once
//! and passes it to each guarded call in the same scope. No function that
//! accepts a guard ever locks again, so this never deadlocks; [`transition`]
//! is only a convenience that locks and then calls [`transition_locked`],
//! and must not be called while holding a guard for the same project (the
//! mutex is not reentrant).
//!
//! [`ProjectLocks`] serializes only within this process. It does not
//! coordinate with other processes (e.g. a second MDium instance) or with a
//! user editing a task file by hand; the `expected_from` check narrows that
//! window but cannot close it.

use crate::workflow::fsutil;
use crate::workflow::model::{AttentionReason, HistoryEntry, Task, TaskStatus};
use crate::workflow::store::{StoreError, WorkflowStore};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock};

/// Proof that this thread holds the per-project lock for one project root.
/// Only [`ProjectLocks::lock`] can create one; dropping it releases the
/// lock. Store mutations take `&ProjectGuard` and reject a guard for a
/// different project (see [`ProjectGuard::covers`]).
pub struct ProjectGuard {
    _guard: MutexGuard<'static, ()>,
    key: PathBuf,
}

impl ProjectGuard {
    /// True if this guard is the lock for `project_root` (compared by the
    /// same normalized key [`ProjectLocks::lock`] uses).
    pub fn covers(&self, project_root: &Path) -> bool {
        project_key(project_root) == self.key
    }
}

impl std::fmt::Debug for ProjectGuard {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ProjectGuard")
            .field("key", &self.key)
            .finish()
    }
}

/// Whether moving a task from `from` to `to` is permitted. This is the
/// complete transition table; every pair not listed is rejected.
pub fn is_allowed(from: TaskStatus, to: TaskStatus) -> bool {
    use TaskStatus::*;
    matches!(
        (from, to),
        (Inbox, Running | Cancelled)
            | (
                Running,
                Completed | Attention | AwaitingUser | OnHold | Cancelled
            )
            | (AwaitingUser, Inbox | Cancelled)
            | (Attention, Inbox | Completed | Cancelled)
            | (OnHold, Inbox | Cancelled)
    )
}

/// Why a [`transition`] failed.
#[derive(Debug, Clone, PartialEq)]
pub enum TransitionError {
    /// The task document does not exist.
    NotFound,
    /// The task's status on disk is not the caller's `expected_from`.
    Conflict { actual: TaskStatus },
    /// The transition table does not permit `from -> to`.
    NotAllowed { from: TaskStatus, to: TaskStatus },
    /// Any other store failure (I/O, corrupt file, invalid id, ...).
    Store(StoreError),
}

impl TransitionError {
    /// Stable machine code for this failure, for callers/UI to key off.
    /// A wrapped store failure reports the inner `STORE_*` code, so the
    /// specific cause is never hidden behind a generic wrapper code.
    pub fn code(&self) -> &'static str {
        match self {
            TransitionError::NotFound => "TASK_NOT_FOUND",
            TransitionError::Conflict { .. } => "TRANSITION_CONFLICT",
            TransitionError::NotAllowed { .. } => "TRANSITION_NOT_ALLOWED",
            TransitionError::Store(err) => err.code(),
        }
    }
}

impl std::fmt::Display for TransitionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TransitionError::NotFound => f.write_str(self.code()),
            TransitionError::Conflict { actual } => {
                write!(f, "{}: actual {actual:?}", self.code())
            }
            TransitionError::NotAllowed { from, to } => {
                write!(f, "{}: {from:?} -> {to:?}", self.code())
            }
            TransitionError::Store(err) => err.fmt(f),
        }
    }
}

crate::workflow::errors::impl_workflow_error!(TransitionError);

impl From<StoreError> for TransitionError {
    fn from(err: StoreError) -> Self {
        match err {
            StoreError::NotFound => TransitionError::NotFound,
            other => TransitionError::Store(other),
        }
    }
}

/// Process-wide registry of one mutex per project, serializing every task
/// state change within a project.
///
/// Each project's mutex is allocated once and intentionally leaked so the
/// returned guard can be `'static` without self-referential tricks; the
/// set of projects opened in one app session is small, and entries are
/// never removed anyway.
pub struct ProjectLocks;

impl ProjectLocks {
    /// Blocks until this process holds the lock for `project_root`.
    /// Different spellings of the same directory (relative vs. absolute,
    /// and letter case on Windows) share one lock. The lock is not
    /// reentrant: never call this while already holding a guard for the
    /// same project.
    pub fn lock(project_root: &Path) -> ProjectGuard {
        static LOCKS: OnceLock<Mutex<HashMap<PathBuf, &'static Mutex<()>>>> = OnceLock::new();

        let key = project_key(project_root);
        let mutex: &'static Mutex<()> = {
            let mut locks = LOCKS
                .get_or_init(Default::default)
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            *locks
                .entry(key.clone())
                .or_insert_with(|| Box::leak(Box::new(Mutex::new(()))))
        };
        // The mutex guards no data, so a panic in a previous holder cannot
        // have left anything inconsistent; recover from poisoning.
        let guard = mutex
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        ProjectGuard { _guard: guard, key }
    }
}

/// A project root as MDium works with it: canonicalized when the path
/// exists (falling back to the path as given), without a trailing
/// separator, and without the Windows verbatim (`\\?\`) prefix that
/// `canonicalize` adds. Letter case is preserved.
pub(crate) fn normalize_root(project_root: &Path) -> PathBuf {
    // `canonicalize` fails for paths that do not exist (yet). Fall back to
    // `absolute`, which needs no file system access, so a relative and an
    // absolute spelling of the same missing root still share one key; only
    // if that fails too is the path used exactly as given.
    let resolved = std::fs::canonicalize(project_root)
        .or_else(|_| std::path::absolute(project_root))
        .unwrap_or_else(|_| project_root.to_path_buf());
    // Rebuilding from the components drops a trailing separator.
    strip_verbatim(resolved.components().collect())
}

/// Removes the verbatim prefix from a verbatim disk (`\\?\C:\...`) or UNC
/// (`\\?\UNC\server\share`) path; any other path is returned unchanged.
#[cfg(windows)]
fn strip_verbatim(path: PathBuf) -> PathBuf {
    let Some(text) = path.to_str() else {
        return path;
    };
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    match text.strip_prefix(r"\\?\") {
        Some(rest) if rest.as_bytes().get(1) == Some(&b':') => PathBuf::from(rest),
        _ => path,
    }
}

#[cfg(not(windows))]
fn strip_verbatim(path: PathBuf) -> PathBuf {
    path
}

/// Normalized key for a project root ([`normalize_root`]), lowercased on
/// Windows, whose file system is case-insensitive. Different spellings of
/// the same directory share one key; the per-project lock and the
/// orchestrator's project table are both keyed by it.
pub(crate) fn project_key(project_root: &Path) -> PathBuf {
    let root = normalize_root(project_root);
    if cfg!(windows) {
        PathBuf::from(root.to_string_lossy().to_lowercase())
    } else {
        root
    }
}

/// Moves task `task_id` from `expected_from` to `to` and returns the task
/// as written. Takes the project lock for the duration of the call; see
/// [`transition_locked`] for the semantics, and use that instead when the
/// caller already holds the guard.
pub fn transition(
    store: &WorkflowStore,
    task_id: &str,
    expected_from: TaskStatus,
    to: TaskStatus,
    reason: Option<AttentionReason>,
) -> Result<Task, TransitionError> {
    let guard = ProjectLocks::lock(store.project_root());
    transition_locked(&guard, store, task_id, expected_from, to, reason)
}

/// [`transition`] for a caller that already holds `guard` for the store's
/// project, so it can combine this with other guarded store mutations in
/// one critical section. A guard for another project is rejected with
/// [`StoreError::LockMismatch`] before anything is read or written.
///
/// Under the project lock this reloads the task, fails with
/// [`TransitionError::Conflict`] if its status is not `expected_from`, and
/// fails with [`TransitionError::NotAllowed`] if the table forbids the
/// move. On success it sets the status, sets `attention` to `reason` when
/// moving to `Attention` (clearing it otherwise), appends a history entry
/// carrying `reason`, and writes the task atomically. Nothing is written
/// on failure.
pub fn transition_locked(
    guard: &ProjectGuard,
    store: &WorkflowStore,
    task_id: &str,
    expected_from: TaskStatus,
    to: TaskStatus,
    reason: Option<AttentionReason>,
) -> Result<Task, TransitionError> {
    if !guard.covers(store.project_root()) {
        return Err(TransitionError::Store(StoreError::LockMismatch));
    }

    let mut task = store.get_task(task_id)?;
    if task.meta.status != expected_from {
        return Err(TransitionError::Conflict {
            actual: task.meta.status,
        });
    }
    if !is_allowed(expected_from, to) {
        return Err(TransitionError::NotAllowed {
            from: expected_from,
            to,
        });
    }

    task.meta.status = to;
    task.meta.attention = if to == TaskStatus::Attention {
        reason.clone()
    } else {
        None
    };
    let at = fsutil::now();
    task.meta.history.push(HistoryEntry {
        at: at.clone(),
        from: Some(expected_from),
        to,
        reason,
    });

    // Stamp updated_at with the same instant as the history entry.
    Ok(store.put_task_at(guard, &task, at)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workflow::model::{AttentionReason, TaskMeta, TaskStatus};
    use crate::workflow::store::WorkflowStore;
    use std::collections::BTreeMap;
    use std::sync::{Arc, Barrier};

    const TASK_ID: &str = "00000000000000aa";

    const ALL: [TaskStatus; 7] = [
        TaskStatus::Inbox,
        TaskStatus::Running,
        TaskStatus::AwaitingUser,
        TaskStatus::Attention,
        TaskStatus::OnHold,
        TaskStatus::Completed,
        TaskStatus::Cancelled,
    ];

    fn new_store_with_task(status: TaskStatus) -> (tempfile::TempDir, WorkflowStore) {
        let dir = tempfile::tempdir().unwrap();
        let store = WorkflowStore::new(dir.path().to_path_buf());
        let meta = TaskMeta {
            schema_version: 1,
            id: TASK_ID.to_string(),
            title: "Task".to_string(),
            status,
            root_id: TASK_ID.to_string(),
            parent_id: None,
            workflow_id: None,
            stage_id: None,
            role: None,
            auto_generated: false,
            archived: false,
            created_at: "2026-01-01T00:00:00.000Z".to_string(),
            updated_at: "2026-01-01T00:00:00.000Z".to_string(),
            attention: None,
            history: Vec::new(),
            awaiting: None,
            plan_approved: false,
            user_input: None,
            screening_ack: None,
        };
        store.create_task(&store.lock(), meta, "body\n").unwrap();
        (dir, store)
    }

    fn reason(code: &str) -> AttentionReason {
        let mut params = BTreeMap::new();
        params.insert("stage".to_string(), "review".to_string());
        AttentionReason {
            code: code.to_string(),
            params,
        }
    }

    #[test]
    fn is_allowed_matches_transition_table_exactly() {
        use TaskStatus::*;
        let allowed = [
            (Inbox, Running),
            (Inbox, Cancelled),
            (Running, Completed),
            (Running, Attention),
            (Running, AwaitingUser),
            (Running, OnHold),
            (Running, Cancelled),
            (AwaitingUser, Inbox),
            (AwaitingUser, Cancelled),
            (Attention, Inbox),
            (Attention, Completed),
            (Attention, Cancelled),
            (OnHold, Inbox),
            (OnHold, Cancelled),
        ];
        for from in ALL {
            for to in ALL {
                assert_eq!(
                    is_allowed(from, to),
                    allowed.contains(&(from, to)),
                    "{from:?} -> {to:?}"
                );
            }
        }
    }

    #[test]
    fn transition_updates_status_and_appends_history() {
        let (_dir, store) = new_store_with_task(TaskStatus::Inbox);

        let task = transition(
            &store,
            TASK_ID,
            TaskStatus::Inbox,
            TaskStatus::Running,
            None,
        )
        .unwrap();
        assert_eq!(task.meta.status, TaskStatus::Running);
        assert_eq!(task.meta.history.len(), 1);
        let entry = &task.meta.history[0];
        assert_eq!(entry.from, Some(TaskStatus::Inbox));
        assert_eq!(entry.to, TaskStatus::Running);
        assert_eq!(entry.reason, None);
        assert!(!entry.at.is_empty());
        // The history timestamp and the stored updated_at are one instant.
        assert_eq!(task.meta.updated_at, task.meta.history.last().unwrap().at);

        // The returned task is exactly what was persisted.
        assert_eq!(store.get_task(TASK_ID).unwrap(), task);
    }

    #[test]
    fn transition_records_reason_in_history() {
        let (_dir, store) = new_store_with_task(TaskStatus::Running);

        let task = transition(
            &store,
            TASK_ID,
            TaskStatus::Running,
            TaskStatus::OnHold,
            Some(reason("USER_PAUSED")),
        )
        .unwrap();
        assert_eq!(task.meta.history[0].reason, Some(reason("USER_PAUSED")));
        // Only the attention status carries an active attention reason.
        assert_eq!(task.meta.attention, None);
    }

    #[test]
    fn attention_reason_is_set_then_cleared_on_return_to_inbox() {
        let (_dir, store) = new_store_with_task(TaskStatus::Running);

        let task = transition(
            &store,
            TASK_ID,
            TaskStatus::Running,
            TaskStatus::Attention,
            Some(reason("STAGE_TIMEOUT")),
        )
        .unwrap();
        assert_eq!(task.meta.attention, Some(reason("STAGE_TIMEOUT")));

        let task = transition(
            &store,
            TASK_ID,
            TaskStatus::Attention,
            TaskStatus::Inbox,
            None,
        )
        .unwrap();
        assert_eq!(task.meta.status, TaskStatus::Inbox);
        assert_eq!(task.meta.attention, None);
        assert_eq!(task.meta.history.len(), 2);
        assert_eq!(task.meta.history[1].from, Some(TaskStatus::Attention));
        assert_eq!(task.meta.history[1].to, TaskStatus::Inbox);
    }

    #[test]
    fn conflict_when_expected_from_differs_leaves_file_unchanged() {
        let (dir, store) = new_store_with_task(TaskStatus::Running);
        let path = dir
            .path()
            .join(".mdium")
            .join("tasks")
            .join(format!("{TASK_ID}.md"));
        let before = std::fs::read(&path).unwrap();

        let err = transition(
            &store,
            TASK_ID,
            TaskStatus::Inbox,
            TaskStatus::Running,
            None,
        )
        .unwrap_err();
        assert_eq!(
            err,
            TransitionError::Conflict {
                actual: TaskStatus::Running
            }
        );
        assert_eq!(err.code(), "TRANSITION_CONFLICT");
        assert_eq!(std::fs::read(&path).unwrap(), before);
    }

    #[test]
    fn disallowed_transition_is_rejected_and_file_unchanged() {
        let (dir, store) = new_store_with_task(TaskStatus::Completed);
        let path = dir
            .path()
            .join(".mdium")
            .join("tasks")
            .join(format!("{TASK_ID}.md"));
        let before = std::fs::read(&path).unwrap();

        let err = transition(
            &store,
            TASK_ID,
            TaskStatus::Completed,
            TaskStatus::Running,
            None,
        )
        .unwrap_err();
        assert_eq!(
            err,
            TransitionError::NotAllowed {
                from: TaskStatus::Completed,
                to: TaskStatus::Running
            }
        );
        assert_eq!(err.code(), "TRANSITION_NOT_ALLOWED");
        assert_eq!(std::fs::read(&path).unwrap(), before);
    }

    #[test]
    fn missing_task_is_not_found() {
        let dir = tempfile::tempdir().unwrap();
        let store = WorkflowStore::new(dir.path().to_path_buf());

        let err = transition(
            &store,
            TASK_ID,
            TaskStatus::Inbox,
            TaskStatus::Running,
            None,
        )
        .unwrap_err();
        assert_eq!(err, TransitionError::NotFound);
        assert_eq!(err.code(), "TASK_NOT_FOUND");
    }

    #[test]
    fn store_errors_are_wrapped() {
        let (_dir, store) = new_store_with_task(TaskStatus::Inbox);

        let err = transition(
            &store,
            "../bad",
            TaskStatus::Inbox,
            TaskStatus::Running,
            None,
        )
        .unwrap_err();
        assert!(matches!(err, TransitionError::Store(_)));
        // A wrapped store failure reports the store's own code.
        assert_eq!(err.code(), "STORE_INVALID_ID");
    }

    #[test]
    fn racing_identical_transitions_exactly_one_succeeds() {
        let (dir, _store) = new_store_with_task(TaskStatus::Inbox);
        let root = dir.path().to_path_buf();
        let barrier = Arc::new(Barrier::new(2));

        let handles: Vec<_> = (0..2)
            .map(|_| {
                let root = root.clone();
                let barrier = Arc::clone(&barrier);
                std::thread::spawn(move || {
                    // Each thread uses its own store, as separate callers would.
                    let store = WorkflowStore::new(root);
                    barrier.wait();
                    transition(
                        &store,
                        TASK_ID,
                        TaskStatus::Inbox,
                        TaskStatus::Running,
                        None,
                    )
                })
            })
            .collect();
        let results: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();

        let successes = results.iter().filter(|r| r.is_ok()).count();
        assert_eq!(successes, 1, "{results:?}");
        assert!(results.iter().any(|r| *r
            == Err(TransitionError::Conflict {
                actual: TaskStatus::Running
            })));

        let store = WorkflowStore::new(root);
        assert_eq!(store.get_task(TASK_ID).unwrap().meta.history.len(), 1);
    }

    #[test]
    fn one_guard_scope_creates_child_transitions_parent_and_creates_run() {
        use crate::workflow::model::{
            IssueTracking, Provider, Role, RunStatus, Stage, Workflow, WorkflowRun,
        };

        const CHILD_ID: &str = "00000000000000bb";
        let (_dir, store) = new_store_with_task(TaskStatus::Inbox);
        let stage = |id: &str, role: Role| Stage {
            id: id.to_string(),
            role,
            name: id.to_string(),
            prompt: "p".to_string(),
            completion_criteria: "c".to_string(),
            provider: Provider::Claude,
            model: None,
            requires_approval: false,
            timeout_minutes: 60,
        };
        let run = WorkflowRun {
            schema_version: 1,
            root_task_id: TASK_ID.to_string(),
            workflow: Workflow {
                id: "wf-1".to_string(),
                name: "wf".to_string(),
                enabled: true,
                archived: false,
                stages: vec![
                    stage("design", Role::Design),
                    stage("implement", Role::Implement),
                    stage("review", Role::Review),
                ],
                review_return_to: Role::Design,
                max_reentry_count: 5,
                max_concurrent_runs: 1,
                design_doc_path: None,
                issue_tracking: IssueTracking::Off,
            },
            status: RunStatus::Active,
            current_task_id: CHILD_ID.to_string(),
            reentry_count: 0,
            worktree: None,
            attempts: Vec::new(),
            pending_transition: None,
            integrity_baseline: None,
            created_at: "2026-01-01T00:00:00.000Z".to_string(),
            updated_at: "2026-01-01T00:00:00.000Z".to_string(),
            acknowledged_agent_config: Vec::new(),
        };

        // Run on a helper thread so a deadlock fails the test instead of
        // hanging the suite.
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let guard = ProjectLocks::lock(store.project_root());
            let mut child = store.get_task(TASK_ID).unwrap().meta;
            child.id = CHILD_ID.to_string();
            child.parent_id = Some(TASK_ID.to_string());
            store.create_task(&guard, child, "child\n").unwrap();
            transition_locked(
                &guard,
                &store,
                TASK_ID,
                TaskStatus::Inbox,
                TaskStatus::Running,
                None,
            )
            .unwrap();
            store.create_run(&guard, &run).unwrap();
            let mut run = store.get_run(TASK_ID).unwrap();
            run.reentry_count = 1;
            store.put_run(&guard, &run).unwrap();
            drop(guard);
            tx.send(store).unwrap();
        });
        let store = rx
            .recv_timeout(std::time::Duration::from_secs(10))
            .expect("guarded sequence deadlocked");

        assert_eq!(
            store.get_task(TASK_ID).unwrap().meta.status,
            TaskStatus::Running
        );
        assert!(store.get_task(CHILD_ID).is_ok());
        assert_eq!(store.get_run(TASK_ID).unwrap().reentry_count, 1);
    }

    #[test]
    fn guard_for_another_project_is_rejected() {
        let (_dir, store) = new_store_with_task(TaskStatus::Inbox);
        let other = tempfile::tempdir().unwrap();
        let guard = ProjectLocks::lock(other.path());

        let err = transition_locked(
            &guard,
            &store,
            TASK_ID,
            TaskStatus::Inbox,
            TaskStatus::Running,
            None,
        )
        .unwrap_err();
        assert_eq!(err, TransitionError::Store(StoreError::LockMismatch));
        let task = store.get_task(TASK_ID).unwrap();
        assert_eq!(
            store.put_task(&guard, &task).unwrap_err(),
            StoreError::LockMismatch
        );
        assert_eq!(task.meta.status, TaskStatus::Inbox);
    }

    #[test]
    fn guard_accepts_other_spelling_of_same_root() {
        let (dir, store) = new_store_with_task(TaskStatus::Inbox);
        let alias = dir.path().join(".").join("");
        let guard = ProjectLocks::lock(&alias);
        assert!(guard.covers(store.project_root()));
    }

    #[test]
    fn lock_key_falls_back_for_missing_paths() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("does-not-exist");
        // Must not panic, and must be stable across calls.
        assert_eq!(project_key(&missing), project_key(&missing));
        let _guard = ProjectLocks::lock(&missing);
    }

    #[test]
    fn lock_key_fallback_makes_relative_missing_paths_absolute() {
        let relative = Path::new("mdium-lock-key-test-does-not-exist");
        assert!(!relative.exists());
        let absolute = std::env::current_dir().unwrap().join(relative);
        assert_eq!(project_key(relative), project_key(&absolute));
    }

    #[cfg(windows)]
    #[test]
    fn lock_key_is_case_insensitive_on_windows() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().to_path_buf();
        let upper = std::path::PathBuf::from(path.to_string_lossy().to_uppercase());
        assert_eq!(project_key(&path), project_key(&upper));
    }

    #[test]
    fn normalize_root_drops_trailing_separator_and_keeps_case() {
        let dir = tempfile::tempdir().unwrap();
        let root = normalize_root(dir.path());
        assert_eq!(normalize_root(&dir.path().join("")), root);
        assert!(!root.to_string_lossy().ends_with(std::path::MAIN_SEPARATOR));
        let missing = dir.path().join("Missing-Dir");
        let normalized = normalize_root(&missing.join(""));
        assert!(normalized.to_string_lossy().ends_with("Missing-Dir"));
    }

    #[cfg(windows)]
    #[test]
    fn normalize_root_strips_the_verbatim_prefix() {
        let dir = tempfile::tempdir().unwrap();
        let root = normalize_root(dir.path());
        assert!(!root.to_string_lossy().starts_with(r"\\?\"), "{root:?}");
        let verbatim = PathBuf::from(format!(r"\\?\{}", root.display()));
        assert_eq!(normalize_root(&verbatim), root);
        assert_eq!(
            strip_verbatim(PathBuf::from(r"\\?\UNC\server\share\x")),
            PathBuf::from(r"\\server\share\x")
        );
        let volume = PathBuf::from(r"\\?\Volume{0}\x");
        assert_eq!(strip_verbatim(volume.clone()), volume);
    }
}
