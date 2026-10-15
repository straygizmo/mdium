//! The builtin "standard" workflow template: a design -> implement -> review
//! pipeline with self-contained English stage prompts.
//!
//! The prompts here are only the stage-specific part of what an agent sees;
//! `prompt.rs` wraps them with the task, requirement, previous-stage input,
//! user instructions, review diff and the frontmatter output contract. They
//! therefore do not restate the output contract, and stay in English
//! (user-facing names and descriptions are localized by the UI instead).

use crate::workflow::fsutil::new_id;
use crate::workflow::model::{
    IssueTracking, Provider, Role, Stage, Workflow, DEFAULT_MAX_CONCURRENT_RUNS,
    DEFAULT_MAX_REENTRY_COUNT, DEFAULT_TIMEOUT_MINUTES,
};

/// Suggested `Workflow::design_doc_path` offered by the UI. `{date}` and
/// `{slug}` are rendered when the design document is written.
pub const DEFAULT_DESIGN_DOC_PATH: &str = "docs/designs/{date}-{slug}-design.md";

pub use flow_core::prompts::{DESIGN_PROMPT, DESIGN_CRITERIA, IMPLEMENT_PROMPT, IMPLEMENT_CRITERIA, REVIEW_PROMPT, REVIEW_CRITERIA};

/// Instructions for a requirement intake session collecting a feature
/// request (read-only). `intake.rs` appends the conversation, the attached
/// files and [`INTAKE_OUTPUT_CONTRACT`].
pub const INTAKE_FEATURE_PROMPT: &str = r###"You are a requirements analyst. You help a user turn a feature idea into a clear, complete requirement document for this software project. The document is later handed to an automated design -> implement -> review pipeline as its only description of the work, so it must be understandable without this conversation.

Your working directory is the project's repository. You may read files and run read-only commands (listing, searching, viewing history) to ground your questions in the actual code. Do not modify, create or delete any file, and do not run commands that change the repository or its git state.

How to work:
1. Read the conversation so far. The user's messages and any attached files describe what they want.
2. Explore the repository as needed to understand the relevant code, terminology and existing behavior, so that your questions are specific and you never ask what the code already answers.
3. If something important is still unclear, ask exactly one question: the single most important open point. Offer up to six short answer options when the likely answers are predictable. Never ask several questions at once.
4. When the goal, the constraints and the acceptance criteria are clear enough to build and verify the feature, write a proposal: the full requirement document, with exactly these sections:

## Goal
What the feature achieves and for whom, and what is explicitly out of scope.

## Constraints
Technical, compatibility, performance, security or user-experience limits the solution must respect, grounded in the existing code.

## Acceptance criteria
A list of concrete, testable statements that must all hold when the work is done.

## Open questions
Anything still undecided that the design stage has to resolve; write "None" if there is nothing.

Never propose code changes, patches or an implementation plan: describe what is required, not how to build it. You may propose updates to documentation files (for example CONTEXT.md or a glossary) when the conversation established terminology or context worth recording; never propose changes to source code, configuration, build, test or tooling files."###;

/// Instructions for a requirement intake session collecting a bug report
/// (read-only). `intake.rs` appends the conversation, the attached files and
/// [`INTAKE_OUTPUT_CONTRACT`].
pub const INTAKE_BUG_PROMPT: &str = r###"You are a support engineer. You help a user turn a problem they ran into into a clear, complete bug report for this software project. The report is later handed to an automated design -> implement -> review pipeline as its only description of the work, so it must be understandable without this conversation.

Your working directory is the project's repository. You may read files and run read-only commands (listing, searching, viewing history) to ground your questions in the actual code. Do not modify, create or delete any file, and do not run commands that change the repository or its git state.

How to work:
1. Read the conversation so far. The user's messages and any attached files (screenshots, logs) describe what went wrong.
2. Explore the repository as needed to find the code involved and to understand the intended behavior, so that your questions are specific and you never ask what the code already answers.
3. If something important is still unclear (for example how to reproduce the problem, what was expected, or in which environment it happens), ask exactly one question: the single most important open point. Offer up to six short answer options when the likely answers are predictable. Never ask several questions at once.
4. When the problem is clear enough to reproduce and to verify a fix, write a proposal: the full bug report, with exactly these sections:

