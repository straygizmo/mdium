//! Data model for the workflow foundation (Part 3b).
//!
//! These types mirror the on-disk shapes described in the design spec:
//! `workflows.json` (`WorkflowsFile`), task documents (`Task`/`TaskMeta`
//! frontmatter) and run state (`WorkflowRun`). All structs serialize with
//! camelCase field names; status/role enums serialize as lowercase or
//! snake_case string tags as noted per type. Nothing in this module is wired
//! into the app yet (Part 3b-2), so the whole module is allowed to look
//! unused for now.

use crate::workflow::forge::ForgeKind;
use crate::workflow::integrity::IntegritySnapshot;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// A stage's place in the fixed design -> implement -> review pipeline.
/// Serializes as `"design"` | `"implement"` | `"review"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
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

/// Default `Stage::timeout_minutes` (constraints.md).
pub const DEFAULT_TIMEOUT_MINUTES: u32 = 60;
/// Default `Workflow::max_reentry_count` (constraints.md).
pub const DEFAULT_MAX_REENTRY_COUNT: u32 = 5;
/// Default `Workflow::max_concurrent_runs` (constraints.md).
pub const DEFAULT_MAX_CONCURRENT_RUNS: u32 = 1;

fn default_timeout_minutes() -> u32 {
    DEFAULT_TIMEOUT_MINUTES
}

fn default_max_reentry_count() -> u32 {
    DEFAULT_MAX_REENTRY_COUNT
}

fn default_max_concurrent_runs() -> u32 {
    DEFAULT_MAX_CONCURRENT_RUNS
}

fn default_review_return_to() -> Role {
    Role::Design
}

/// One step of a workflow's design/implement/review pipeline. Fields with
/// a documented default (constraints.md) may be omitted from a
/// hand-written `workflows.json`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Stage {
    pub id: String,
    pub role: Role,
    pub name: String,
    pub prompt: String,
    pub completion_criteria: String,
    pub provider: Provider,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub requires_approval: bool,
    #[serde(default = "default_timeout_minutes")]
    pub timeout_minutes: u32,
}

/// A user-defined workflow: exactly three stages (design, implement,
/// review) plus the policy around re-entry, concurrency and approvals.
/// Fields with a documented default (constraints.md) may be omitted from a
/// hand-written `workflows.json`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workflow {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub archived: bool,
    pub stages: Vec<Stage>,
    #[serde(default = "default_review_return_to")]
    pub review_return_to: Role,
    #[serde(default = "default_max_reentry_count")]
    pub max_reentry_count: u32,
    #[serde(default = "default_max_concurrent_runs")]
    pub max_concurrent_runs: u32,
    #[serde(default)]
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
    /// What the task is waiting for; set while `status == awaiting_user`.
    #[serde(default)]
    pub awaiting: Option<AwaitingInfo>,
    /// Set when the user approves a plan; consumed when the execute attempt
    /// starts.
    #[serde(default)]
    pub plan_approved: bool,
    /// Answer or revision instruction for the next attempt; consumed at
    /// attempt start.
    #[serde(default)]
    pub user_input: Option<String>,
    /// SHA-256 hex digest of screened input the user accepted.
    #[serde(default)]
    pub screening_ack: Option<String>,
    /// Forge issue tracking this task; set on root tasks only.
    #[serde(default)]
    pub issue: Option<IssueRef>,
    /// Entry kind (`design` | `implement` | `review`) whose issue comment
    /// still awaits sync after `ATTENTION_ISSUE_SYNC_FAILED`.
    #[serde(default)]
    pub pending_issue_entry: Option<String>,
}

/// A forge issue linked to a task/run: which forge and repository it lives
/// in, plus its number and web URL.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueRef {
    pub kind: ForgeKind,
    pub host: String,
    pub path: String,
    pub number: u64,
    pub url: String,
}

/// Why a task is waiting on the user. Serializes as snake_case.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AwaitingKind {
    PlanApproval,
    Question,
}

/// Details of what an `awaiting_user` task is waiting for.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AwaitingInfo {
    pub kind: AwaitingKind,
    /// The agent's question, when `kind` is `Question`.
    #[serde(default)]
    pub question: Option<String>,
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
    Cancelled,
    Merged,
    Discarded,
}

