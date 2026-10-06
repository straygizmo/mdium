//! Text → [`FlowDef`]: syntax (YAML / JSON), the schema version, a key
//! check of every object (unknown node attributes are errors, unknown
//! top-level keys are warnings), condition syntax, and the serde decode.

use crate::flow::condition::Condition;
use crate::flow::issues::*;
use crate::flow::model::{FlowDef, FlowNode, FLOW_SCHEMA_VERSION};
use serde_json::{Map, Value};

/// On-disk format of a flow file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FlowFormat {
    Yaml,
    Json,
}

impl FlowFormat {
    /// Format by file name: `*.flow.yaml` / `*.flow.yml` / `*.flow.json`.
    pub fn from_file_name(name: &str) -> Option<Self> {
        let lower = name.to_ascii_lowercase();
        if lower.ends_with(".flow.yaml") || lower.ends_with(".flow.yml") {
            Some(Self::Yaml)
        } else if lower.ends_with(".flow.json") {
            Some(Self::Json)
        } else {
            None
        }
    }
}

/// Parses the text into a JSON value (`FLOW_PARSE_FAILED` with line/column).
pub fn parse_text(text: &str, format: FlowFormat) -> Result<Value, FlowIssue> {
    match format {
        FlowFormat::Json => serde_json::from_str(text).map_err(|err| {
            FlowIssue::new(FLOW_PARSE_FAILED, "")
                .with("line", err.line())
                .with("column", err.column())
                .with("message", err.to_string())
        }),
        FlowFormat::Yaml => {
            // Going through serde_yaml_ng's own Value rejects duplicate keys,
            // which a direct decode into serde_json::Value would silently merge.
            let yaml: serde_yaml_ng::Value = serde_yaml_ng::from_str(text).map_err(|err| {
                let mut issue =
                    FlowIssue::new(FLOW_PARSE_FAILED, "").with("message", err.to_string());
                if let Some(location) = err.location() {
                    issue = issue
                        .with("line", location.line())
                        .with("column", location.column());
                }
                issue
            })?;
            // Not expected for values serde_yaml_ng produces; reported as a parse failure.
            serde_json::to_value(&yaml).map_err(|err| {
                FlowIssue::new(FLOW_PARSE_FAILED, "").with("message", err.to_string())
            })
        }
    }
}

const TOP_LEVEL_KEYS: &[&str] = &[
    "schemaVersion",
    "id",
    "name",
    "description",
    "params",
    "defaults",
    "limits",
    "env",
    "envPassthrough",
    "nodes",
    "edges",
    "outputs",
    "ui",
];
const PARAM_KEYS: &[&str] = &["type", "required", "default", "description"];
const DEFAULTS_KEYS: &[&str] = &["timeout", "retry", "workingDir"];
const LIMITS_KEYS: &[&str] = &["maxConcurrentNodes", "budgetUsd", "stopGrace"];
const RETRY_KEYS: &[&str] = &["max", "backoff", "on"];
const COST_KEYS: &[&str] = &["estimateUsd", "budgetUsd"];
/// Deprecated key under `limits` (warned, then ignored).
const DEPRECATED_LIMITS_MAX_TRAVERSALS: &str = "maxTraversals";
const EDGE_KEYS: &[&str] = &["from", "to", "port", "maxTraversals"];
const BODY_KEYS: &[&str] = &["nodes", "edges", "outputs"];
const CASE_KEYS: &[&str] = &["when", "port"];
const COMMON_NODE_KEYS: &[&str] = &[
    "id",
    "kind",
    "name",
    "description",
    "timeout",
    "retry",
    "cost",
    "when",
    "concurrencyKey",
];

/// Attributes specific to each node kind (`None` for an unknown kind).
fn kind_keys(kind: &str) -> Option<&'static [&'static str]> {
    Some(match kind {
        "agent" => &[
            "provider",
            "model",
            "prompt",
            "promptRef",
            "permission",
            "outputContract",
            "policy",
            "workingDir",
        ],
        "command" => &[
            "run",
            "shell",
            "workingDir",
            "env",
            "successCodes",
            "protocol",
            "detach",
        ],
        "approval" => &["message", "show", "options"],
        "loop" => &[
            "mode",
            "items",
            "until",
            "maxIterations",
            "parallelism",
            "body",
            "as",
            "onItemFailure",
            "params",
        ],
        "branch" => &["cases", "default"],
        "subflow" => &["flow", "params"],
        "action" => &["uses", "with"],
        _ => return None,
    })
}

