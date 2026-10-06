//! End-to-end engine tests with real child processes (the test binary in
//! helper mode, see `test_helper`).

use crate::flow::run::driver::*;
use crate::flow::run::engine::*;
use crate::flow::run::model::*;
use crate::flow::run::process::AttachedLauncher;
use crate::flow::run::store::{RunMeta, RunStore, RUN_SCHEMA_VERSION};
use crate::flow::run::test_helper::{detached_launcher, helper_argv, helper_env, process_alive};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[derive(Default)]
struct Sink {
    runs: Mutex<Vec<(String, RunStatus)>>,
    nodes: Mutex<Vec<(String, NodeStatus)>>,
    progress: Mutex<Vec<String>>,
}

impl EventSink for Sink {
    fn run_changed(&self, _: &Path, run_id: &str, state: &RunState) {
        self.runs
            .lock()
            .unwrap()
            .push((run_id.to_string(), state.status));
    }
    fn node_changed(&self, _: &Path, _: &str, key: &str, node: &NodeState, _: u64) {
        self.nodes
            .lock()
            .unwrap()
            .push((key.to_string(), node.status));
    }
    fn progress(&self, _: &Path, _: &str, _: &str, progress: &Progress) {
        self.progress.lock().unwrap().push(progress.text.clone());
    }
}

#[derive(Default)]
struct Notifier {
    requests: Mutex<Vec<ApprovalRequest>>,
}

impl ApprovalNotifier for Notifier {
    fn approval_requested(&self, _: &Path, _: &str, request: &ApprovalRequest) {
        self.requests.lock().unwrap().push(request.clone());
    }
}

struct Fixture {
    _tmp: tempfile::TempDir,
    root: PathBuf,
    config: PathBuf,
    engine: FlowEngine,
    sink: Arc<Sink>,
    notifier: Arc<Notifier>,
}

fn make_engine(config: &Path, sink: Arc<Sink>, notifier: Arc<Notifier>) -> FlowEngine {
    let env = DriverEnv {
        launcher: Arc::new(AttachedLauncher),
        // Commands run detached by default, as in the app.
        detached: Some(Arc::new(detached_launcher())),
        sink,
        notifiers: Arc::new(vec![notifier as Arc<dyn ApprovalNotifier>]),
        process_env: Arc::new(std::env::vars().collect()),
        poll: Duration::from_millis(20),
    };
    FlowEngine::new(env, config.join("confirmations.json"))
}

fn fixture() -> Fixture {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("project");
    let config = tmp.path().join("config");
    std::fs::create_dir_all(&root).unwrap();
    let sink = Arc::new(Sink::default());
    let notifier = Arc::new(Notifier::default());
    let engine = make_engine(&config, sink.clone(), notifier.clone());
    Fixture {
        _tmp: tmp,
        root,
        config,
        engine,
        sink,
        notifier,
    }
}

/// A command node running the helper with `steps`.
fn cmd(id: &str, steps: Value) -> Value {
    let (k, v) = helper_env(steps.as_array().unwrap());
    json!({ "id": id, "kind": "command", "run": helper_argv(), "env": { k: v } })
}

fn ev(value: Value) -> Value {
    json!({ "emit": value })
}

fn write_flow(
    root: &Path,
    name: &str,
    extra: Value,
    nodes: Vec<Value>,
    edges: Vec<Value>,
) -> String {
    let mut flow =
        json!({ "schemaVersion": 1, "id": name, "name": name, "nodes": nodes, "edges": edges });
    for (k, v) in extra.as_object().cloned().unwrap_or_default() {
        flow[k] = v;
    }
    let rel = format!(".mdium/flows/{name}.flow.json");
    let path = root.join(&rel);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, serde_json::to_vec_pretty(&flow).unwrap()).unwrap();
    rel
}

impl Fixture {
    fn confirm_and_start(&self, rel: &str, params: Value) -> String {
        let review = self.engine.review_commands(&self.root, rel).unwrap();
        self.engine
            .confirm_commands(&self.root, rel, &review.sha256)
            .unwrap();
        let params: BTreeMap<String, Value> = serde_json::from_value(params).unwrap();
        self.engine
            .start(&self.root, rel, &params, &review.sha256)
            .unwrap()
            .run_id
    }

    fn snapshot(&self, run_id: &str) -> RunSnapshot {
        self.engine.get(&self.root, run_id).unwrap()
    }

