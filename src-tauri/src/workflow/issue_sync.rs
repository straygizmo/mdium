//! Issue sync entries: the comment bodies MDium posts to a task's Issue when
//! a stage completes, and marker-based duplicate protection so a retried
//! post (e.g. after a crash between posting and advancing) never creates a
//! second comment.
//!
//! Bodies are machine-generated records in English (not UI text). Every
//! body ends with `<!-- mdium:entry:<entryId> -->`.

use crate::workflow::forge::{ForgeCli, ForgeError, ForgeRepo};
use crate::workflow::gitops::CommitSummary;
use serde::{Deserialize, Serialize};

/// Maximum body length in characters (GitHub's comment limit is 65 536).
const MAX_BODY_CHARS: usize = 60_000;

/// Which stage an Issue entry records.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EntryKind {
    Design,
    Implement,
    Review,
}

impl EntryKind {
    /// Stable lowercase name (`design|implement|review`), e.g. for the
    /// `entry` param of `ATTENTION_ISSUE_SYNC_FAILED`.
    pub fn as_str(self) -> &'static str {
        match self {
            EntryKind::Design => "design",
            EntryKind::Implement => "implement",
            EntryKind::Review => "review",
        }
    }
}

/// Result of [`post_entry`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PostOutcome {
    /// A new comment was added.
    Posted,
    /// A comment carrying the entry's marker already existed; nothing posted.
    AlreadyPosted,
}

/// The id of the entry an attempt produces: `<taskId>-<attemptId>`.
pub fn entry_id(task_id: &str, attempt_id: &str) -> String {
    format!("{task_id}-{attempt_id}")
}

/// The hidden marker every entry body ends with.
pub fn marker(entry_id: &str) -> String {
    format!("<!-- mdium:entry:{entry_id} -->")
}

/// Inserted after `@` to keep a mention from notifying anyone.
const WORD_JOINER: char = '\u{2060}';

/// Neutralizes `@` mentions in Markdown posted to an Issue, so text written
/// by agents or users never notifies people or teams: a word joiner
/// (U+2060, invisible) is inserted after every `@` followed by an
/// identifier character (alphanumeric, `_` or `-`). Text inside fenced
/// code blocks (``` or ~~~) and inline code spans is left alone (code is
/// never rendered as a mention). Addresses such as `a@b.c` are changed too,
/// which is harmless: they read the same.
pub fn neutralize_mentions(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    // The open fence: its character and length.
    let mut fence: Option<(char, usize)> = None;
    for line in text.split_inclusive('\n') {
        let opener = fence_run(line);
        match (fence, opener) {
            (Some((ch, len)), Some((c, n))) if c == ch && n >= len && is_bare_fence(line, n) => {
                fence = None;
                out.push_str(line);
            }
            (Some(_), _) => out.push_str(line),
            (None, Some(open)) => {
                fence = Some(open);
                out.push_str(line);
            }
            (None, None) => neutralize_line(line, &mut out),
        }
    }
    out
}

/// The fence run (character and length) a line starts with: at most three
/// spaces of indentation, then at least three backticks or tildes.
fn fence_run(line: &str) -> Option<(char, usize)> {
    let indent = line.len() - line.trim_start_matches(' ').len();
    if indent > 3 {
        return None;
    }
    let rest = &line[indent..];
    let ch = rest.chars().next().filter(|c| *c == '`' || *c == '~')?;
    let len = rest.chars().take_while(|c| *c == ch).count();
    (len >= 3).then_some((ch, len))
}

/// Whether a line starting with a fence run of `len` characters has
/// nothing else on it (a closing fence).
fn is_bare_fence(line: &str, len: usize) -> bool {
    let rest = line.trim_start_matches(' ');
    rest[len..].trim().is_empty()
}

/// Appends `line` to `out`, neutralizing mentions outside inline code
/// spans (a backtick run opens a span that the next run of the same length
/// closes; an unmatched run is literal).
fn neutralize_line(line: &str, out: &mut String) {
    let chars: Vec<char> = line.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '`' {
            let run = chars[i..].iter().take_while(|c| **c == '`').count();
            if let Some(end) = closing_run(&chars, i + run, run) {
                out.extend(&chars[i..end + run]);
                i = end + run;
            } else {
                out.extend(&chars[i..i + run]);
                i += run;
            }
            continue;
        }
        out.push(c);
        if c == '@' {
            if let Some(next) = chars.get(i + 1) {
                if next.is_alphanumeric() || *next == '_' || *next == '-' {
                    out.push(WORD_JOINER);
                }
            }
        }
        i += 1;
    }
}

