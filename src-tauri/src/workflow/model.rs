//! Data model for the workflow foundation (Part 3b).
//!
//! These types mirror the on-disk shapes described in the design spec:
//! `workflows.json` (`WorkflowsFile`), task documents (`Task`/`TaskMeta`
//! frontmatter) and run state (`WorkflowRun`). All structs serialize with
//! camelCase field names; status/role enums serialize as lowercase or
//! snake_case string tags as noted per type. Nothing in this module is wired
//! into the app yet (Part 3b-2), so the whole module is allowed to look
//! unused for now.

use crate::workflow::integrity::IntegritySnapshot;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// A stage's place in the fixed design -> implement -> review pipeline.
/// Serializes as `"design"` | `"implement"` | `"review"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    Design,
    Implement,
    Review,
}

/// Which coding agent runs a stage. Serializes as lowercase.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Codex,
    Copilot,
    Opencode,
    Claude,
}

/// Whether the workflow auto-creates/updates an issue tracker entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum IssueTracking {
    Auto,
    Off,
}

/// One step of a workflow's design/implement/review pipeline.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Stage {
    pub id: String,
    pub role: Role,
    pub name: String,
    pub prompt: String,
    pub completion_criteria: String,
    pub provider: Provider,
    pub model: Option<String>,
    pub requires_approval: bool,
    pub timeout_minutes: u32,
}

/// A user-defined workflow: exactly three stages (design, implement,
/// review) plus the policy around re-entry, concurrency and approvals.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workflow {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub archived: bool,
    pub stages: Vec<Stage>,
    pub review_return_to: Role,
    pub max_reentry_count: u32,
    pub max_concurrent_runs: u32,
    pub design_doc_path: Option<String>,
    pub issue_tracking: IssueTracking,
}

/// On-disk shape of `.mdium/workflows.json`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowsFile {
    pub schema_version: u32,
    pub workflows: Vec<Workflow>,
}

/// Lifecycle status of a task. Serializes as snake_case on disk.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Inbox,
    Running,
    AwaitingUser,
    Attention,
    OnHold,
    Completed,
    Cancelled,
}

/// A machine-readable reason for a task needing attention. The UI localizes
/// `code`/`params` for display; no user-facing text lives in Rust.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttentionReason {
    pub code: String,
    pub params: BTreeMap<String, String>,
}

/// One status transition recorded in a task's history.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub at: String,
    pub from: Option<TaskStatus>,
    pub to: TaskStatus,
    pub reason: Option<AttentionReason>,
}

/// Frontmatter of a task document (`.mdium/tasks/<taskId>.md`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskMeta {
    pub schema_version: u32,
    pub id: String,
    pub title: String,
    pub status: TaskStatus,
    pub root_id: String,
    pub parent_id: Option<String>,
    pub workflow_id: Option<String>,
    pub stage_id: Option<String>,
    pub role: Option<Role>,
    pub auto_generated: bool,
    pub archived: bool,
    pub created_at: String,
    pub updated_at: String,
    pub attention: Option<AttentionReason>,
    pub history: Vec<HistoryEntry>,
}

/// A task document: frontmatter plus the markdown body.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub meta: TaskMeta,
    pub body: String,
}

/// Location and branch info for a run's dedicated worktree.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeInfo {
    pub path: String,
    pub branch: String,
    pub base_branch: String,
    pub base_commit: String,
}

/// Lifecycle status of a workflow run. Serializes as snake_case on disk,
/// matching `TaskStatus`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunStatus {
    Active,
    AwaitingMerge,
    Attention,
    Cancelled,
    Merged,
    Discarded,
}

/// A single attempt at running a stage (one runner process invocation).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttemptRecord {
    pub attempt_id: String,
    pub task_id: String,
    pub stage_id: String,
    pub session_id: String,
    pub runner_pid: Option<u32>,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub outcome: Option<String>,
}

/// A queued move from one task to the child task of the next stage,
/// applied once the current attempt settles.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingTransition {
    pub from_task_id: String,
    pub to_stage_id: String,
    pub child_task_id: String,
}

/// On-disk shape of `.mdium/runs/<rootTaskId>.json`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRun {
    pub schema_version: u32,
    pub root_task_id: String,
    /// Snapshot of the workflow definition at run start, so later edits to
    /// the workflow don't change a run already in progress.
    pub workflow: Workflow,
    pub status: RunStatus,
    pub current_task_id: String,
    pub reentry_count: u32,
    pub worktree: Option<WorktreeInfo>,
    pub attempts: Vec<AttemptRecord>,
    pub pending_transition: Option<PendingTransition>,
    pub integrity_baseline: Option<IntegritySnapshot>,
    pub created_at: String,
    pub updated_at: String,
}

