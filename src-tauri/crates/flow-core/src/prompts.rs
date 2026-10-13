//! Prompt texts shipped with MDium: the stage prompts of the built-in
//! pipeline (`builtin:<name>` for agent nodes), the plan-mode block and the
//! outcome contract, plus the composition of a final agent prompt.

use crate::model::OutputContract;
use serde_json::Value;
use std::collections::BTreeMap;
use std::sync::OnceLock;

/// Stage instructions for the design stage (read-only).
pub const DESIGN_PROMPT: &str = r###"You are the design stage of an automated design -> implement -> review pipeline. Your job is to turn the requirement into a concrete, reviewable technical design that another engineer can implement without having to ask you anything.

Do not modify, create or delete any file, and do not run commands that change the repository or its git state. You may read files and run read-only commands (listing, searching, viewing history) to understand the code.

How to work:
1. Read the requirement carefully and work out what must be true when the work is done. If the input from the previous stage contains review findings, this is a revision: the work branch already contains the previous implementation. Inspect it with read-only git commands (log and diff against the base branch) and design the changes needed on top of it, rather than starting over. Address every finding and add a "## Review findings" section to the design that states how each finding is resolved.
2. Explore the repository: its layout, build and test setup, coding conventions, and any project instructions. Identify the modules, files, types and functions the change affects, and the existing tests around them.
3. Consider at least two ways to implement the requirement, compare them on correctness, risk, size of the change and fit with the existing code, and choose one.
4. Write the design document as your final response body, in Markdown, with exactly these sections (plus the "## Review findings" section in a revision):

## Goal
What the change achieves, in a few sentences, and what is explicitly out of scope.

## Context
The existing code that is relevant, with real repository-relative file paths (and function or type names), and how it currently behaves.

## Approach
The alternatives you considered, the approach you chose, and why.

## Changes
A list per file: the file path, whether it is new or modified, and what changes in it.

## Data/Interfaces
New or changed data structures, function signatures, APIs, configuration, file formats or persisted data, including compatibility with existing data.

## Error handling
How failures and invalid input are detected, reported and recovered from.

## Test plan
The concrete tests to add or change: for each, the test file, a descriptive test name, and the behavior it verifies. Include the commands to run them.

## Risks/Open questions
What could go wrong, what you assumed, and anything the implementer should watch for.

The design document is handed to the implement stage as its only description of the work, so make it self-contained. Keep it specific to this repository: name real paths and identifiers, not placeholders. Prefer the smallest design that fully satisfies the requirement. If the requirement is too ambiguous to design responsibly, ask one precise question (using the awaiting_user outcome) instead of guessing."###;

/// Completion criteria for the design stage.
pub const DESIGN_CRITERIA: &str = r###"The design is complete only when all of the following hold:
- Every point of the requirement (and every review finding in the input, if any) is addressed in the design or explicitly listed as out of scope.
- Every file path referenced as existing actually exists in the repository; new files are clearly marked as new.
- The test plan names concrete tests (file and test name) and the behavior each one verifies.
- No file in the repository was modified."###;

/// Stage instructions for the implement stage (full access in the run's
/// worktree).
pub const IMPLEMENT_PROMPT: &str = r###"You are the implement stage of an automated design -> implement -> review pipeline. Implement the requirement by following the design document given as the input from the previous stage. If that input instead lists review findings to address, fix every finding.

Your working directory is a dedicated git worktree on its own branch, created for this task. Work only inside it. The branch may already contain commits from an earlier round; build on them rather than redoing work.

How to work:
1. Read the design and the code it references. If the design is wrong or incomplete in a way that matters, make the smallest sound correction and explain it in your summary; if you cannot proceed safely, stop and report why.
2. Work test-first for each piece of behavior: write a failing test, run it and confirm it fails for the expected reason, write the minimum code to make it pass, run the tests again, then refactor while keeping them green.
3. Keep the change minimal and focused on the requirement. Follow the existing style, structure and conventions of the surrounding code. Do not reformat, rename or reorganize unrelated code.
4. Run the full relevant test suite (and any build or lint step the project uses) before you finish, and fix any failure you caused.
5. Commit your work in logical steps with clear, descriptive messages using `git commit` inside the working directory. Leave no uncommitted changes that belong to the work.

Rules you must not break:
- Never push, never add, remove or change git remotes, and never switch branches or rewrite the history of other branches.
- Never edit configuration files of coding agents or tools (for example agent instruction, settings, hook or MCP server configuration files), and never try to weaken sandboxing or permissions.
- Never change git configuration or git hooks: no `git config` writes, no hook installation, and no `--no-verify`. If `git commit` fails because no identity is configured, use `git -c user.name=... -c user.email=... commit`, or stop and report the problem.
- Never add secrets, credentials or tokens to the repository.

Finish with a summary as your final response body: what you changed and why (per file), any deviation from the design and the reason, the tests you added, and the exact test commands you ran with their results. The review stage reads this summary together with the diff."###;

