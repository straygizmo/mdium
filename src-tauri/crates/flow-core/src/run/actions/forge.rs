//! The forge actions: `mdium/design-doc-commit`, `mdium/issue-entry` and
//! `mdium/issue-close`. Thin adapters over `gitops`, `issue_sync` and the
//! forge CLI of the context.

use super::{
    git_failed, input_invalid, required_str, worktree_of, ActionContext, ActionEnd,
    FLOW_ACTION_FAILED,
};
use crate::forge::{self, ForgeError, ForgeRepo};
use crate::fsutil;
use crate::gitops;
use crate::issue_sync::{self, EntryKind, PostOutcome};
use crate::prompts::render_design_doc_path;
use crate::run::model::Reason;
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::{Component, Path, PathBuf};

/// `FLOW_ACTION_FAILED` code when the project has no forge remote.
const FORGE_NOT_DETECTED: &str = "FORGE_NOT_DETECTED";

/// `FLOW_ACTION_FAILED` carrying a forge failure.
fn forge_failed(err: ForgeError) -> Reason {
    Reason::new(FLOW_ACTION_FAILED)
        .with("code", err.code())
        .with("message", err.to_string())
}

/// The forge repository behind the project's `origin`.
fn detect_repo(ctx: &ActionContext) -> Result<ForgeRepo, Reason> {
    forge::detect(&ctx.project_root, &*ctx.forge)
        .map_err(forge_failed)?
        .ok_or_else(|| {
            Reason::new(FLOW_ACTION_FAILED)
                .with("code", FORGE_NOT_DETECTED)
                .with("message", "no forge remote detected")
        })
}

/// The `issue` input: an Issue number given as a string or a number.
fn issue_number(with: &BTreeMap<String, Value>) -> Result<u64, Reason> {
    const KEY: &str = "issue";
    let parsed = match with.get(KEY) {
        None | Some(Value::Null) => return Err(input_invalid(KEY, "missing")),
        Some(Value::String(text)) => text.trim().trim_start_matches('#').parse::<u64>().ok(),
        Some(Value::Number(number)) => number.as_u64(),
        Some(_) => return Err(input_invalid(KEY, "not-a-string")),
    };
    parsed
        .filter(|number| *number > 0)
        .ok_or_else(|| input_invalid(KEY, "not-an-issue-number"))
}

/// `mdium/design-doc-commit` `{ worktree, docPath, title, body }` →
/// `{ path, commit }`: writes the design document into the worktree and
/// commits exactly that file.
pub(super) fn design_doc_commit(
    with: &BTreeMap<String, Value>,
    ctx: &ActionContext,
) -> Result<ActionEnd, Reason> {
    let info = worktree_of(with)?;
    let template = required_str(with, "docPath")?;
    let title = required_str(with, "title")?;
    let body = required_str(with, "body")?;
    let rel = render_design_doc_path(&template, &fsutil::now(), &title, &ctx.run_id)
        .ok_or_else(|| input_invalid("docPath", "unsafe-path"))?;
    // Validate the worktree link before writing anything into it.
    gitops::validate_worktree(&ctx.worktree_base, &info).map_err(git_failed)?;
    let target = safe_worktree_file(Path::new(&info.path), &rel)
        .ok_or_else(|| input_invalid("docPath", "unsafe-path"))?;
    fsutil::atomic_write(&target, body.as_bytes()).map_err(|err| {
        Reason::new(FLOW_ACTION_FAILED)
            .with("code", "IO_ERROR")
            .with("message", err.to_string())
    })?;
    let title = title.split_whitespace().collect::<Vec<_>>().join(" ");
    let commit = gitops::commit_paths_in(
        &ctx.worktree_base,
        &info,
        &[rel.as_str()],
        &format!("docs: design for {title}"),
    )
    .map_err(git_failed)?;
    // No commit means the file was already committed with this content: the
    // current head is the document's commit.
    let commit = match commit {
        Some(hash) => hash,
        None => gitops::worktree_git(Path::new(&info.path), &["rev-parse", "HEAD"])
            .map_err(git_failed)?
            .trim()
            .to_string(),
    };
    Ok(ActionEnd::done(BTreeMap::from([
        ("path".to_string(), Value::String(rel)),
        ("commit".to_string(), Value::String(commit)),
    ])))
}