/// Which kind of session an attempt ran. Serializes as snake_case;
/// defaults to `Single` for attempt records written before modes existed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AttemptMode {
    /// One session that does the whole stage.
    #[default]
    Single,
    /// Read-only planning session of an approval-gated implement stage.
    Plan,
    /// Full-access execution session after the plan was approved.
    Execute,
}

/// A single attempt at running a stage (one runner process invocation).
///
/// `outcome` is one of `completed`, `attention`, `awaiting_user`, `failed`,
/// `timeout`, `cancelled`, `guard_blocked`, `interrupted`, `output_invalid`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttemptRecord {
    pub attempt_id: String,
    pub task_id: String,
    pub stage_id: String,
    pub session_id: String,
    /// Reserved; currently always `None`. The runner API does not expose
    /// its process id, and nothing needs it: attempts never outlive the
    /// app process, so recovery does not probe runner liveness.
    pub runner_pid: Option<u32>,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub outcome: Option<String>,
    #[serde(default)]
    pub mode: AttemptMode,
    /// Copy of the user input consumed by this attempt (traceability).
    #[serde(default)]
    pub user_input: Option<String>,
    /// Entry kind (`design` | `implement` | `review`) of the Issue entry
    /// being posted for this attempt's result; set right before the post
    /// and cleared when the attempt is finished, so recovery can tell an
    /// attempt interrupted during its Issue sync.
    #[serde(default)]
    pub issue_sync_pending: Option<String>,
}

/// Content fingerprint of an agent-config file. `sha256` is `None` when the
/// file is deleted.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileFingerprint {
    pub path: String,
    #[serde(default)]
    pub sha256: Option<String>,
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
    /// Agent-config file states the user explicitly accepted for this run.
    #[serde(default)]
    pub acknowledged_agent_config: Vec<FileFingerprint>,
    /// Forge issue tracking this run (copied from the root task).
    #[serde(default)]
    pub issue: Option<IssueRef>,
    /// True once the run's issue was closed on the forge.
    #[serde(default)]
    pub issue_closed: bool,
    /// Error code of the last failed attempt to close the issue.
    #[serde(default)]
    pub issue_close_error: Option<String>,
}

// Consumed by the intake module (not wired up yet).
#[allow(dead_code)]
/// What an intake session is collecting. Serializes as snake_case.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IntakeKind {
    Feature,
    Bug,
}

// Consumed by the intake module (not wired up yet).
#[allow(dead_code)]
/// Lifecycle status of an intake session. Serializes as snake_case.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IntakeStatus {
    Active,
    Finalizing,
    Done,
    Abandoned,
}

// Consumed by the intake module (not wired up yet).
#[allow(dead_code)]
/// The last completed step of the resumable finalize pipeline. Serializes
/// as snake_case; defaults to `Ready` (nothing done yet).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FinalizeStage {
    #[default]
    Ready,
    IssueCreated,
    AttachmentsCommitted,
    TaskCreated,
    Done,
}

// Consumed by the intake module (not wired up yet).
#[allow(dead_code)]
/// One message of an intake transcript.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntakeMessage {
    pub id: String,
    /// `user` | `assistant` | `error`.
    pub role: String,
    pub text: String,
    /// Draft attachments sent with this message.
    #[serde(default)]
    pub draft_ids: Vec<String>,
    pub at: String,
}

// Consumed by the intake module (not wired up yet).
#[allow(dead_code)]
/// The agent's current proposal for the task/issue title and body.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntakeProposal {
    pub title: String,
    pub body: String,
}

// Consumed by the intake module (not wired up yet).
#[allow(dead_code)]
/// A proposed replacement of a project document's content.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocUpdateProposal {
    pub id: String,
    /// Project-relative path of the document.
    pub path: String,
    pub content: String,
    /// `pending` | `applied` | `rejected`.
    pub status: String,
    /// Why the update was rejected when it was proposed (an `INTAKE_*`
    /// code); `None` for updates the user decided.
    #[serde(default)]
    pub reason: Option<String>,
}