/// Result of decoding a parsed value.
pub struct Decoded {
    pub flow: Option<FlowDef>,
    pub issues: Issues,
}

/// Checks the structure of `value` and decodes it. `flow` is `None` when
/// any error was found (later checks would only produce follow-up noise).
pub fn decode(value: &Value) -> Decoded {
    let mut issues = Issues::default();
    let Some(root) = value.as_object() else {
        issues.error(FlowIssue::new(FLOW_INVALID_VALUE, "").with("reason", "not-an-object"));
        return Decoded { flow: None, issues };
    };
    match root.get("schemaVersion").and_then(Value::as_u64) {
        Some(v) if v == u64::from(FLOW_SCHEMA_VERSION) => {}
        other => {
            let found = root.get("schemaVersion").cloned().unwrap_or(Value::Null);
            let _ = other;
            issues.error(
                FlowIssue::new(FLOW_SCHEMA_UNSUPPORTED, "schemaVersion")
                    .with("found", found)
                    .with("supported", FLOW_SCHEMA_VERSION),
            );
            return Decoded { flow: None, issues };
        }
    }
    for key in root.keys() {
        if !TOP_LEVEL_KEYS.contains(&key.as_str()) {
            issues.warn(FlowIssue::new(FLOW_UNKNOWN_KEY, key.clone()).with("key", key.clone()));
        }
    }
    if let Some(params) = root.get("params").and_then(Value::as_object) {
        for (name, def) in params {
            check_keys(def, &format!("params.{name}"), PARAM_KEYS, &mut issues);
        }
    }
    if let Some(defaults) = root.get("defaults") {
        check_keys(defaults, "defaults", DEFAULTS_KEYS, &mut issues);
        if let Some(retry) = defaults.get("retry") {
            check_keys(retry, "defaults.retry", RETRY_KEYS, &mut issues);
        }
    }
    if let Some(limits) = root.get("limits") {
        // `limits.maxTraversals` was dropped: every back-edge states its own
        // bound. Warn and ignore it rather than failing older files.
        let mut limits = limits.clone();
        if let Some(map) = limits.as_object_mut() {
            if map.remove(DEPRECATED_LIMITS_MAX_TRAVERSALS).is_some() {
                issues.warn(
                    FlowIssue::new(FLOW_DEPRECATED_FIELD, "limits.maxTraversals")
                        .with("field", "limits.maxTraversals")
                        .with("replacement", "edges[].maxTraversals"),
                );
            }
        }
        check_keys(&limits, "limits", LIMITS_KEYS, &mut issues);
    }
    check_graph(root, "", &mut issues);
    if issues.has_errors() {
        return Decoded { flow: None, issues };
    }
    // Drop unknown top-level keys (already warned) before decoding.
    let mut known: Map<String, Value> = root
        .iter()
        .filter(|(k, _)| TOP_LEVEL_KEYS.contains(&k.as_str()))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    if let Some(limits) = known.get_mut("limits").and_then(Value::as_object_mut) {
        limits.remove(DEPRECATED_LIMITS_MAX_TRAVERSALS);
    }
    match serde_json::from_value::<FlowDef>(Value::Object(known)) {
        Ok(flow) => Decoded {
            flow: Some(flow),
            issues,
        },
        Err(err) => {
            issues.error(invalid_value("", &err));
            Decoded { flow: None, issues }
        }
    }
}

fn invalid_value(path: &str, err: &serde_json::Error) -> FlowIssue {
    FlowIssue::new(FLOW_INVALID_VALUE, path)
        .with("reason", "decode")
        .with("message", err.to_string())
}