/// `mdium/issue-entry` `{ issue, entry, body, returned?, worktree? }` → `{ posted }`.
/// The entry's marker prevents a duplicate comment on a rerun.
pub(super) fn issue_entry(
    with: &BTreeMap<String, Value>,
    ctx: &ActionContext,
) -> Result<ActionEnd, Reason> {
    let number = issue_number(with)?;
    let kind = match required_str(with, "entry")?.as_str() {
        "design" => EntryKind::Design,
        "implement" => EntryKind::Implement,
        "review" => EntryKind::Review,
        _ => return Err(input_invalid("entry", "unknown-entry")),
    };
    let markdown = required_str(with, "body")?;
    let returned = super::optional_bool(with, "returned")?;
    // An implement entry with a worktree lists its branch and commits.
    let worktree = match with.get("worktree") {
        None | Some(Value::Null) => None,
        Some(_) => Some(worktree_of(with)?),
    };
    let entry = issue_sync::entry_id(&ctx.run_id, &ctx.node_id);
    let body = match kind {
        EntryKind::Design => issue_sync::design_body(&markdown, &entry),
        EntryKind::Review => issue_sync::review_body(&markdown, returned, &entry),
        EntryKind::Implement => match &worktree {
            Some(info) => {
                let commits = gitops::commits_since_base_in(&ctx.worktree_base, info).map_err(git_failed)?;
                issue_sync::implement_body(&markdown, &info.branch, &commits, &entry)
            }
            // Without a worktree there is no branch or commit list: the text
            // is the summary.
            None => issue_sync::implement_body(&markdown, "", &[], &entry),
        },
    };
    let repo = detect_repo(ctx)?;
    let outcome = issue_sync::post_entry(&*ctx.forge, &repo, number, &body, &entry)
        .map_err(forge_failed)?;
    Ok(ActionEnd::done(BTreeMap::from([(
        "posted".to_string(),
        Value::Bool(outcome == PostOutcome::Posted),
    )])))
}

/// `mdium/issue-close` `{ issue }` → `{ closed: true }`.
pub(super) fn issue_close(
    with: &BTreeMap<String, Value>,
    ctx: &ActionContext,
) -> Result<ActionEnd, Reason> {
    let number = issue_number(with)?;
    let repo = detect_repo(ctx)?;
    ctx.forge.close_issue(&repo, number).map_err(forge_failed)?;
    Ok(ActionEnd::done(BTreeMap::from([(
        "closed".to_string(),
        Value::Bool(true),
    )])))
}

/// `<root>/<rel>` if nothing on the way there is a symlink/junction and the
/// target is either missing or a regular file, so a write cannot be
/// redirected outside the worktree or replace a directory.
fn safe_worktree_file(root: &Path, rel: &str) -> Option<PathBuf> {
    let mut path = root.to_path_buf();
    let components: Vec<Component> = Path::new(rel).components().collect();
    for (index, component) in components.iter().enumerate() {
        let Component::Normal(name) = component else {
            return None;
        };
        path.push(name);
        let meta = match std::fs::symlink_metadata(&path) {
            Ok(meta) => meta,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                return Some(path_rest(path, &components[index + 1..]))
            }
            Err(_) => return None,
        };
        if meta.file_type().is_symlink() || is_reparse_point(&meta) {
            return None;
        }
        let last = index + 1 == components.len();
        if (last && !meta.is_file()) || (!last && !meta.is_dir()) {
            return None;
        }
    }
    Some(path)
}

/// `path` extended by the remaining (not yet existing) components.
fn path_rest(mut path: PathBuf, rest: &[Component]) -> PathBuf {
    for component in rest {
        path.push(component);
    }
    path
}