// Consumed by the intake module (not wired up yet).
#[allow(dead_code)]
/// A question the agent asked in its last turn, with optional choices.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntakeQuestion {
    pub text: String,
    #[serde(default)]
    pub options: Vec<String>,
}

// Consumed by the intake module (not wired up yet).
#[allow(dead_code)]
/// Progress of the finalize pipeline, persisted so a failed finalize resumes
/// at the failed step without redoing completed ones.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FinalizeState {
    #[serde(default)]
    pub stage: FinalizeStage,
    #[serde(default)]
    pub root_task_id: Option<String>,
    #[serde(default)]
    pub issue: Option<IssueRef>,
    #[serde(default)]
    pub attachment_ids: Vec<String>,
    #[serde(default)]
    pub skip_issue: bool,
    /// Set (and saved) right before the Issue is created and cleared once
    /// it is recorded: when still set on a retry, the Issue may exist
    /// already and is looked up by the session marker before creating one.
    #[serde(default)]
    pub issue_creating: bool,
    /// Error code of the last failed finalize step.
    #[serde(default)]
    pub last_error: Option<String>,
}

// Consumed by the intake module (not wired up yet).
#[allow(dead_code)]
/// On-disk shape of `.mdium/intakes/<intakeId>.json`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntakeSession {
    pub schema_version: u32,
    pub id: String,
    pub workflow_id: String,
    pub kind: IntakeKind,
    pub provider: Provider,
    #[serde(default)]
    pub model: Option<String>,
    pub status: IntakeStatus,
    #[serde(default)]
    pub messages: Vec<IntakeMessage>,
    #[serde(default)]
    pub last_question: Option<IntakeQuestion>,
    #[serde(default)]
    pub proposal: Option<IntakeProposal>,
    #[serde(default)]
    pub doc_updates: Vec<DocUpdateProposal>,
    #[serde(default)]
    pub finalize: FinalizeState,
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
    /// A stage's `name` is empty (or whitespace-only).
    StageNameEmpty(String),
}

impl ValidationError {
    /// Stable machine code for this validation failure.
    pub fn code(&self) -> &'static str {
        match self {
            ValidationError::StageRoles => "WORKFLOW_INVALID_STAGE_ROLES",
            ValidationError::StageIdDuplicate(_) => "WORKFLOW_STAGE_ID_DUPLICATE",
            ValidationError::ReviewReturnTo => "WORKFLOW_INVALID_REVIEW_RETURN_TO",
            ValidationError::Timeout(_) => "WORKFLOW_INVALID_TIMEOUT",
            ValidationError::MaxReentry => "WORKFLOW_INVALID_MAX_REENTRY",
            ValidationError::MaxConcurrent => "WORKFLOW_INVALID_MAX_CONCURRENT",
            ValidationError::ApprovalRole(_) => "WORKFLOW_INVALID_APPROVAL_ROLE",
            ValidationError::DesignDocPath(_) => "WORKFLOW_INVALID_DESIGN_DOC_PATH",
            ValidationError::NameEmpty => "WORKFLOW_NAME_EMPTY",
            ValidationError::StageNameEmpty(_) => "WORKFLOW_STAGE_NAME_EMPTY",
        }
    }
}

impl std::fmt::Display for ValidationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ValidationError::StageIdDuplicate(detail)
            | ValidationError::Timeout(detail)
            | ValidationError::ApprovalRole(detail)
            | ValidationError::DesignDocPath(detail)
            | ValidationError::StageNameEmpty(detail) => {
                write!(f, "{}: {detail}", self.code())
            }
            ValidationError::StageRoles
            | ValidationError::ReviewReturnTo
            | ValidationError::MaxReentry
            | ValidationError::MaxConcurrent
            | ValidationError::NameEmpty => f.write_str(self.code()),
        }
    }
}

crate::workflow::errors::impl_workflow_error!(ValidationError);

