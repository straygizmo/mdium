//! Conditions (`when`, `until`, branch `cases`): a comparison of one
//! referenced value with a literal, combined with `all` / `any` / `not`.
//! There is deliberately no expression language (spec 2.6).

use crate::flow::template::{parse_reference, Reference};
use serde::{Deserialize, Serialize, Serializer};
use serde_json::{Map, Value};

/// Comparison operators.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CompareOp {
    Eq,
    Ne,
    Lt,
    Le,
    Gt,
    Ge,
    In,
    Exists,
}

impl CompareOp {
    pub fn parse(text: &str) -> Option<Self> {
        Some(match text {
            "==" => Self::Eq,
            "!=" => Self::Ne,
            "<" => Self::Lt,
            "<=" => Self::Le,
            ">" => Self::Gt,
            ">=" => Self::Ge,
            "in" => Self::In,
            "exists" => Self::Exists,
            _ => return None,
        })
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Eq => "==",
            Self::Ne => "!=",
            Self::Lt => "<",
            Self::Le => "<=",
            Self::Gt => ">",
            Self::Ge => ">=",
            Self::In => "in",
            Self::Exists => "exists",
        }
    }
}

/// A parsed condition.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(try_from = "Value")]
pub enum Condition {
    Compare {
        reference: Reference,
        op: CompareOp,
        value: Option<Value>,
    },
    All(Vec<Condition>),
    Any(Vec<Condition>),
    Not(Box<Condition>),
}

/// A malformed condition: where (relative path, e.g. `.any[1].op`) and why.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConditionError {
    pub path: String,
    pub reason: &'static str,
}

impl std::fmt::Display for ConditionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "invalid condition at '{}': {}", self.path, self.reason)
    }
}

impl TryFrom<Value> for Condition {
    type Error = String;
    fn try_from(value: Value) -> Result<Self, Self::Error> {
        Condition::from_value(&value).map_err(|err| err.to_string())
    }
}

const MAX_DEPTH: usize = 16;

impl Condition {
    /// Parses a condition, reporting the first problem with its path.
    pub fn from_value(value: &Value) -> Result<Self, ConditionError> {
        Self::parse_at(value, "", 0)
    }

    fn parse_at(value: &Value, path: &str, depth: usize) -> Result<Self, ConditionError> {
        let err = |reason| ConditionError {
            path: path.to_string(),
            reason,
        };
        if depth > MAX_DEPTH {
            return Err(err("too-deep"));
        }
        let map = value.as_object().ok_or_else(|| err("not-an-object"))?;
        for group in ["all", "any", "not"] {
            if let Some(inner) = map.get(group) {
                if map.len() != 1 {
                    return Err(err("mixed-keys"));
                }
                let child_path = format!("{path}.{group}");
                if group == "not" {
                    return Ok(Condition::Not(Box::new(Self::parse_at(
                        inner,
                        &child_path,
                        depth + 1,
                    )?)));
                }
                let items = inner.as_array().ok_or_else(|| ConditionError {
                    path: child_path.clone(),
                    reason: "not-an-array",
                })?;
                if items.is_empty() {
                    return Err(ConditionError {
                        path: child_path,
                        reason: "empty-group",
                    });
                }
                let parsed = items
                    .iter()
                    .enumerate()
                    .map(|(i, item)| Self::parse_at(item, &format!("{child_path}[{i}]"), depth + 1))
                    .collect::<Result<Vec<_>, _>>()?;
                return Ok(if group == "all" {
                    Condition::All(parsed)
                } else {
                    Condition::Any(parsed)
                });
            }
        }
        if let Some(key) = map
            .keys()
            .find(|k| !matches!(k.as_str(), "ref" | "op" | "value"))
        {
            return Err(ConditionError {
                path: format!("{path}.{key}"),
                reason: "unknown-key",
            });
        }
        let reference = map
            .get("ref")
            .and_then(Value::as_str)
            .ok_or_else(|| err("missing-ref"))?;
        let reference = parse_reference(reference).map_err(|_| ConditionError {
            path: format!("{path}.ref"),
            reason: "bad-reference",
        })?;
        let op = map
            .get("op")
            .and_then(Value::as_str)
            .and_then(CompareOp::parse)
            .ok_or_else(|| ConditionError {
                path: format!("{path}.op"),
                reason: "bad-op",
            })?;
        let value = map.get("value").cloned();
        let value_err = |reason| ConditionError {
            path: format!("{path}.value"),
            reason,
        };
        match (op, &value) {
            (CompareOp::Exists, Some(_)) => return Err(value_err("unexpected-value")),
            (CompareOp::Exists, None) => {}
            (_, None) => return Err(value_err("missing-value")),
            (CompareOp::In, Some(Value::Array(items))) if items.iter().all(is_scalar) => {}
            (CompareOp::In, Some(_)) => return Err(value_err("not-a-scalar-array")),
            (_, Some(v)) if is_scalar(v) => {}
            (_, Some(_)) => return Err(value_err("not-a-scalar")),
        }
        Ok(Condition::Compare {
            reference,
            op,
            value,
        })
    }