## Symptoms
What the user observes, including error messages quoted exactly.

## Expected
What should happen instead.

## Actual
What happens now.

## Steps to reproduce
A numbered list of concrete steps that trigger the problem.

## Environment
Operating system, versions, configuration and any other context that matters; write "Unknown" for what the user could not tell.

## Open questions
Anything still undecided, such as suspected causes you could not confirm; write "None" if there is nothing.

Never propose code changes, patches or a fix: describe the problem, not how to solve it. You may propose updates to documentation files (for example CONTEXT.md or a known-issues page) when the conversation established context worth recording; never propose changes to source code, configuration, build, test or tooling files."###;

/// The intake output contract, matching what
/// `intake::parse_intake_output` accepts.
pub const INTAKE_OUTPUT_CONTRACT: &str = r###"## Output contract

Your final response must start with a YAML frontmatter block, followed by a Markdown body. The first line is `---`, and the block is closed by a line containing only `---`. Use exactly one of these two forms.

To ask a question:
- `type: question`
- `question:` the single question to ask, in one sentence.
- `options:` optional list of at most 6 short answer choices. Quote each choice.
- The body gives brief context for the question: what you found and why it matters.

To propose the requirement document:
- `type: proposal`
- `title:` a short title of at most 100 characters.
- `doc_updates:` optional list of documentation updates. Each entry has `path` and `content` (the complete new content of that file).
- The body is the full requirement document with the sections listed above.

Rules for `doc_updates` paths (anything else is rejected):
- A repository-relative path with forward slashes, without `.` or `..` components, for example `CONTEXT.md` or `docs/glossary.md`.
- The file extension is one of: .md, .markdown, .mdx, .txt, .rst, .adoc.
- Never under `.git` or `.mdium`.
- Never an agent instruction or configuration file or directory: `AGENTS.md`, `CLAUDE.md`, `.claude/`, `.codex/`, `.copilot/`, `.opencode/`, `opencode.json`, `opencode.jsonc`, `.mcp.json`, `.vscode/settings.json`, `.vscode/tasks.json`, `.vscode/mcp.json`.
- Never CI, hook or environment configuration: `.github/`, `.husky/`, `.githooks/`, `.devcontainer/`, `.gitmodules`.

Do not wrap the response in a code fence. The two examples below are each shown between an `[example start]` line and an `[example end]` line; those two marker lines are not part of the response.

[example start]
---
type: question
question: Should the export include archived items?
options:
  - "Yes, always"
  - "No, never"
  - "Only when the user opts in"
---

The export code in `src/export.rs` currently skips archived items.
[example end]

[example start]
---
type: proposal
title: Export archived items on request
doc_updates:
  - path: CONTEXT.md
    content: |
      # Context

      An archived item is hidden from lists but kept on disk.
---

## Goal

The full requirement document.
[example end]"###;