    fn wait_for(
        &self,
        run_id: &str,
        what: &str,
        pred: impl Fn(&RunSnapshot) -> bool,
    ) -> RunSnapshot {
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            let snap = self.snapshot(run_id);
            if pred(&snap) {
                return snap;
            }
            if Instant::now() > deadline {
                panic!("timed out waiting for {what}: {:#?}", snap.state);
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    fn wait_status(&self, run_id: &str, status: RunStatus) -> RunSnapshot {
        let snap = self.wait_for(run_id, &format!("{status:?}"), |s| {
            s.state.status == status && !s.active
        });
        snap
    }

    fn wait_settled(&self, run_id: &str, status: RunStatus) -> RunSnapshot {
        assert!(
            self.engine
                .wait_idle(&self.root, run_id, Duration::from_secs(30)),
            "driver did not finish"
        );
        let snap = self.snapshot(run_id);
        assert_eq!(snap.state.status, status, "{:#?}", snap.state);
        snap
    }

    fn events(&self, run_id: &str) -> Vec<FlowEvent> {
        RunStore::new(&self.root).read_events(run_id).unwrap()
    }
}

fn node(snap: &RunSnapshot, key: &str) -> NodeState {
    snap.state.nodes[key].clone()
}

// ------------------------------------------------------------ happy path

#[test]
fn runs_commands_with_protocol_env_and_templates() {
    let f = fixture();
    let dump = f.root.join("env.json");
    let rel = write_flow(
        &f.root,
        "happy",
        json!({ "params": { "label": { "type": "string", "default": "L" } } }),
        vec![
            cmd(
                "a",
                json!([
                    { "stdout": "hello from a" },
                    ev(json!({ "v": 1, "type": "progress", "text": "1/2", "fraction": 0.5 })),
                    ev(json!({ "v": 1, "type": "cost", "usd": 0.25, "kind": "actual", "provider": "p" })),
                    ev(json!({ "v": 1, "type": "cost", "usd": 0.5, "kind": "estimated" })),
                    ev(json!({ "v": 1, "type": "output", "key": "score", "value": 7 })),
                    ev(json!({ "v": 1, "type": "artifact", "path": "out/a.md", "label": "doc" })),
                    { "emit_raw": "not json" },
                    ev(json!({ "v": 1, "type": "outcome", "status": "ok" })),
                ]),
            ),
            {
                let mut b = cmd("b", json!([{ "dump_env": dump.to_string_lossy() }]));
                b["run"]
                    .as_array_mut()
                    .unwrap()
                    .push(json!("${{ nodes.a.outputs.score }}-${{ params.label }}"));
                b["env"]["FLOWT_RUN"] = json!("${{ run.id }}");
                b
            },
        ],
        vec![json!({ "from": "a", "to": "b" })],
    );
    let run_id = f.confirm_and_start(&rel, json!({}));
    let snap = f.wait_settled(&run_id, RunStatus::Completed);
    let a = node(&snap, "a");
    assert_eq!(a.status, NodeStatus::Succeeded);
    assert_eq!(a.attempt, 1);
    assert_eq!(a.outputs["score"], json!(7));
    assert_eq!(a.artifacts[0].path, "out/a.md");
    assert_eq!(
        a.cost,
        CostTotals {
            actual: 0.25,
            estimated: 0.5
        }
    );
    assert_eq!(snap.state.cost.total(), 0.75);
    assert_eq!(node(&snap, "b").status, NodeStatus::Succeeded);
    assert_eq!(snap.meta.params["label"], json!("L"));

    // The second command saw the rendered argument and the six variables.
    let dumped: Value = serde_json::from_slice(&std::fs::read(&dump).unwrap()).unwrap();
    let args: Vec<String> = serde_json::from_value(dumped["args"].clone()).unwrap();
    assert_eq!(args.last().unwrap(), "7-L");
    assert_eq!(dumped["env"]["FLOWT_RUN"], json!(run_id));
    let store = RunStore::new(&f.root);
    let dir = store.node_attempt_dir(&run_id, "b", 1).unwrap();
    let env = &dumped["env"];
    assert_eq!(env["MDIUM_FLOW_RUN_ID"], json!(run_id));
    assert_eq!(env["MDIUM_FLOW_NODE_KEY"], json!("b"));
    assert_eq!(env["MDIUM_FLOW_NODE_DIR"], json!(dir.to_string_lossy()));
    assert_eq!(
        env["MDIUM_FLOW_EVENTS_FILE"],
        json!(dir.join("events.jsonl").to_string_lossy())
    );
    assert_eq!(
        env["MDIUM_FLOW_INPUTS_FILE"],
        json!(dir.join("inputs.json").to_string_lossy())
    );
    assert_eq!(
        env["MDIUM_FLOW_STOP_FILE"],
        json!(store.stop_file(&run_id).unwrap().to_string_lossy())
    );
    assert_eq!(
        std::fs::read_to_string(dir.join("inputs.json")).unwrap(),
        "{}"
    );
    assert_eq!(
        PathBuf::from(dumped["cwd"].as_str().unwrap())
            .canonicalize()
            .unwrap(),
        f.root.canonicalize().unwrap()
    );

    // Logs, outputs.json, warnings, and the sink.
    let log = f
        .engine
        .log(&f.root, &run_id, "a", 1, "stdout", 4096)
        .unwrap();
    assert!(log.contains("hello from a"), "{log}");
    let outputs: Value = serde_json::from_slice(
        &std::fs::read(
            store
                .node_attempt_dir(&run_id, "a", 1)
                .unwrap()
                .join("outputs.json"),
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(outputs, json!({ "score": 7 }));
    let events = f.events(&run_id);
    assert!(events
        .iter()
        .any(|e| matches!(&e.body, EventBody::Warning(r) if r.code == FLOW_PROTOCOL_WARNING)));
    assert!(events
        .iter()
        .any(|e| matches!(&e.body, EventBody::Process { .. })));
    assert!(
        events.windows(2).all(|w| w[1].seq == w[0].seq + 1),
        "seq increases by one"
    );
    assert!(f
        .sink
        .runs
        .lock()
        .unwrap()
        .iter()
        .any(|(_, s)| *s == RunStatus::Completed));
    assert!(f
        .sink
        .nodes
        .lock()
        .unwrap()
        .contains(&("b".to_string(), NodeStatus::Succeeded)));
    assert_eq!(f.sink.progress.lock().unwrap().as_slice(), ["1/2"]);
    // The checkpoint equals a full replay.
    let checkpoint: RunState = serde_json::from_slice(
        &std::fs::read(store.run_dir(&run_id).unwrap().join("state.json")).unwrap(),
    )
    .unwrap();
    std::fs::remove_file(store.run_dir(&run_id).unwrap().join("state.json")).unwrap();
    assert_eq!(store.load_state(&run_id, &snap.meta).unwrap(), checkpoint);
    // Listing.
    let list = f.engine.list(&f.root).unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].status, RunStatus::Completed);
    assert_eq!(list[0].cost_usd, 0.75);
}

#[test]
fn shell_commands_and_protocol_none() {
    let f = fixture();
    let rel = write_flow(
        &f.root,
        "shell",
        json!({}),
        vec![
            json!({ "id": "s", "kind": "command", "run": "echo shell-ok", "shell": true }),
            {
                let mut n = cmd(
                    "n",
                    json!([ev(json!({ "v": 1, "type": "outcome", "status": "fail" }))]),
                );
                n["protocol"] = json!("none");
                n
            },
        ],
        vec![json!({ "from": "s", "to": "n" })],
    );
    let run_id = f.confirm_and_start(&rel, json!({}));
    f.wait_settled(&run_id, RunStatus::Completed);
    let log = f
        .engine
        .log(&f.root, &run_id, "s", 1, "stdout", 4096)
        .unwrap();
    assert!(log.contains("shell-ok"), "{log}");
}

// --------------------------------------------------- confirmation & start

#[test]
fn commands_must_be_confirmed_for_the_exact_content() {
    let f = fixture();
    let rel = write_flow(&f.root, "c", json!({}), vec![cmd("a", json!([]))], vec![]);
    let review = f.engine.review_commands(&f.root, &rel).unwrap();
    assert!(!review.confirmed);
    assert_eq!(review.commands.len(), 1);
    assert_eq!(review.commands[0].node_id, "a");
    let none = BTreeMap::new();
    let err = f
        .engine
        .start(&f.root, &rel, &none, &review.sha256)
        .unwrap_err();
    assert_eq!(err.code, FLOW_COMMANDS_UNCONFIRMED);
    assert_eq!(
        f.engine
            .start(&f.root, &rel, &none, "beef")
            .unwrap_err()
            .code,
        FLOW_FILE_CHANGED
    );
    assert_eq!(
        f.engine
            .confirm_commands(&f.root, &rel, "beef")
            .unwrap_err()
            .code,
        FLOW_FILE_CHANGED
    );
    f.engine
        .confirm_commands(&f.root, &rel, &review.sha256)
        .unwrap();
    assert!(f.engine.review_commands(&f.root, &rel).unwrap().confirmed);
    // Confirmations are per machine, not per engine instance.
    let other = make_engine(&f.config, f.sink.clone(), f.notifier.clone());
    assert!(other.review_commands(&f.root, &rel).unwrap().confirmed);
    // Editing the file invalidates the confirmation.
    let rel2 = write_flow(
        &f.root,
        "c",
        json!({ "description": "changed" }),
        vec![cmd("a", json!([]))],
        vec![],
    );
    let review2 = f.engine.review_commands(&f.root, &rel2).unwrap();
    assert_ne!(review2.sha256, review.sha256);
    assert!(!review2.confirmed);
    assert_eq!(
        f.engine
            .start(&f.root, &rel2, &none, &review2.sha256)
            .unwrap_err()
            .code,
        FLOW_COMMANDS_UNCONFIRMED
    );
    // A flow without commands needs no confirmation.
    let rel3 = write_flow(
        &f.root,
        "noc",
        json!({}),
        vec![json!({ "id": "x", "kind": "approval" })],
        vec![],
    );
    let review3 = f.engine.review_commands(&f.root, &rel3).unwrap();
    assert!(review3.confirmed && review3.commands.is_empty());
    f.engine
        .start(&f.root, &rel3, &none, &review3.sha256)
        .unwrap();
}

#[test]
fn start_rejects_invalid_unsupported_or_unsafe_flows() {
    let f = fixture();
    let start = |rel: &str, params: Value| {
        let sha = f.engine.review_commands(&f.root, rel).map(|r| r.sha256);
        let sha = sha.unwrap_or_default();
        let _ = f.engine.confirm_commands(&f.root, rel, &sha);
        f.engine
            .start(&f.root, rel, &serde_json::from_value(params).unwrap(), &sha)
            .unwrap_err()
    };
    let agent = write_flow(
        &f.root,
        "agent",
        json!({}),
        vec![
            json!({ "id": "a", "kind": "agent", "provider": "claude", "permission": "read-only", "prompt": "x" }),
        ],
        vec![],
    );
    let err = start(&agent, json!({}));
    assert_eq!(err.code, FLOW_RUN_NOT_RUNNABLE);
    assert_eq!(err.details[0].params["feature"], "agent");
    let unsafe_flow = write_flow(
        &f.root,
        "unsafe",
        json!({ "params": { "p": { "type": "string", "default": "x" } } }),
        vec![json!({ "id": "a", "kind": "command", "run": ["${{ params.p }}"] })],
        vec![],
    );
    assert_eq!(
        start(&unsafe_flow, json!({})).details[0].code,
        "FLOW_RUN_UNSAFE_TEMPLATE"
    );
    let invalid = write_flow(
        &f.root,
        "invalid",
        json!({}),
        vec![json!({ "id": "a", "kind": "command", "run": [] })],
        vec![],
    );
    // Invalid flows can be neither reviewed nor started.
    assert_eq!(
        f.engine
            .review_commands(&f.root, &invalid)
            .unwrap_err()
            .code,
        FLOW_FILE_INVALID
    );
    assert_eq!(
        f.engine
            .start(&f.root, &invalid, &BTreeMap::new(), "x")
            .unwrap_err()
            .code,
        FLOW_FILE_INVALID
    );
    let params = write_flow(
        &f.root,
        "params",
        json!({ "params": { "dir": { "type": "path", "required": true } } }),
        vec![cmd("a", json!([]))],
        vec![],
    );
    let err = start(&params, json!({ "nope": 1 }));
    assert_eq!(err.code, FLOW_PARAMS_INVALID);
    assert_eq!(err.details.len(), 2);
    assert_eq!(
        f.engine
            .start(&f.root, "../x.flow.json", &BTreeMap::new(), "")
            .unwrap_err()
            .code,
        FLOW_FILE_PATH_INVALID
    );
    assert!(
        f.engine.list(&f.root).unwrap().is_empty(),
        "nothing was started"
    );
}

// ------------------------------------------------- failures and retries

#[test]
fn failure_without_handler_fails_the_run_and_with_handler_continues() {
    let f = fixture();
    let rel = write_flow(
        &f.root,
        "fail",
        json!({}),
        vec![cmd("a", json!([{ "exit": 3 }])), cmd("b", json!([]))],
        vec![json!({ "from": "a", "to": "b" })],
    );
    let run_id = f.confirm_and_start(&rel, json!({}));
    let snap = f.wait_settled(&run_id, RunStatus::Failed);
    let a = node(&snap, "a");
    assert_eq!(a.status, NodeStatus::Failed);
    assert_eq!(a.reason.as_ref().unwrap().code, "FLOW_COMMAND_EXIT_CODE");
    assert_eq!(snap.state.reason.as_ref().unwrap().code, FLOW_NODE_FAILED);
    assert_eq!(node(&snap, "b").status, NodeStatus::Pending);

    // A failure edge handles it; the success branch is skipped (and its downstream too).
    let rel = write_flow(
        &f.root,
        "handled",
        json!({}),
        vec![
            cmd(
                "a",
                json!([ev(
                    json!({ "v": 1, "type": "outcome", "status": "fail", "reason": "bad" })
                )]),
            ),
            cmd("ok", json!([])),
            cmd("after_ok", json!([])),
            cmd("handler", json!([])),
        ],
        vec![
            json!({ "from": "a", "to": "ok" }),
            json!({ "from": "ok", "to": "after_ok" }),
            json!({ "from": "a", "to": "handler", "port": "failure" }),
        ],
    );
    let run_id = f.confirm_and_start(&rel, json!({}));
    let snap = f.wait_settled(&run_id, RunStatus::Completed);
    assert_eq!(
        node(&snap, "a").reason.as_ref().unwrap().code,
        "FLOW_COMMAND_REPORTED_FAILURE"
    );
    assert_eq!(
        node(&snap, "a").reason.as_ref().unwrap().params["detail"],
        "bad"
    );
    assert_eq!(node(&snap, "ok").status, NodeStatus::Skipped);
    assert_eq!(node(&snap, "ok").port, None);
    assert_eq!(node(&snap, "after_ok").status, NodeStatus::Skipped);
    assert_eq!(node(&snap, "handler").status, NodeStatus::Succeeded);
}

#[test]
fn retries_then_succeeds_and_mark_succeeded_continues() {
    let f = fixture();
    let mut flaky = cmd("flaky", json!([{ "fail_before_attempt": 2 }]));
    flaky["retry"] = json!({ "max": 2 });
    let rel = write_flow(&f.root, "retry", json!({}), vec![flaky], vec![]);
    let run_id = f.confirm_and_start(&rel, json!({}));
    let snap = f.wait_settled(&run_id, RunStatus::Completed);
    assert_eq!(node(&snap, "flaky").attempt, 2);
    assert!(f.events(&run_id).iter().any(|e| matches!(
        e.body,
        EventBody::NodeStatus {
            to: NodeStatus::RetryWait,
            ..
        }
    )));

    // Exhausted retries fail the run; "mark succeeded" lets it continue.
    let mut always = cmd("always", json!([{ "exit": 1 }]));
    always["retry"] = json!({ "max": 1, "on": ["timeout"] });
    let rel = write_flow(
        &f.root,
        "nore",
        json!({}),
        vec![always, cmd("next", json!([]))],
        vec![json!({ "from": "always", "to": "next" })],
    );
    let run_id = f.confirm_and_start(&rel, json!({}));
    let snap = f.wait_settled(&run_id, RunStatus::Failed);
    assert_eq!(
        node(&snap, "always").attempt,
        1,
        "retry.on: [timeout] does not retry failures"
    );
    assert_eq!(
        f.engine.resume(&f.root, &run_id).unwrap_err().code,
        FLOW_NODE_NEEDS_ACTION
    );
    assert_eq!(
        f.engine
            .mark_succeeded(&f.root, &run_id, "next")
            .unwrap_err()
            .code,
        FLOW_NODE_INVALID_STATE
    );
    f.engine.mark_succeeded(&f.root, &run_id, "always").unwrap();
    let snap = f.wait_settled(&run_id, RunStatus::Completed);
    assert_eq!(node(&snap, "next").status, NodeStatus::Succeeded);
}

#[test]
fn timeouts_fail_the_node() {
    let f = fixture();
    let mut slow = cmd("slow", json!([{ "sleep_ms": 30000 }]));
    slow["timeout"] = json!("1s");
    let rel = write_flow(&f.root, "slow", json!({}), vec![slow], vec![]);
    let started = Instant::now();
    let run_id = f.confirm_and_start(&rel, json!({}));
    let snap = f.wait_settled(&run_id, RunStatus::Failed);
    assert_eq!(
        node(&snap, "slow").reason.as_ref().unwrap().code,
        FLOW_NODE_TIMEOUT
    );
    assert!(started.elapsed() < Duration::from_secs(20));
}

// ------------------------------------------------------------ approvals

#[test]
fn approval_nodes_pause_notify_and_route_by_choice() {
    let f = fixture();
    let rel = write_flow(
        &f.root,
        "appr",
        json!({}),
        vec![
            cmd(
                "a",
                json!([ev(
                    json!({ "v": 1, "type": "output", "key": "doc", "value": "d.md" })
                )]),
            ),
            json!({ "id": "review", "kind": "approval", "message": "Check ${{ nodes.a.outputs.doc }}", "show": ["nodes.a.outputs.doc"], "options": ["publish", "reject"] }),
            cmd("publish", json!([])),
            cmd("rejected", json!([])),
        ],
        vec![
            json!({ "from": "a", "to": "review" }),
            json!({ "from": "review", "to": "publish", "port": "publish" }),
            json!({ "from": "review", "to": "rejected", "port": "reject" }),
        ],
    );
    let run_id = f.confirm_and_start(&rel, json!({}));
    let snap = f.wait_for(&run_id, "awaiting approval", |s| {
        s.state.status == RunStatus::AwaitingApproval
    });
    assert_eq!(node(&snap, "review").status, NodeStatus::AwaitingApproval);
    let request = &snap.state.approvals[0];
    assert_eq!(request.message.as_deref(), Some("Check d.md"));
    assert_eq!(request.show["nodes.a.outputs.doc"], json!("d.md"));
    assert_eq!(f.notifier.requests.lock().unwrap().len(), 1);
    assert_eq!(
        f.engine
            .approve(&f.root, &run_id, Some("review"), "maybe", None)
            .unwrap_err()
            .code,
        FLOW_APPROVAL_INVALID
    );
    assert_eq!(
        f.engine
            .approve(&f.root, &run_id, Some("a"), "publish", None)
            .unwrap_err()
            .code,
        FLOW_APPROVAL_INVALID
    );
    f.engine
        .approve(
            &f.root,
            &run_id,
            Some("review"),
            "publish",
            Some("lgtm".into()),
        )
        .unwrap();
    let snap = f.wait_settled(&run_id, RunStatus::Completed);
    assert_eq!(node(&snap, "review").port.as_deref(), Some("publish"));
    assert_eq!(node(&snap, "publish").status, NodeStatus::Succeeded);
    assert_eq!(node(&snap, "rejected").status, NodeStatus::Skipped);
    assert!(f
        .events(&run_id)
        .iter()
        .any(|e| matches!(&e.body, EventBody::Approval { comment: Some(c), .. } if c == "lgtm")));
}

#[test]
fn when_false_skips_and_approval_takes_first_option() {
    let f = fixture();
    let rel = write_flow(
        &f.root,
        "when",
        json!({ "params": { "review": { "type": "bool", "default": false } } }),
        vec![
            json!({ "id": "review", "kind": "approval", "options": ["go", "no"], "when": { "ref": "params.review", "op": "==", "value": true } }),
            cmd("go", json!([])),
            {
                let mut n = cmd("never", json!([]));
                n["when"] = json!({ "ref": "params.review", "op": "exists" });
                n["when"] = json!({ "not": { "ref": "params.review", "op": "exists" } });
                n
            },
        ],
        vec![
            json!({ "from": "review", "to": "go", "port": "go" }),
            json!({ "from": "go", "to": "never" }),
        ],
    );
    let run_id = f.confirm_and_start(&rel, json!({}));
    let snap = f.wait_settled(&run_id, RunStatus::Completed);
    assert_eq!(node(&snap, "review").status, NodeStatus::Skipped);
    assert_eq!(node(&snap, "review").port.as_deref(), Some("go"));
    assert_eq!(node(&snap, "go").status, NodeStatus::Succeeded);
    assert_eq!(node(&snap, "never").status, NodeStatus::Skipped);
    assert_eq!(
        node(&snap, "never").port.as_deref(),
        Some("success"),
        "when-skipped nodes let the flow continue"
    );
}

#[test]
fn commands_can_ask_for_approval() {
    let f = fixture();
    let ask = |name: &str| {
        write_flow(
            &f.root,
            name,
            json!({}),
            vec![
                cmd(
                    "a",
                    json!([ev(
                        json!({ "v": 1, "type": "outcome", "status": "needs_approval", "message": "quota low" })
                    )]),
                ),
                cmd("b", json!([])),
            ],
            vec![json!({ "from": "a", "to": "b" })],
        )
    };
    let rel = ask("ask1");
    let run_id = f.confirm_and_start(&rel, json!({}));
    let snap = f.wait_for(&run_id, "awaiting", |s| {
        s.state.status == RunStatus::AwaitingApproval
    });
    assert_eq!(
        snap.state.approvals[0].message.as_deref(),
        Some("quota low")
    );
    assert_eq!(snap.state.approvals[0].options, vec!["approve", "reject"]);
    f.engine
        .approve(&f.root, &run_id, Some("a"), "approve", None)
        .unwrap();
    assert_eq!(
        node(&f.wait_settled(&run_id, RunStatus::Completed), "b").status,
        NodeStatus::Succeeded
    );

    let rel = ask("ask2");
    let run_id = f.confirm_and_start(&rel, json!({}));
    f.wait_for(&run_id, "awaiting", |s| {
        s.state.status == RunStatus::AwaitingApproval
    });
    f.engine
        .approve(&f.root, &run_id, Some("a"), "reject", None)
        .unwrap();
    let snap = f.wait_settled(&run_id, RunStatus::Failed);
    assert_eq!(
        node(&snap, "a").reason.as_ref().unwrap().code,
        FLOW_APPROVAL_REJECTED
    );
}

#[test]
fn budget_overrun_waits_for_approval() {
    let f = fixture();
    let spend = |name: &str| {
        write_flow(
            &f.root,
            name,
            json!({ "limits": { "budgetUsd": 1.0 } }),
            vec![
                cmd(
                    "a",
                    json!([ev(
                        json!({ "v": 1, "type": "cost", "usd": 1.5, "kind": "actual" })
                    )]),
                ),
                cmd("b", json!([])),
            ],
            vec![json!({ "from": "a", "to": "b" })],
        )
    };
    let run_id = f.confirm_and_start(&spend("b1"), json!({}));
    let snap = f.wait_for(&run_id, "budget", |s| {
        s.state.status == RunStatus::AwaitingApproval
    });
    let request = &snap.state.approvals[0];
    assert_eq!(request.node_key, None);
    assert_eq!(request.reason.code, FLOW_BUDGET_EXCEEDED);
    assert_eq!(
        node(&snap, "b").status,
        NodeStatus::Ready,
        "b waits for the budget decision"
    );
    assert!(f
        .notifier
        .requests
        .lock()
        .unwrap()
        .iter()
        .any(|r| r.node_key.is_none()));
    f.engine
        .approve(&f.root, &run_id, None, "approve", None)
        .unwrap();
    let snap = f.wait_settled(&run_id, RunStatus::Completed);
    assert_eq!(snap.state.budget_limit_usd, Some(2.5));

    let run_id = f.confirm_and_start(&spend("b2"), json!({}));
    f.wait_for(&run_id, "budget", |s| {
        s.state.status == RunStatus::AwaitingApproval
    });
    f.engine
        .approve(&f.root, &run_id, None, "stop", None)
        .unwrap();
    let snap = f.wait_settled(&run_id, RunStatus::Paused);
    assert_eq!(node(&snap, "b").status, NodeStatus::Ready);
}

// --------------------------------------------------- stop / cancel

#[test]
fn cooperative_stop_pauses_and_resume_reruns_the_node() {
    let f = fixture();
    let rel = write_flow(
        &f.root,
        "stop",
        json!({}),
        vec![
            cmd(
                "long",
                json!([{ "succeed_from_attempt": 2 }, { "wait_stop_ms": 20000 }, { "exit": 9 }]),
            ),
            cmd("next", json!([])),
        ],
        vec![json!({ "from": "long", "to": "next" })],
    );
    let run_id = f.confirm_and_start(&rel, json!({}));
    f.wait_for(&run_id, "running", |s| node(s, "long").process.is_some());
    f.engine.stop(&f.root, &run_id).unwrap();
    let snap = f.wait_settled(&run_id, RunStatus::Paused);
    let long = node(&snap, "long");
    assert_eq!(long.status, NodeStatus::Ready);
    assert_eq!(long.reason.as_ref().unwrap().code, FLOW_NODE_STOPPED);
    assert!(RunStore::new(&f.root).stop_file(&run_id).unwrap().exists());
    assert_eq!(
        f.engine.stop(&f.root, &run_id).unwrap_err().code,
        FLOW_RUN_INVALID_STATE
    );
    f.engine.resume(&f.root, &run_id).unwrap();
    let snap = f.wait_settled(&run_id, RunStatus::Completed);
    assert_eq!(node(&snap, "long").attempt, 2);
    assert!(!RunStore::new(&f.root).stop_file(&run_id).unwrap().exists());
}

#[test]
fn stop_grace_kills_a_command_that_ignores_stop() {
    let f = fixture();
    let rel = write_flow(
        &f.root,
        "grace",
        json!({ "limits": { "stopGrace": "1s" } }),
        vec![cmd("stubborn", json!([{ "sleep_ms": 30000 }]))],
        vec![],
    );
    let run_id = f.confirm_and_start(&rel, json!({}));
    f.wait_for(&run_id, "running", |s| {
        node(s, "stubborn").process.is_some()
    });
    let started = Instant::now();
    f.engine.stop(&f.root, &run_id).unwrap();
    let snap = f.wait_settled(&run_id, RunStatus::Paused);
    assert!(started.elapsed() < Duration::from_secs(15));
    assert_eq!(
        node(&snap, "stubborn").reason.as_ref().unwrap().code,
        FLOW_STOP_GRACE_EXCEEDED
    );
    assert_eq!(node(&snap, "stubborn").status, NodeStatus::Ready);
}

#[test]
fn cancel_kills_the_process_tree() {
    let f = fixture();
    let pid_file = f.root.join("grandchild.pid");
    let rel = write_flow(
        &f.root,
        "cancel",
        json!({}),
        vec![cmd(
            "tree",
            json!([{ "spawn_sleeper_pid_file": pid_file.to_string_lossy() }, { "sleep_ms": 30000 }]),
        )],
        vec![],
    );
    let run_id = f.confirm_and_start(&rel, json!({}));
    let deadline = Instant::now() + Duration::from_secs(20);
    while !pid_file.exists() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    let grandchild: u32 = std::fs::read_to_string(&pid_file)
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    assert!(process_alive(grandchild));
    f.engine.cancel(&f.root, &run_id).unwrap();
    let snap = f.wait_settled(&run_id, RunStatus::Cancelled);
    assert_eq!(node(&snap, "tree").status, NodeStatus::Cancelled);
    let deadline = Instant::now() + Duration::from_secs(10);
    while process_alive(grandchild) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(
        !process_alive(grandchild),
        "grandchild {grandchild} survived the cancel"
    );
    assert_eq!(
        f.engine.cancel(&f.root, &run_id).unwrap_err().code,
        FLOW_RUN_INVALID_STATE
    );
    assert_eq!(
        f.engine.resume(&f.root, &run_id).unwrap_err().code,
        FLOW_RUN_INVALID_STATE
    );
    f.engine.delete(&f.root, &run_id).unwrap();
    assert_eq!(
        f.engine.get(&f.root, &run_id).unwrap_err().code,
        FLOW_RUN_NOT_FOUND
    );
}

// --------------------------------------------------- restart / recovery

#[test]
fn app_exit_interrupts_and_rerun_continues_after_restart() {
    let f = fixture();
    let rel = write_flow(
        &f.root,
        "exit",
        json!({}),
        vec![
            {
                // Attached on purpose: such processes end with the app.
                let mut n = cmd(
                    "long",
                    json!([{ "succeed_from_attempt": 2 }, { "sleep_ms": 30000 }]),
                );
                n["detach"] = json!(false);
                n
            },
            cmd("next", json!([])),
        ],
        vec![json!({ "from": "long", "to": "next" })],
    );
    let run_id = f.confirm_and_start(&rel, json!({}));
    let snap = f.wait_for(&run_id, "running", |s| node(s, "long").process.is_some());
    let pid = node(&snap, "long").process.unwrap().pid;
    f.engine.shutdown(Duration::from_secs(10));
    assert!(!process_alive(pid), "attached processes end with the app");
    let restarted = make_engine(&f.config, f.sink.clone(), f.notifier.clone());
    let snap = restarted.get(&f.root, &run_id).unwrap();
    assert_eq!(snap.state.status, RunStatus::Interrupted);
    assert_eq!(node(&snap, "long").status, NodeStatus::Interrupted);
    let err = restarted.resume(&f.root, &run_id).unwrap_err();
    assert_eq!(err.code, FLOW_NODE_NEEDS_ACTION);
    assert_eq!(err.details[0].params["node"], "long");
    restarted.rerun_node(&f.root, &run_id, "long").unwrap();
    assert!(restarted.wait_idle(&f.root, &run_id, Duration::from_secs(30)));
    let snap = restarted.get(&f.root, &run_id).unwrap();
    assert_eq!(snap.state.status, RunStatus::Completed, "{:#?}", snap.state);
    assert_eq!(node(&snap, "long").attempt, 2);
}

#[test]
fn crash_recovery_marks_running_runs_interrupted() {
    let f = fixture();
    let rel = write_flow(
        &f.root,
        "crash",
        json!({}),
        vec![cmd("a", json!([]))],
        vec![],
    );
    // Write a run that looks like the app died while `a` was running.
    let review = f.engine.review_commands(&f.root, &rel).unwrap();
    let (flow, _) = crate::flow::load::check_text(
        &std::fs::read_to_string(f.root.join(&rel)).unwrap(),
        crate::flow::parse::FlowFormat::Json,
    );
    let store = RunStore::new(&f.root);
    let run_id = "00000000000000aa".to_string();
    let meta = RunMeta {
        schema_version: RUN_SCHEMA_VERSION,
        run_id: run_id.clone(),
        flow_path: rel.clone(),
        flow_sha256: review.sha256,
        flow: flow.unwrap(),
        params: BTreeMap::new(),
        created_at: "2026-10-06T00:00:00.000Z".into(),
        started_by: "user".into(),
        subflows: BTreeMap::new(),
        refs: BTreeMap::new(),
    };
    store.create(&meta).unwrap();
    let meta = store.load_meta(&run_id).unwrap();
    let mut log = store.open_log(&run_id).unwrap();
    let events = [
        (
            None,
            EventBody::RunStatus {
                from: RunStatus::Pending,
                to: RunStatus::Running,
                reason: None,
            },
        ),
        (
            Some("a"),
            EventBody::NodeStatus {
                from: NodeStatus::Pending,
                to: NodeStatus::Ready,
                attempt: 0,
                reason: None,
                port: None,
            },
        ),
        (
            Some("a"),
            EventBody::NodeStatus {
                from: NodeStatus::Ready,
                to: NodeStatus::Running,
                attempt: 1,
                reason: None,
                port: None,
            },
        ),
    ];
    for (i, (key, body)) in events.into_iter().enumerate() {
        log.append(&FlowEvent {
            seq: i as u64 + 1,
            ts: "t".into(),
            node_key: key.map(String::from),
            body,
        })
        .unwrap();
    }
    drop(log);
    let snap = f.engine.get(&f.root, &run_id).unwrap();
    assert_eq!(snap.state.status, RunStatus::Interrupted);
    assert_eq!(node(&snap, "a").status, NodeStatus::Interrupted);
    assert_eq!(
        node(&snap, "a").reason.as_ref().unwrap().code,
        FLOW_APP_EXITED
    );
    // Re-running needs this machine's confirmation of the snapshot's content.
    assert_eq!(
        f.engine.rerun_node(&f.root, &run_id, "a").unwrap_err().code,
        FLOW_COMMANDS_UNCONFIRMED
    );
    assert_eq!(
        f.engine.get(&f.root, &run_id).unwrap().state.nodes["a"].status,
        NodeStatus::Interrupted,
        "nothing changed"
    );
    f.engine
        .confirm_commands(&f.root, &rel, &meta.flow_sha256)
        .unwrap();
    f.engine.rerun_node(&f.root, &run_id, "a").unwrap();
    f.wait_settled(&run_id, RunStatus::Completed);
}

#[test]
fn pending_approvals_survive_a_restart() {
    let f = fixture();
    let rel = write_flow(
        &f.root,
        "keep",
        json!({}),
        vec![
            json!({ "id": "ok", "kind": "approval" }),
            cmd("after", json!([])),
        ],
        vec![json!({ "from": "ok", "to": "after", "port": "approve" })],
    );
    let run_id = f.confirm_and_start(&rel, json!({}));
    f.wait_for(&run_id, "awaiting", |s| {
        s.state.status == RunStatus::AwaitingApproval
    });
    f.engine.shutdown(Duration::from_secs(5));
    let restarted = make_engine(&f.config, f.sink.clone(), f.notifier.clone());
    let snap = restarted.get(&f.root, &run_id).unwrap();
    assert_eq!(snap.state.status, RunStatus::AwaitingApproval);
    assert!(!snap.active);
    restarted
        .approve(&f.root, &run_id, Some("ok"), "approve", None)
        .unwrap();
    assert!(restarted.wait_idle(&f.root, &run_id, Duration::from_secs(30)));
    let snap = restarted.get(&f.root, &run_id).unwrap();
    assert_eq!(snap.state.status, RunStatus::Completed, "{:#?}", snap.state);
}

#[test]
fn operations_validate_ids_and_states() {
    let f = fixture();
    assert_eq!(
        f.engine.get(&f.root, "../../etc").unwrap_err().code,
        FLOW_RUN_INVALID_ID
    );
    assert_eq!(
        f.engine.get(&f.root, "0123456789abcdef").unwrap_err().code,
        FLOW_RUN_NOT_FOUND
    );
    let rel = write_flow(
        &f.root,
        "ops",
        json!({}),
        vec![cmd("a", json!([{ "sleep_ms": 30000 }]))],
        vec![],
    );
    let run_id = f.confirm_and_start(&rel, json!({}));
    f.wait_for(&run_id, "running", |s| node(s, "a").process.is_some());
    assert_eq!(
        f.engine.delete(&f.root, &run_id).unwrap_err().code,
        FLOW_RUN_BUSY
    );
    assert_eq!(
        f.engine.resume(&f.root, &run_id).unwrap_err().code,
        FLOW_RUN_BUSY
    );
    assert_eq!(
        f.engine.rerun_node(&f.root, &run_id, "a").unwrap_err().code,
        FLOW_RUN_BUSY
    );
    assert_eq!(
        f.engine
            .log(&f.root, &run_id, "a", 1, "secrets", 10)
            .unwrap_err()
            .code,
        FLOW_LOG_INVALID
    );
    assert_eq!(
        f.engine
            .log(&f.root, &run_id, "zz", 1, "stdout", 10)
            .unwrap_err()
            .code,
        FLOW_NODE_NOT_FOUND
    );
    f.engine.cancel(&f.root, &run_id).unwrap();
    f.wait_settled(&run_id, RunStatus::Cancelled);
    let _ = f.wait_status(&run_id, RunStatus::Cancelled);
}

#[test]
fn run_data_from_elsewhere_never_executes_without_confirmation() {
    // A repository could ship `.mdium/flow-runs/` with a pending run.
    let f = fixture();
    let marker = f.root.join("executed.txt");
    let rel = write_flow(
        &f.root,
        "cloned",
        json!({}),
        vec![cmd("a", json!([{ "dump_env": marker.to_string_lossy() }]))],
        vec![],
    );
    let review = f.engine.review_commands(&f.root, &rel).unwrap();
    let (flow, _) = crate::flow::load::check_text(
        &std::fs::read_to_string(f.root.join(&rel)).unwrap(),
        crate::flow::parse::FlowFormat::Json,
    );
    let store = RunStore::new(&f.root);
    let run_id = "00000000000000bb".to_string();
    store
        .create(&RunMeta {
            schema_version: RUN_SCHEMA_VERSION,
            run_id: run_id.clone(),
            flow_path: rel.clone(),
            flow_sha256: review.sha256.clone(),
            flow: flow.unwrap(),
            params: BTreeMap::new(),
            created_at: "2026-10-06T00:00:00.000Z".into(),
            started_by: "someone".into(),
            subflows: BTreeMap::new(),
            refs: BTreeMap::new(),
        })
        .unwrap();
    // Listing (first contact with the project) does not start it.
    assert_eq!(
        f.engine.list(&f.root).unwrap()[0].status,
        RunStatus::Pending
    );
    std::thread::sleep(Duration::from_millis(300));
    assert!(!marker.exists());
    assert!(f.events(&run_id).is_empty());
    assert_eq!(
        f.engine.resume(&f.root, &run_id).unwrap_err().code,
        FLOW_COMMANDS_UNCONFIRMED
    );
    assert!(!marker.exists());
    // After the user reviews and confirms the commands, it can run.
    f.engine
        .confirm_commands(&f.root, &rel, &review.sha256)
        .unwrap();
    f.engine.resume(&f.root, &run_id).unwrap();
    f.wait_settled(&run_id, RunStatus::Completed);
    assert!(marker.exists());
}

// ------------------------------------------------ detached + reconnect

fn count_events(f: &Fixture, run_id: &str, pred: impl Fn(&EventBody) -> bool) -> usize {
    f.events(run_id).iter().filter(|e| pred(&e.body)).count()
}

fn wait_engine(
    engine: &FlowEngine,
    root: &Path,
    run_id: &str,
    pred: impl Fn(&RunSnapshot) -> bool,
) -> RunSnapshot {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let snap = engine.get(root, run_id).unwrap();
        if pred(&snap) {
            return snap;
        }
        if Instant::now() > deadline {
            panic!("timed out: {:#?}", snap.state);
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn detached_commands_record_identity_and_exit_file() {
    let f = fixture();
    let rel = write_flow(
        &f.root,
        "det",
        json!({}),
        vec![cmd("a", json!([{ "exit": 0 }]))],
        vec![],
    );
    let run_id = f.confirm_and_start(&rel, json!({}));
    f.wait_settled(&run_id, RunStatus::Completed);
    let process = f.events(&run_id).into_iter().find_map(|e| match e.body {
        EventBody::Process {
            pid,
            started_at,
            exit_file,
        } => Some((pid, started_at, exit_file)),
        _ => None,
    });
    let (_, identity, exit_file) = process.expect("process event");
    assert!(
        identity.contains(':'),
        "creation-time identity, got {identity}"
    );
    let exit_file = PathBuf::from(exit_file.expect("exit file"));
    let record = crate::flow::run::supervise::read_exit(&exit_file).expect("exit.json");
    assert_eq!(record.code, 0);
    assert!(exit_file.parent().unwrap().join("supervise.json").exists());
}

#[test]
fn detached_command_survives_app_exit_and_is_reconnected() {
    let f = fixture();
    let rel = write_flow(
        &f.root,
        "survive",
        json!({}),
        vec![
            cmd(
                "long",
                json!([
                    ev(json!({ "v": 1, "type": "output", "key": "first", "value": 1 })),
                    ev(json!({ "v": 1, "type": "cost", "usd": 0.5, "kind": "actual" })),
                    { "sleep_ms": 1500 },
                    ev(json!({ "v": 1, "type": "output", "key": "second", "value": 2 })),
                    ev(json!({ "v": 1, "type": "outcome", "status": "ok" })),
                ]),
            ),
            cmd("next", json!([])),
        ],
        vec![json!({ "from": "long", "to": "next" })],
    );
    let run_id = f.confirm_and_start(&rel, json!({}));
    let snap = f.wait_for(&run_id, "first output", |s| {
        node(s, "long").outputs.contains_key("first") && s.state.cost.actual > 0.0
    });
    let pid = node(&snap, "long").process.unwrap().pid;
    f.engine.shutdown(Duration::from_secs(10));
    // The app is gone; the command keeps running.
    let after = f.snapshot(&run_id);
    assert_eq!(after.state.status, RunStatus::Running);
    assert_eq!(node(&after, "long").status, NodeStatus::Running);
    assert!(process_alive(pid), "the supervisor outlives the app");
    // Restart: the engine reconnects and the run finishes.
    let restarted = make_engine(&f.config, f.sink.clone(), f.notifier.clone());
    assert!(
        restarted.get(&f.root, &run_id).unwrap().active,
        "a driver reconnected"
    );
    assert!(restarted.wait_idle(&f.root, &run_id, Duration::from_secs(30)));
    let snap = restarted.get(&f.root, &run_id).unwrap();
    assert_eq!(snap.state.status, RunStatus::Completed, "{:#?}", snap.state);
    let long = node(&snap, "long");
    assert_eq!(long.attempt, 1, "not re-run");
    assert_eq!(long.outputs["second"], json!(2));
    // Events read before the exit are not applied twice.
    assert_eq!(
        count_events(
            &f,
            &run_id,
            |b| matches!(b, EventBody::NodeOutput { key, .. } if key == "first")
        ),
        1
    );
    assert_eq!(
        count_events(&f, &run_id, |b| matches!(b, EventBody::Cost { .. })),
        1
    );
    assert_eq!(snap.state.cost.actual, 0.5);
    assert_eq!(node(&snap, "next").status, NodeStatus::Succeeded);
}

#[test]
fn command_that_finished_while_the_app_was_down_is_settled_from_exit_json() {
    let f = fixture();
    let rel = write_flow(
        &f.root,
        "finished",
        json!({}),
        vec![cmd(
            "quick",
            json!([
                { "sleep_ms": 400 },
                ev(json!({ "v": 1, "type": "output", "key": "done", "value": true })),
                ev(json!({ "v": 1, "type": "outcome", "status": "needs_approval", "message": "check" })),
            ]),
        )],
        vec![],
    );
    let run_id = f.confirm_and_start(&rel, json!({}));
    f.wait_for(&run_id, "running", |s| node(s, "quick").process.is_some());
    f.engine.shutdown(Duration::from_secs(10));
    let exit_file = PathBuf::from(
        node(&f.snapshot(&run_id), "quick")
            .process
            .unwrap()
            .exit_file
            .unwrap(),
    );
    let deadline = Instant::now() + Duration::from_secs(20);
    while !exit_file.exists() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(exit_file.exists());
    let restarted = make_engine(&f.config, f.sink.clone(), f.notifier.clone());
    let snap = wait_engine(&restarted, &f.root, &run_id, |s| {
        s.state.status == RunStatus::AwaitingApproval
    });
    assert_eq!(node(&snap, "quick").outputs["done"], json!(true));
    assert_eq!(snap.state.approvals[0].message.as_deref(), Some("check"));
}

#[test]
fn reconnect_rejects_a_reused_pid_and_marks_the_node_interrupted() {
    let f = fixture();
    let rel = write_flow(
        &f.root,
        "reused",
        json!({}),
        vec![cmd("a", json!([]))],
        vec![],
    );
    let review = f.engine.review_commands(&f.root, &rel).unwrap();
    f.engine
        .confirm_commands(&f.root, &rel, &review.sha256)
        .unwrap();
    let (flow, _) = crate::flow::load::check_text(
        &std::fs::read_to_string(f.root.join(&rel)).unwrap(),
        crate::flow::parse::FlowFormat::Json,
    );
    let store = RunStore::new(&f.root);
    let run_id = "00000000000000cc".to_string();
    store
        .create(&RunMeta {
            schema_version: RUN_SCHEMA_VERSION,
            run_id: run_id.clone(),
            flow_path: rel.clone(),
            flow_sha256: review.sha256,
            flow: flow.unwrap(),
            params: BTreeMap::new(),
            created_at: "2026-10-06T00:00:00.000Z".into(),
            started_by: "user".into(),
            subflows: BTreeMap::new(),
            refs: BTreeMap::new(),
        })
        .unwrap();
    // `a` "runs" under this test process's pid, but with another creation time.
    let exit_file = store
        .node_attempt_dir(&run_id, "a", 1)
        .unwrap()
        .join("exit.json");
    let mut log = store.open_log(&run_id).unwrap();
    let events = [
        (
            None,
            EventBody::RunStatus {
                from: RunStatus::Pending,
                to: RunStatus::Running,
                reason: None,
            },
        ),
        (
            Some("a"),
            EventBody::NodeStatus {
                from: NodeStatus::Pending,
                to: NodeStatus::Ready,
                attempt: 0,
                reason: None,
                port: None,
            },
        ),
        (
            Some("a"),
            EventBody::NodeStatus {
                from: NodeStatus::Ready,
                to: NodeStatus::Running,
                attempt: 1,
                reason: None,
                port: None,
            },
        ),
        (
            Some("a"),
            EventBody::Process {
                pid: std::process::id(),
                started_at: "win:1".into(),
                exit_file: Some(exit_file.to_string_lossy().into_owned()),
            },
        ),
    ];
    for (i, (key, body)) in events.into_iter().enumerate() {
        log.append(&FlowEvent {
            seq: i as u64 + 1,
            ts: "t".into(),
            node_key: key.map(String::from),
            body,
        })
        .unwrap();
    }
    drop(log);
    let snap = f.engine.get(&f.root, &run_id).unwrap();
    assert_eq!(snap.state.status, RunStatus::Interrupted);
    assert_eq!(node(&snap, "a").status, NodeStatus::Interrupted);
    assert!(
        process_alive(std::process::id()),
        "the unrelated process was not killed"
    );
}

#[test]
fn cancel_after_reconnect_kills_the_detached_tree() {
    let f = fixture();
    let pid_file = f.root.join("gc.pid");
    let rel = write_flow(
        &f.root,
        "cancel2",
        json!({}),
        vec![cmd(
            "tree",
            json!([{ "spawn_sleeper_pid_file": pid_file.to_string_lossy() }, { "sleep_ms": 30000 }]),
        )],
        vec![],
    );
    let run_id = f.confirm_and_start(&rel, json!({}));
    let deadline = Instant::now() + Duration::from_secs(20);
    while !pid_file.exists() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    std::thread::sleep(Duration::from_millis(100));
    let grandchild: u32 = std::fs::read_to_string(&pid_file)
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    f.engine.shutdown(Duration::from_secs(10));
    assert!(process_alive(grandchild));
    let restarted = make_engine(&f.config, f.sink.clone(), f.notifier.clone());
    assert!(restarted.get(&f.root, &run_id).unwrap().active);
    restarted.cancel(&f.root, &run_id).unwrap();
    assert!(restarted.wait_idle(&f.root, &run_id, Duration::from_secs(30)));
    assert_eq!(
        restarted.get(&f.root, &run_id).unwrap().state.status,
        RunStatus::Cancelled
    );
    let deadline = Instant::now() + Duration::from_secs(10);
    while process_alive(grandchild) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(
        !process_alive(grandchild),
        "grandchild {grandchild} survived"
    );
}

// ------------------------------------- PR 4a: branches, passes, loops, sub-flows

fn keys_with_status(snap: &RunSnapshot, status: NodeStatus) -> Vec<String> {
    snap.state
        .nodes
        .iter()
        .filter(|(_, n)| n.status == status)
        .map(|(k, _)| k.clone())
        .collect()
}

fn lines(path: &Path) -> Vec<String> {
    std::fs::read_to_string(path)
        .unwrap_or_default()
        .lines()
        .map(String::from)
        .collect()
}

#[test]
fn branches_route_by_condition() {
    let f = fixture();
    let rel = |score: i64| {
        write_flow(
            &f.root,
            &format!("branch{score}"),
            json!({}),
            vec![
                cmd(
                    "measure",
                    json!([ev(
                        json!({ "v": 1, "type": "output", "key": "score", "value": score })
                    )]),
                ),
                json!({ "id": "gate", "kind": "branch", "cases": [ { "when": { "ref": "nodes.measure.outputs.score", "op": "<", "value": 7 }, "port": "low" } ], "default": "ok" }),
                cmd("fix", json!([])),
                cmd("publish", json!([])),
            ],
            vec![
                json!({ "from": "measure", "to": "gate" }),
                json!({ "from": "gate", "to": "fix", "port": "low" }),
                json!({ "from": "gate", "to": "publish", "port": "ok" }),
            ],
        )
    };
    let run_id = f.confirm_and_start(&rel(3), json!({}));
    let snap = f.wait_settled(&run_id, RunStatus::Completed);
    assert_eq!(node(&snap, "gate").port.as_deref(), Some("low"));
    assert_eq!(node(&snap, "fix").status, NodeStatus::Succeeded);
    assert_eq!(node(&snap, "publish").status, NodeStatus::Skipped);
    let run_id = f.confirm_and_start(&rel(9), json!({}));
    let snap = f.wait_settled(&run_id, RunStatus::Completed);
    assert_eq!(node(&snap, "gate").port.as_deref(), Some("ok"));
    assert_eq!(node(&snap, "fix").status, NodeStatus::Skipped);
    assert_eq!(node(&snap, "publish").status, NodeStatus::Succeeded);
}

/// gen → gate (branch) –retry→ gen (back-edge); gate –good→ done.
fn retry_cycle_flow(f: &Fixture, name: &str, max: u32, good_on: &str, order: &Path) -> String {
    write_flow(
        &f.root,
        name,
        json!({}),
        vec![
            cmd(
                "gen",
                json!([
                    { "append_key_to": order.to_string_lossy() },
                    { "emit_if_key_contains": { "needle": good_on, "event": { "v": 1, "type": "output", "key": "ok", "value": true } } },
                ]),
            ),
            json!({ "id": "gate", "kind": "branch", "cases": [ { "when": { "ref": "nodes.gen.outputs.ok", "op": "==", "value": true }, "port": "good" } ], "default": "retry" }),
            {
                let mut done = cmd(
                    "done",
                    json!([{ "append_key_to": order.to_string_lossy() }]),
                );
                done["name"] = json!("Done");
                done
            },
        ],
        vec![
            json!({ "from": "gen", "to": "gate" }),
            json!({ "from": "gate", "to": "gen", "port": "retry", "maxTraversals": max }),
            json!({ "from": "gate", "to": "done", "port": "good" }),
        ],
    )
}

#[test]
fn back_edges_open_new_passes_and_rearm_skipped_nodes() {
    let f = fixture();
    let order = f.root.join("order.txt");
    let rel = retry_cycle_flow(&f, "cycle", 5, "@3", &order);
    let run_id = f.confirm_and_start(&rel, json!({}));
    let snap = f.wait_settled(&run_id, RunStatus::Completed);
    // gen ran in three passes, then the downstream node (skipped twice) ran once.
    assert_eq!(lines(&order), vec!["gen", "gen@2", "gen@3", "done"]);
    assert_eq!(node(&snap, "gen").status, NodeStatus::Succeeded);
    assert_eq!(node(&snap, "gate").port.as_deref(), Some("retry"));
    assert_eq!(node(&snap, "gate@3").port.as_deref(), Some("good"));
    assert_eq!(node(&snap, "done").status, NodeStatus::Succeeded);
    assert_eq!(snap.state.traversals["#1"], 2);
    assert_eq!(snap.state.pass("", "gen"), 3);
    // `done` waited for the latest pass of `gate` instead of being skipped early.
    let skipped_early = f.events(&run_id).iter().any(|e| {
        e.node_key.as_deref() == Some("done")
            && matches!(
                e.body,
                EventBody::NodeStatus {
                    to: NodeStatus::Skipped,
                    ..
                }
            )
    });
    assert!(!skipped_early);
}

#[test]
fn exhausted_back_edge_fails_the_source() {
    let f = fixture();
    let order = f.root.join("order.txt");
    let rel = retry_cycle_flow(&f, "limit", 1, "@9", &order);
    let run_id = f.confirm_and_start(&rel, json!({}));
    let snap = f.wait_settled(&run_id, RunStatus::Failed);
    assert_eq!(lines(&order), vec!["gen", "gen@2"]);
    let gate = node(&snap, "gate@2");
    assert_eq!(gate.status, NodeStatus::Failed);
    assert_eq!(gate.reason.as_ref().unwrap().code, FLOW_TRAVERSAL_LIMIT);
    assert_eq!(snap.state.reason.as_ref().unwrap().params["node"], "gate@2");
    assert_eq!(
        node(&snap, "done").status,
        NodeStatus::Pending,
        "the run failed first"
    );
}

#[test]
fn review_rework_redesign_then_merge() {
    // The dev-workflow shape: review -rework-> design (back-edge), review -approve-> merge.
    let f = fixture();
    let order = f.root.join("order.txt");
    let step = |id: &str| cmd(id, json!([{ "append_key_to": order.to_string_lossy() }]));
    let rel = write_flow(
        &f.root,
        "dev",
        json!({}),
        vec![
            step("prepare"),
            step("design"),
            json!({ "id": "review", "kind": "approval", "options": ["approve", "rework"] }),
            step("merge"),
            step("cleanup"),
        ],
        vec![
            json!({ "from": "prepare", "to": "design" }),
            json!({ "from": "design", "to": "review" }),
            json!({ "from": "review", "to": "design", "port": "rework", "maxTraversals": 3 }),
            json!({ "from": "review", "to": "merge", "port": "approve" }),
            json!({ "from": "merge", "to": "cleanup" }),
        ],
    );
    let run_id = f.confirm_and_start(&rel, json!({}));
    f.wait_for(&run_id, "first review", |s| {
        node(s, "review").status == NodeStatus::AwaitingApproval
    });
    f.engine
        .approve(&f.root, &run_id, Some("review"), "rework", None)
        .unwrap();
    f.wait_for(&run_id, "second review", |s| {
        s.state
            .nodes
            .get("review@2")
            .is_some_and(|n| n.status == NodeStatus::AwaitingApproval)
    });
    // The superseded first pass can no longer be answered.
    assert_eq!(
        f.engine
            .approve(&f.root, &run_id, Some("review"), "approve", None)
            .unwrap_err()
            .code,
        FLOW_APPROVAL_INVALID
    );
    f.engine
        .approve(&f.root, &run_id, Some("review@2"), "approve", None)
        .unwrap();
    let snap = f.wait_settled(&run_id, RunStatus::Completed);
    assert_eq!(
        lines(&order),
        vec!["prepare", "design", "design@2", "merge", "cleanup"]
    );
    assert_eq!(node(&snap, "merge").status, NodeStatus::Succeeded);
    assert_eq!(
        node(&snap, "prepare").attempt,
        1,
        "nodes outside the cycle keep their record"
    );
}

fn foreach_flow(
    f: &Fixture,
    name: &str,
    items: Value,
    max: u32,
    extra: Value,
    body_steps: Value,
) -> String {
    let mut lp = json!({
        "id": "docs", "kind": "loop", "mode": "foreach", "as": "doc",
        "items": "${{ nodes.collect.outputs.docs }}", "maxIterations": max,
        "body": {
            "nodes": [ cmd("proc", body_steps) ],
            "outputs": { "item": "${{ nodes.proc.outputs.item }}", "doc": "${{ doc }}" }
        }
    });
    for (k, v) in extra.as_object().cloned().unwrap_or_default() {
        lp[k] = v;
    }
    write_flow(
        &f.root,
        name,
        json!({}),
        vec![
            cmd(
                "collect",
                json!([ev(
                    json!({ "v": 1, "type": "output", "key": "docs", "value": items })
                )]),
            ),
            lp,
            cmd("after", json!([])),
        ],
        vec![
            json!({ "from": "collect", "to": "docs" }),
            json!({ "from": "docs", "to": "after" }),
        ],
    )
}

#[test]
fn foreach_runs_each_item_in_its_own_scope() {
    let f = fixture();
    let rel = foreach_flow(
        &f,
        "each",
        json!(["a", "b", "c"]),
        10,
        json!({}),
        json!([{ "emit_input": true }]),
    );
    let run_id = f.confirm_and_start(&rel, json!({}));
    let snap = f.wait_settled(&run_id, RunStatus::Completed);
    for (i, item) in ["a", "b", "c"].iter().enumerate() {
        let key = format!("docs[{i}]/proc");
        assert_eq!(node(&snap, &key).outputs["item"], json!(item), "{key}");
        assert_eq!(
            snap.state.scopes[&format!("docs[{i}]/")].status,
            ScopeStatus::Completed
        );
    }
    let docs = node(&snap, "docs");
    assert_eq!(docs.outputs["iterations"], json!(3));
    assert_eq!(docs.outputs["limitReached"], json!(false));
    assert_eq!(
        docs.outputs["results"][1],
        json!({ "item": "b", "doc": "b" })
    );
    assert_eq!(
        snap.state.loops["docs"].items,
        vec![json!("a"), json!("b"), json!("c")]
    );
    assert_eq!(node(&snap, "after").status, NodeStatus::Succeeded);
    // Logs are found by instance key.
    let dir = RunStore::new(&f.root)
        .node_attempt_dir(&run_id, "docs[2]/proc", 1)
        .unwrap();
    assert!(dir.join("stdout.log").exists(), "{}", dir.display());
    assert!(f
        .engine
        .log(&f.root, &run_id, "docs[2]/proc", 1, "stdout", 100)
        .is_ok());

    // More items than maxIterations: the first ones run, limitReached is set.
    let rel = foreach_flow(
        &f,
        "capped",
        json!(["a", "b", "c"]),
        2,
        json!({}),
        json!([]),
    );
    let run_id = f.confirm_and_start(&rel, json!({}));
    let snap = f.wait_settled(&run_id, RunStatus::Completed);
    assert_eq!(node(&snap, "docs").outputs["iterations"], json!(2));
    assert_eq!(node(&snap, "docs").outputs["limitReached"], json!(true));
    assert!(!snap.state.nodes.contains_key("docs[2]/proc"));
}

#[test]
fn failing_iterations_stop_or_continue() {
    let f = fixture();
    let body = json!([{ "fail_if_item": "b" }]);
    let rel = foreach_flow(
        &f,
        "stop",
        json!(["a", "b", "c"]),
        10,
        json!({}),
        body.clone(),
    );
    let run_id = f.confirm_and_start(&rel, json!({}));
    let snap = f.wait_settled(&run_id, RunStatus::Failed);
    assert_eq!(
        node(&snap, "docs").reason.as_ref().unwrap().code,
        FLOW_LOOP_ITERATION_FAILED
    );
    assert!(
        !snap.state.nodes.contains_key("docs[2]/proc"),
        "no iteration after the failure"
    );
    assert_eq!(snap.state.scopes["docs[1]/"].status, ScopeStatus::Failed);

    let rel = foreach_flow(
        &f,
        "cont",
        json!(["a", "b", "c"]),
        10,
        json!({ "onItemFailure": "continue" }),
        body,
    );
    let run_id = f.confirm_and_start(&rel, json!({}));
    let snap = f.wait_settled(&run_id, RunStatus::Completed);
    assert_eq!(node(&snap, "docs").outputs["failedIterations"], json!(1));
    assert_eq!(node(&snap, "docs[2]/proc").status, NodeStatus::Succeeded);
}

#[test]
fn while_loops_until_a_condition_or_the_limit() {
    let f = fixture();
    let flow = |name: &str, max: u32| {
        write_flow(
            &f.root,
            name,
            json!({}),
            vec![json!({
                "id": "rounds", "kind": "loop", "mode": "while", "maxIterations": max,
                "until": { "ref": "iteration.outputs.n", "op": ">=", "value": 3 },
                "body": { "nodes": [ cmd("step", json!([{ "emit_input": true }])) ], "outputs": { "n": "${{ nodes.step.outputs.n }}" } }
            })],
            vec![],
        )
    };
    let run_id = f.confirm_and_start(&flow("until", 10), json!({}));
    let snap = f.wait_settled(&run_id, RunStatus::Completed);
    assert_eq!(node(&snap, "rounds").outputs["iterations"], json!(3));
    assert_eq!(node(&snap, "rounds").outputs["limitReached"], json!(false));
    assert_eq!(node(&snap, "rounds[2]/step").outputs["index"], json!(2));
    let run_id = f.confirm_and_start(&flow("cap", 2), json!({}));
    let snap = f.wait_settled(&run_id, RunStatus::Completed);
    assert_eq!(node(&snap, "rounds").outputs["iterations"], json!(2));
    assert_eq!(node(&snap, "rounds").outputs["limitReached"], json!(true));
}

/// A child flow file: echoes its `x` parameter as output `res`.
fn write_child(f: &Fixture, name: &str, extra_step: Option<Value>) -> String {
    let mut steps = vec![json!({ "emit_arg_as": "arg" })];
    steps.extend(extra_step);
    let mut echo = cmd("echo", Value::Array(steps));
    echo["run"]
        .as_array_mut()
        .unwrap()
        .push(json!("${{ params.x }}"));
    write_flow(
        &f.root,
        name,
        json!({ "params": { "x": { "type": "string", "required": true } }, "outputs": { "res": "${{ nodes.echo.outputs.arg }}" } }),
        vec![echo],
        vec![],
    )
}

#[test]
fn subflows_run_in_their_own_scope_with_params_and_outputs() {
    let f = fixture();
    write_child(&f, "child", None);
    let mut use_it = cmd("use", json!([{ "emit_arg_as": "got" }]));
    use_it["run"]
        .as_array_mut()
        .unwrap()
        .push(json!("${{ nodes.sub.outputs.res }}"));
    let rel = write_flow(
        &f.root,
        "parent",
        json!({ "params": { "v": { "type": "string", "default": "hello" } } }),
        vec![
            json!({ "id": "sub", "kind": "subflow", "flow": "./child.flow.json", "params": { "x": "${{ params.v }}" } }),
            use_it,
        ],
        vec![json!({ "from": "sub", "to": "use" })],
    );
    // The review covers the child's command, labelled with its file.
    let review = f.engine.review_commands(&f.root, &rel).unwrap();
    assert_eq!(review.commands.len(), 2);
    assert!(review
        .commands
        .iter()
        .any(|c| c.file == ".mdium/flows/child.flow.json" && c.node_id == "echo"));
    let run_id = f.confirm_and_start(&rel, json!({}));
    let snap = f.wait_settled(&run_id, RunStatus::Completed);
    assert_eq!(node(&snap, "sub/echo").outputs["arg"], json!("hello"));
    assert_eq!(node(&snap, "sub").outputs["res"], json!("hello"));
    assert_eq!(node(&snap, "use").outputs["got"], json!("hello"));
    assert_eq!(
        snap.meta.subflows.len(),
        1,
        "the child is part of the snapshot"
    );

    // Changing the child invalidates the confirmation of the parent.
    let before = f.engine.review_commands(&f.root, &rel).unwrap();
    assert!(before.confirmed);
    write_child(&f, "child", Some(json!({ "sleep_ms": 1 })));
    let after = f.engine.review_commands(&f.root, &rel).unwrap();
    assert_ne!(after.sha256, before.sha256);
    assert!(!after.confirmed);
    assert_eq!(
        f.engine
            .start(&f.root, &rel, &BTreeMap::new(), &after.sha256)
            .unwrap_err()
            .code,
        FLOW_COMMANDS_UNCONFIRMED
    );
}

#[test]
fn failing_subflow_follows_the_parent_failure_edge() {
    let f = fixture();
    write_child(&f, "bad", Some(json!({ "exit": 2 })));
    let rel = write_flow(
        &f.root,
        "handled",
        json!({}),
        vec![
            json!({ "id": "sub", "kind": "subflow", "flow": "./bad.flow.json", "params": { "x": "1" } }),
            cmd("recover", json!([])),
        ],
        vec![json!({ "from": "sub", "to": "recover", "port": "failure" })],
    );
    let run_id = f.confirm_and_start(&rel, json!({}));
    let snap = f.wait_settled(&run_id, RunStatus::Completed);
    assert_eq!(
        node(&snap, "sub").reason.as_ref().unwrap().code,
        FLOW_SUBFLOW_FAILED
    );
    assert_eq!(snap.state.scopes["sub/"].status, ScopeStatus::Failed);
    assert_eq!(node(&snap, "recover").status, NodeStatus::Succeeded);
}

#[test]
fn file_bodies_get_params_from_the_item() {
    let f = fixture();
    write_child(&f, "each", None);
    let rel = write_flow(
        &f.root,
        "fileloop",
        json!({}),
        vec![
            json!({ "id": "l", "kind": "loop", "mode": "foreach", "items": ["p", "q"], "maxIterations": 5, "body": "./each.flow.json", "params": { "x": "${{ item }}" } }),
        ],
        vec![],
    );
    let run_id = f.confirm_and_start(&rel, json!({}));
    let snap = f.wait_settled(&run_id, RunStatus::Completed);
    assert_eq!(node(&snap, "l[0]/echo").outputs["arg"], json!("p"));
    assert_eq!(node(&snap, "l[1]/echo").outputs["arg"], json!("q"));
    assert_eq!(
        node(&snap, "l").outputs["results"],
        json!([{ "res": "p" }, { "res": "q" }])
    );
}

#[test]
fn rerunning_a_failed_loop_starts_a_new_pass() {
    let f = fixture();
    let marker = f.root.join("broken");
    std::fs::write(&marker, "").unwrap();
    let rel = foreach_flow(
        &f,
        "rerun",
        json!(["a", "b"]),
        10,
        json!({}),
        json!([{ "fail_if_file_exists": marker.to_string_lossy() }]),
    );
    let run_id = f.confirm_and_start(&rel, json!({}));
    f.wait_settled(&run_id, RunStatus::Failed);
    std::fs::remove_file(&marker).unwrap();
    // The inner node belongs to a finished iteration scope: only the loop can be re-run.
    assert_eq!(
        f.engine
            .rerun_node(&f.root, &run_id, "docs[0]/proc")
            .unwrap_err()
            .code,
        FLOW_NODE_INVALID_STATE
    );
    f.engine.rerun_node(&f.root, &run_id, "docs").unwrap();
    let snap = f.wait_settled(&run_id, RunStatus::Completed);
    assert_eq!(node(&snap, "docs@2").status, NodeStatus::Succeeded);
    assert_eq!(node(&snap, "docs@2[1]/proc").status, NodeStatus::Succeeded);
    assert_eq!(
        node(&snap, "docs").status,
        NodeStatus::Failed,
        "the old pass is history"
    );
    assert!(keys_with_status(&snap, NodeStatus::Running).is_empty());
}

#[test]
fn interrupted_iteration_resumes_after_restart() {
    let f = fixture();
    let rel = foreach_flow(
        &f,
        "resume",
        json!(["a"]),
        10,
        json!({}),
        json!([{ "succeed_from_attempt": 2 }, { "sleep_ms": 30000 }]),
    );
    // Attached commands so the app exit interrupts them.
    let path = f.root.join(&rel);
    let mut def: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    def["nodes"][1]["body"]["nodes"][0]["detach"] = json!(false);
    std::fs::write(&path, serde_json::to_vec_pretty(&def).unwrap()).unwrap();
    let run_id = f.confirm_and_start(&rel, json!({}));
    f.wait_for(&run_id, "inner running", |s| {
        s.state
            .nodes
            .get("docs[0]/proc")
            .is_some_and(|n| n.process.is_some())
    });
    f.engine.shutdown(Duration::from_secs(10));
    let restarted = make_engine(&f.config, f.sink.clone(), f.notifier.clone());
    let snap = restarted.get(&f.root, &run_id).unwrap();
    assert_eq!(snap.state.status, RunStatus::Interrupted);
    assert_eq!(node(&snap, "docs[0]/proc").status, NodeStatus::Interrupted);
    assert_eq!(
        node(&snap, "docs").status,
        NodeStatus::Running,
        "the loop itself carries on"
    );
    let err = restarted.resume(&f.root, &run_id).unwrap_err();
    assert_eq!(err.details[0].params["node"], "docs[0]/proc");
    restarted
        .rerun_node(&f.root, &run_id, "docs[0]/proc")
        .unwrap();
    assert!(restarted.wait_idle(&f.root, &run_id, Duration::from_secs(30)));
    let snap = restarted.get(&f.root, &run_id).unwrap();
    assert_eq!(snap.state.status, RunStatus::Completed, "{:#?}", snap.state);
    assert_eq!(node(&snap, "docs[0]/proc").attempt, 2);
}

#[test]
fn scoped_runs_replay_to_the_checkpoint() {
    let f = fixture();
    let order = f.root.join("order.txt");
    let rel = retry_cycle_flow(&f, "replay", 5, "@2", &order);
    let run_id = f.confirm_and_start(&rel, json!({}));
    f.wait_settled(&run_id, RunStatus::Completed);
    let rel = foreach_flow(
        &f,
        "replay2",
        json!(["a", "b"]),
        10,
        json!({}),
        json!([{ "emit_input": true }]),
    );
    let loop_run = f.confirm_and_start(&rel, json!({}));
    f.wait_settled(&loop_run, RunStatus::Completed);
    let store = RunStore::new(&f.root);
    for id in [run_id, loop_run] {
        let meta = store.load_meta(&id).unwrap();
        let state_file = store.run_dir(&id).unwrap().join("state.json");
        let checkpoint: RunState =
            serde_json::from_slice(&std::fs::read(&state_file).unwrap()).unwrap();
        std::fs::remove_file(&state_file).unwrap();
        assert_eq!(store.load_state(&id, &meta).unwrap(), checkpoint, "{id}");
    }
}

#[test]
fn nodes_skipped_before_a_back_edge_are_rearmed() {
    // a -> b; b -x-> c (skipped when b takes y); b -y-> d; d -back-> a.
    let f = fixture();
    let order = f.root.join("order.txt");
    let step = |id: &str, extra: Value| {
        let mut steps = vec![json!({ "append_key_to": order.to_string_lossy() })];
        if let Some(extra) = extra.as_array() {
            steps.extend(extra.iter().cloned());
        }
        cmd(id, Value::Array(steps))
    };
    let rel = write_flow(
        &f.root,
        "rearm",
        json!({}),
        vec![
            step(
                "a",
                json!([{ "emit_if_key_contains": { "needle": "@2", "event": { "v": 1, "type": "output", "key": "second", "value": true } } }]),
            ),
            json!({ "id": "b", "kind": "branch", "cases": [ { "when": { "ref": "nodes.a.outputs.second", "op": "==", "value": true }, "port": "x" } ], "default": "y" }),
            step("c", json!([])),
            step("d", json!([])),
        ],
        vec![
            json!({ "from": "a", "to": "b" }),
            json!({ "from": "b", "to": "c", "port": "x" }),
            json!({ "from": "b", "to": "d", "port": "y" }),
            json!({ "from": "d", "to": "a", "maxTraversals": 2 }),
        ],
    );
    let run_id = f.confirm_and_start(&rel, json!({}));
    let snap = f.wait_settled(&run_id, RunStatus::Completed);
    assert_eq!(lines(&order), vec!["a", "d", "a@2", "c"]);
    let rearmed = f.events(&run_id).iter().any(|e| {
        e.node_key.as_deref() == Some("c")
            && matches!(
                e.body,
                EventBody::NodeStatus {
                    from: NodeStatus::Skipped,
                    to: NodeStatus::Pending,
                    ..
                }
            )
    });
    assert!(rearmed, "c was skipped in pass 1 and re-armed");
    assert_eq!(node(&snap, "c").status, NodeStatus::Succeeded);
    assert_eq!(
        node(&snap, "d").status,
        NodeStatus::Succeeded,
        "d keeps its pass-1 record"
    );
    assert_eq!(node(&snap, "d@2").status, NodeStatus::Skipped);
}

/// The sample flow for checking the run UI by hand is runnable as shipped.
#[test]
fn manual_check_sample_is_runnable() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/flows/valid/manual-check.flow.yaml");
    let (flow, issues) = crate::flow::load::check_text(
        &std::fs::read_to_string(&path).unwrap(),
        crate::flow::parse::FlowFormat::Yaml,
    );
    assert!(issues.errors.is_empty(), "{:#?}", issues.errors);
    let flow = flow.unwrap();
    assert!(
        crate::flow::run::prepare::check_runnable(&[("manual-check.flow.yaml", &flow)]).is_empty()
    );
}

/// End-to-end run of the sample flow with PowerShell (slow; run with `--ignored`).
#[cfg(windows)]
#[test]
#[ignore]
fn manual_check_sample_runs_end_to_end() {
    let f = fixture();
    let dir = f.root.join(".mdium/flows");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::copy(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/flows/valid/manual-check.flow.yaml"),
        dir.join("manual-check.flow.yaml"),
    )
    .unwrap();
    let rel = ".mdium/flows/manual-check.flow.yaml";
    let run_id = f.confirm_and_start(rel, json!({}));
    f.wait_for(&run_id, "work running", |s| {
        s.state
            .nodes
            .get("work")
            .is_some_and(|n| n.progress.is_some())
    });
    f.engine.stop(&f.root, &run_id).unwrap();
    let snap = f.wait_settled(&run_id, RunStatus::Paused);
    assert_eq!(
        node(&snap, "work").reason.as_ref().unwrap().code,
        FLOW_NODE_STOPPED
    );
    f.engine.resume(&f.root, &run_id).unwrap();
    f.wait_for(&run_id, "review", |s| {
        s.state.status == RunStatus::AwaitingApproval
    });
    f.engine
        .approve(&f.root, &run_id, Some("review"), "rework", None)
        .unwrap();
    f.wait_for(&run_id, "second review", |s| {
        s.state
            .nodes
            .get("review@2")
            .is_some_and(|n| n.status == NodeStatus::AwaitingApproval)
    });
    f.engine
        .approve(&f.root, &run_id, Some("review@2"), "publish", None)
        .unwrap();
    let snap = f.wait_settled(&run_id, RunStatus::Completed);
    assert_eq!(node(&snap, "publish").artifacts[0].path, "published.txt");
    assert!(f
        .engine
        .log(&f.root, &run_id, "publish", 1, "stdout", 1000)
        .unwrap()
        .contains("published"));
}
