//! Parser for the stage outcome contract: an agent's final response must
//! start with YAML frontmatter declaring `outcome` (plus `reason` /
//! `question` where relevant), followed by a Markdown body.

use serde::Deserialize;

/// The declared result of one stage attempt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StageOutcomeKind {
    Completed,
    Attention,
    AwaitingUser,
}

/// A parsed stage outcome. `body` is the Markdown after the frontmatter,
/// preserved verbatim (minus one optional blank separator line).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StageOutcome {
    pub kind: StageOutcomeKind,
    pub reason: Option<String>,
    pub question: Option<String>,
    pub body: String,
}

/// Why a response did not satisfy the outcome contract.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OutcomeError {
    /// No `---` delimited frontmatter block at the start of the response.
    MissingFrontmatter,
    /// The frontmatter is not a valid YAML mapping of the expected shape.
    InvalidYaml(String),
    /// `outcome` is missing or not one of the accepted values.
    InvalidOutcome(String),
    /// `attention` / `awaiting_user` without a non-empty `reason`.
    MissingReason,
}

impl OutcomeError {
    /// Stable machine code for this failure, for callers/UI to key off.
    pub fn code(&self) -> &'static str {
        match self {
            OutcomeError::MissingFrontmatter => "OUTCOME_MISSING_FRONTMATTER",
            OutcomeError::InvalidYaml(_) => "OUTCOME_INVALID_YAML",
            OutcomeError::InvalidOutcome(_) => "OUTCOME_INVALID_VALUE",
            OutcomeError::MissingReason => "OUTCOME_MISSING_REASON",
        }
    }
}

/// Frontmatter delimiter line.
const FRONTMATTER_DELIMITER: &str = "---";

/// Markdown code fence marker.
const CODE_FENCE: &str = "```";

/// UTF-8 byte order mark that some Windows tools prepend.
const BOM: char = '\u{feff}';

/// Parses an agent's final response into a [`StageOutcome`].
///
/// Tolerated: a BOM, leading whitespace/blank lines, CRLF line endings, a
/// single ```` ``` ```` / ```` ```markdown ```` fence wrapping the whole
/// response, and unknown frontmatter keys. The body is everything after the
/// closing `---` (minus one optional blank line), verbatim.
pub fn parse_outcome(text: &str) -> Result<StageOutcome, OutcomeError> {
    let text = text.strip_prefix(BOM).unwrap_or(text).trim_start();
    let text = strip_wrapping_fence(text).trim_start();
    let (yaml, body) = split_frontmatter(text).ok_or(OutcomeError::MissingFrontmatter)?;
    let raw = decode_frontmatter(&yaml)?;

    let value = raw
        .outcome
        .ok_or_else(|| OutcomeError::InvalidOutcome(String::new()))?;
    let kind = match value.trim().to_ascii_lowercase().replace('-', "_").as_str() {
        "completed" => StageOutcomeKind::Completed,
        "attention" => StageOutcomeKind::Attention,
        "awaiting_user" => StageOutcomeKind::AwaitingUser,
        _ => return Err(OutcomeError::InvalidOutcome(value)),
    };

    let reason = non_blank(raw.reason);
    if kind != StageOutcomeKind::Completed && reason.is_none() {
        return Err(OutcomeError::MissingReason);
    }

    Ok(StageOutcome {
        kind,
        reason,
        question: non_blank(raw.question),
        body: body.to_string(),
    })
}

