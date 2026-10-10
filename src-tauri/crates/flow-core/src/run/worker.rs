//! The resident Python worker of `python` nodes (spec 2026-10-10, chapter 3):
//! the `mdium-worker-v1` JSON-line protocol, the manifest a worker returns
//! to `describe`, input validation against a stage, interpreter resolution
//! and the piped child process behind [`WorkerLauncher`].

use crate::run::model::Reason;
use crate::run::process::{parse_line, ProtocolItem};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::BTreeMap;

pub const WORKER_PROTOCOL_VERSION: u64 = 1;

pub const FLOW_RUNTIME_START_FAILED: &str = "FLOW_RUNTIME_START_FAILED";
pub const FLOW_PYTHON_ENTRY_UNKNOWN: &str = "FLOW_PYTHON_ENTRY_UNKNOWN";
pub const FLOW_PYTHON_INPUT_INVALID: &str = "FLOW_PYTHON_INPUT_INVALID";
pub const FLOW_PYTHON_PROTOCOL: &str = "FLOW_PYTHON_PROTOCOL";
pub const FLOW_PYTHON_WORKER_EXITED: &str = "FLOW_PYTHON_WORKER_EXITED";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StageInputType {
    String,
    Number,
    Bool,
    Path,
    Object,
    Array,
}