/// Reports keys of `value` (if it is an object) that are not in `allowed`.
fn check_keys(value: &Value, path: &str, allowed: &[&str], issues: &mut Issues) {
    if let Some(map) = value.as_object() {
        for key in map.keys() {
            if !allowed.contains(&key.as_str()) {
                issues.error(
                    FlowIssue::new(FLOW_UNKNOWN_FIELD, join(path, key)).with("field", key.clone()),
                );
            }
        }
    }
}

fn join(path: &str, key: &str) -> String {
    if path.is_empty() {
        key.to_string()
    } else {
        format!("{path}.{key}")
    }
}

/// Checks `nodes` / `edges` of a scope (the root or an inline loop body).
fn check_graph(scope: &Map<String, Value>, path: &str, issues: &mut Issues) {
    if let Some(nodes) = scope.get("nodes").and_then(Value::as_array) {
        for (i, node) in nodes.iter().enumerate() {
            check_node(node, &format!("{}[{i}]", join(path, "nodes")), issues);
        }
    }
    if let Some(edges) = scope.get("edges").and_then(Value::as_array) {
        for (i, edge) in edges.iter().enumerate() {
            check_keys(
                edge,
                &format!("{}[{i}]", join(path, "edges")),
                EDGE_KEYS,
                issues,
            );
        }
    }
}

fn check_condition(value: &Value, path: &str, issues: &mut Issues) {
    if let Err(err) = Condition::from_value(value) {
        issues.error(
            FlowIssue::new(FLOW_CONDITION_INVALID, format!("{path}{}", err.path))
                .with("reason", err.reason),
        );
    }
}