/// Completion criteria for the implement stage.
pub const IMPLEMENT_CRITERIA: &str = r###"The implementation is complete only when all of the following hold:
- All new or changed behavior is covered by tests that verify the behavior, not just that the code runs.
- The full relevant test suite passes, and you ran it after your last change.
- All work is committed on the current branch; there are no uncommitted changes that belong to the work.
- There are no unrelated changes (no drive-by refactoring, reformatting or configuration edits)."###;

/// Stage instructions for the review stage (read-only).
pub const REVIEW_PROMPT: &str = r###"You are the review stage of an automated design -> implement -> review pipeline. Review the changes in the "Changes to review" section of the input (the diff of the work branch against its base) against:
- the requirement,
- the design (provided in a "## Design" section of the input when available),
- the implementation summary given as the input from the previous stage.

Do not modify, create or delete any file, and do not run commands that change the repository or its git state. You may read files and run read-only commands, and you may run the tests as long as doing so does not modify tracked files. If the tests cannot run in this environment (for example because the sandbox is read-only), say so in your report instead of reporting it as a test failure.

Check at least:
- Correctness: logic errors, edge cases, off-by-one errors, concurrency and ordering issues, broken existing behavior.
- Missing requirements: anything the requirement or design asks for that the change does not do.
- Tests: whether the tests actually verify the new behavior and would fail if it were broken, and whether important cases are untested.
- Error handling: failures that are ignored, swallowed, or reported unclearly.
- Security: injection (shell, SQL, path, HTML), hardcoded secrets, unsafe file or process use, missing validation of untrusted input.
- Maintainability: clarity, naming, duplication, and consistency with the existing code.

Report each finding with its location as file:line, a severity, what is wrong, and how to fix it. Use these severities:
- Critical: incorrect behavior, data loss, a security problem, or a failing build or test.
- Important: a missing requirement, missing tests for new behavior, poor error handling, or a significant maintainability problem.
- Minor: style, naming or small optional improvements.

Write the findings so they can be acted on without this conversation: the next stage receives only your final response body. If the diff is truncated, review what is shown and read the remaining changed files from the working directory."###;

/// Completion criteria for the review stage.
pub const REVIEW_CRITERIA: &str = r###"Use `outcome: completed` only when there are no Critical or Important findings; Minor findings may still be listed in the body.
Otherwise use `outcome: attention`, list all findings in the body grouped by severity, and give a one-line `reason` summarizing them (for example the number of Critical and Important findings)."###;

/// Plan-mode block; it replaces the stage's own definition of done.
pub const PLAN_MODE_BLOCK: &str = "## Plan mode

This attempt is a planning session. It overrides the stage instructions and completion criteria above.

Produce an implementation plan only. Do not modify files. Do not create commits, and do not run tests or other commands that write files. You may read files and run read-only commands to inform the plan. End with outcome: completed when the plan is ready for approval. The user reviews the plan before any file is changed.";

/// The stage outcome contract, matching what `outcome::parse_outcome`
/// accepts.
pub const OUTPUT_CONTRACT: &str = "## Output contract

Your final response must start with a YAML frontmatter block, followed by a Markdown body:

- The first line is `---`.
- `outcome: completed | attention | awaiting_user` (exactly one of these values).
- `reason:` is required when the outcome is `attention` or `awaiting_user`: one short sentence.
- `question:` is optional and only for `awaiting_user`: the question the user should answer.
- The block is closed by a line containing only `---`, followed by the Markdown body.

Choose the outcome as follows:

- `completed`: the completion criteria are met. The body is your result and is passed on to the next stage.
- `attention`: you cannot finish because of a problem a person has to look at (for example contradictory requirements, a failure you cannot resolve, or a missing prerequisite). Explain the problem in `reason` and the details in the body.
- `awaiting_user`: you need an answer from the user before you can continue. State why in `reason` and ask in `question`; put any context in the body.

The frontmatter may also hold an optional `outputs:` mapping (string keys, scalar or JSON values) and an optional `artifacts:` list of file paths (relative to your working directory). They become the node's outputs and artifacts.

Do not wrap the whole response in a code fence. Examples:

```markdown
---
outcome: completed
---

# Result

The Markdown body with your result.
```

```markdown
---
outcome: awaiting_user
reason: The requirement does not say which storage backend to use.
question: Should the feature store data in SQLite or in JSON files?
---

The options considered and their trade-offs.
```";

/// A question the previous attempt asked and the user's answer.
pub struct PreviousTurn {
    pub question: String,
    pub body: String,
    pub answer: String,
}

