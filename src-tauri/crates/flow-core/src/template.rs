//! `${{ ... }}` templates and the references they may contain.
//!
//! A template only ever names a value (spec 2.5); there is no expression
//! language. Parsing is context free; whether a reference is allowed at a
//! given place (loop variables, `iteration`, known params/nodes) is decided
//! by the validator, and resolving values is up to the caller of [`render`].

use serde_json::Value;
use std::fmt;

/// A value a template or a condition may refer to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Reference {
    /// `params.<name>`
    Param(String),
    /// `nodes.<id>.outputs.<key>`
    NodeOutput { node: String, key: String },
    /// `iteration.outputs.<key>` (only inside a `while` loop's `until`)
    IterationOutput(String),
    /// A loop's iteration variable (`item`, or the loop's `as` name)
    LoopVar(String),
    /// `index` (position of the current loop iteration)
    Index,
    /// `run.id`
    RunId,
    /// `run.dir`
    RunDir,
    /// `node.dir`
    NodeDir,
    /// `project.root`
    ProjectRoot,
    /// `env.<NAME>` (must be listed in `envPassthrough`)
    Env(String),
}

impl fmt::Display for Reference {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Reference::Param(name) => write!(f, "params.{name}"),
            Reference::NodeOutput { node, key } => write!(f, "nodes.{node}.outputs.{key}"),
            Reference::IterationOutput(key) => write!(f, "iteration.outputs.{key}"),
            Reference::LoopVar(name) => write!(f, "{name}"),
            Reference::Index => write!(f, "index"),
            Reference::RunId => write!(f, "run.id"),
            Reference::RunDir => write!(f, "run.dir"),
            Reference::NodeDir => write!(f, "node.dir"),
            Reference::ProjectRoot => write!(f, "project.root"),
            Reference::Env(name) => write!(f, "env.{name}"),
        }
    }
}

/// Why a template or reference could not be parsed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TemplateError {
    /// `${{` without a matching `}}`.
    Unclosed,
    /// `${{ }}` with nothing inside.
    Empty,
    /// The text inside `${{ }}` is not a supported reference.
    BadReference(String),
}

impl TemplateError {
    /// Short machine-readable reason (validation issue parameter).
    pub fn reason(&self) -> &'static str {
        match self {
            TemplateError::Unclosed => "unclosed",
            TemplateError::Empty => "empty",
            TemplateError::BadReference(_) => "bad-reference",
        }
    }
}

/// One piece of a parsed template.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Segment {
    Literal(String),
    Ref(Reference),
}

const OPEN: &str = "${{";
const CLOSE: &str = "}}";

/// True when `text` contains at least one `${{`.
pub fn has_template(text: &str) -> bool {
    text.contains(OPEN)
}

/// Splits `text` into literal and reference segments.
pub fn parse_template(text: &str) -> Result<Vec<Segment>, TemplateError> {
    let mut segments = Vec::new();
    let mut rest = text;
    while let Some(start) = rest.find(OPEN) {
        if start > 0 {
            segments.push(Segment::Literal(rest[..start].to_string()));
        }
        let after = &rest[start + OPEN.len()..];
        let end = after.find(CLOSE).ok_or(TemplateError::Unclosed)?;
        let expr = after[..end].trim();
        if expr.is_empty() {
            return Err(TemplateError::Empty);
        }
        segments.push(Segment::Ref(parse_reference(expr)?));
        rest = &after[end + CLOSE.len()..];
    }
    if !rest.is_empty() {
        segments.push(Segment::Literal(rest.to_string()));
    }
    Ok(segments)
}

/// All references in `text` (empty when it has no template).
pub fn references(text: &str) -> Result<Vec<Reference>, TemplateError> {
    Ok(parse_template(text)?
        .into_iter()
        .filter_map(|segment| match segment {
            Segment::Ref(reference) => Some(reference),
            Segment::Literal(_) => None,
        })
        .collect())
}