/// The start of the first backtick run of exactly `len` characters at or
/// after `from`.
fn closing_run(chars: &[char], from: usize, len: usize) -> Option<usize> {
    let mut i = from;
    while i < chars.len() {
        if chars[i] == '`' {
            let run = chars[i..].iter().take_while(|c| **c == '`').count();
            if run == len {
                return Some(i);
            }
            i += run;
        } else {
            i += 1;
        }
    }
    None
}

/// Joins `content` and the marker, truncating `content` (by characters) so
/// the whole body stays within [`MAX_BODY_CHARS`]. A truncation note is
/// placed before the marker so the marker always survives. Mentions in
/// `content` are neutralized first ([`neutralize_mentions`]).
fn finish_body(content: &str, entry: &str) -> String {
    const NOTE: &str = "\n\n_[truncated: the full text is in the task's run history]_";
    let tail = format!("\n\n{}", marker(entry));
    let content = neutralize_mentions(content);
    let content = content.trim_end();
    let budget = MAX_BODY_CHARS.saturating_sub(tail.chars().count());
    if content.chars().count() <= budget {
        return format!("{content}{tail}");
    }
    let keep = budget.saturating_sub(NOTE.chars().count());
    let cut = content
        .char_indices()
        .nth(keep)
        .map_or(content.len(), |(i, _)| i);
    format!("{}{NOTE}{tail}", &content[..cut])
}

/// Entry for a completed design stage.
pub fn design_body(design_markdown: &str, entry: &str) -> String {
    let content = format!("## Design\n\n{}", design_markdown.trim());
    finish_body(&content, entry)
}

/// Entry for a completed implement stage: branch and commits first (so they
/// survive truncation), then the agent's summary.
pub fn implement_body(
    summary_markdown: &str,
    branch: &str,
    commits: &[CommitSummary],
    entry: &str,
) -> String {
    let mut content = format!("## Implementation\n\nBranch: `{branch}`\n\n### Commits\n\n");
    if commits.is_empty() {
        content.push_str("No commits.\n");
    }
    for commit in commits {
        let short: String = commit.hash.chars().take(7).collect();
        content.push_str(&format!("- `{short}` {}\n", commit.subject));
    }
    content.push_str("\n### Summary\n\n");
    content.push_str(summary_markdown.trim());
    finish_body(&content, entry)
}

/// Entry for a review stage; `returned` means the findings were sent back
/// for rework (to the design or implement stage).
pub fn review_body(review_markdown: &str, returned: bool, entry: &str) -> String {
    let result = if returned {
        "Result: findings returned for rework."
    } else {
        "Result: Approved."
    };
    let content = format!("## Review\n\n{result}\n\n{}", review_markdown.trim());
    finish_body(&content, entry)
}