/// A `Workflow::validate` rule violation. Each variant has a stable `code()`
/// so callers (and the UI) can key off the failure without matching text.
#[derive(Debug, Clone, PartialEq)]
pub enum ValidationError {
    /// Stages are not exactly design, implement, review in that order.
    StageRoles,
    /// Two stages share the same `id`.
    StageIdDuplicate(String),
    /// `review_return_to` is not design or implement.
    ReviewReturnTo,
    /// A stage's `timeout_minutes` is 0.
    Timeout(String),
    /// `max_reentry_count` is 0.
    MaxReentry,
    /// `max_concurrent_runs` is 0.
    MaxConcurrent,
    /// `requires_approval` is set on a stage other than implement.
    ApprovalRole(String),
    /// `design_doc_path` is absolute, escapes the repo, or points into
    /// `.git`/`.mdium`.
    DesignDocPath(String),
    /// The workflow's `name` is empty (or whitespace-only).
    NameEmpty,
}

impl ValidationError {
    /// Stable machine code for this validation failure.
    pub fn code(&self) -> &'static str {
        match self {
            ValidationError::StageRoles => "STAGE_ROLES",
            ValidationError::StageIdDuplicate(_) => "STAGE_ID_DUPLICATE",
            ValidationError::ReviewReturnTo => "REVIEW_RETURN_TO",
            ValidationError::Timeout(_) => "TIMEOUT",
            ValidationError::MaxReentry => "MAX_REENTRY",
            ValidationError::MaxConcurrent => "MAX_CONCURRENT",
            ValidationError::ApprovalRole(_) => "APPROVAL_ROLE",
            ValidationError::DesignDocPath(_) => "DESIGN_DOC_PATH",
            ValidationError::NameEmpty => "NAME_EMPTY",
        }
    }
}

/// True if `path` is not a safe repo-relative `designDocPath`: absolute,
/// containing a `..` segment, or rooted under `.git`/`.mdium`.
fn is_invalid_design_doc_path(path: &str) -> bool {
    if std::path::Path::new(path).is_absolute() {
        return true;
    }
    // `Path::is_absolute` only recognizes a Windows drive/UNC prefix or,
    // on Unix, a leading `/`. A workflow file can be authored on any OS, so
    // also reject a leading separator here directly: on Windows a bare
    // "/etc/passwd" is "rooted" but not "absolute" per std, yet it is still
    // not a safe repo-relative path.
    if path.starts_with('/') || path.starts_with('\\') {
        return true;
    }

    let mut first_segment: Option<&str> = None;
    for segment in path.split(['/', '\\']).filter(|s| !s.is_empty()) {
        if first_segment.is_none() {
            first_segment = Some(segment);
        }
        if segment == ".." {
            return true;
        }
    }

    matches!(first_segment, Some(".git") | Some(".mdium"))
}