/// An identifier segment of a reference: `[A-Za-z_][A-Za-z0-9_-]*`.
pub fn is_ident(text: &str) -> bool {
    let mut chars = text.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// Parses the text inside `${{ }}` (or a condition's `ref`).
pub fn parse_reference(expr: &str) -> Result<Reference, TemplateError> {
    let bad = || TemplateError::BadReference(expr.to_string());
    let parts: Vec<&str> = expr.trim().split('.').collect();
    if parts.iter().any(|part| !is_ident(part)) {
        return Err(bad());
    }
    let reference = match parts.as_slice() {
        ["params", name] => Reference::Param(name.to_string()),
        ["nodes", node, "outputs", key] => Reference::NodeOutput {
            node: node.to_string(),
            key: key.to_string(),
        },
        ["iteration", "outputs", key] => Reference::IterationOutput(key.to_string()),
        ["run", "id"] => Reference::RunId,
        ["run", "dir"] => Reference::RunDir,
        ["node", "dir"] => Reference::NodeDir,
        ["project", "root"] => Reference::ProjectRoot,
        ["env", name] => Reference::Env(name.to_string()),
        ["index"] => Reference::Index,
        [name] if !RESERVED_ROOTS.contains(name) => Reference::LoopVar(name.to_string()),
        _ => return Err(bad()),
    };
    Ok(reference)
}

/// First segments with a fixed meaning; never a loop variable name.
pub const RESERVED_ROOTS: [&str; 8] = [
    "params",
    "nodes",
    "iteration",
    "run",
    "node",
    "project",
    "env",
    "index",
];

/// Why [`render`] failed.
#[derive(Debug, Clone, PartialEq)]
pub enum RenderError {
    Parse(TemplateError),
    /// The resolver had no value for this reference.
    Unresolved(Reference),
}

/// Expands `text`. A text that is exactly one reference yields the
/// referenced value unchanged (so `items: "${{ nodes.x.outputs.list }}"`
/// keeps its array); otherwise the result is a string where strings are
/// inserted as is and other values as JSON.
pub fn render(
    text: &str,
    resolve: &dyn Fn(&Reference) -> Option<Value>,
) -> Result<Value, RenderError> {
    let segments = parse_template(text).map_err(RenderError::Parse)?;
    if let [Segment::Ref(reference)] = segments.as_slice() {
        return resolve(reference).ok_or_else(|| RenderError::Unresolved(reference.clone()));
    }
    let mut out = String::new();
    for segment in segments {
        match segment {
            Segment::Literal(text) => out.push_str(&text),
            Segment::Ref(reference) => {
                let value = resolve(&reference)
                    .ok_or_else(|| RenderError::Unresolved(reference.clone()))?;
                match value {
                    Value::String(s) => out.push_str(&s),
                    other => out.push_str(&other.to_string()),
                }
            }
        }
    }
    Ok(Value::String(out))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_every_reference_form() {
        let cases = [
            ("params.sourceDir", Reference::Param("sourceDir".into())),
            (
                "nodes.collect.outputs.docs",
                Reference::NodeOutput {
                    node: "collect".into(),
                    key: "docs".into(),
                },
            ),
            (
                "iteration.outputs.score",
                Reference::IterationOutput("score".into()),
            ),
            ("run.id", Reference::RunId),
            ("run.dir", Reference::RunDir),
            ("node.dir", Reference::NodeDir),
            ("project.root", Reference::ProjectRoot),
            ("env.HOME_DIR", Reference::Env("HOME_DIR".into())),
            ("index", Reference::Index),
            ("item", Reference::LoopVar("item".into())),
            ("  doc ", Reference::LoopVar("doc".into())),
        ];
        for (text, expected) in cases {
            assert_eq!(parse_reference(text), Ok(expected.clone()), "{text}");
            assert_eq!(
                parse_reference(&expected.to_string()),
                Ok(expected),
                "{text} round trip"
            );
        }
    }

    #[test]
    fn rejects_unsupported_references() {
        for text in [
            "params",
            "params.a.b",
            "nodes.x.output.y",
            "nodes.x.outputs",
            "run.other",
            "1abc",
            "a + b",
            "params.",
            "env",
            "node",
            "foo()",
        ] {
            assert!(
                matches!(parse_reference(text), Err(TemplateError::BadReference(_))),
                "{text}"
            );
        }
    }

    #[test]
    fn parses_mixed_templates() {
        let segments = parse_template("--out ${{ node.dir }}/digest.md").unwrap();
        assert_eq!(
            segments,
            vec![
                Segment::Literal("--out ".into()),
                Segment::Ref(Reference::NodeDir),
                Segment::Literal("/digest.md".into()),
            ]
        );
        assert_eq!(
            parse_template("plain").unwrap(),
            vec![Segment::Literal("plain".into())]
        );
        assert_eq!(parse_template("").unwrap(), vec![]);
    }

    #[test]
    fn reports_template_syntax_errors() {
        assert_eq!(
            parse_template("a ${{ params.x"),
            Err(TemplateError::Unclosed)
        );
        assert_eq!(parse_template("${{   }}"), Err(TemplateError::Empty));
        assert!(matches!(
            parse_template("${{ x y }}"),
            Err(TemplateError::BadReference(_))
        ));
    }

    #[test]
    fn render_keeps_value_of_a_single_reference() {
        let resolve = |r: &Reference| match r {
            Reference::NodeOutput { .. } => Some(json!(["a.md", "b.md"])),
            Reference::Param(_) => Some(json!(7)),
            Reference::NodeDir => Some(json!("C:/runs/1")),
            _ => None,
        };
        assert_eq!(
            render("${{ nodes.c.outputs.docs }}", &resolve),
            Ok(json!(["a.md", "b.md"]))
        );
        assert_eq!(
            render("min=${{ params.min }}", &resolve),
            Ok(json!("min=7"))
        );
        assert_eq!(
            render("${{ node.dir }}/x ${{ nodes.c.outputs.docs }}", &resolve),
            Ok(json!("C:/runs/1/x [\"a.md\",\"b.md\"]"))
        );
        assert_eq!(
            render("${{ run.id }}", &resolve),
            Err(RenderError::Unresolved(Reference::RunId))
        );
        assert_eq!(render("no template", &resolve), Ok(json!("no template")));
    }
}