impl StageInputType {
    fn accepts(self, value: &Value) -> bool {
        match self {
            StageInputType::String | StageInputType::Path => value.is_string(),
            StageInputType::Number => value.is_number(),
            StageInputType::Bool => value.is_boolean(),
            StageInputType::Object => value.is_object(),
            StageInputType::Array => value.is_array(),
        }
    }
    fn name(self) -> &'static str {
        match self {
            StageInputType::String => "string",
            StageInputType::Number => "number",
            StageInputType::Bool => "bool",
            StageInputType::Path => "path",
            StageInputType::Object => "object",
            StageInputType::Array => "array",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StageInput {
    #[serde(rename = "type")]
    pub ty: StageInputType,
    #[serde(default)]
    pub required: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StageOutput {
    #[serde(rename = "type", default, skip_serializing_if = "Option::is_none")]
    pub ty: Option<StageInputType>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StageArtifact {
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub media_type: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StageDef {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default)]
    pub inputs: BTreeMap<String, StageInput>,
    #[serde(default)]
    pub outputs: BTreeMap<String, StageOutput>,
    #[serde(default)]
    pub artifacts: Vec<StageArtifact>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub module: String,
    #[serde(default)]
    pub stages: Vec<StageDef>,
}

impl Manifest {
    pub fn stage(&self, name: &str) -> Option<&StageDef> {
        self.stages.iter().find(|s| s.name == name)
    }
}

/// One line received from a worker.
#[derive(Debug)]
pub enum WorkerMessage {
    Manifest {
        request_id: String,
        manifest: Manifest,
    },
    Error {
        request_id: Option<String>,
        code: String,
        message: String,
    },
    Log {
        call_id: Option<String>,
        level: String,
        text: String,
    },
    /// A node-level protocol item; `line` is the JSON without `callId`
    /// (what the attempt's `events.jsonl` records).
    Item {
        call_id: Option<String>,
        item: ProtocolItem,
        line: String,
    },
    Invalid {
        reason: &'static str,
    },
}

pub fn parse_worker_line(line: &str) -> WorkerMessage {
    let Ok(Value::Object(mut obj)) = serde_json::from_str::<Value>(line) else {
        return WorkerMessage::Invalid {
            reason: "invalid-json",
        };
    };
    if obj.get("v").and_then(Value::as_u64) != Some(WORKER_PROTOCOL_VERSION) {
        return WorkerMessage::Invalid {
            reason: "unsupported-version",
        };
    }
    let s = |o: &Map<String, Value>, k: &str| o.get(k).and_then(Value::as_str).map(String::from);
    match obj.get("type").and_then(Value::as_str) {
        Some("manifest") => {
            let Some(request_id) = s(&obj, "requestId") else {
                return WorkerMessage::Invalid {
                    reason: "missing-request-id",
                };
            };
            match serde_json::from_value::<Manifest>(Value::Object(obj.clone())) {
                Ok(manifest) => WorkerMessage::Manifest {
                    request_id,
                    manifest,
                },
                Err(_) => WorkerMessage::Invalid {
                    reason: "bad-manifest",
                },
            }
        }
        Some("error") => WorkerMessage::Error {
            request_id: s(&obj, "requestId"),
            code: s(&obj, "code").unwrap_or_else(|| FLOW_PYTHON_PROTOCOL.to_string()),
            message: s(&obj, "message").unwrap_or_default(),
        },
        Some("log") => WorkerMessage::Log {
            call_id: s(&obj, "callId"),
            level: s(&obj, "level").unwrap_or_else(|| "info".to_string()),
            text: s(&obj, "text").unwrap_or_default(),
        },
        Some("progress") | Some("cost") | Some("output") | Some("artifact") | Some("outcome") => {
            let call_id = s(&obj, "callId");
            obj.remove("callId");
            let line = Value::Object(obj).to_string();
            match parse_line(&line) {
                Ok(item) => WorkerMessage::Item {
                    call_id,
                    item,
                    line,
                },
                Err(reason) => WorkerMessage::Invalid { reason },
            }
        }
        _ => WorkerMessage::Invalid {
            reason: "unknown-type",
        },
    }
}

/// Checks `given` against the stage's inputs and fills defaults (spec 3.4).
pub fn validate_inputs(
    stage: &StageDef,
    given: &Map<String, Value>,
) -> Result<Map<String, Value>, Vec<Reason>> {
    let mut errors = Vec::new();
    let mut out = Map::new();
    let bad = |input: &str, reason: &str| {
        Reason::new(FLOW_PYTHON_INPUT_INVALID)
            .with("input", input)
            .with("reason", reason)
    };
    for key in given.keys() {
        if !stage.inputs.contains_key(key) {
            errors.push(bad(key, "unknown"));
        }
    }
    for (name, def) in &stage.inputs {
        let value = given
            .get(name)
            .filter(|v| !v.is_null())
            .cloned()
            .or_else(|| def.default.clone());
        match value {
            None if def.required => errors.push(bad(name, "missing")),
            None => {}
            Some(v) if !def.ty.accepts(&v) => errors.push(
                bad(name, "type")
                    .with("expected", def.ty.name())
                    .with("found", json_type_name(&v)),
            ),
            Some(v) => {
                out.insert(name.clone(), v);
            }
        }
    }
    if errors.is_empty() {
        Ok(out)
    } else {
        Err(errors)
    }
}

fn json_type_name(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "bool",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

/// Where a call runs, as the worker sees it (`context` of `call`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CallContext {
    pub run_id: String,
    pub node_key: String,
    pub node_dir: String,
    pub project_root: String,
    pub stop_file: String,
    pub attempt: u32,
}

pub fn describe_request(request_id: &str) -> String {
    serde_json::json!({ "v": WORKER_PROTOCOL_VERSION, "type": "describe", "requestId": request_id })
        .to_string()
}

pub fn call_request(
    request_id: &str,
    call_id: &str,
    entry: &str,
    inputs: &Map<String, Value>,
    ctx: &CallContext,
) -> String {
    serde_json::json!({
        "v": WORKER_PROTOCOL_VERSION, "type": "call", "requestId": request_id, "callId": call_id,
        "entry": entry, "inputs": inputs, "context": ctx,
    })
    .to_string()
}

pub fn cancel_request(call_id: &str) -> String {
    serde_json::json!({ "v": WORKER_PROTOCOL_VERSION, "type": "cancel", "callId": call_id })
        .to_string()
}

pub fn shutdown_request() -> String {
    serde_json::json!({ "v": WORKER_PROTOCOL_VERSION, "type": "shutdown" }).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::run::process::{ProtocolItem, ProtocolOutcome};
    use serde_json::json;

    fn manifest() -> Manifest {
        serde_json::from_value(json!({
            "module": "demo",
            "stages": [{
                "name": "video.render",
                "description": "Render",
                "inputs": {
                    "videoDir": { "type": "path", "required": true },
                    "title": { "type": "string", "default": "video" },
                    "n": { "type": "number" },
                    "flags": { "type": "object" }
                },
                "outputs": { "videoPath": { "type": "path" } },
                "artifacts": [{ "label": "video", "mediaType": "video/mp4" }]
            }]
        }))
        .unwrap()
    }

    #[test]
    fn parses_manifest_error_log_and_items() {
        let m = parse_worker_line(
            r#"{"v":1,"type":"manifest","requestId":"1","module":"demo","stages":[]}"#,
        );
        assert!(
            matches!(m, WorkerMessage::Manifest { ref request_id, ref manifest } if request_id == "1" && manifest.module == "demo")
        );
        let e = parse_worker_line(
            r#"{"v":1,"type":"error","requestId":"2","code":"FLOW_PYTHON_ENTRY_UNKNOWN","message":"no such stage"}"#,
        );
        assert!(
            matches!(e, WorkerMessage::Error { ref code, .. } if code == "FLOW_PYTHON_ENTRY_UNKNOWN")
        );
        let l = parse_worker_line(
            r#"{"v":1,"type":"log","callId":"c1","level":"warning","text":"hi"}"#,
        );
        assert!(
            matches!(l, WorkerMessage::Log { ref level, ref text, .. } if level == "warning" && text == "hi")
        );
        let p = parse_worker_line(
            r#"{"v":1,"type":"progress","callId":"c1","text":"t","fraction":0.5}"#,
        );
        match p {
            WorkerMessage::Item {
                call_id,
                item: ProtocolItem::Progress { text, fraction },
                line,
            } => {
                assert_eq!(call_id.as_deref(), Some("c1"));
                assert_eq!((text.as_str(), fraction), ("t", Some(0.5)));
                assert!(!line.contains("callId"), "{line}");
                assert!(line.contains("\"type\":\"progress\""));
            }
            other => panic!("{other:?}"),
        }
        let o = parse_worker_line(
            r#"{"v":1,"type":"outcome","callId":"c1","status":"needs_approval","message":"ok?"}"#,
        );
        assert!(
            matches!(o, WorkerMessage::Item { item: ProtocolItem::Outcome(ProtocolOutcome::NeedsApproval(Some(ref m))), .. } if m == "ok?")
        );
        let a = parse_worker_line(
            r#"{"v":1,"type":"artifact","callId":"c1","path":"out/x.mp4","label":"video","mediaType":"video/mp4"}"#,
        );
        assert!(matches!(
            a,
            WorkerMessage::Item {
                item: ProtocolItem::Artifact { .. },
                ..
            }
        ));
    }

    #[test]
    fn rejects_bad_lines_with_a_reason() {
        // Review Focus 1: a stray print() is an invalid line, never a panic.
        assert!(matches!(
            parse_worker_line("hello from print()"),
            WorkerMessage::Invalid {
                reason: "invalid-json"
            }
        ));
        assert!(matches!(
            parse_worker_line(r#"{"v":2,"type":"log"}"#),
            WorkerMessage::Invalid {
                reason: "unsupported-version"
            }
        ));
        assert!(matches!(
            parse_worker_line(r#"{"v":1,"type":"dance"}"#),
            WorkerMessage::Invalid {
                reason: "unknown-type"
            }
        ));
        assert!(matches!(
            parse_worker_line(r#"{"v":1,"type":"output","key":"bad key","value":1}"#),
            WorkerMessage::Invalid { .. }
        ));
    }

    #[test]
    fn validates_inputs_against_the_stage() {
        let stage = manifest().stage("video.render").unwrap().clone();
        let given = json!({ "videoDir": "/v", "n": 2, "flags": { "a": true } });
        let filled = validate_inputs(&stage, given.as_object().unwrap()).unwrap();
        assert_eq!(filled["title"], "video");
        assert_eq!(filled["n"], 2);
        let bad = json!({ "title": "t", "n": "3", "extra": 1 });
        let errs = validate_inputs(&stage, bad.as_object().unwrap()).unwrap_err();
        let reasons: Vec<(String, String)> = errs
            .iter()
            .map(|r| {
                (
                    r.params["input"].as_str().unwrap().to_string(),
                    r.params["reason"].as_str().unwrap().to_string(),
                )
            })
            .collect();
        assert!(
            reasons.contains(&("videoDir".into(), "missing".into())),
            "{reasons:?}"
        );
        assert!(
            reasons.contains(&("n".into(), "type".into())),
            "{reasons:?}"
        );
        assert!(
            reasons.contains(&("extra".into(), "unknown".into())),
            "{reasons:?}"
        );
        assert!(errs.iter().all(|r| r.code == FLOW_PYTHON_INPUT_INVALID));
        let null_default = json!({ "videoDir": "/v", "title": null });
        assert_eq!(
            validate_inputs(&stage, null_default.as_object().unwrap()).unwrap()["title"],
            "video"
        );
    }

    #[test]
    fn builds_requests_as_single_lines() {
        let ctx = CallContext {
            run_id: "r".into(),
            node_key: "a".into(),
            node_dir: "/d".into(),
            project_root: "/p".into(),
            stop_file: "/p/STOP".into(),
            attempt: 1,
        };
        let call = call_request(
            "7",
            "c7",
            "video.render",
            json!({ "x": 1 }).as_object().unwrap(),
            &ctx,
        );
        let v: Value = serde_json::from_str(&call).unwrap();
        assert_eq!(v["v"], 1);
        assert_eq!(v["type"], "call");
        assert_eq!(v["requestId"], "7");
        assert_eq!(v["callId"], "c7");
        assert_eq!(v["entry"], "video.render");
        assert_eq!(v["inputs"]["x"], 1);
        assert_eq!(v["context"]["nodeKey"], "a");
        assert_eq!(v["context"]["attempt"], 1);
        assert!(!call.contains('\n'));
        assert_eq!(
            serde_json::from_str::<Value>(&describe_request("1")).unwrap()["type"],
            "describe"
        );
        assert_eq!(
            serde_json::from_str::<Value>(&cancel_request("c7")).unwrap()["callId"],
            "c7"
        );
        assert_eq!(
            serde_json::from_str::<Value>(&shutdown_request()).unwrap()["type"],
            "shutdown"
        );
    }
}