/// Builds a new builtin "standard" workflow named `name` (the caller passes
/// the localized name) whose three stages all use `provider`. It starts
/// disabled so the user can review it before it picks up tasks.
pub fn standard_workflow(name: &str, provider: Provider) -> Workflow {
    let stage = |role: Role, stage_name: &str, prompt: &str, criteria: &str| Stage {
        id: new_id(),
        role,
        name: stage_name.to_string(),
        prompt: prompt.to_string(),
        completion_criteria: criteria.to_string(),
        provider,
        model: None,
        requires_approval: false,
        timeout_minutes: DEFAULT_TIMEOUT_MINUTES,
    };

    Workflow {
        id: new_id(),
        name: name.to_string(),
        enabled: false,
        archived: false,
        stages: vec![
            stage(Role::Design, "design", DESIGN_PROMPT, DESIGN_CRITERIA),
            stage(
                Role::Implement,
                "implement",
                IMPLEMENT_PROMPT,
                IMPLEMENT_CRITERIA,
            ),
            stage(Role::Review, "review", REVIEW_PROMPT, REVIEW_CRITERIA),
        ],
        review_return_to: Role::Design,
        max_reentry_count: DEFAULT_MAX_REENTRY_COUNT,
        max_concurrent_runs: DEFAULT_MAX_CONCURRENT_RUNS,
        design_doc_path: None,
        issue_tracking: IssueTracking::Off,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workflow::fsutil::is_valid_id;
    use crate::workflow::model::{IssueTracking, Role};

    #[test]
    fn standard_workflow_is_valid() {
        let workflow = standard_workflow("x", Provider::Codex);
        assert_eq!(workflow.validate(), Ok(()));
    }

    #[test]
    fn standard_workflow_has_roles_in_order_with_role_names() {
        let workflow = standard_workflow("x", Provider::Codex);
        let roles: Vec<Role> = workflow.stages.iter().map(|s| s.role).collect();
        assert_eq!(roles, vec![Role::Design, Role::Implement, Role::Review]);
        let names: Vec<&str> = workflow.stages.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, vec!["design", "implement", "review"]);
    }

    #[test]
    fn standard_workflow_uses_given_name_provider_and_defaults() {
        let workflow = standard_workflow("My flow", Provider::Opencode);
        assert_eq!(workflow.name, "My flow");
        assert!(!workflow.enabled);
        assert!(!workflow.archived);
        assert_eq!(workflow.review_return_to, Role::Design);
        assert_eq!(workflow.max_reentry_count, 5);
        assert_eq!(workflow.max_concurrent_runs, 1);
        assert_eq!(workflow.design_doc_path, None);
        assert_eq!(workflow.issue_tracking, IssueTracking::Off);
        for stage in &workflow.stages {
            assert_eq!(stage.provider, Provider::Opencode);
            assert_eq!(stage.model, None);
            assert!(!stage.requires_approval);
            assert_eq!(stage.timeout_minutes, 60);
        }
    }

    #[test]
    fn standard_workflow_uses_the_builtin_prompts() {
        let workflow = standard_workflow("x", Provider::Claude);
        let texts: Vec<(&str, &str)> = workflow
            .stages
            .iter()
            .map(|s| (s.prompt.as_str(), s.completion_criteria.as_str()))
            .collect();
        assert_eq!(
            texts,
            vec![
                (DESIGN_PROMPT, DESIGN_CRITERIA),
                (IMPLEMENT_PROMPT, IMPLEMENT_CRITERIA),
                (REVIEW_PROMPT, REVIEW_CRITERIA),
            ]
        );
    }

    #[test]
    fn prompts_are_non_empty_ascii() {
        for text in [
            DESIGN_PROMPT,
            DESIGN_CRITERIA,
            IMPLEMENT_PROMPT,
            IMPLEMENT_CRITERIA,
            REVIEW_PROMPT,
            REVIEW_CRITERIA,
            DEFAULT_DESIGN_DOC_PATH,
            INTAKE_FEATURE_PROMPT,
            INTAKE_BUG_PROMPT,
            INTAKE_OUTPUT_CONTRACT,
        ] {
            assert!(!text.trim().is_empty());
            assert!(text.is_ascii(), "non-ASCII text in: {text}");
        }
    }

    #[test]
    fn ids_are_valid_and_distinct() {
        let workflow = standard_workflow("x", Provider::Codex);
        let mut ids = vec![workflow.id.as_str()];
        ids.extend(workflow.stages.iter().map(|s| s.id.as_str()));
        for id in &ids {
            assert!(is_valid_id(id), "invalid id {id}");
        }
        let mut unique = ids.clone();
        unique.sort_unstable();
        unique.dedup();
        assert_eq!(unique.len(), ids.len());

        let other = standard_workflow("x", Provider::Codex);
        assert_ne!(other.id, workflow.id);
    }

    #[test]
    fn default_design_doc_path_is_accepted_by_validation() {
        let mut workflow = standard_workflow("x", Provider::Codex);
        workflow.design_doc_path = Some(DEFAULT_DESIGN_DOC_PATH.to_string());
        assert_eq!(workflow.validate(), Ok(()));
    }
}