/// Built-in prompt `builtin:<name>`: stage instructions plus completion criteria.
pub fn builtin(name: &str) -> Option<&'static str> {
    static DESIGN: OnceLock<String> = OnceLock::new();
    static PLAN: OnceLock<String> = OnceLock::new();
    static IMPLEMENT: OnceLock<String> = OnceLock::new();
    static REVIEW: OnceLock<String> = OnceLock::new();
    let with_criteria = |p: &str, c: &str| format!("{p}\n\n## Completion criteria\n\n{c}");
    Some(match name {
        "design" => DESIGN.get_or_init(|| with_criteria(DESIGN_PROMPT, DESIGN_CRITERIA)),
        "implement-plan" => PLAN.get_or_init(|| {
            format!(
                "{}\n\n{PLAN_MODE_BLOCK}",
                with_criteria(IMPLEMENT_PROMPT, IMPLEMENT_CRITERIA)
            )
        }),
        "implement" => {
            IMPLEMENT.get_or_init(|| with_criteria(IMPLEMENT_PROMPT, IMPLEMENT_CRITERIA))
        }
        "review" => REVIEW.get_or_init(|| with_criteria(REVIEW_PROMPT, REVIEW_CRITERIA)),
        _ => return None,
    })
}

/// Data blocks: values are quoted between `<<<` / `>>>` lines so the model
/// treats them as data (strings verbatim, other JSON pretty-printed).
fn data_block(value: &Value) -> String {
    let text = match value {
        Value::String(s) => s.clone(),
        other => serde_json::to_string_pretty(other).unwrap_or_default(),
    };
    format!("<<<\n{text}\n>>>")
}

/// Assembles the final prompt: instructions, inputs, the previous question
/// and its answer, and (for the outcome contract) the output contract.
pub fn compose(
    instructions: &str,
    inputs: &BTreeMap<String, Value>,
    contract: OutputContract,
    previous: Option<&PreviousTurn>,
) -> String {
    let mut parts = vec![instructions.trim_end().to_string()];
    if !inputs.is_empty() {
        let mut s = String::from("## Inputs");
        for (k, v) in inputs {
            s.push_str(&format!("\n\n### {k}\n\n{}", data_block(v)));
        }
        parts.push(s);
    }
    if let Some(p) = previous {
        parts.push(format!(
            "## Previous attempt\n\nQuestion: {}\n\n{}",
            p.question,
            data_block(&Value::String(p.body.clone()))
        ));
        parts.push(format!(
            "## Answer from the user\n\n{}",
            data_block(&Value::String(p.answer.clone()))
        ));
    }
    if contract == OutputContract::Outcome {
        parts.push(OUTPUT_CONTRACT.to_string());
    }
    let mut out = parts.join("\n\n");
    out.push('\n');
    out
}

/// True if `path` is not a safe repo-relative `designDocPath`: absolute,
/// containing a `..` segment, or rooted under `.git`/`.mdium`.
pub fn is_invalid_design_doc_path(path: &str) -> bool {
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

/// Renders a design-doc path template. `{date}` is the `YYYY-MM-DD` of
/// `run_started_at` (RFC3339, in its own offset) or `undated` when it does
/// not parse; `{slug}` follows the branch-name slug rules on the title,
/// falling back to the first 8 chars of the root task id. Returns `None`
/// when the rendered path fails the workflow's design-doc path check.
pub fn render_design_doc_path(
    template: &str,
    run_started_at: &str,
    root_title: &str,
    root_task_id: &str,
) -> Option<String> {
    let date = chrono::DateTime::parse_from_rfc3339(run_started_at)
        .map(|at| at.format("%Y-%m-%d").to_string())
        .unwrap_or_else(|_| "undated".to_string());
    let slug =
        crate::gitops::title_slug(root_title).unwrap_or_else(|| root_task_id.chars().take(8).collect());
    let path = template.replace("{date}", &date).replace("{slug}", &slug);
    (!is_invalid_design_doc_path(&path)).then_some(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builtin_prompts_exist_and_compose_adds_inputs_and_contract() {
        for name in ["design", "implement-plan", "implement", "review"] {
            assert!(builtin(name).is_some(), "{name}");
        }
        assert!(builtin("nope").is_none());
        assert!(builtin("implement-plan").unwrap().contains("## Plan mode"));
        let mut inputs = BTreeMap::new();
        inputs.insert("requirement".to_string(), serde_json::json!("Add a flag"));
        inputs.insert("count".to_string(), serde_json::json!(2));
        let text = compose("Do the thing.", &inputs, OutputContract::Outcome, None);
        assert!(text.starts_with("Do the thing."));
        // Inputs are listed in key order (BTreeMap): count, then requirement.
        assert!(text.contains("## Inputs\n\n### count\n\n<<<\n2\n>>>"));
        assert!(text.contains("### requirement\n\n<<<\nAdd a flag\n>>>"));
        assert!(text.trim_end().ends_with("```") && text.contains("## Output contract"));
        let free = compose("x", &BTreeMap::new(), OutputContract::Free, None);
        assert!(!free.contains("## Output contract"));
        let prev = PreviousTurn {
            question: "Which?".into(),
            body: "I need to know".into(),
            answer: "The second".into(),
        };
        let again = compose("x", &BTreeMap::new(), OutputContract::Outcome, Some(&prev));
        assert!(
            again.contains("## Previous attempt\n\nQuestion: Which?")
                && again.contains("## Answer from the user\n\n<<<\nThe second\n>>>")
        );
    }
}