impl Workflow {
    /// Validate this workflow against the fixed shape rules (constraints.md):
    /// exactly design/implement/review stages in order, unique stage ids,
    /// sane review-return target, positive timeouts/limits, approval only on
    /// the implement stage, a safe design doc path, and a non-empty name.
    ///
    /// Returns every violation found, not just the first.
    pub fn validate(&self) -> Result<(), Vec<ValidationError>> {
        let mut errors = Vec::new();

        let expected_roles = [Role::Design, Role::Implement, Role::Review];
        let roles_in_order = self.stages.len() == expected_roles.len()
            && self
                .stages
                .iter()
                .zip(expected_roles.iter())
                .all(|(stage, expected)| stage.role == *expected);
        if !roles_in_order {
            errors.push(ValidationError::StageRoles);
        }

        let mut seen_ids: Vec<&str> = Vec::new();
        for stage in &self.stages {
            if seen_ids.contains(&stage.id.as_str()) {
                errors.push(ValidationError::StageIdDuplicate(stage.id.clone()));
            } else {
                seen_ids.push(stage.id.as_str());
            }
        }

        if self.review_return_to == Role::Review {
            errors.push(ValidationError::ReviewReturnTo);
        }

        for stage in &self.stages {
            if stage.timeout_minutes == 0 {
                errors.push(ValidationError::Timeout(stage.id.clone()));
            }
        }

        if self.max_reentry_count == 0 {
            errors.push(ValidationError::MaxReentry);
        }
        if self.max_concurrent_runs == 0 {
            errors.push(ValidationError::MaxConcurrent);
        }

        for stage in &self.stages {
            if stage.requires_approval && stage.role != Role::Implement {
                errors.push(ValidationError::ApprovalRole(stage.id.clone()));
            }
        }

        if let Some(path) = &self.design_doc_path {
            if is_invalid_design_doc_path(path) {
                errors.push(ValidationError::DesignDocPath(path.clone()));
            }
        }

        if self.name.trim().is_empty() {
            errors.push(ValidationError::NameEmpty);
        }

        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors)
        }
    }

    /// The stage for `role`. Panics if there is no such stage; callers
    /// should only rely on this after `validate()` has confirmed the
    /// workflow has exactly one stage per role.
    pub fn stage(&self, role: Role) -> &Stage {
        self.stages
            .iter()
            .find(|stage| stage.role == role)
            .expect("workflow does not have a stage for the requested role")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sample_stage(id: &str, role: Role, name: &str) -> Stage {
        Stage {
            id: id.to_string(),
            role,
            name: name.to_string(),
            prompt: format!("{name} prompt"),
            completion_criteria: format!("{name} done"),
            provider: Provider::Claude,
            model: None,
            requires_approval: false,
            timeout_minutes: 60,
        }
    }

    fn valid_workflow() -> Workflow {
        Workflow {
            id: "wf-1".to_string(),
            name: "Test Workflow".to_string(),
            enabled: true,
            archived: false,
            stages: vec![
                sample_stage("design", Role::Design, "Design"),
                sample_stage("implement", Role::Implement, "Implement"),
                sample_stage("review", Role::Review, "Review"),
            ],
            review_return_to: Role::Design,
            max_reentry_count: 5,
            max_concurrent_runs: 1,
            design_doc_path: None,
            issue_tracking: IssueTracking::Auto,
        }
    }

    fn minimal_task_meta() -> TaskMeta {
        TaskMeta {
            schema_version: 1,
            id: "task-1".to_string(),
            title: "Do the thing".to_string(),
            status: TaskStatus::AwaitingUser,
            root_id: "task-1".to_string(),
            parent_id: None,
            workflow_id: None,
            stage_id: None,
            role: None,
            auto_generated: false,
            archived: false,
            created_at: "2026-01-01T00:00:00Z".to_string(),
            updated_at: "2026-01-01T00:00:00Z".to_string(),
            attention: None,
            history: Vec::new(),
        }
    }

    #[test]
    fn workflow_json_roundtrip_uses_camel_case() {
        let workflow = valid_workflow();
        let value = serde_json::to_value(&workflow).unwrap();

        assert_eq!(
            value,
            json!({
                "id": "wf-1",
                "name": "Test Workflow",
                "enabled": true,
                "archived": false,
                "stages": [
                    {
                        "id": "design",
                        "role": "design",
                        "name": "Design",
                        "prompt": "Design prompt",
                        "completionCriteria": "Design done",
                        "provider": "claude",
                        "model": null,
                        "requiresApproval": false,
                        "timeoutMinutes": 60
                    },
                    {
                        "id": "implement",
                        "role": "implement",
                        "name": "Implement",
                        "prompt": "Implement prompt",
                        "completionCriteria": "Implement done",
                        "provider": "claude",
                        "model": null,
                        "requiresApproval": false,
                        "timeoutMinutes": 60
                    },
                    {
                        "id": "review",
                        "role": "review",
                        "name": "Review",
                        "prompt": "Review prompt",
                        "completionCriteria": "Review done",
                        "provider": "claude",
                        "model": null,
                        "requiresApproval": false,
                        "timeoutMinutes": 60
                    }
                ],
                "reviewReturnTo": "design",
                "maxReentryCount": 5,
                "maxConcurrentRuns": 1,
                "designDocPath": null,
                "issueTracking": "auto"
            })
        );

        let round_tripped: Workflow = serde_json::from_value(value).unwrap();
        assert_eq!(round_tripped, workflow);
    }

    #[test]
    fn task_meta_json_roundtrip_uses_snake_case_status() {
        let meta = minimal_task_meta();
        let value = serde_json::to_value(&meta).unwrap();

        assert_eq!(
            value,
            json!({
                "schemaVersion": 1,
                "id": "task-1",
                "title": "Do the thing",
                "status": "awaiting_user",
                "rootId": "task-1",
                "parentId": null,
                "workflowId": null,
                "stageId": null,
                "role": null,
                "autoGenerated": false,
                "archived": false,
                "createdAt": "2026-01-01T00:00:00Z",
                "updatedAt": "2026-01-01T00:00:00Z",
                "attention": null,
                "history": []
            })
        );

        let round_tripped: TaskMeta = serde_json::from_value(value).unwrap();
        assert_eq!(round_tripped, meta);
    }

    #[test]
    fn validate_passes_for_valid_workflow() {
        assert_eq!(valid_workflow().validate(), Ok(()));
    }

    #[test]
    fn validate_reports_stage_roles_out_of_order() {
        let mut workflow = valid_workflow();
        workflow.stages.swap(0, 1);

        let errors = workflow.validate().unwrap_err();
        assert_eq!(errors, vec![ValidationError::StageRoles]);
        assert_eq!(errors[0].code(), "STAGE_ROLES");
    }

    #[test]
    fn validate_reports_stage_id_duplicate() {
        let mut workflow = valid_workflow();
        workflow.stages[1].id = workflow.stages[0].id.clone();

        let errors = workflow.validate().unwrap_err();
        assert_eq!(
            errors,
            vec![ValidationError::StageIdDuplicate("design".to_string())]
        );
        assert_eq!(errors[0].code(), "STAGE_ID_DUPLICATE");
    }

    #[test]
    fn validate_reports_review_return_to() {
        let mut workflow = valid_workflow();
        workflow.review_return_to = Role::Review;

        let errors = workflow.validate().unwrap_err();
        assert_eq!(errors, vec![ValidationError::ReviewReturnTo]);
        assert_eq!(errors[0].code(), "REVIEW_RETURN_TO");
    }

    #[test]
    fn validate_reports_timeout_zero() {
        let mut workflow = valid_workflow();
        workflow.stages[0].timeout_minutes = 0;

        let errors = workflow.validate().unwrap_err();
        assert_eq!(
            errors,
            vec![ValidationError::Timeout("design".to_string())]
        );
        assert_eq!(errors[0].code(), "TIMEOUT");
    }

    #[test]
    fn validate_reports_max_reentry_zero() {
        let mut workflow = valid_workflow();
        workflow.max_reentry_count = 0;

        let errors = workflow.validate().unwrap_err();
        assert_eq!(errors, vec![ValidationError::MaxReentry]);
        assert_eq!(errors[0].code(), "MAX_REENTRY");
    }

    #[test]
    fn validate_reports_max_concurrent_zero() {
        let mut workflow = valid_workflow();
        workflow.max_concurrent_runs = 0;

        let errors = workflow.validate().unwrap_err();
        assert_eq!(errors, vec![ValidationError::MaxConcurrent]);
        assert_eq!(errors[0].code(), "MAX_CONCURRENT");
    }

    #[test]
    fn validate_reports_approval_role_on_non_implement_stage() {
        let mut workflow = valid_workflow();
        workflow.stages[0].requires_approval = true;

        let errors = workflow.validate().unwrap_err();
        assert_eq!(
            errors,
            vec![ValidationError::ApprovalRole("design".to_string())]
        );
        assert_eq!(errors[0].code(), "APPROVAL_ROLE");
    }

    #[test]
    fn validate_reports_design_doc_path_escaping_repo() {
        let mut workflow = valid_workflow();
        workflow.design_doc_path = Some("../outside.md".to_string());

        let errors = workflow.validate().unwrap_err();
        assert_eq!(
            errors,
            vec![ValidationError::DesignDocPath("../outside.md".to_string())]
        );
        assert_eq!(errors[0].code(), "DESIGN_DOC_PATH");
    }

    #[test]
    fn validate_reports_design_doc_path_absolute() {
        let mut workflow = valid_workflow();
        workflow.design_doc_path = Some("/etc/passwd".to_string());

        let errors = workflow.validate().unwrap_err();
        assert_eq!(errors[0].code(), "DESIGN_DOC_PATH");
    }

    #[test]
    fn validate_reports_design_doc_path_in_mdium_dir() {
        let mut workflow = valid_workflow();
        workflow.design_doc_path = Some(".mdium/secret.md".to_string());

        let errors = workflow.validate().unwrap_err();
        assert_eq!(errors[0].code(), "DESIGN_DOC_PATH");
    }

    #[test]
    fn validate_reports_name_empty() {
        let mut workflow = valid_workflow();
        workflow.name = "  ".to_string();

        let errors = workflow.validate().unwrap_err();
        assert_eq!(errors, vec![ValidationError::NameEmpty]);
        assert_eq!(errors[0].code(), "NAME_EMPTY");
    }

    #[test]
    fn stage_returns_matching_role() {
        let workflow = valid_workflow();
        assert_eq!(workflow.stage(Role::Implement).id, "implement");
    }
}