/// Posts `body` as a comment on Issue `number` unless a comment containing
/// the entry's marker already exists. Comments are always listed first; a
/// listing failure is returned as an error (never a blind post).
pub fn post_entry(
    cli: &dyn ForgeCli,
    repo: &ForgeRepo,
    number: u64,
    body: &str,
    entry: &str,
) -> Result<PostOutcome, ForgeError> {
    let marker = marker(entry);
    let comments = cli.list_comments(repo, number)?;
    if comments.iter().any(|c| c.body.contains(&marker)) {
        return Ok(PostOutcome::AlreadyPosted);
    }
    cli.add_comment(repo, number, body)?;
    Ok(PostOutcome::Posted)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workflow::forge::{FakeForge, FakeOp, ForgeCall, ForgeKind};

    const ENTRY: &str = "0123456789abcdef-fedcba9876543210";

    fn repo() -> ForgeRepo {
        ForgeRepo {
            kind: ForgeKind::GitHub,
            host: "github.com".to_string(),
            path: "owner/repo".to_string(),
        }
    }

    fn commits() -> Vec<CommitSummary> {
        vec![
            CommitSummary {
                hash: "1111111111111111111111111111111111111111".to_string(),
                subject: "feat: first".to_string(),
            },
            CommitSummary {
                hash: "2222222222222222222222222222222222222222".to_string(),
                subject: "fix: second".to_string(),
            },
        ]
    }

    #[test]
    fn entry_id_and_marker_format() {
        let id = entry_id("0123456789abcdef", "fedcba9876543210");
        assert_eq!(id, ENTRY);
        assert_eq!(marker(&id), format!("<!-- mdium:entry:{ENTRY} -->"));
    }

    #[test]
    fn entry_kind_serializes_lowercase() {
        assert_eq!(
            serde_json::to_string(&EntryKind::Implement).unwrap(),
            "\"implement\""
        );
        assert_eq!(EntryKind::Design.as_str(), "design");
        assert_eq!(EntryKind::Implement.as_str(), "implement");
        assert_eq!(EntryKind::Review.as_str(), "review");
    }

    #[test]
    fn bodies_have_heading_content_and_marker_at_end() {
        let m = marker(ENTRY);

        let design = design_body("The design.", ENTRY);
        assert!(design.starts_with("## Design\n"));
        assert!(design.contains("The design."));
        assert!(design.ends_with(&m));

        let implement = implement_body("Did the work.", "mdium/task-1", &commits(), ENTRY);
        assert!(implement.starts_with("## Implementation\n"));
        assert!(implement.contains("Did the work."));
        assert!(implement.contains("`mdium/task-1`"));
        assert!(implement.contains("`1111111` feat: first"));
        assert!(implement.contains("`2222222` fix: second"));
        assert!(implement.ends_with(&m));

        let approved = review_body("Looks good.", false, ENTRY);
        assert!(approved.starts_with("## Review\n"));
        assert!(approved.contains("Looks good."));
        assert!(approved.contains("Approved"));
        assert!(approved.ends_with(&m));

        let returned = review_body("Fix X.", true, ENTRY);
        assert!(returned.contains("returned"));
        assert!(!returned.contains("Approved"));
        assert!(returned.ends_with(&m));
    }

    #[test]
    fn implement_body_without_commits_says_so() {
        let body = implement_body("Summary.", "b", &[], ENTRY);
        assert!(body.contains("No commits"));
        assert!(body.ends_with(&marker(ENTRY)));
    }

    #[test]
    fn short_body_is_not_truncated() {
        let body = design_body("short", ENTRY);
        assert!(!body.contains("truncated"));
    }

    #[test]
    fn long_body_is_truncated_and_keeps_marker() {
        // Multi-byte chars make sure the cap is by characters and the cut
        // lands on a char boundary.
        let huge = "あ".repeat(100_000);
        for body in [
            design_body(&huge, ENTRY),
            implement_body(&huge, "b", &commits(), ENTRY),
            review_body(&huge, true, ENTRY),
        ] {
            assert!(body.chars().count() <= MAX_BODY_CHARS, "too long");
            assert!(body.contains("truncated"));
            assert!(body.ends_with(&marker(ENTRY)));
        }
    }

    #[test]
    fn post_entry_posts_when_marker_absent() {
        let fake = FakeForge::new();
        fake.set_comments(7, &["unrelated comment"]);
        let body = design_body("D", ENTRY);
        let outcome = post_entry(&fake, &repo(), 7, &body, ENTRY).unwrap();
        assert_eq!(outcome, PostOutcome::Posted);
        assert_eq!(
            fake.calls(),
            vec![
                ForgeCall::ListComments(7),
                ForgeCall::AddComment {
                    number: 7,
                    body: body.clone()
                }
            ]
        );
        assert_eq!(fake.comments(7).len(), 2);
    }

    #[test]
    fn post_entry_dedupes_when_marker_present() {
        let fake = FakeForge::new();
        let body = design_body("D", ENTRY);
        // Simulates a crash after posting: the comment is already there.
        assert_eq!(
            post_entry(&fake, &repo(), 3, &body, ENTRY).unwrap(),
            PostOutcome::Posted
        );
        fake.clear_calls();
        assert_eq!(
            post_entry(&fake, &repo(), 3, &body, ENTRY).unwrap(),
            PostOutcome::AlreadyPosted
        );
        assert_eq!(fake.calls(), vec![ForgeCall::ListComments(3)]);
        assert_eq!(fake.comments(3).len(), 1);
    }

    #[test]
    fn post_entry_dedupes_on_marker_in_edited_comment() {
        let fake = FakeForge::new();
        let edited = format!("someone edited this\n{}", marker(ENTRY));
        fake.set_comments(4, &[&edited]);
        let outcome = post_entry(&fake, &repo(), 4, &design_body("D", ENTRY), ENTRY).unwrap();
        assert_eq!(outcome, PostOutcome::AlreadyPosted);
    }

    #[test]
    fn post_entry_other_entry_marker_does_not_dedupe() {
        let fake = FakeForge::new();
        let other = design_body("D", "0123456789abcdef-0000000000000000");
        fake.set_comments(5, &[&other]);
        let outcome = post_entry(&fake, &repo(), 5, &design_body("D", ENTRY), ENTRY).unwrap();
        assert_eq!(outcome, PostOutcome::Posted);
    }

    #[test]
    fn post_entry_list_failure_is_error_without_post() {
        let fake = FakeForge::new();
        fake.set_failure(FakeOp::ListComments, Some(ForgeError::Timeout));
        let err = post_entry(&fake, &repo(), 9, &design_body("D", ENTRY), ENTRY).unwrap_err();
        assert_eq!(err, ForgeError::Timeout);
        assert_eq!(fake.calls(), vec![ForgeCall::ListComments(9)]);
        assert!(fake.comments(9).is_empty());
    }

    const WJ: char = '\u{2060}';

    #[test]
    fn mentions_are_neutralized() {
        assert_eq!(
            neutralize_mentions("ping @alice and @org/team, cc @bob-2."),
            format!("ping @{WJ}alice and @{WJ}org/team, cc @{WJ}bob-2.")
        );
        // Emails are neutralized too (harmless: the text reads the same).
        assert_eq!(neutralize_mentions("a@b.c"), format!("a@{WJ}b.c"));
        // A lone `@` or one before punctuation or space is left alone.
        assert_eq!(neutralize_mentions("@ x @! @"), "@ x @! @");
    }

    #[test]
    fn mentions_in_code_are_left_alone() {
        let text = "use `@decorator` here\n```py\n@app.route\n```\n~~~\n@x\n~~~\nthen @bob";
        assert_eq!(
            neutralize_mentions(text),
            format!("use `@decorator` here\n```py\n@app.route\n```\n~~~\n@x\n~~~\nthen @{WJ}bob")
        );
        // Longer backtick runs delimit spans containing single backticks.
        assert_eq!(
            neutralize_mentions("``a ` @b`` @c"),
            format!("``a ` @b`` @{WJ}c")
        );
        // An unclosed backtick is literal, so the mention after it counts.
        assert_eq!(neutralize_mentions("` @d"), format!("` @{WJ}d"));
        // A fence closes only with a run at least as long as its opener.
        assert_eq!(
            neutralize_mentions("````\n```\n@e\n````\n@f"),
            format!("````\n```\n@e\n````\n@{WJ}f")
        );
        // CRLF line endings are kept.
        assert_eq!(
            neutralize_mentions("@g\r\n```\r\n@h\r\n```\r\n"),
            format!("@{WJ}g\r\n```\r\n@h\r\n```\r\n")
        );
    }

    #[test]
    fn entry_bodies_neutralize_mentions_but_keep_the_marker() {
        let body = design_body("Ask @alice.", ENTRY);
        assert!(body.contains(&format!("@{WJ}alice")), "{body}");
        assert!(body.ends_with(&marker(ENTRY)));
        let body = implement_body("Done by @bob", "b", &[], ENTRY);
        assert!(body.contains(&format!("@{WJ}bob")), "{body}");
        let body = review_body("@carol please look", true, ENTRY);
        assert!(body.contains(&format!("@{WJ}carol")), "{body}");
    }

    #[test]
    fn post_entry_add_failure_is_error() {
        let fake = FakeForge::new();
        fake.set_failure(FakeOp::AddComment, Some(ForgeError::NotAuthenticated));
        let err = post_entry(&fake, &repo(), 9, &design_body("D", ENTRY), ENTRY).unwrap_err();
        assert_eq!(err, ForgeError::NotAuthenticated);
    }
}