fn check_node(node: &Value, path: &str, issues: &mut Issues) {
    let before = issues.errors.len();
    let Some(map) = node.as_object() else {
        issues.error(FlowIssue::new(FLOW_INVALID_VALUE, path).with("reason", "not-an-object"));
        return;
    };
    let kind = map.get("kind").and_then(Value::as_str).unwrap_or("");
    let Some(specific) = kind_keys(kind) else {
        issues.error(
            FlowIssue::new(FLOW_UNKNOWN_NODE_KIND, join(path, "kind"))
                .with("kind", map.get("kind").cloned().unwrap_or(Value::Null)),
        );
        return;
    };
    for key in map.keys() {
        if !COMMON_NODE_KEYS.contains(&key.as_str()) && !specific.contains(&key.as_str()) {
            issues.error(
                FlowIssue::new(FLOW_UNKNOWN_FIELD, join(path, key))
                    .with("field", key.clone())
                    .with("kind", kind),
            );
        }
    }
    if let Some(retry) = map.get("retry") {
        check_keys(retry, &join(path, "retry"), RETRY_KEYS, issues);
    }
    if let Some(cost) = map.get("cost") {
        check_keys(cost, &join(path, "cost"), COST_KEYS, issues);
    }
    if let Some(when) = map.get("when") {
        check_condition(when, &join(path, "when"), issues);
    }
    match kind {
        "loop" => {
            if let Some(until) = map.get("until") {
                check_condition(until, &join(path, "until"), issues);
            }
            if let Some(body) = map.get("body").and_then(Value::as_object) {
                let body_path = join(path, "body");
                check_keys(&Value::Object(body.clone()), &body_path, BODY_KEYS, issues);
                check_graph(body, &body_path, issues);
            }
        }
        "branch" => {
            if let Some(cases) = map.get("cases").and_then(Value::as_array) {
                for (i, case) in cases.iter().enumerate() {
                    let case_path = format!("{}[{i}]", join(path, "cases"));
                    check_keys(case, &case_path, CASE_KEYS, issues);
                    if let Some(when) = case.get("when") {
                        check_condition(when, &join(&case_path, "when"), issues);
                    }
                }
            }
        }
        _ => {}
    }
    // Decode the node on its own so a type error carries the node's path.
    if issues.errors.len() == before {
        if let Err(err) = serde_json::from_value::<FlowNode>(node.clone()) {
            issues.error(invalid_value(path, &err));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn codes(issues: &[FlowIssue]) -> Vec<(String, String)> {
        issues
            .iter()
            .map(|i| (i.code.clone(), i.path.clone()))
            .collect()
    }

    #[test]
    fn format_from_file_name() {
        assert_eq!(
            FlowFormat::from_file_name("a.flow.yaml"),
            Some(FlowFormat::Yaml)
        );
        assert_eq!(
            FlowFormat::from_file_name("A.FLOW.YML"),
            Some(FlowFormat::Yaml)
        );
        assert_eq!(
            FlowFormat::from_file_name("a.flow.json"),
            Some(FlowFormat::Json)
        );
        assert_eq!(FlowFormat::from_file_name("a.yaml"), None);
        assert_eq!(FlowFormat::from_file_name("flow.json"), None);
    }

    #[test]
    fn parse_errors_carry_location() {
        let err = parse_text("a: [1, 2\nb: c", FlowFormat::Yaml).unwrap_err();
        assert_eq!(err.code, FLOW_PARSE_FAILED);
        assert!(err.params.contains_key("line"));
        let err = parse_text("{\n  \"a\": }", FlowFormat::Json).unwrap_err();
        assert_eq!(err.code, FLOW_PARSE_FAILED);
        assert_eq!(err.params["line"], json!(2));
    }

    #[test]
    fn duplicate_yaml_keys_fail_to_parse() {
        let err = parse_text("a: 1\na: 2\n", FlowFormat::Yaml).unwrap_err();
        assert_eq!(err.code, FLOW_PARSE_FAILED);
    }

    #[test]
    fn nested_unknown_fields_are_errors() {
        let value = json!({
            "schemaVersion": 1, "id": "f", "name": "F",
            "defaults": { "timeout": "1m", "colour": 1, "retry": { "max": 1, "x": 2 } },
            "limits": { "maxConcurrentNodes": 1, "y": 1 },
            "params": { "p": { "type": "string", "requird": true } },
            "nodes": [
                { "id": "a", "kind": "command", "run": ["x"], "retry": { "max": 1, "tries": 2 },
                  "cost": { "estimate": 1 } },
                { "id": "b", "kind": "loop", "mode": "foreach", "items": [1], "maxIterations": 1,
                  "body": { "nodes": [ { "id": "c", "kind": "approval", "prompt": "x" } ],
                            "edges": [ { "from": "c", "to": "c", "label": "x" } ], "z": 1 } },
                { "id": "d", "kind": "branch", "cases": [ { "when": { "ref": "params.p", "op": "exists" }, "port": "p", "q": 1 } ] }
            ],
            "edges": [ { "from": "a", "to": "b", "weight": 1 } ]
        });
        let decoded = decode(&value);
        assert!(decoded.flow.is_none());
        let mut found = codes(&decoded.issues.errors);
        found.sort();
        let mut expected: Vec<(String, String)> = [
            "defaults.colour",
            "defaults.retry.x",
            "limits.y",
            "params.p.requird",
            "nodes[0].retry.tries",
            "nodes[0].cost.estimate",
            "nodes[1].body.z",
            "nodes[1].body.nodes[0].prompt",
            "nodes[1].body.edges[0].label",
            "nodes[2].cases[0].q",
            "edges[0].weight",
        ]
        .iter()
        .map(|p| (FLOW_UNKNOWN_FIELD.to_string(), p.to_string()))
        .collect();
        expected.sort();
        assert_eq!(found, expected);
    }

    #[test]
    fn decode_reports_type_errors_with_node_path() {
        let value = json!({
            "schemaVersion": 1, "id": "f", "name": "F",
            "nodes": [
                { "id": "a", "kind": "command", "run": ["x"] },
                { "id": "b", "kind": "command", "run": 5 }
            ]
        });
        let decoded = decode(&value);
        assert_eq!(
            codes(&decoded.issues.errors),
            vec![(FLOW_INVALID_VALUE.into(), "nodes[1]".into())]
        );
    }

    #[test]
    fn root_must_be_an_object() {
        let decoded = decode(&json!([1]));
        assert_eq!(
            codes(&decoded.issues.errors),
            vec![(FLOW_INVALID_VALUE.into(), "".into())]
        );
    }
}
