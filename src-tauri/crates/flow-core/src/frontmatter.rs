//! YAML-frontmatter splitting shared by task documents (`store`) and stage
//! outcomes (`outcome`): a `---` line, the YAML lines, a closing `---`
//! line, then the body.

/// Frontmatter delimiter line.
pub const FRONTMATTER_DELIMITER: &str = "---";

/// UTF-8 byte order mark that some Windows editors and tools prepend.
pub const BOM: char = '\u{feff}';

/// `text` without a leading [`BOM`], if it has one.
pub fn strip_bom(text: &str) -> &str {
    text.strip_prefix(BOM).unwrap_or(text)
}

/// Splits the first line off `text`, returning `(line, rest)`. The line
/// excludes its terminator, and a trailing `\r` is dropped so CRLF input is
/// handled like LF input.
pub fn split_line(text: &str) -> (&str, &str) {
    let (line, rest) = match text.find('\n') {
        Some(pos) => (&text[..pos], &text[pos + 1..]),
        None => (text, ""),
    };
    (line.strip_suffix('\r').unwrap_or(line), rest)
}

/// How a line is compared against [`FRONTMATTER_DELIMITER`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DelimiterMatch {
    /// The line must be exactly `---` (task documents MDium writes itself).
    Exact,
    /// Trailing whitespace after `---` is tolerated (agent responses).
    TrimEnd,
}

impl DelimiterMatch {
    fn is_delimiter(self, line: &str) -> bool {
        match self {
            DelimiterMatch::Exact => line == FRONTMATTER_DELIMITER,
            DelimiterMatch::TrimEnd => line.trim_end() == FRONTMATTER_DELIMITER,
        }
    }
}

/// Why [`split_frontmatter`] found no frontmatter block.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SplitError {
    /// The first line is not a delimiter.
    MissingOpening,
    /// No closing delimiter line follows the opening one.
    MissingClosing,
}

/// Splits `text` into `(yaml, body)` when its first line is a delimiter.
/// Only the FIRST block is frontmatter: everything after its closing
/// delimiter is the body, verbatim (even if it starts with `---` itself),
/// minus one blank separator line (`\n` or `\r\n`) directly after the
/// closing delimiter. YAML lines are re-joined with `\n`.
pub fn split_frontmatter(
    text: &str,
    delimiter: DelimiterMatch,
) -> Result<(String, &str), SplitError> {
    let (first, mut rest) = split_line(text);
    if !delimiter.is_delimiter(first) {
        return Err(SplitError::MissingOpening);
    }

    let mut yaml = String::new();
    loop {
        if rest.is_empty() {
            return Err(SplitError::MissingClosing);
        }
        let (line, next) = split_line(rest);
        rest = next;
        if delimiter.is_delimiter(line) {
            let body = match rest.strip_prefix("\r\n") {
                Some(body) => body,
                None => rest.strip_prefix('\n').unwrap_or(rest),
            };
            return Ok((yaml, body));
        }
        yaml.push_str(line);
        yaml.push('\n');
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_line_handles_lf_crlf_and_last_line() {
        assert_eq!(split_line("a\nb"), ("a", "b"));
        assert_eq!(split_line("a\r\nb"), ("a", "b"));
        assert_eq!(split_line("a"), ("a", ""));
        assert_eq!(split_line(""), ("", ""));
    }

    #[test]
    fn strip_bom_removes_only_a_leading_bom() {
        assert_eq!(strip_bom("\u{feff}---"), "---");
        assert_eq!(strip_bom("a\u{feff}"), "a\u{feff}");
    }

    #[test]
    fn splits_yaml_and_body_dropping_one_separator_line() {
        let (yaml, body) =
            split_frontmatter("---\na: 1\nb: 2\n---\n\n\nbody\n", DelimiterMatch::Exact).unwrap();
        assert_eq!(yaml, "a: 1\nb: 2\n");
        assert_eq!(body, "\nbody\n");
    }

    #[test]
    fn crlf_input_yields_lf_yaml_and_verbatim_body() {
        let (yaml, body) =
            split_frontmatter("---\r\na: 1\r\n---\r\n\r\nx\r\n", DelimiterMatch::Exact).unwrap();
        assert_eq!(yaml, "a: 1\n");
        assert_eq!(body, "x\r\n");
    }

    #[test]
    fn body_may_start_with_delimiter() {
        let (_, body) =
            split_frontmatter("---\na: 1\n---\n---\nmore\n", DelimiterMatch::Exact).unwrap();
        assert_eq!(body, "---\nmore\n");
    }

    #[test]
    fn trailing_whitespace_on_delimiters_depends_on_mode() {
        let text = "---  \na: 1\n--- \nbody";
        assert_eq!(
            split_frontmatter(text, DelimiterMatch::Exact),
            Err(SplitError::MissingOpening)
        );
        assert_eq!(
            split_frontmatter(text, DelimiterMatch::TrimEnd),
            Ok(("a: 1\n".to_string(), "body"))
        );
    }

    #[test]
    fn missing_delimiters_are_reported() {
        assert_eq!(
            split_frontmatter("a: 1\n", DelimiterMatch::Exact),
            Err(SplitError::MissingOpening)
        );
        assert_eq!(
            split_frontmatter("---\na: 1\n", DelimiterMatch::Exact),
            Err(SplitError::MissingClosing)
        );
        assert_eq!(
            split_frontmatter("---", DelimiterMatch::TrimEnd),
            Err(SplitError::MissingClosing)
        );
    }
}