/// Trims a text field, mapping missing or whitespace-only values to `None`.
fn non_blank(value: Option<String>) -> Option<String> {
    value
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

/// Splits the first line off `text`, returning `(line, rest)`. The line
/// excludes its terminator, and a trailing `\r` is dropped so CRLF input is
/// handled like LF input.
fn split_line(text: &str) -> (&str, &str) {
    let (line, rest) = match text.find('\n') {
        Some(pos) => (&text[..pos], &text[pos + 1..]),
        None => (text, ""),
    };
    (line.strip_suffix('\r').unwrap_or(line), rest)
}

/// If `text` opens with a bare or `markdown`/`md` code fence, removes that
/// opening line and, when present, the matching closing fence on the last
/// non-blank line. Any other text is returned unchanged.
fn strip_wrapping_fence(text: &str) -> &str {
    let (first, rest) = split_line(text);
    let Some(info) = first.trim_end().strip_prefix(CODE_FENCE) else {
        return text;
    };
    let info = info.trim().to_ascii_lowercase();
    if !matches!(info.as_str(), "" | "markdown" | "md") {
        return text;
    }

    let trimmed = rest.trim_end();
    let last_line_start = trimmed.rfind('\n').map_or(0, |pos| pos + 1);
    if trimmed[last_line_start..].trim() == CODE_FENCE {
        &rest[..last_line_start]
    } else {
        rest
    }
}

/// Splits `text` into `(yaml, body)` if it starts with a `---` delimited
/// frontmatter block. One blank line directly after the closing delimiter
/// is dropped; the rest of the body is returned verbatim.
fn split_frontmatter(text: &str) -> Option<(String, &str)> {
    let (first, mut rest) = split_line(text);
    if first.trim_end() != FRONTMATTER_DELIMITER {
        return None;
    }

    let mut yaml = String::new();
    loop {
        if rest.is_empty() {
            return None;
        }
        let (line, next) = split_line(rest);
        rest = next;
        if line.trim_end() == FRONTMATTER_DELIMITER {
            let body = match rest.strip_prefix("\r\n") {
                Some(body) => body,
                None => rest.strip_prefix('\n').unwrap_or(rest),
            };
            return Some((yaml, body));
        }
        yaml.push_str(line);
        yaml.push('\n');
    }
}

/// Decodes the frontmatter YAML. An empty block yields all-`None` fields;
/// anything other than a mapping is [`OutcomeError::InvalidYaml`].
fn decode_frontmatter(yaml: &str) -> Result<RawFrontmatter, OutcomeError> {
    let value: serde_yaml_ng::Value =
        serde_yaml_ng::from_str(yaml).map_err(|err| OutcomeError::InvalidYaml(err.to_string()))?;
    match value {
        serde_yaml_ng::Value::Null => Ok(RawFrontmatter::default()),
        serde_yaml_ng::Value::Mapping(_) => serde_yaml_ng::from_value(value)
            .map_err(|err| OutcomeError::InvalidYaml(err.to_string())),
        _ => Err(OutcomeError::InvalidYaml(
            "frontmatter is not a mapping".to_string(),
        )),
    }
}

/// Frontmatter fields the parser reads; unknown keys are ignored.
#[derive(Deserialize, Default)]
struct RawFrontmatter {
    #[serde(default)]
    outcome: Option<String>,
    #[serde(default)]
    reason: Option<String>,
    #[serde(default)]
    question: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok(text: &str) -> StageOutcome {
        parse_outcome(text).unwrap_or_else(|err| panic!("unexpected error {err:?} for {text:?}"))
    }

    #[test]
    fn parses_completed_without_reason() {
        let out = ok("---\noutcome: completed\n---\n\n# Done\n\nAll good.\n");
        assert_eq!(out.kind, StageOutcomeKind::Completed);
        assert_eq!(out.reason, None);
        assert_eq!(out.question, None);
        assert_eq!(out.body, "# Done\n\nAll good.\n");
    }

    #[test]
    fn parses_attention_with_reason() {
        let out = ok("---\noutcome: attention\nreason: tests fail\n---\nbody\n");
        assert_eq!(out.kind, StageOutcomeKind::Attention);
        assert_eq!(out.reason.as_deref(), Some("tests fail"));
        assert_eq!(out.body, "body\n");
    }

    #[test]
    fn parses_awaiting_user_with_reason_and_question() {
        let out = ok(
            "---\noutcome: awaiting_user\nreason: ambiguous spec\nquestion: Which API?\n---\n\nbody",
        );
        assert_eq!(out.kind, StageOutcomeKind::AwaitingUser);
        assert_eq!(out.reason.as_deref(), Some("ambiguous spec"));
        assert_eq!(out.question.as_deref(), Some("Which API?"));
        assert_eq!(out.body, "body");
    }

    #[test]
    fn completed_keeps_optional_reason() {
        let out = ok("---\noutcome: completed\nreason: fine\n---\n");
        assert_eq!(out.reason.as_deref(), Some("fine"));
        assert_eq!(out.body, "");
    }

    #[test]
    fn outcome_values_are_case_insensitive_and_accept_hyphen_alias() {
        let cases = [
            ("Completed", StageOutcomeKind::Completed),
            ("ATTENTION", StageOutcomeKind::Attention),
            ("Awaiting_User", StageOutcomeKind::AwaitingUser),
            ("awaiting-user", StageOutcomeKind::AwaitingUser),
            ("AWAITING-USER", StageOutcomeKind::AwaitingUser),
        ];
        for (value, kind) in cases {
            let out = ok(&format!("---\noutcome: {value}\nreason: r\n---\nb"));
            assert_eq!(out.kind, kind, "value {value}");
        }
    }

    #[test]
    fn tolerates_leading_whitespace_and_blank_lines() {
        let out = ok("\n  \n\t\n---\noutcome: completed\n---\nbody\n");
        assert_eq!(out.kind, StageOutcomeKind::Completed);
        assert_eq!(out.body, "body\n");
    }

    #[test]
    fn tolerates_bom() {
        let out = ok("\u{feff}---\noutcome: completed\n---\nbody");
        assert_eq!(out.body, "body");
    }

    #[test]
    fn tolerates_crlf_and_preserves_body_verbatim() {
        let out = ok("---\r\noutcome: attention\r\nreason: r\r\n---\r\n\r\nline1\r\nline2\r\n");
        assert_eq!(out.kind, StageOutcomeKind::Attention);
        assert_eq!(out.reason.as_deref(), Some("r"));
        assert_eq!(out.body, "line1\r\nline2\r\n");
    }

    #[test]
    fn strips_only_one_blank_line_after_frontmatter() {
        let out = ok("---\noutcome: completed\n---\n\n\n  indented\n---\nmore\n");
        assert_eq!(out.body, "\n  indented\n---\nmore\n");
    }

    #[test]
    fn tolerates_markdown_code_fence() {
        let out = ok("```markdown\n---\noutcome: completed\n---\n\n# Title\n\ntext\n```\n");
        assert_eq!(out.kind, StageOutcomeKind::Completed);
        assert_eq!(out.body, "# Title\n\ntext\n");
    }

    #[test]
    fn tolerates_bare_code_fence_with_crlf_and_surrounding_whitespace() {
        let out = ok("\r\n```\r\n---\r\noutcome: completed\r\n---\r\nbody\r\n```\r\n\r\n");
        assert_eq!(out.body, "body\r\n");
    }

    #[test]
    fn inner_code_fences_in_body_are_preserved() {
        let out = ok("---\noutcome: completed\n---\n```rust\nfn main() {}\n```\n");
        assert_eq!(out.body, "```rust\nfn main() {}\n```\n");
    }

    #[test]
    fn ignores_unknown_keys() {
        let out = ok("---\noutcome: completed\nconfidence: 0.9\nfiles:\n  - a.rs\n---\nb");
        assert_eq!(out.kind, StageOutcomeKind::Completed);
    }

    #[test]
    fn missing_frontmatter_is_reported() {
        for text in [
            "",
            "   \n",
            "# Just markdown\n",
            "outcome: completed\n",
            "---\noutcome: completed\nno closing delimiter\n",
            "text before\n---\noutcome: completed\n---\n",
        ] {
            let err = parse_outcome(text).unwrap_err();
            assert_eq!(err, OutcomeError::MissingFrontmatter, "text {text:?}");
            assert_eq!(err.code(), "OUTCOME_MISSING_FRONTMATTER");
        }
    }

    #[test]
    fn invalid_yaml_is_reported() {
        for text in [
            "---\noutcome: [unclosed\n---\nb",
            "---\n- a\n- b\n---\nb",
            "---\njust a scalar\n---\nb",
        ] {
            let err = parse_outcome(text).unwrap_err();
            assert!(
                matches!(err, OutcomeError::InvalidYaml(_)),
                "text {text:?}: {err:?}"
            );
            assert_eq!(err.code(), "OUTCOME_INVALID_YAML");
        }
    }

    #[test]
    fn invalid_or_missing_outcome_value_is_reported() {
        for text in [
            "---\noutcome: done\n---\nb",
            "---\noutcome: awaiting user\n---\nb",
            "---\nreason: r\n---\nb",
            "---\n---\nb",
        ] {
            let err = parse_outcome(text).unwrap_err();
            assert!(
                matches!(err, OutcomeError::InvalidOutcome(_)),
                "text {text:?}: {err:?}"
            );
            assert_eq!(err.code(), "OUTCOME_INVALID_VALUE");
        }
    }

    #[test]
    fn missing_reason_is_reported_for_attention_and_awaiting_user() {
        for text in [
            "---\noutcome: attention\n---\nb",
            "---\noutcome: awaiting_user\nquestion: q?\n---\nb",
            "---\noutcome: attention\nreason: \"  \"\n---\nb",
            "---\noutcome: awaiting-user\nreason:\n---\nb",
        ] {
            let err = parse_outcome(text).unwrap_err();
            assert_eq!(err, OutcomeError::MissingReason, "text {text:?}");
            assert_eq!(err.code(), "OUTCOME_MISSING_REASON");
        }
    }
}