#[cfg(windows)]
fn is_reparse_point(meta: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn is_reparse_point(_meta: &std::fs::Metadata) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::super::*;
    use crate::forge::{FakeForge, ForgeCall};
    use crate::gitops::{self, test_support::{Fixture, TASK_ID}};
    use crate::run::process::AttachedLauncher;
    use serde_json::json;
    use std::path::{Path, PathBuf};
    use std::sync::Arc;
    use std::time::Duration;

    fn ctx(root: &Path, base: &Path) -> ActionContext {
        ActionContext {
            project_root: root.to_path_buf(),
            run_id: TASK_ID.into(),
            run_dir: root.join(".mdium/flow-runs/run1"),
            node_dir: root.join(".mdium/flow-runs/run1/nodes/a/1"),
            node_id: "a".into(),
            project: None,
            project_sha256: None,
            forge: Arc::new(FakeForge::default()),
            launcher: Arc::new(AttachedLauncher),
            worktree_base: base.to_path_buf(),
            poll: Duration::from_millis(20),
            acknowledged: None,
            progress: Box::new(|_| {}),
        }
    }

    fn with(value: Value) -> BTreeMap<String, Value> {
        serde_json::from_value(value).unwrap()
    }

    fn object(map: BTreeMap<String, Value>) -> Value {
        Value::Object(map.into_iter().collect())
    }

    #[test]
    fn design_doc_commit_writes_and_commits_in_the_worktree() {
        let repo = Fixture::new();
        let base = tempfile::tempdir().unwrap();
        let c = ctx(repo.root(), base.path());
        let ActionEnd::Done { outputs: wt, .. } = run_action("mdium/git-worktree-create", &with(json!({ "title": "My Feature" })), &c) else { panic!() };
        let wt = object(wt);
        let ActionEnd::Done { outputs, .. } = run_action(
            "mdium/design-doc-commit",
            &with(json!({ "worktree": wt.clone(), "docPath": "docs/designs/{date}-{slug}-design.md", "title": "My Feature", "body": "# Design\n" })),
            &c,
        ) else { panic!() };
        let rel = outputs["path"].as_str().unwrap();
        assert!(rel.starts_with("docs/designs/") && rel.ends_with("-my-feature-design.md"));
        let path = PathBuf::from(wt["path"].as_str().unwrap()).join(rel);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "# Design\n");
        assert!(gitops::git(path.parent().unwrap(), &["log", "-1", "--format=%s"]).unwrap().contains("My Feature"));
        for bad in ["../x.md", ".git/x.md", ".mdium/x.md"] {
            let ActionEnd::Failed(r) = run_action(
                "mdium/design-doc-commit",
                &with(json!({ "worktree": wt.clone(), "docPath": bad, "title": "t", "body": "b" })),
                &c,
            ) else { panic!() };
            assert_eq!(r.code, FLOW_ACTION_INPUT_INVALID, "{bad}");
        }
    }

    #[test]
    fn issue_entry_posts_once_and_issue_close_closes() {
        let repo = Fixture::new();
        gitops::git(repo.root(), &["remote", "add", "origin", "https://github.com/o/r.git"]).unwrap();
        let forge = Arc::new(FakeForge::default());
        let mut c = ctx(repo.root(), repo.root());
        c.forge = forge.clone();
        let input = with(json!({ "issue": "12", "entry": "design", "body": "# Design" }));
        let ActionEnd::Done { outputs, .. } = run_action("mdium/issue-entry", &input, &c) else { panic!() };
        assert_eq!(outputs["posted"], json!(true));
        let ActionEnd::Done { outputs, .. } = run_action("mdium/issue-entry", &input, &c) else { panic!() };
        assert_eq!(outputs["posted"], json!(false), "the marker prevents a duplicate");
        assert!(matches!(run_action("mdium/issue-close", &with(json!({ "issue": "12" })), &c), ActionEnd::Done { .. }));
        let calls = forge.calls();
        assert_eq!(calls.iter().filter(|call| matches!(call, ForgeCall::AddComment { number: 12, .. })).count(), 1);
        assert!(calls.iter().any(|call| matches!(call, ForgeCall::CloseIssue(12))));
    }

    #[test]
    fn issue_entry_implement_lists_the_worktree_branch_and_commits() {
        let repo = Fixture::new();
        gitops::git(repo.root(), &["remote", "add", "origin", "https://github.com/o/r.git"]).unwrap();
        let base = tempfile::tempdir().unwrap();
        let forge = Arc::new(FakeForge::default());
        let mut c = ctx(repo.root(), base.path());
        c.forge = forge.clone();
        let ActionEnd::Done { outputs: wt, .. } = run_action("mdium/git-worktree-create", &with(json!({ "title": "My Feature" })), &c) else { panic!() };
        let wt = object(wt);
        let ActionEnd::Done { .. } = run_action(
            "mdium/design-doc-commit",
            &with(json!({ "worktree": wt.clone(), "docPath": "docs/d.md", "title": "Subject Marker", "body": "x" })),
            &c,
        ) else { panic!() };
        let input = with(json!({ "issue": "12", "entry": "implement", "body": "Done.", "worktree": wt.clone() }));
        let ActionEnd::Done { .. } = run_action("mdium/issue-entry", &input, &c) else { panic!() };
        let calls = forge.calls();
        let body = calls.iter().find_map(|call| match call {
            ForgeCall::AddComment { number: 12, body } => Some(body.clone()),
            _ => None,
        }).expect("a comment was posted");
        assert!(body.contains(wt["branch"].as_str().unwrap()), "{body}");
        assert!(body.contains("Subject Marker"), "{body}");
    }

    #[test]
    fn forge_actions_fail_without_a_forge_remote() {
        let repo = Fixture::new();
        let c = ctx(repo.root(), repo.root());
        let ActionEnd::Failed(r) = run_action("mdium/issue-close", &with(json!({ "issue": "12" })), &c) else { panic!() };
        assert_eq!(r.code, FLOW_ACTION_FAILED);
        assert_eq!(r.params["code"], json!("FORGE_NOT_DETECTED"));
    }
}