    /// Every reference the condition reads.
    pub fn references(&self) -> Vec<&Reference> {
        match self {
            Condition::Compare { reference, .. } => vec![reference],
            Condition::All(items) | Condition::Any(items) => {
                items.iter().flat_map(Condition::references).collect()
            }
            Condition::Not(inner) => inner.references(),
        }
    }

    /// Converts back to the on-disk shape.
    pub fn to_value(&self) -> Value {
        match self {
            Condition::Compare {
                reference,
                op,
                value,
            } => {
                let mut map = Map::new();
                map.insert("ref".into(), Value::String(reference.to_string()));
                map.insert("op".into(), Value::String(op.as_str().into()));
                if let Some(value) = value {
                    map.insert("value".into(), value.clone());
                }
                Value::Object(map)
            }
            Condition::All(items) => group("all", items),
            Condition::Any(items) => group("any", items),
            Condition::Not(inner) => {
                let mut map = Map::new();
                map.insert("not".into(), inner.to_value());
                Value::Object(map)
            }
        }
    }

    /// Evaluates the condition. A missing reference makes a comparison
    /// false (including `!=`); `exists` is true for any non-null value.
    /// Ordering a number against a non-number (or similar) is a type error,
    /// which the engine reports as `FLOW_CONDITION_TYPE`.
    pub fn evaluate(
        &self,
        resolve: &dyn Fn(&Reference) -> Option<Value>,
    ) -> Result<bool, ConditionTypeError> {
        match self {
            Condition::All(items) => {
                for item in items {
                    if !item.evaluate(resolve)? {
                        return Ok(false);
                    }
                }
                Ok(true)
            }
            Condition::Any(items) => {
                for item in items {
                    if item.evaluate(resolve)? {
                        return Ok(true);
                    }
                }
                Ok(false)
            }
            Condition::Not(inner) => Ok(!inner.evaluate(resolve)?),
            Condition::Compare {
                reference,
                op,
                value,
            } => {
                let actual = resolve(reference).filter(|v| !v.is_null());
                let Some(actual) = actual else {
                    return Ok(false);
                };
                let expected = value.as_ref().unwrap_or(&Value::Null);
                compare(&actual, *op, expected).ok_or_else(|| ConditionTypeError {
                    reference: reference.to_string(),
                    op: op.as_str(),
                })
            }
        }
    }
}

fn group(key: &str, items: &[Condition]) -> Value {
    let mut map = Map::new();
    map.insert(
        key.into(),
        Value::Array(items.iter().map(Condition::to_value).collect()),
    );
    Value::Object(map)
}

fn is_scalar(value: &Value) -> bool {
    matches!(value, Value::String(_) | Value::Number(_) | Value::Bool(_))
}

/// Equality treating all numbers as f64 (so `7 == 7.0`).
fn loose_eq(a: &Value, b: &Value) -> bool {
    match (a.as_f64(), b.as_f64()) {
        (Some(x), Some(y)) => x == y,
        _ => a == b,
    }
}

fn compare(actual: &Value, op: CompareOp, expected: &Value) -> Option<bool> {
    use std::cmp::Ordering;
    match op {
        CompareOp::Exists => Some(true),
        CompareOp::Eq => Some(loose_eq(actual, expected)),
        CompareOp::Ne => Some(!loose_eq(actual, expected)),
        CompareOp::In => Some(
            expected
                .as_array()?
                .iter()
                .any(|item| loose_eq(actual, item)),
        ),
        CompareOp::Lt | CompareOp::Le | CompareOp::Gt | CompareOp::Ge => {
            let ordering = match (actual, expected) {
                (Value::Number(a), Value::Number(b)) => a.as_f64()?.partial_cmp(&b.as_f64()?)?,
                (Value::String(a), Value::String(b)) => a.cmp(b),
                _ => return None,
            };
            Some(match op {
                CompareOp::Lt => ordering == Ordering::Less,
                CompareOp::Le => ordering != Ordering::Greater,
                CompareOp::Gt => ordering == Ordering::Greater,
                _ => ordering != Ordering::Less,
            })
        }
    }
}

/// An ordering comparison between incompatible types.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConditionTypeError {
    pub reference: String,
    pub op: &'static str,
}

impl Serialize for Condition {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.to_value().serialize(serializer)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn cond(value: Value) -> Condition {
        Condition::from_value(&value).expect("valid condition")
    }

    fn reason(value: Value) -> (String, &'static str) {
        let err = Condition::from_value(&value).expect_err("invalid condition");
        (err.path, err.reason)
    }

