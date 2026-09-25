//! Task state machine: the allowed status transitions and the single
//! [`transition`] entry point that applies one under a per-project lock.
//!
//! Transitions are optimistic: the caller states the status it believes the
//! task is in (`expected_from`), and the transition fails with
//! [`TransitionError::Conflict`] if the task on disk says otherwise. The
//! per-project lock makes the reload-check-write sequence atomic with
//! respect to other transitions in this process.
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
    pub fn code(&self) -> &'static str {
        match self {
            TransitionError::NotFound => "TASK_NOT_FOUND",
            TransitionError::Conflict { .. } => "STATUS_CONFLICT",
            TransitionError::NotAllowed { .. } => "TRANSITION_NOT_ALLOWED",
            TransitionError::Store(_) => "STORE_ERROR",
        }
    }
}

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
    /// and letter case on Windows) share one lock.
    pub fn lock(project_root: &Path) -> MutexGuard<'static, ()> {
        static LOCKS: OnceLock<Mutex<HashMap<PathBuf, &'static Mutex<()>>>> = OnceLock::new();

        let key = lock_key(project_root);
        let mutex: &'static Mutex<()> = {
            let mut locks = LOCKS
                .get_or_init(Default::default)
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            *locks
                .entry(key)
                .or_insert_with(|| Box::leak(Box::new(Mutex::new(()))))
        };
        // The mutex guards no data, so a panic in a previous holder cannot
        // have left anything inconsistent; recover from poisoning.
        mutex
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// Normalized map key for a project root: canonicalized when the path
/// exists (falling back to the path as given), and lowercased on Windows,
/// whose file system is case-insensitive.
fn lock_key(project_root: &Path) -> PathBuf {
    // `canonicalize` fails for paths that do not exist (yet). Fall back to
    // `absolute`, which needs no file system access, so a relative and an
    // absolute spelling of the same missing root still share one key; only
    // if that fails too is the path used exactly as given.
    let canonical = std::fs::canonicalize(project_root)
        .or_else(|_| std::path::absolute(project_root))
        .unwrap_or_else(|_| project_root.to_path_buf());
    if cfg!(windows) {
        PathBuf::from(canonical.to_string_lossy().to_lowercase())
    } else {
        canonical
    }
}

/// Moves task `task_id` from `expected_from` to `to` and returns the task
/// as written.
///
/// Under the project lock this reloads the task, fails with
/// [`TransitionError::Conflict`] if its status is not `expected_from`, and
/// fails with [`TransitionError::NotAllowed`] if the table forbids the
/// move. On success it sets the status, sets `attention` to `reason` when
/// moving to `Attention` (clearing it otherwise), appends a history entry
/// carrying `reason`, and writes the task atomically. Nothing is written
/// on failure.
pub fn transition(
    store: &WorkflowStore,
    task_id: &str,
    expected_from: TaskStatus,
    to: TaskStatus,
    reason: Option<AttentionReason>,
) -> Result<Task, TransitionError> {
    let _guard = ProjectLocks::lock(store.project_root());

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
    Ok(store.put_task_at(&task, at)?)
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
        };
        store.create_task(meta, "body\n").unwrap();
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
        assert_eq!(err.code(), "STATUS_CONFLICT");
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
        assert_eq!(err.code(), "STORE_ERROR");
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
    fn lock_key_falls_back_for_missing_paths() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("does-not-exist");
        // Must not panic, and must be stable across calls.
        assert_eq!(lock_key(&missing), lock_key(&missing));
        let _guard = ProjectLocks::lock(&missing);
    }

    #[test]
    fn lock_key_fallback_makes_relative_missing_paths_absolute() {
        let relative = Path::new("mdium-lock-key-test-does-not-exist");
        assert!(!relative.exists());
        let absolute = std::env::current_dir().unwrap().join(relative);
        assert_eq!(lock_key(relative), lock_key(&absolute));
    }

    #[cfg(windows)]
    #[test]
    fn lock_key_is_case_insensitive_on_windows() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().to_path_buf();
        let upper = std::path::PathBuf::from(path.to_string_lossy().to_uppercase());
        assert_eq!(lock_key(&path), lock_key(&upper));
    }
}