/// True if `path` is not a safe repo-relative `designDocPath`: absolute,
/// containing a `..` segment, or rooted under `.git`/`.mdium`.
pub(crate) fn is_invalid_design_doc_path(path: &str) -> bool {
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

    // Compare case-insensitively: Windows/macOS filesystems are typically
    // case-insensitive, so ".Git"/".GIT" resolve to the same directory as
    // ".git" and must be rejected too.
    matches!(first_segment, Some(seg) if seg.eq_ignore_ascii_case(".git") || seg.eq_ignore_ascii_case(".mdium"))
}

impl Workflow {
    /// Validate this workflow against the fixed shape rules (constraints.md):
    /// exactly design/implement/review stages in order, unique stage ids,
    /// sane review-return target, positive timeouts/limits, approval only on
    /// the implement stage, a safe design doc path, and non-empty
    /// workflow/stage names.
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

        for stage in &self.stages {
            if stage.name.trim().is_empty() {
                errors.push(ValidationError::StageNameEmpty(stage.id.clone()));
            }
        }

        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors)
        }
    }

    /// The stage for `role`, or `None` if the workflow has no such stage.
    /// A workflow that passed `validate()` always has exactly one stage per
    /// role, but this never panics on one that did not.
    pub fn stage(&self, role: Role) -> Option<&Stage> {
        self.stages.iter().find(|stage| stage.role == role)
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
            awaiting: None,
            plan_approved: false,
            user_input: None,
            screening_ack: None,
            issue: None,
            pending_issue_entry: None,
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
                "history": [],
                "awaiting": null,
                "planApproved": false,
                "userInput": null,
                "screeningAck": null,
                "issue": null,
                "pendingIssueEntry": null
            })
        );

        let round_tripped: TaskMeta = serde_json::from_value(value).unwrap();
        assert_eq!(round_tripped, meta);
    }

    #[test]
    fn task_meta_without_new_fields_loads_with_defaults() {
        let value = json!({
            "schemaVersion": 1,
            "id": "task-1",
            "title": "Do the thing",
            "status": "inbox",
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
        });

        let meta: TaskMeta = serde_json::from_value(value).unwrap();
        assert_eq!(meta.awaiting, None);
        assert!(!meta.plan_approved);
        assert_eq!(meta.user_input, None);
        assert_eq!(meta.screening_ack, None);
    }

    #[test]
    fn task_meta_new_fields_roundtrip_uses_camel_case() {
        let mut meta = minimal_task_meta();
        meta.awaiting = Some(AwaitingInfo {
            kind: AwaitingKind::PlanApproval,
            question: None,
        });
        meta.plan_approved = true;
        meta.user_input = Some("Please also add tests".to_string());
        meta.screening_ack = Some("abc123".to_string());

        let value = serde_json::to_value(&meta).unwrap();
        assert_eq!(
            value["awaiting"],
            json!({ "kind": "plan_approval", "question": null })
        );
        assert_eq!(value["planApproved"], json!(true));
        assert_eq!(value["userInput"], json!("Please also add tests"));
        assert_eq!(value["screeningAck"], json!("abc123"));

        let round_tripped: TaskMeta = serde_json::from_value(value).unwrap();
        assert_eq!(round_tripped, meta);

        let question = AwaitingInfo {
            kind: AwaitingKind::Question,
            question: Some("Which DB?".to_string()),
        };
        assert_eq!(
            serde_json::to_value(&question).unwrap(),
            json!({ "kind": "question", "question": "Which DB?" })
        );
    }

    fn sample_run_value() -> serde_json::Value {
        json!({
            "schemaVersion": 1,
            "rootTaskId": "task-1",
            "workflow": serde_json::to_value(valid_workflow()).unwrap(),
            "status": "active",
            "currentTaskId": "task-1",
            "reentryCount": 0,
            "worktree": null,
            "attempts": [{
                "attemptId": "a-1",
                "taskId": "task-1",
                "stageId": "design",
                "sessionId": "s-1",
                "runnerPid": null,
                "startedAt": "2026-01-01T00:00:00Z",
                "finishedAt": null,
                "outcome": null
            }],
            "pendingTransition": null,
            "integrityBaseline": null,
            "createdAt": "2026-01-01T00:00:00Z",
            "updatedAt": "2026-01-01T00:00:00Z"
        })
    }

    #[test]
    fn run_without_new_fields_loads_with_defaults() {
        let run: WorkflowRun = serde_json::from_value(sample_run_value()).unwrap();
        assert!(run.acknowledged_agent_config.is_empty());
        assert_eq!(run.attempts[0].mode, AttemptMode::Single);
        assert_eq!(run.attempts[0].user_input, None);
    }

    #[test]
    fn run_new_fields_roundtrip_uses_camel_case() {
        let mut run: WorkflowRun = serde_json::from_value(sample_run_value()).unwrap();
        run.acknowledged_agent_config = vec![
            FileFingerprint {
                path: "AGENTS.md".to_string(),
                sha256: Some("deadbeef".to_string()),
            },
            FileFingerprint {
                path: ".claude/settings.json".to_string(),
                sha256: None,
            },
        ];
        run.attempts[0].mode = AttemptMode::Execute;
        run.attempts[0].user_input = Some("go ahead".to_string());
        run.attempts[0].issue_sync_pending = Some("design".to_string());

        let value = serde_json::to_value(&run).unwrap();
        assert_eq!(
            value["acknowledgedAgentConfig"],
            json!([
                { "path": "AGENTS.md", "sha256": "deadbeef" },
                { "path": ".claude/settings.json", "sha256": null }
            ])
        );
        assert_eq!(value["attempts"][0]["mode"], json!("execute"));
        assert_eq!(value["attempts"][0]["userInput"], json!("go ahead"));
        assert_eq!(value["attempts"][0]["issueSyncPending"], json!("design"));

        let round_tripped: WorkflowRun = serde_json::from_value(value).unwrap();
        assert_eq!(round_tripped, run);

        assert_eq!(
            serde_json::to_value(AttemptMode::Single).unwrap(),
            json!("single")
        );
        assert_eq!(
            serde_json::to_value(AttemptMode::Plan).unwrap(),
            json!("plan")
        );
    }

    fn sample_issue() -> IssueRef {
        IssueRef {
            kind: ForgeKind::GitHub,
            host: "github.com".to_string(),
            path: "owner/repo".to_string(),
            number: 42,
            url: "https://github.com/owner/repo/issues/42".to_string(),
        }
    }

    #[test]
    fn task_meta_without_issue_fields_loads_with_defaults() {
        let mut value = serde_json::to_value(minimal_task_meta()).unwrap();
        let object = value.as_object_mut().unwrap();
        object.remove("issue");
        object.remove("pendingIssueEntry");

        let meta: TaskMeta = serde_json::from_value(value).unwrap();
        assert_eq!(meta.issue, None);
        assert_eq!(meta.pending_issue_entry, None);
    }

    #[test]
    fn task_meta_issue_fields_roundtrip_uses_camel_case() {
        let mut meta = minimal_task_meta();
        meta.issue = Some(sample_issue());
        meta.pending_issue_entry = Some("implement".to_string());

        let value = serde_json::to_value(&meta).unwrap();
        assert_eq!(
            value["issue"],
            json!({
                "kind": serde_json::to_value(ForgeKind::GitHub).unwrap(),
                "host": "github.com",
                "path": "owner/repo",
                "number": 42,
                "url": "https://github.com/owner/repo/issues/42"
            })
        );
        assert_eq!(value["pendingIssueEntry"], json!("implement"));

        let round_tripped: TaskMeta = serde_json::from_value(value).unwrap();
        assert_eq!(round_tripped, meta);
    }

    #[test]
    fn run_without_issue_fields_loads_with_defaults() {
        let run: WorkflowRun = serde_json::from_value(sample_run_value()).unwrap();
        assert_eq!(run.issue, None);
        assert!(!run.issue_closed);
        assert_eq!(run.issue_close_error, None);
    }

    #[test]
    fn run_issue_fields_roundtrip_uses_camel_case() {
        let mut run: WorkflowRun = serde_json::from_value(sample_run_value()).unwrap();
        run.issue = Some(sample_issue());
        run.issue_closed = true;
        run.issue_close_error = Some("FORGE_COMMAND_FAILED".to_string());

        let value = serde_json::to_value(&run).unwrap();
        assert_eq!(value["issue"]["number"], json!(42));
        assert_eq!(value["issueClosed"], json!(true));
        assert_eq!(value["issueCloseError"], json!("FORGE_COMMAND_FAILED"));

        let round_tripped: WorkflowRun = serde_json::from_value(value).unwrap();
        assert_eq!(round_tripped, run);
    }

    fn sample_intake_session() -> IntakeSession {
        IntakeSession {
            schema_version: 1,
            id: "0123456789abcdef".to_string(),
            workflow_id: "wf-1".to_string(),
            kind: IntakeKind::Bug,
            provider: Provider::Claude,
            model: Some("sonnet".to_string()),
            status: IntakeStatus::Finalizing,
            messages: vec![IntakeMessage {
                id: "m1".to_string(),
                role: "user".to_string(),
                text: "It crashes".to_string(),
                draft_ids: vec!["d1".to_string()],
                at: "2026-01-01T00:00:00Z".to_string(),
            }],
            last_question: Some(IntakeQuestion {
                text: "Which OS?".to_string(),
                options: vec!["Windows".to_string(), "macOS".to_string()],
            }),
            proposal: Some(IntakeProposal {
                title: "Fix crash".to_string(),
                body: "Steps...".to_string(),
            }),
            doc_updates: vec![DocUpdateProposal {
                id: "u1".to_string(),
                path: "docs/a.md".to_string(),
                content: "new".to_string(),
                status: "pending".to_string(),
                reason: None,
            }],
            finalize: FinalizeState {
                stage: FinalizeStage::AttachmentsCommitted,
                root_task_id: Some("fedcba9876543210".to_string()),
                issue: Some(sample_issue()),
                attachment_ids: vec!["a1".to_string()],
                skip_issue: false,
                issue_creating: false,
                last_error: None,
            },
            created_at: "2026-01-01T00:00:00Z".to_string(),
            updated_at: "2026-01-01T00:00:01Z".to_string(),
        }
    }

    #[test]
    fn intake_session_roundtrip_uses_camel_case_and_snake_case_enums() {
        let session = sample_intake_session();
        let value = serde_json::to_value(&session).unwrap();

        assert_eq!(value["schemaVersion"], json!(1));
        assert_eq!(value["workflowId"], json!("wf-1"));
        assert_eq!(value["kind"], json!("bug"));
        assert_eq!(value["status"], json!("finalizing"));
        assert_eq!(value["messages"][0]["draftIds"], json!(["d1"]));
        assert_eq!(
            value["lastQuestion"]["options"],
            json!(["Windows", "macOS"])
        );
        assert_eq!(value["docUpdates"][0]["status"], json!("pending"));
        assert_eq!(value["finalize"]["stage"], json!("attachments_committed"));
        assert_eq!(value["finalize"]["rootTaskId"], json!("fedcba9876543210"));
        assert_eq!(value["finalize"]["attachmentIds"], json!(["a1"]));
        assert_eq!(value["finalize"]["skipIssue"], json!(false));
        assert_eq!(value["finalize"]["issueCreating"], json!(false));
        assert_eq!(value["finalize"]["lastError"], json!(null));
        assert_eq!(value["createdAt"], json!("2026-01-01T00:00:00Z"));

        let round_tripped: IntakeSession = serde_json::from_value(value).unwrap();
        assert_eq!(round_tripped, session);

        assert_eq!(
            serde_json::to_value(IntakeKind::Feature).unwrap(),
            json!("feature")
        );
        assert_eq!(
            serde_json::to_value(IntakeStatus::Abandoned).unwrap(),
            json!("abandoned")
        );
        assert_eq!(
            serde_json::to_value(FinalizeStage::IssueCreated).unwrap(),
            json!("issue_created")
        );
        assert_eq!(
            serde_json::to_value(FinalizeStage::TaskCreated).unwrap(),
            json!("task_created")
        );
    }

    #[test]
    fn intake_session_minimal_json_loads_with_defaults() {
        let value = json!({
            "schemaVersion": 1,
            "id": "0123456789abcdef",
            "workflowId": "wf-1",
            "kind": "feature",
            "provider": "codex",
            "status": "active",
            "createdAt": "2026-01-01T00:00:00Z",
            "updatedAt": "2026-01-01T00:00:00Z"
        });

        let session: IntakeSession = serde_json::from_value(value).unwrap();
        assert_eq!(session.model, None);
        assert!(session.messages.is_empty());
        assert_eq!(session.last_question, None);
        assert_eq!(session.proposal, None);
        assert!(session.doc_updates.is_empty());
        assert_eq!(session.finalize, FinalizeState::default());
        assert_eq!(session.finalize.stage, FinalizeStage::Ready);
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
        assert_eq!(errors[0].code(), "WORKFLOW_INVALID_STAGE_ROLES");
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
        assert_eq!(errors[0].code(), "WORKFLOW_STAGE_ID_DUPLICATE");
    }

    #[test]
    fn validate_reports_review_return_to() {
        let mut workflow = valid_workflow();
        workflow.review_return_to = Role::Review;

        let errors = workflow.validate().unwrap_err();
        assert_eq!(errors, vec![ValidationError::ReviewReturnTo]);
        assert_eq!(errors[0].code(), "WORKFLOW_INVALID_REVIEW_RETURN_TO");
    }

    #[test]
    fn validate_reports_timeout_zero() {
        let mut workflow = valid_workflow();
        workflow.stages[0].timeout_minutes = 0;

        let errors = workflow.validate().unwrap_err();
        assert_eq!(errors, vec![ValidationError::Timeout("design".to_string())]);
        assert_eq!(errors[0].code(), "WORKFLOW_INVALID_TIMEOUT");
    }

    #[test]
    fn validate_reports_max_reentry_zero() {
        let mut workflow = valid_workflow();
        workflow.max_reentry_count = 0;

        let errors = workflow.validate().unwrap_err();
        assert_eq!(errors, vec![ValidationError::MaxReentry]);
        assert_eq!(errors[0].code(), "WORKFLOW_INVALID_MAX_REENTRY");
    }

    #[test]
    fn validate_reports_max_concurrent_zero() {
        let mut workflow = valid_workflow();
        workflow.max_concurrent_runs = 0;

        let errors = workflow.validate().unwrap_err();
        assert_eq!(errors, vec![ValidationError::MaxConcurrent]);
        assert_eq!(errors[0].code(), "WORKFLOW_INVALID_MAX_CONCURRENT");
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
        assert_eq!(errors[0].code(), "WORKFLOW_INVALID_APPROVAL_ROLE");
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
        assert_eq!(errors[0].code(), "WORKFLOW_INVALID_DESIGN_DOC_PATH");
    }

    #[test]
    fn validate_reports_design_doc_path_absolute() {
        let mut workflow = valid_workflow();
        workflow.design_doc_path = Some("/etc/passwd".to_string());

        let errors = workflow.validate().unwrap_err();
        assert_eq!(errors[0].code(), "WORKFLOW_INVALID_DESIGN_DOC_PATH");
    }

    #[test]
    fn validate_reports_design_doc_path_in_mdium_dir() {
        let mut workflow = valid_workflow();
        workflow.design_doc_path = Some(".mdium/secret.md".to_string());

        let errors = workflow.validate().unwrap_err();
        assert_eq!(errors[0].code(), "WORKFLOW_INVALID_DESIGN_DOC_PATH");
    }

    #[test]
    fn validate_reports_design_doc_path_git_dir_case_insensitive_slash() {
        let mut workflow = valid_workflow();
        workflow.design_doc_path = Some(".Git/config".to_string());

        let errors = workflow.validate().unwrap_err();
        assert_eq!(errors[0].code(), "WORKFLOW_INVALID_DESIGN_DOC_PATH");
    }

    #[test]
    fn validate_reports_design_doc_path_git_dir_case_insensitive_backslash() {
        let mut workflow = valid_workflow();
        workflow.design_doc_path = Some(".GIT\\hooks\\x".to_string());

        let errors = workflow.validate().unwrap_err();
        assert_eq!(errors[0].code(), "WORKFLOW_INVALID_DESIGN_DOC_PATH");
    }

    #[test]
    fn validate_reports_design_doc_path_mdium_dir_case_insensitive() {
        let mut workflow = valid_workflow();
        workflow.design_doc_path = Some(".Mdium/x.md".to_string());

        let errors = workflow.validate().unwrap_err();
        assert_eq!(errors[0].code(), "WORKFLOW_INVALID_DESIGN_DOC_PATH");
    }

    #[test]
    fn validate_reports_design_doc_path_windows_drive_absolute() {
        let mut workflow = valid_workflow();
        workflow.design_doc_path = Some("C:\\Users\\x\\doc.md".to_string());

        let errors = workflow.validate().unwrap_err();
        assert_eq!(errors[0].code(), "WORKFLOW_INVALID_DESIGN_DOC_PATH");
    }

    #[test]
    fn validate_reports_design_doc_path_unc_absolute() {
        let mut workflow = valid_workflow();
        workflow.design_doc_path = Some("\\\\server\\share\\doc.md".to_string());

        let errors = workflow.validate().unwrap_err();
        assert_eq!(errors[0].code(), "WORKFLOW_INVALID_DESIGN_DOC_PATH");
    }

    #[test]
    fn validate_reports_design_doc_path_escaping_repo_from_nested_segment() {
        let mut workflow = valid_workflow();
        workflow.design_doc_path = Some("a/../../x".to_string());

        let errors = workflow.validate().unwrap_err();
        assert_eq!(errors[0].code(), "WORKFLOW_INVALID_DESIGN_DOC_PATH");
    }

    #[test]
    fn validate_accepts_safe_nested_design_doc_path() {
        let mut workflow = valid_workflow();
        workflow.design_doc_path =
            Some("docs/designs/2026-09-25-workflow-foundation-design.md".to_string());

        assert_eq!(workflow.validate(), Ok(()));
    }

    #[test]
    fn validate_reports_name_empty() {
        let mut workflow = valid_workflow();
        workflow.name = "  ".to_string();

        let errors = workflow.validate().unwrap_err();
        assert_eq!(errors, vec![ValidationError::NameEmpty]);
        assert_eq!(errors[0].code(), "WORKFLOW_NAME_EMPTY");
    }

    #[test]
    fn validate_reports_stage_name_empty() {
        let mut workflow = valid_workflow();
        workflow.stages[0].name = "  ".to_string();

        let errors = workflow.validate().unwrap_err();
        assert_eq!(
            errors,
            vec![ValidationError::StageNameEmpty("design".to_string())]
        );
        assert_eq!(errors[0].code(), "WORKFLOW_STAGE_NAME_EMPTY");
    }

    #[test]
    fn stage_returns_matching_role() {
        let workflow = valid_workflow();
        assert_eq!(workflow.stage(Role::Implement).unwrap().id, "implement");
    }

    #[test]
    fn stage_returns_none_for_missing_role_instead_of_panicking() {
        let mut workflow = valid_workflow();
        workflow.stages.retain(|stage| stage.role != Role::Review);
        assert!(workflow.stage(Role::Review).is_none());
    }

    #[test]
    fn workflow_missing_defaulted_fields_loads_with_constraint_defaults() {
        let stage = |id: &str, role: &str| {
            json!({
                "id": id,
                "role": role,
                "name": id,
                "prompt": "p",
                "completionCriteria": "c",
                "provider": "codex"
            })
        };
        let value = json!({
            "id": "wf-1",
            "name": "Hand written",
            "enabled": true,
            "archived": false,
            "stages": [
                stage("design", "design"),
                stage("implement", "implement"),
                stage("review", "review")
            ],
            "issueTracking": "off"
        });

        let workflow: Workflow = serde_json::from_value(value).unwrap();
        assert_eq!(workflow.review_return_to, Role::Design);
        assert_eq!(workflow.max_reentry_count, 5);
        assert_eq!(workflow.max_concurrent_runs, 1);
        assert_eq!(workflow.design_doc_path, None);
        for stage in &workflow.stages {
            assert_eq!(stage.model, None);
            assert!(!stage.requires_approval);
            assert_eq!(stage.timeout_minutes, 60);
        }
        assert_eq!(workflow.validate(), Ok(()));
    }
}