    #[test]
    fn parses_and_round_trips() {
        let values = [
            json!({ "ref": "nodes.check.outputs.score", "op": "<", "value": 7 }),
            json!({ "ref": "params.flag", "op": "exists" }),
            json!({ "ref": "item", "op": "in", "value": ["a", "b"] }),
            json!({ "any": [
                { "ref": "iteration.outputs.coverage", "op": ">=", "value": 0.95 },
                { "not": { "ref": "params.x", "op": "==", "value": true } }
            ] }),
            json!({ "all": [ { "ref": "params.a", "op": "!=", "value": "" } ] }),
        ];
        for value in values {
            assert_eq!(cond(value.clone()).to_value(), value);
            // serde goes through the same parser
            let via_serde: Condition = serde_json::from_value(value.clone()).unwrap();
            assert_eq!(serde_json::to_value(&via_serde).unwrap(), value);
        }
    }

    #[test]
    fn reports_malformed_conditions() {
        assert_eq!(reason(json!("x")), ("".into(), "not-an-object"));
        assert_eq!(
            reason(json!({ "op": "==", "value": 1 })),
            ("".into(), "missing-ref")
        );
        assert_eq!(
            reason(json!({ "ref": "a b", "op": "==", "value": 1 })),
            (".ref".into(), "bad-reference")
        );
        assert_eq!(
            reason(json!({ "ref": "params.a", "op": "~", "value": 1 })),
            (".op".into(), "bad-op")
        );
        assert_eq!(
            reason(json!({ "ref": "params.a", "op": "==" })),
            (".value".into(), "missing-value")
        );
        assert_eq!(
            reason(json!({ "ref": "params.a", "op": "exists", "value": 1 })),
            (".value".into(), "unexpected-value")
        );
        assert_eq!(
            reason(json!({ "ref": "params.a", "op": "in", "value": 1 })),
            (".value".into(), "not-a-scalar-array")
        );
        assert_eq!(
            reason(json!({ "ref": "params.a", "op": "==", "value": [1] })),
            (".value".into(), "not-a-scalar")
        );
        assert_eq!(
            reason(json!({ "ref": "params.a", "op": "==", "value": 1, "x": 1 })),
            (".x".into(), "unknown-key")
        );
        assert_eq!(reason(json!({ "all": [] })), (".all".into(), "empty-group"));
        assert_eq!(
            reason(json!({ "any": {} })),
            (".any".into(), "not-an-array")
        );
        assert_eq!(
            reason(json!({ "all": [{}], "ref": "params.a" })),
            ("".into(), "mixed-keys")
        );
        assert_eq!(
            reason(
                json!({ "any": [ { "ref": "params.a", "op": "==", "value": 1 }, { "ref": "params.a" } ] })
            ),
            (".any[1].op".into(), "bad-op")
        );
        let mut deep = json!({ "ref": "params.a", "op": "exists" });
        for _ in 0..20 {
            deep = json!({ "not": deep });
        }
        assert_eq!(Condition::from_value(&deep).unwrap_err().reason, "too-deep");
    }

    #[test]
    fn evaluates_comparisons() {
        let resolve = |r: &Reference| match r.to_string().as_str() {
            "params.score" => Some(json!(7.5)),
            "params.name" => Some(json!("b")),
            "params.flag" => Some(json!(true)),
            "params.null" => Some(Value::Null),
            _ => None,
        };
        let eval = |v: Value| cond(v).evaluate(&resolve);
        assert_eq!(
            eval(json!({ "ref": "params.score", "op": ">=", "value": 7 })),
            Ok(true)
        );
        assert_eq!(
            eval(json!({ "ref": "params.score", "op": "<", "value": 7 })),
            Ok(false)
        );
        assert_eq!(
            eval(json!({ "ref": "params.score", "op": "==", "value": 7.5 })),
            Ok(true)
        );
        assert_eq!(
            eval(json!({ "ref": "params.name", "op": ">", "value": "a" })),
            Ok(true)
        );
        assert_eq!(
            eval(json!({ "ref": "params.name", "op": "in", "value": ["a", "b"] })),
            Ok(true)
        );
        assert_eq!(
            eval(json!({ "ref": "params.flag", "op": "==", "value": true })),
            Ok(true)
        );
        assert_eq!(
            eval(json!({ "ref": "params.flag", "op": "exists" })),
            Ok(true)
        );
        // Missing or null references are false, even for != and exists.
        assert_eq!(
            eval(json!({ "ref": "params.missing", "op": "!=", "value": 1 })),
            Ok(false)
        );
        assert_eq!(
            eval(json!({ "ref": "params.null", "op": "exists" })),
            Ok(false)
        );
        assert_eq!(
            eval(json!({ "not": { "ref": "params.missing", "op": "exists" } })),
            Ok(true)
        );
        assert_eq!(
            eval(
                json!({ "all": [ { "ref": "params.flag", "op": "exists" }, { "ref": "params.score", "op": ">", "value": 9 } ] })
            ),
            Ok(false)
        );
        assert_eq!(
            eval(
                json!({ "any": [ { "ref": "params.missing", "op": "exists" }, { "ref": "params.score", "op": ">", "value": 1 } ] })
            ),
            Ok(true)
        );
        assert_eq!(
            eval(json!({ "ref": "params.name", "op": "<", "value": 3 })),
            Err(ConditionTypeError {
                reference: "params.name".into(),
                op: "<"
            })
        );
    }
}
