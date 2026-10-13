//! Golden-file and behaviour tests of parsing + validation.

use crate::issues::*;
use crate::load::{
    check_content, check_file, check_text, list_flows, resolve_flow_path, FlowKind, PathProblem,
    MAX_FLOW_FILE_BYTES,
};
use crate::model::*;
use crate::parse::FlowFormat;
use std::fs;
use std::path::{Path, PathBuf};

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/flows")
}

fn codes(issues: &[FlowIssue]) -> Vec<String> {
    let mut codes: Vec<String> = issues.iter().map(|i| i.code.clone()).collect();
    codes.sort();
    codes
}

/// Checks a YAML snippet (no file references) and returns error codes.
fn errors_of(yaml: &str) -> Vec<String> {
    codes(&check_text(yaml, FlowFormat::Yaml).1.errors)
}

fn reasons_of(yaml: &str) -> Vec<(String, String, String)> {
    let (_, issues) = check_text(yaml, FlowFormat::Yaml);
    issues
        .errors
        .iter()
        .map(|i| {
            let reason = i
                .params
                .get("reason")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            (i.code.clone(), i.path.clone(), reason)
        })
        .collect()
}

const HEADER: &str = "schemaVersion: 1\nid: t\nname: T\n";

fn flow(body: &str) -> String {
    format!("{HEADER}{body}")
}

// ---------------------------------------------------------------- golden

#[test]
fn valid_fixtures_have_no_errors_or_warnings() {
    let root = fixtures().join("valid");
    for name in [
        "doc-digest.flow.yaml",
        "doc-digest-json.flow.json",
        "dev-workflow.flow.yaml",
        "manual-check.flow.yaml",
    ] {
        let report = check_file(&root, &root.join(name));
        assert!(report.errors.is_empty(), "{name}: {:#?}", report.errors);
        assert!(report.warnings.is_empty(), "{name}: {:#?}", report.warnings);
        assert!(report.flow.is_some(), "{name}");
    }
}

#[test]
fn yaml_and_json_fixtures_decode_to_the_same_flow() {
    let root = fixtures().join("valid");
    let yaml = check_file(&root, &root.join("doc-digest.flow.yaml"))
        .flow
        .unwrap();
    let json = check_file(&root, &root.join("doc-digest-json.flow.json"))
        .flow
        .unwrap();
    assert_eq!(yaml, json);
}

#[test]
fn doc_digest_fixture_decodes_every_node_kind_used() {
    let root = fixtures().join("valid");
    let flow = check_file(&root, &root.join("doc-digest.flow.yaml"))
        .flow
        .unwrap();
    let kinds: Vec<&str> = flow.nodes.iter().map(|n| n.kind.name()).collect();
    assert_eq!(
        kinds,
        ["command", "loop", "command", "approval", "command", "command"]
    );
    let NodeKind::Loop(lp) = &flow.nodes[1].kind else {
        panic!("loop")
    };
    assert_eq!(lp.parallelism, Some(2));
    assert_eq!(lp.loop_var(), "doc");
    let LoopBody::Inline(body) = &lp.body else {
        panic!("inline body")
    };
    assert_eq!(body.edges[2].max_traversals, Some(2));
    assert!(matches!(body.nodes[0].kind, NodeKind::Agent(_)));
    assert!(matches!(body.nodes[2].kind, NodeKind::Branch(_)));
}

#[test]
fn decoded_flow_round_trips_through_serialization() {
    let root = fixtures().join("valid");
    for name in ["doc-digest.flow.yaml", "dev-workflow.flow.yaml"] {
        let flow = check_file(&root, &root.join(name)).flow.unwrap();
        let json = serde_json::to_string(&flow).unwrap();
        let (again, issues) = check_text(&json, FlowFormat::Json);
        assert!(issues.errors.is_empty(), "{name}: {:#?}", issues.errors);
        assert_eq!(again.unwrap(), flow, "{name}");
    }
}

const MANIFEST_WITH_RUNTIME: &str = "schemaVersion: 1\nid: p\nname: P\nruntimes:\n  video_gen: { kind: python, python: .venv/bin/python, module: video_gen_flow }\n";

#[test]
fn python_node_needs_a_declared_runtime() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    write(&root.join(".mdium/project.yaml"), MANIFEST_WITH_RUNTIME);
    let file = root.join(".mdium/flows/a.flow.yaml");
    let ok = check_content(root, &file, &flow("nodes:\n  - { id: r, kind: python, runtime: video_gen, entry: video.render, with: { title: '${{ params.t }}' } }\nparams: { t: { type: string } }\n"));
    assert!(ok.errors.is_empty(), "{:#?}", ok.errors);
    let bad = check_content(
        root,
        &file,
        &flow("nodes:\n  - { id: r, kind: python, runtime: nope, entry: video.render }\n"),
    );
    assert_eq!(codes(&bad.errors), vec![FLOW_RUNTIME_UNKNOWN]);
    assert_eq!(bad.errors[0].path, "nodes[0].runtime");
    assert_eq!(bad.errors[0].params["runtime"], "nope");
}

#[test]
fn python_node_attributes_are_validated() {
    assert_eq!(
        reasons_of(&flow(
            "nodes:\n  - { id: r, kind: python, runtime: '', entry: video.render }\n"
        ))[0],
        (
            FLOW_INVALID_VALUE.to_string(),
            "nodes[0].runtime".to_string(),
            "empty".to_string()
        )
    );
    assert_eq!(
        reasons_of(&flow(
            "nodes:\n  - { id: r, kind: python, runtime: x, entry: 'Video.Render' }\n"
        ))[0],
        (
            FLOW_INVALID_VALUE.to_string(),
            "nodes[0].entry".to_string(),
            "bad-entry-name".to_string()
        )
    );
    assert_eq!(
        errors_of(&flow("nodes:\n  - { id: r, kind: python, runtime: x, entry: a.b, with: { k: '${{ nodes.zzz.outputs.q }}' } }\n")),
        vec![FLOW_UNKNOWN_NODE_REF]
    );
    assert_eq!(
        errors_of(&flow(
            "nodes:\n  - { id: r, kind: python, runtime: x, entry: a.b, module: m }\n"
        )),
        vec![FLOW_UNKNOWN_FIELD]
    );
}

#[test]
fn invalid_fixtures_report_exactly_their_error() {
    let cases = [
        ("schema-unsupported", FLOW_SCHEMA_UNSUPPORTED),
        ("parse-failed", FLOW_PARSE_FAILED),
        ("duplicate-node-id", FLOW_DUPLICATE_NODE_ID),
        ("unknown-port", FLOW_UNKNOWN_PORT),
        ("cycle-without-limit", FLOW_CYCLE_WITHOUT_LIMIT),
        ("loop-limit-missing", FLOW_LOOP_LIMIT_MISSING),
        ("template-invalid", FLOW_TEMPLATE_INVALID),
        ("action-unknown", FLOW_ACTION_UNKNOWN),
        ("unknown-field", FLOW_UNKNOWN_FIELD),
        ("unknown-node-kind", FLOW_UNKNOWN_NODE_KIND),
        ("invalid-value", FLOW_INVALID_VALUE),
        ("invalid-id", FLOW_INVALID_ID),
        ("condition-invalid", FLOW_CONDITION_INVALID),
        ("python-without-project", FLOW_PROJECT_REQUIRED),
    ];
    let root = fixtures().join("invalid");
    let mut seen = 0;
    for entry in fs::read_dir(&root).unwrap() {
        let path = entry.unwrap().path();
        let stem = path
            .file_name()
            .unwrap()
            .to_str()
            .unwrap()
            .trim_end_matches(".flow.yaml")
            .to_string();
        if stem == "unknown-node-ref" {
            continue;
        }
        let (_, expected) = cases
            .iter()
            .find(|(name, _)| *name == stem)
            .unwrap_or_else(|| panic!("{stem} has no expectation"));
        let report = check_file(&root, &path);
        assert_eq!(
            codes(&report.errors),
            vec![expected.to_string()],
            "{stem}: {:#?}",
            report.errors
        );
        seen += 1;
    }
    assert_eq!(seen, cases.len());
    // Both the edge and the template point at nodes that don't exist.
    let report = check_file(&root, &root.join("unknown-node-ref.flow.yaml"));
    assert_eq!(
        codes(&report.errors),
        vec![FLOW_UNKNOWN_NODE_REF, FLOW_UNKNOWN_NODE_REF]
    );
    let paths: Vec<&str> = report.errors.iter().map(|e| e.path.as_str()).collect();
    assert!(paths.contains(&"edges[0].to"), "{paths:?}");
    assert!(paths.contains(&"nodes[0].run[1]"), "{paths:?}");
}

#[test]
fn warning_fixtures_report_exactly_their_warning() {
    let root = fixtures().join("warnings");
    for (name, expected) in [
        ("unknown-key", FLOW_UNKNOWN_KEY),
        ("traversal-limit-unused", FLOW_TRAVERSAL_LIMIT_UNUSED),
        ("deprecated-field", FLOW_DEPRECATED_FIELD),
    ] {
        let report = check_file(&root, &root.join(format!("{name}.flow.yaml")));
        assert!(report.errors.is_empty(), "{name}: {:#?}", report.errors);
        assert!(report.flow.is_some(), "{name}");
        let warnings = codes(&report.warnings);
        assert!(
            warnings.iter().all(|w| w == expected) && !warnings.is_empty(),
            "{name}: {warnings:?}"
        );
    }
}

#[test]
fn parse_failure_reports_line_and_column() {
    let root = fixtures().join("invalid");
    let report = check_file(&root, &root.join("parse-failed.flow.yaml"));
    let issue = &report.errors[0];
    assert!(issue.params.contains_key("line") && issue.params.contains_key("column"));
}

#[test]
fn schema_version_must_be_present_and_supported() {
    assert_eq!(
        errors_of("id: t\nname: T\nnodes: []\n"),
        vec![FLOW_SCHEMA_UNSUPPORTED]
    );
    assert_eq!(
        errors_of("schemaVersion: '1'\nid: t\nname: T\nnodes: []\n"),
        vec![FLOW_SCHEMA_UNSUPPORTED]
    );
}

// ------------------------------------------------------- per-rule checks

#[test]
fn object_param_default_must_be_an_object() {
    let bad = flow("params:
  c: { type: object, default: [1] }
nodes:
  - { id: a, kind: command, run: [echo] }
");
    assert_eq!(reasons_of(&bad)[0].2, "type-mismatch");
    let ok = flow("params:
  c: { type: object, default: { x: 1 } }
  l: { type: array, default: [] }
nodes:
  - { id: a, kind: command, run: [echo] }
");
    assert!(errors_of(&ok).is_empty());
}

#[test]
fn flow_level_values_are_checked() {
    let yaml = "schemaVersion: 1\nid: Bad_Id\nname: ' '\n\
        params: { n: { type: number, default: 'x' }, 1p: { type: string } }\n\
        envPassthrough: ['bad-name']\n\
        defaults: { timeout: forever, retry: { max: 1, backoff: soon, on: [] } }\n\
        limits: { maxConcurrentNodes: 0, budgetUsd: -1, stopGrace: x }\n\
        env: { 'A-B': x }\n\
        outputs: { 'bad key': x }\n\
        nodes: [ { id: a, kind: command, run: [x] } ]\n";
    let found = reasons_of(yaml);
    let has = |code: &str, path: &str| found.iter().any(|(c, p, _)| c == code && p == path);
    for (code, path) in [
        (FLOW_INVALID_ID, "id"),
        (FLOW_INVALID_VALUE, "name"),
        (FLOW_INVALID_VALUE, "params.n.default"),
        (FLOW_INVALID_ID, "params.1p"),
        (FLOW_INVALID_ID, "envPassthrough[0]"),
        (FLOW_INVALID_VALUE, "defaults.timeout"),
        (FLOW_INVALID_VALUE, "defaults.retry.backoff"),
        (FLOW_INVALID_VALUE, "defaults.retry.on"),
        (FLOW_INVALID_VALUE, "limits.maxConcurrentNodes"),
        (FLOW_INVALID_VALUE, "limits.budgetUsd"),
        (FLOW_INVALID_VALUE, "limits.stopGrace"),
        (FLOW_INVALID_ID, "env.A-B"),
        (FLOW_INVALID_ID, "outputs.bad key"),
    ] {
        assert!(has(code, path), "missing {code} at {path}: {found:#?}");
    }
    assert_eq!(found.len(), 13, "{found:#?}");
}

#[test]
fn agent_prompt_rules() {
    let agent = |extra: &str| {
        flow(&format!(
            "nodes:\n  - {{ id: a, kind: agent, provider: claude, permission: read-only{extra} }}\n"
        ))
    };
    assert_eq!(reasons_of(&agent(""))[0].2, "prompt-missing");
    assert_eq!(
        reasons_of(&agent(", prompt: x, promptRef: ./p.md"))[0].2,
        "prompt-conflict"
    );
    assert_eq!(
        reasons_of(&agent(", promptRef: 'builtin:bad name'"))[0].2,
        "bad-builtin"
    );
    assert_eq!(
        reasons_of(&agent(", promptRef: './${{ params.x }}.md'"))[0].2,
        "template-not-allowed"
    );
    assert!(errors_of(&agent(", promptRef: 'builtin:review'")).is_empty());
    assert!(errors_of(&agent(", prompt: 'Summarize ${{ run.id }}', model: m1")).is_empty());
    // cli-default is not a flow permission.
    assert_eq!(
        errors_of(&flow("nodes:\n  - { id: a, kind: agent, provider: claude, permission: cli-default, prompt: x }\n")),
        vec![FLOW_INVALID_VALUE]
    );
    assert_eq!(
        errors_of(&flow(
            "nodes:\n  - { id: a, kind: agent, provider: gpt, permission: read-only, prompt: x }\n"
        )),
        vec![FLOW_INVALID_VALUE]
    );
}

#[test]
fn retry_on_key_survives_yaml_parsing() {
    // YAML 1.1 would read a bare `on` as boolean true; serde_yaml_ng keeps it a string.
    let yaml = flow(
        "nodes:
  - { id: a, kind: command, run: [x], timeout: 30分, retry: { max: 1, backoff: 10s, on: [failed, timeout] } }
",
    );
    let (_, issues) = check_text(&yaml, FlowFormat::Yaml);
    // Only the non-ASCII timeout is rejected (as a value, not a panic).
    assert_eq!(codes(&issues.errors), vec![FLOW_INVALID_VALUE]);
    assert_eq!(issues.errors[0].path, "nodes[0].timeout");
    let (flow_def, issues) = check_text(&yaml.replace("30分", "30m"), FlowFormat::Yaml);
    assert!(issues.errors.is_empty(), "{issues:#?}");
    let retry = flow_def.unwrap().nodes[0].retry.clone().unwrap();
    assert_eq!(retry.on, Some(vec![RetryOn::Failed, RetryOn::Timeout]));
}

#[test]
fn command_run_rules() {
    let cmd = |attrs: &str| {
        flow(&format!(
            "nodes:\n  - {{ id: a, kind: command, {attrs} }}\n"
        ))
    };
    assert_eq!(
        reasons_of(&cmd("run: 'echo hi'"))[0].2,
        "string-requires-shell"
    );
    assert_eq!(
        reasons_of(&cmd("run: [echo, hi], shell: true"))[0].2,
        "shell-requires-string"
    );
    assert_eq!(reasons_of(&cmd("run: []"))[0].2, "empty");
    assert_eq!(reasons_of(&cmd("run: [x], successCodes: []"))[0].2, "empty");
    assert_eq!(
        errors_of(&cmd("run: [x], env: { 'bad-name': v }")),
        vec![FLOW_INVALID_ID]
    );
    assert_eq!(
        errors_of(&cmd("run: [x], protocol: mdium-v2")),
        vec![FLOW_INVALID_VALUE]
    );
    assert!(errors_of(&cmd(
        "run: 'echo hi && exit 0', shell: true, protocol: none, detach: false"
    ))
    .is_empty());
    assert!(errors_of(&cmd(
        "run: [x], successCodes: [0, 3], env: { A_B: '${{ run.dir }}' }"
    ))
    .is_empty());
}

#[test]
fn approval_option_rules() {
    let approval = |options: &str| {
        flow(&format!(
            "nodes:\n  - {{ id: a, kind: approval, options: {options} }}\n"
        ))
    };
    assert_eq!(reasons_of(&approval("[]"))[0].2, "empty");
    assert_eq!(reasons_of(&approval("[ok, ok]"))[0].2, "duplicate-port");
    assert_eq!(reasons_of(&approval("[ok, failure]"))[0].2, "reserved-port");
    assert_eq!(errors_of(&approval("['no way']")), vec![FLOW_INVALID_ID]);
    assert!(errors_of(&approval("[publish, reject]")).is_empty());
    // `show` entries are references.
    let yaml = flow(
        "nodes:\n  - { id: a, kind: approval, show: ['nodes.ghost.outputs.x', 'not a ref'] }\n",
    );
    assert_eq!(
        errors_of(&yaml),
        vec![FLOW_TEMPLATE_INVALID, FLOW_UNKNOWN_NODE_REF]
    );
}

#[test]
fn branch_port_rules() {
    let branch = |cases: &str, default: &str| {
        flow(&format!(
            "nodes:\n  - {{ id: b, kind: branch, cases: {cases}{default} }}\n"
        ))
    };
    let c = "{ when: { ref: params.p, op: exists }, port: low }";
    let p = "params: { p: { type: string } }\n";
    let with_params = |yaml: String| yaml.replacen("nodes:", &format!("{p}nodes:"), 1);
    assert_eq!(reasons_of(&with_params(branch("[]", "")))[0].2, "empty");
    assert_eq!(
        reasons_of(&with_params(branch(&format!("[{c}]"), ", default: low")))[0].2,
        "duplicate-port"
    );
    assert_eq!(
        reasons_of(&with_params(branch(
            &format!("[{c}]"),
            ", default: failure"
        )))[0]
            .2,
        "reserved-port"
    );
    assert!(errors_of(&with_params(branch(&format!("[{c}]"), ", default: ok"))).is_empty());
    // A branch has no implicit success port.
    let yaml = with_params(flow(&format!(
        "nodes:\n  - {{ id: b, kind: branch, cases: [{c}] }}\n  - {{ id: n, kind: command, run: [x] }}\nedges:\n  - {{ from: b, to: n }}\n"
    )));
    assert_eq!(errors_of(&yaml), vec![FLOW_UNKNOWN_PORT]);
}

#[test]
fn agent_outcome_contract_adds_attention_port() {
    let yaml = |contract: &str| {
        flow(&format!(
            "nodes:\n  - {{ id: a, kind: agent, provider: codex, permission: read-only, prompt: x, outputContract: {contract} }}\n  - {{ id: n, kind: command, run: [x] }}\nedges:\n  - {{ from: a, to: n, port: attention }}\n"
        ))
    };
    assert!(errors_of(&yaml("outcome")).is_empty());
    assert_eq!(errors_of(&yaml("free")), vec![FLOW_UNKNOWN_PORT]);
}

#[test]
fn loop_rules() {
    let lp = |attrs: &str| {
        flow(&format!(
            "params: {{ list: {{ type: string }} }}\nnodes:\n  - {{ id: l, kind: loop, maxIterations: 3, {attrs} }}\n"
        ))
    };
    let body =
        "body: { nodes: [ { id: a, kind: command, run: [x, '${{ item }}', '${{ index }}'] } ] }";
    assert!(errors_of(&lp(&format!("mode: foreach, items: [1, 2], {body}"))).is_empty());
    assert_eq!(
        reasons_of(&lp(&format!("mode: foreach, {body}")))[0].2,
        "items-missing"
    );
    assert_eq!(
        reasons_of(&lp(&format!(
            "mode: foreach, items: 'a ${{{{ params.list }}}}', {body}"
        )))[0]
            .2,
        "items-not-array"
    );
    assert_eq!(
        reasons_of(&lp(&format!("mode: foreach, items: 5, {body}")))[0].2,
        "items-not-array"
    );
    assert!(errors_of(&lp(&format!(
        "mode: foreach, items: '${{{{ params.list }}}}', {body}"
    )))
    .is_empty());
    assert_eq!(
        reasons_of(&lp(&format!(
            "mode: foreach, items: [1], until: {{ ref: params.list, op: exists }}, {body}"
        )))[0]
            .2,
        "until-requires-while"
    );
    assert_eq!(
        reasons_of(&lp(&format!("mode: while, {body}")))[0].2,
        "until-missing"
    );
    assert_eq!(
        reasons_of(&lp(&format!(
            "mode: while, items: [1], until: {{ ref: iteration.outputs.done, op: exists }}, {body}"
        )))[0]
            .2,
        "items-requires-foreach"
    );
    assert!(errors_of(&lp(&format!(
        "mode: while, until: {{ ref: iteration.outputs.done, op: '==', value: true }}, {body}"
    )))
    .is_empty());
    assert_eq!(
        reasons_of(&lp(&format!(
            "mode: foreach, items: [1], parallelism: 0, {body}"
        )))[0]
            .2,
        "zero"
    );
    assert!(errors_of(&lp(
        "mode: foreach, items: [1], as: index, body: { nodes: [ { id: a, kind: command, run: [x] } ] }"
    ))
    .contains(&FLOW_INVALID_ID.to_string()));
    assert_eq!(
        reasons_of(&lp(&format!(
            "mode: foreach, items: [1], params: {{ x: 1 }}, {body}"
        )))[0]
            .2,
        "params-need-file-body"
    );
    assert_eq!(
        errors_of(&flow("nodes:\n  - { id: l, kind: loop, mode: foreach, items: [1], maxIterations: 0, body: { nodes: [ { id: a, kind: command, run: [x] } ] } }\n")),
        vec![FLOW_INVALID_VALUE]
    );
    assert_eq!(
        errors_of(&flow("nodes:\n  - { id: l, kind: loop, mode: foreach, items: [1], maxIterations: 1, body: { nodes: [] } }\n")),
        vec![FLOW_INVALID_VALUE]
    );
}

#[test]
fn reference_scoping() {
    // Inline bodies see the enclosing scope; the outer scope does not see the body.
    let yaml = flow(
        "params: { dir: { type: path } }\n\
         nodes:\n\
         \x20 - { id: collect, kind: command, run: [ls, '${{ params.dir }}'] }\n\
         \x20 - id: l\n\
         \x20   kind: loop\n\
         \x20   mode: foreach\n\
         \x20   items: '${{ nodes.collect.outputs.list }}'\n\
         \x20   maxIterations: 9\n\
         \x20   as: doc\n\
         \x20   body:\n\
         \x20     nodes:\n\
         \x20       - { id: inner, kind: command, run: [x, '${{ doc }}', '${{ nodes.collect.outputs.list }}'] }\n\
         \x20     outputs: { last: '${{ nodes.inner.outputs.v }}' }\n\
         \x20 - { id: after, kind: command, run: [x, '${{ nodes.inner.outputs.v }}', '${{ doc }}', '${{ index }}', '${{ iteration.outputs.v }}', '${{ env.HOME }}'] }\n\
         edges:\n\
         \x20 - { from: collect, to: l }\n\
         \x20 - { from: l, to: after }\n",
    );
    let found = reasons_of(&yaml);
    let at = |i: usize| format!("nodes[2].run[{i}]");
    let expect = [
        (FLOW_UNKNOWN_NODE_REF, at(1), ""),
        (FLOW_TEMPLATE_INVALID, at(2), "unknown-variable"),
        (FLOW_TEMPLATE_INVALID, at(3), "index-outside-loop"),
        (FLOW_TEMPLATE_INVALID, at(4), "iteration-outside-until"),
        (FLOW_TEMPLATE_INVALID, at(5), "env-not-passed"),
    ];
    assert_eq!(found.len(), expect.len(), "{found:#?}");
    for (code, path, reason) in expect {
        assert!(
            found
                .iter()
                .any(|(c, p, r)| c == code && *p == path && r == reason),
            "missing {code} {path} {reason}: {found:#?}"
        );
    }
    // envPassthrough makes env references valid.
    let ok = flow("envPassthrough: [HOME]\nnodes:\n  - { id: a, kind: command, run: [x, '${{ env.HOME }}'] }\n");
    assert!(errors_of(&ok).is_empty());
}

#[test]
fn template_syntax_errors_are_reported() {
    let cmd = |arg: &str| {
        flow(&format!(
            "nodes:\n  - {{ id: a, kind: command, run: [x, '{arg}'] }}\n"
        ))
    };
    assert_eq!(reasons_of(&cmd("${{ run.id"))[0].2, "unclosed");
    assert_eq!(reasons_of(&cmd("${{ }}"))[0].2, "empty");
    assert_eq!(reasons_of(&cmd("${{ a + b }}"))[0].2, "bad-reference");
}

#[test]
fn condition_references_are_checked_in_context() {
    let yaml = flow(
        "nodes:\n  - { id: a, kind: command, run: [x], when: { any: [ { ref: params.nope, op: exists }, { ref: nodes.ghost.outputs.v, op: exists } ] } }\n",
    );
    assert_eq!(
        errors_of(&yaml),
        vec![FLOW_TEMPLATE_INVALID, FLOW_UNKNOWN_NODE_REF]
    );
    let found = reasons_of(&flow(
        "nodes:\n  - { id: a, kind: command, run: [x], when: { ref: params.p, op: '==' } }\n",
    ));
    assert_eq!(
        found,
        vec![(
            FLOW_CONDITION_INVALID.to_string(),
            "nodes[0].when.value".to_string(),
            "missing-value".to_string()
        )]
    );
}

#[test]
fn edge_rules() {
    let yaml = flow(
        "nodes:\n  - { id: a, kind: command, run: [x] }\n  - { id: b, kind: command, run: [x] }\nedges:\n  - { from: a, to: b }\n  - { from: b, to: a, maxTraversals: 0 }\n",
    );
    let found = reasons_of(&yaml);
    assert!(
        found.iter().any(|(c, p, r)| c == FLOW_INVALID_VALUE
            && p == "edges[1].maxTraversals"
            && r == "zero"),
        "{found:#?}"
    );
    // A self-loop is a cycle that needs a bound.
    let self_loop = |limit: &str| {
        flow(&format!(
            "nodes:\n  - {{ id: s, kind: command, run: [x] }}\n  - {{ id: a, kind: command, run: [x] }}\nedges:\n  - {{ from: s, to: a }}\n  - {{ from: a, to: a, port: failure{limit} }}\n"
        ))
    };
    assert_eq!(errors_of(&self_loop("")), vec![FLOW_CYCLE_WITHOUT_LIMIT]);
    let (_, issues) = check_text(&self_loop(", maxTraversals: 3"), FlowFormat::Yaml);
    assert!(
        issues.errors.is_empty() && issues.warnings.is_empty(),
        "{issues:#?}"
    );
    // Fan-out and joins are fine.
    let diamond = flow(
        "nodes:\n  - { id: a, kind: command, run: [x] }\n  - { id: b, kind: command, run: [x] }\n  - { id: c, kind: command, run: [x] }\n  - { id: d, kind: command, run: [x] }\nedges:\n  - { from: a, to: b }\n  - { from: a, to: c }\n  - { from: b, to: d }\n  - { from: c, to: d }\n",
    );
    let (_, issues) = check_text(&diamond, FlowFormat::Yaml);
    assert!(
        issues.errors.is_empty() && issues.warnings.is_empty(),
        "{issues:#?}"
    );
}

#[test]
fn a_node_entered_only_by_a_back_edge_is_still_an_entry() {
    // The retry loop of the doc-digest example: `summarize` has an incoming
    // back-edge only, so it is where the body starts.
    let yaml = flow(
        "nodes:
  - { id: a, kind: command, run: [x] }
  - { id: b, kind: command, run: [x] }
edges:
  - { from: a, to: b }
  - { from: b, to: a, maxTraversals: 2 }
",
    );
    let (_, issues) = check_text(&yaml, FlowFormat::Yaml);
    assert!(
        issues.errors.is_empty() && issues.warnings.is_empty(),
        "{issues:#?}"
    );
}

#[test]
fn cycle_issue_names_only_the_nodes_on_the_cycle() {
    let yaml = flow(
        "nodes:
  - { id: s, kind: command, run: [x] }
  - { id: a, kind: command, run: [x] }
  - { id: b, kind: command, run: [x] }
  - { id: c, kind: command, run: [x] }
edges:
  - { from: s, to: a }
  - { from: a, to: b }
  - { from: b, to: a }
  - { from: b, to: c }
",
    );
    let (_, issues) = check_text(&yaml, FlowFormat::Yaml);
    assert_eq!(
        issues.errors[0].params["nodes"],
        serde_json::json!(["a", "b"])
    );
}

#[test]
fn cycle_issue_names_the_nodes() {
    let root = fixtures().join("invalid");
    let report = check_file(&root, &root.join("cycle-without-limit.flow.yaml"));
    assert_eq!(
        report.errors[0].params["nodes"],
        serde_json::json!(["a", "b"])
    );
}

#[test]
fn inline_body_graph_is_validated_as_its_own_scope() {
    let yaml = flow(
        "nodes:\n  - id: l\n    kind: loop\n    mode: foreach\n    items: [1]\n    maxIterations: 1\n    body:\n      nodes:\n        - { id: a, kind: command, run: [x] }\n        - { id: b, kind: command, run: [x] }\n      edges:\n        - { from: a, to: b }\n        - { from: b, to: a }\n        - { from: a, to: l }\n",
    );
    let found = reasons_of(&yaml);
    let has = |code: &str, path: &str| found.iter().any(|(c, p, _)| c == code && p == path);
    assert!(
        has(FLOW_CYCLE_WITHOUT_LIMIT, "nodes[0].body.edges"),
        "{found:#?}"
    );
    // An edge may not leave its scope.
    assert!(
        has(FLOW_UNKNOWN_NODE_REF, "nodes[0].body.edges[2].to"),
        "{found:#?}"
    );
}

#[test]
fn node_level_values_are_checked() {
    let yaml = flow(
        "nodes:\n  - { id: a, kind: command, run: [x], name: ' ', concurrencyKey: '', retry: { max: 1, backoff: '1x' }, cost: { estimateUsd: -1, budgetUsd: 0 } }\n",
    );
    let found = reasons_of(&yaml);
    let paths: Vec<&str> = found.iter().map(|(_, p, _)| p.as_str()).collect();
    for path in [
        "nodes[0].name",
        "nodes[0].concurrencyKey",
        "nodes[0].retry.backoff",
        "nodes[0].cost.estimateUsd",
        "nodes[0].cost.budgetUsd",
    ] {
        assert!(paths.contains(&path), "missing {path}: {found:#?}");
    }
    assert_eq!(found.len(), 5);
}

// ------------------------------------------------------ file references

fn write(path: &Path, text: &str) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, text).unwrap();
}

fn subflow_parent(reference: &str, params: &str) -> String {
    flow(&format!(
        "nodes:\n  - {{ id: s, kind: subflow, flow: '{reference}'{params} }}\n"
    ))
}

const CHILD: &str = "schemaVersion: 1\nid: child\nname: Child\nparams: { dir: { type: path, required: true }, opt: { type: string, default: x } }\nnodes:\n  - { id: a, kind: command, run: [x, '${{ params.dir }}'] }\n";

#[test]
fn subflow_reference_is_resolved_and_arguments_checked() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    let flows = root.join(".mdium/flows");
    write(&flows.join("child.flow.yaml"), CHILD);
    let parent = flows.join("parent.flow.yaml");
    let ok = check_content(
        root,
        &parent,
        &subflow_parent("./child.flow.yaml", ", params: { dir: '/tmp' }"),
    );
    assert!(ok.errors.is_empty(), "{:#?}", ok.errors);
    let bad = check_content(
        root,
        &parent,
        &subflow_parent("./child.flow.yaml", ", params: { extra: 1 }"),
    );
    let found: Vec<(String, String)> = bad
        .errors
        .iter()
        .map(|e| {
            (
                e.path.clone(),
                e.params["reason"].as_str().unwrap().to_string(),
            )
        })
        .collect();
    assert_eq!(
        codes(&bad.errors),
        vec![FLOW_PARAM_MISMATCH, FLOW_PARAM_MISMATCH]
    );
    assert!(
        found.contains(&("nodes[0].params.extra".into(), "unknown".into())),
        "{found:?}"
    );
    assert!(
        found.contains(&("nodes[0].params".into(), "missing".into())),
        "{found:?}"
    );
}

const CHILD_WITH_OUTPUTS: &str = "schemaVersion: 1\nid: child\nname: Child\nparams: { dir: { type: path, required: true } }\nnodes:\n  - { id: a, kind: command, run: [x, '${{ params.dir }}'] }\noutputs:\n  summary: \"${{ nodes.a.outputs.text }}\"\n";

fn parent_using_output(key: &str) -> String {
    flow(&format!(
        "nodes:\n  - {{ id: s, kind: subflow, flow: './child.flow.yaml', params: {{ dir: '/tmp' }} }}\n  - {{ id: use, kind: command, run: [echo, '${{{{ nodes.s.outputs.{key} }}}}'] }}\nedges:\n  - {{ from: s, to: use }}\n"
    ))
}

#[test]
fn subflow_output_references_must_be_declared_by_the_callee() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    let flows = root.join(".mdium/flows");
    write(&flows.join("child.flow.yaml"), CHILD_WITH_OUTPUTS);
    let parent = flows.join("parent.flow.yaml");
    let ok = check_content(root, &parent, &parent_using_output("summary"));
    assert!(ok.errors.is_empty(), "{:#?}", ok.errors);
    let bad = check_content(root, &parent, &parent_using_output("nope"));
    assert_eq!(codes(&bad.errors), vec![FLOW_OUTPUT_UNKNOWN]);
    let issue = &bad.errors[0];
    assert_eq!(issue.path, "nodes[1].run[1]");
    assert_eq!(issue.params["node"], "s");
    assert_eq!(issue.params["key"], "nope");
    // The whole object is always allowed.
    let whole = flow("nodes:\n  - { id: s, kind: subflow, flow: './child.flow.yaml', params: { dir: '/tmp' } }\n  - { id: use, kind: command, run: [echo, '${{ nodes.s.outputs }}'] }\nedges:\n  - { from: s, to: use }\n");
    assert!(check_content(root, &parent, &whole).errors.is_empty());
}

#[test]
fn loop_output_references_use_the_fixed_keys() {
    let ok = flow("nodes:\n  - { id: l, kind: loop, mode: foreach, items: '${{ params.xs }}', maxIterations: 3, body: { nodes: [ { id: a, kind: command, run: [x] } ] } }\n  - { id: use, kind: command, run: [echo, '${{ nodes.l.outputs.results }}'] }\nparams: { xs: { type: string } }\nedges:\n  - { from: l, to: use }\n");
    assert!(errors_of(&ok).is_empty(), "{:?}", errors_of(&ok));
    let bad = flow("nodes:\n  - { id: l, kind: loop, mode: foreach, items: '${{ params.xs }}', maxIterations: 3, body: { nodes: [ { id: a, kind: command, run: [x] } ] } }\n  - { id: use, kind: command, run: [echo, '${{ nodes.l.outputs.total }}'] }\nparams: { xs: { type: string } }\nedges:\n  - { from: l, to: use }\n");
    assert_eq!(errors_of(&bad), vec![FLOW_OUTPUT_UNKNOWN]);
}

#[test]
fn output_check_is_skipped_when_the_callee_is_invalid() {
    // Only FLOW_SUBFLOW_INVALID, no second error, no panic.
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    let flows = root.join(".mdium/flows");
    write(
        &flows.join("child.flow.yaml"),
        "schemaVersion: 1\nid: child\nname: Child\nnodes: []\n",
    );
    let parent = flows.join("parent.flow.yaml");
    let report = check_content(root, &parent, &parent_using_output("summary"));
    assert_eq!(codes(&report.errors), vec![FLOW_SUBFLOW_INVALID]);
}

#[test]
fn missing_and_escaping_references_are_rejected() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("project");
    let flows = root.join(".mdium/flows");
    fs::create_dir_all(&flows).unwrap();
    write(&tmp.path().join("outside.flow.yaml"), CHILD);
    let parent = flows.join("p.flow.yaml");
    let check = |reference: &str| {
        codes(&check_content(&root, &parent, &subflow_parent(reference, "")).errors)
    };
    assert_eq!(check("./nope.flow.yaml"), vec![FLOW_REF_NOT_FOUND]);
    assert_eq!(
        check("../../../outside.flow.yaml"),
        vec![FLOW_PATH_OUTSIDE_PROJECT]
    );
    let absolute = tmp.path().join("outside.flow.yaml").display().to_string();
    assert_eq!(check(&absolute), vec![FLOW_PATH_OUTSIDE_PROJECT]);
    // promptRef follows the same rules.
    let agent = flow("nodes:\n  - { id: a, kind: agent, provider: claude, permission: read-only, promptRef: ./prompts/missing.md }\n");
    assert_eq!(
        codes(&check_content(&root, &parent, &agent).errors),
        vec![FLOW_REF_NOT_FOUND]
    );
    write(&flows.join("prompts/ok.md"), "hello");
    let agent = agent.replace("missing.md", "ok.md");
    assert!(check_content(&root, &parent, &agent).errors.is_empty());
    // A referenced file must itself be a flow file.
    assert_eq!(check("./prompts/ok.md"), vec![FLOW_INVALID_VALUE]);
}

#[cfg(windows)]
#[test]
fn references_through_a_junction_are_rejected() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("project");
    let flows = root.join(".mdium/flows");
    let real = tmp.path().join("elsewhere");
    write(&real.join("child.flow.yaml"), CHILD);
    fs::create_dir_all(&flows).unwrap();
    junction::create(&real, flows.join("linked")).unwrap();
    let parent = flows.join("p.flow.yaml");
    let report = check_content(
        &root,
        &parent,
        &subflow_parent("./linked/child.flow.yaml", ", params: { dir: x }"),
    );
    assert_eq!(codes(&report.errors), vec![FLOW_PATH_OUTSIDE_PROJECT]);
    assert_eq!(report.errors[0].params["reason"], "link");
}

#[test]
fn subflow_recursion_is_detected() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    let flows = root.join(".mdium/flows");
    write(
        &flows.join("a.flow.yaml"),
        &subflow_parent("./b.flow.yaml", ""),
    );
    write(
        &flows.join("b.flow.yaml"),
        &subflow_parent("./a.flow.yaml", "").replace("id: t", "id: b"),
    );
    let report = check_file(root, &flows.join("a.flow.yaml"));
    assert_eq!(codes(&report.errors), vec![FLOW_SUBFLOW_RECURSION]);
    // Self reference, and through a loop's file body.
    write(
        &flows.join("self.flow.yaml"),
        &subflow_parent("./self.flow.yaml", ""),
    );
    assert_eq!(
        codes(&check_file(root, &flows.join("self.flow.yaml")).errors),
        vec![FLOW_SUBFLOW_RECURSION]
    );
    let looped = flow("nodes:\n  - { id: l, kind: loop, mode: foreach, items: [1], maxIterations: 1, body: ./looped.flow.yaml }\n");
    write(&flows.join("looped.flow.yaml"), &looped);
    assert_eq!(
        codes(&check_file(root, &flows.join("looped.flow.yaml")).errors),
        vec![FLOW_SUBFLOW_RECURSION]
    );
}

#[test]
fn deep_subflow_chains_are_cut_off() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    let flows = root.join(".mdium/flows");
    for i in 0..20 {
        write(
            &flows.join(format!("f{i}.flow.yaml")),
            &subflow_parent(&format!("./f{}.flow.yaml", i + 1), ""),
        );
    }
    write(
        &flows.join("f20.flow.yaml"),
        &flow("nodes:\n  - { id: a, kind: command, run: [x] }\n"),
    );
    let report = check_file(root, &flows.join("f0.flow.yaml"));
    assert_eq!(codes(&report.errors), vec![FLOW_SUBFLOW_RECURSION]);
}

#[test]
fn invalid_subflow_is_reported_on_the_parent() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    let flows = root.join(".mdium/flows");
    write(
        &flows.join("broken.flow.yaml"),
        &flow("nodes:\n  - { id: a, kind: command }\n"),
    );
    let report = check_content(
        root,
        &flows.join("p.flow.yaml"),
        &subflow_parent("./broken.flow.yaml", ""),
    );
    assert_eq!(codes(&report.errors), vec![FLOW_SUBFLOW_INVALID]);
    assert_eq!(report.errors[0].params["errorCount"], 1);
}

#[test]
fn file_body_loop_passes_params_with_loop_variable() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    let flows = root.join(".mdium/flows");
    write(&flows.join("child.flow.yaml"), CHILD);
    let parent = flow("nodes:\n  - { id: l, kind: loop, mode: foreach, items: [a, b], maxIterations: 2, body: ./child.flow.yaml, params: { dir: '${{ item }}' } }\n");
    let report = check_content(root, &flows.join("p.flow.yaml"), &parent);
    assert!(report.errors.is_empty(), "{:#?}", report.errors);
}

#[test]
fn oversized_files_are_refused() {
    let tmp = tempfile::tempdir().unwrap();
    let file = tmp.path().join("big.flow.yaml");
    let mut text = flow("nodes:\n  - { id: a, kind: command, run: [x] }\n");
    text.push_str(&format!("# {}\n", "x".repeat(MAX_FLOW_FILE_BYTES as usize)));
    fs::write(&file, text).unwrap();
    assert_eq!(
        codes(&check_file(tmp.path(), &file).errors),
        vec![FLOW_FILE_TOO_LARGE]
    );
}

#[test]
fn content_is_checked_by_file_name_format() {
    let tmp = tempfile::tempdir().unwrap();
    let json = "{\"schemaVersion\":1,\"id\":\"t\",\"name\":\"T\",\"nodes\":[{\"id\":\"a\",\"kind\":\"command\",\"run\":[\"x\"]}]}";
    assert!(
        check_content(tmp.path(), &tmp.path().join("a.flow.json"), json)
            .errors
            .is_empty()
    );
    assert!(
        check_content(tmp.path(), &tmp.path().join("a.flow.yaml"), json)
            .errors
            .is_empty()
    );
    let yaml = flow("nodes:\n  - { id: a, kind: command, run: [x] }\n");
    assert_eq!(
        codes(&check_content(tmp.path(), &tmp.path().join("a.flow.json"), &yaml).errors),
        vec![FLOW_PARSE_FAILED]
    );
    assert_eq!(
        codes(&check_content(tmp.path(), &tmp.path().join("a.txt"), &yaml).errors),
        vec![FLOW_INVALID_VALUE]
    );
}

// ------------------------------------------------------------ listing

#[test]
fn list_flows_groups_entries_and_lib_parts() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    assert!(
        list_flows(root).unwrap().is_empty(),
        "missing dir yields empty list"
    );
    let flows = root.join(".mdium/flows");
    write(
        &flows.join("b.flow.yaml"),
        &flow("description: Entry B\nparams: { n: { type: number, default: 1 } }\nnodes:\n  - { id: a, kind: command, run: [x] }\noutputs: { total: \"${{ nodes.a.outputs.n }}\" }\n"),
    );
    write(&flows.join("a.flow.json"), "{ not json");
    write(&flows.join("notes.md"), "ignored");
    write(&flows.join("nested/c.flow.yaml"), "ignored: true");
    write(
        &flows.join("lib/part.flow.yaml"),
        &flow("nodes:\n  - { id: a, kind: command, run: [x] }\n"),
    );
    write(
        &flows.join("lib/deep/inner.flow.yaml"),
        &flow("nodes:\n  - { id: a, kind: command, run: [x] }\n"),
    );
    write(
        &root.join(".mdium/project.yaml"),
        "schemaVersion: 1\nid: p\nname: P\nflows: { main: flows/b.flow.yaml }\n",
    );
    let list = list_flows(root).unwrap();
    let paths: Vec<&str> = list.iter().map(|s| s.path.as_str()).collect();
    assert_eq!(
        paths,
        vec![
            ".mdium/flows/a.flow.json",
            ".mdium/flows/b.flow.yaml",
            ".mdium/flows/lib/deep/inner.flow.yaml",
            ".mdium/flows/lib/part.flow.yaml",
        ]
    );
    assert_eq!(
        (list[0].kind, list[0].id.clone(), list[0].error_count),
        (FlowKind::Entry, None, 1)
    );
    let b = &list[1];
    assert_eq!(
        (b.kind, b.id.as_deref(), b.role.as_deref()),
        (FlowKind::Entry, Some("t"), Some("main"))
    );
    assert_eq!(b.description.as_deref(), Some("Entry B"));
    assert_eq!(b.params.keys().cloned().collect::<Vec<_>>(), vec!["n"]);
    assert_eq!(b.outputs, vec!["total"]);
    assert_eq!(list[2].kind, FlowKind::Part);
    assert_eq!(list[3].kind, FlowKind::Part);
    assert!(list[3].role.is_none());
}

#[test]
fn resolve_flow_path_checks_name_and_containment() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    write(&root.join(".mdium/flows/a.flow.yaml"), "x");
    assert!(resolve_flow_path(root, ".mdium/flows/a.flow.yaml", true).is_ok());
    assert_eq!(
        resolve_flow_path(root, ".mdium/flows/b.flow.yaml", true),
        Err(PathProblem::NotFound)
    );
    assert!(resolve_flow_path(root, ".mdium/flows/b.flow.yaml", false).is_ok());
    assert_eq!(
        resolve_flow_path(root, ".mdium/flows/a.yaml", false),
        Err(PathProblem::Outside("bad-file-name"))
    );
    assert_eq!(
        resolve_flow_path(root, "../x.flow.yaml", false),
        Err(PathProblem::Outside("outside-root"))
    );
    let absolute = root.join("x.flow.yaml").display().to_string();
    assert_eq!(
        resolve_flow_path(root, &absolute, false),
        Err(PathProblem::Outside("absolute"))
    );
}

#[test]
fn whole_outputs_reference_needs_a_visible_node() {
    let ok = flow(
        "nodes:
  - { id: a, kind: command, run: [x] }
  - { id: b, kind: command, run: [y, '${{ nodes.a.outputs }}'] }
edges:
  - { from: a, to: b }
",
    );
    assert!(errors_of(&ok).is_empty(), "{:?}", errors_of(&ok));
    let bad = flow(
        "nodes:
  - { id: b, kind: command, run: [y, '${{ nodes.zzz.outputs }}'] }
",
    );
    assert_eq!(errors_of(&bad), vec![FLOW_UNKNOWN_NODE_REF]);
}

#[test]
fn constant_subflow_arguments_must_match_the_param_type() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    let flows = root.join(".mdium/flows");
    write(&flows.join("child.flow.yaml"), CHILD);
    let parent = flows.join("parent.flow.yaml");
    let bad = check_content(
        root,
        &parent,
        &subflow_parent("./child.flow.yaml", ", params: { dir: 42 }"),
    );
    assert_eq!(codes(&bad.errors), vec![FLOW_PARAM_TYPE]);
    let issue = &bad.errors[0];
    assert_eq!(issue.path, "nodes[0].params.dir");
    assert_eq!(issue.params["expected"], "path");
    assert_eq!(issue.params["found"], "number");
    // Templated values are not checked here (run time does that).
    let templated = check_content(
        root,
        &parent,
        &flow("params: { n: { type: number } }\nnodes:\n  - { id: s, kind: subflow, flow: './child.flow.yaml', params: { dir: '${{ params.n }}' } }\n"),
    );
    assert!(templated.errors.is_empty(), "{:#?}", templated.errors);
}

const TYPED_CHILD: &str = "schemaVersion: 1\nid: child\nname: Child\nparams: { dir: { type: path, default: d }, opt: { type: string, default: x }, b: { type: bool, default: false }, n: { type: number, default: 0 } }\nnodes:\n  - { id: a, kind: command, run: [x] }\n";

fn check_with_child(child: &str, parent_yaml: &str) -> crate::load::FlowReport {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    let flows = root.join(".mdium/flows");
    write(&flows.join("child.flow.yaml"), child);
    check_content(root, &flows.join("parent.flow.yaml"), parent_yaml)
}

#[test]
fn null_constants_use_the_default_and_do_not_satisfy_required_params() {
    // `null` for a required param without default is "missing".
    let missing = check_with_child(
        CHILD,
        &subflow_parent("./child.flow.yaml", ", params: { dir: null }"),
    );
    assert_eq!(codes(&missing.errors), vec![FLOW_PARAM_MISMATCH]);
    assert_eq!(missing.errors[0].params["reason"], "missing");
    // `null` for an optional param is fine.
    let opt_null = check_with_child(
        CHILD,
        &subflow_parent("./child.flow.yaml", ", params: { dir: '/tmp', opt: null }"),
    );
    assert!(opt_null.errors.is_empty(), "{:#?}", opt_null.errors);
    // A wrong-typed value for a string param.
    let opt_num = check_with_child(
        CHILD,
        &subflow_parent("./child.flow.yaml", ", params: { dir: '/tmp', opt: 1 }"),
    );
    assert_eq!(codes(&opt_num.errors), vec![FLOW_PARAM_TYPE]);
    assert_eq!(opt_num.errors[0].params["expected"], "string");
}

#[test]
fn constant_arguments_are_checked_for_every_param_type() {
    let bool_num = check_with_child(
        TYPED_CHILD,
        &subflow_parent("./child.flow.yaml", ", params: { b: 1 }"),
    );
    assert_eq!(codes(&bool_num.errors), vec![FLOW_PARAM_TYPE]);
    assert_eq!(bool_num.errors[0].params["expected"], "bool");
    assert_eq!(bool_num.errors[0].params["found"], "number");
    let num_str = check_with_child(
        TYPED_CHILD,
        &subflow_parent("./child.flow.yaml", ", params: { n: 'x' }"),
    );
    assert_eq!(codes(&num_str.errors), vec![FLOW_PARAM_TYPE]);
    assert_eq!(num_str.errors[0].params["expected"], "number");
    assert_eq!(num_str.errors[0].params["found"], "string");
    let ok = check_with_child(
        TYPED_CHILD,
        &subflow_parent(
            "./child.flow.yaml",
            ", params: { dir: '/tmp', opt: s, b: true, n: 3 }",
        ),
    );
    assert!(ok.errors.is_empty(), "{:#?}", ok.errors);
    // An unknown param is only a mismatch, never also a type error.
    let unknown = check_with_child(
        TYPED_CHILD,
        &subflow_parent("./child.flow.yaml", ", params: { extra: { a: 1 } }"),
    );
    assert_eq!(codes(&unknown.errors), vec![FLOW_PARAM_MISMATCH]);
}

#[test]
fn loop_file_body_arguments_are_type_checked() {
    let parent = flow("params: { xs: { type: string } }\nnodes:\n  - { id: l, kind: loop, mode: foreach, items: '${{ params.xs }}', maxIterations: 2, body: './child.flow.yaml', params: { dir: 42 } }\n");
    let report = check_with_child(CHILD, &parent);
    assert_eq!(codes(&report.errors), vec![FLOW_PARAM_TYPE]);
    assert_eq!(report.errors[0].path, "nodes[0].params.dir");
}

#[test]
fn template_referencing_a_missing_node_reports_only_the_node() {
    let yaml =
        flow("nodes:\n  - { id: a, kind: command, run: [echo, '${{ nodes.zzz.outputs.k }}'] }\n");
    assert_eq!(errors_of(&yaml), vec![FLOW_UNKNOWN_NODE_REF]);
}

#[test]
fn subflow_outputs_are_checked_inside_an_inline_loop_body() {
    let parent = |key: &str| {
        flow(&format!(
            "params: {{ xs: {{ type: string }} }}\nnodes:\n  - {{ id: l, kind: loop, mode: foreach, items: '${{{{ params.xs }}}}', maxIterations: 2, body: {{ nodes: [ {{ id: s, kind: subflow, flow: './child.flow.yaml', params: {{ dir: '/tmp' }} }}, {{ id: use, kind: command, run: [echo, '${{{{ nodes.s.outputs.{key} }}}}'] }} ], edges: [ {{ from: s, to: use }} ] }} }}\n"
        ))
    };
    let bad = check_with_child(CHILD_WITH_OUTPUTS, &parent("nope"));
    assert_eq!(
        codes(&bad.errors),
        vec![FLOW_OUTPUT_UNKNOWN],
        "{:#?}",
        bad.errors
    );
    let ok = check_with_child(CHILD_WITH_OUTPUTS, &parent("summary"));
    assert!(ok.errors.is_empty(), "{:#?}", ok.errors);
}

#[test]
fn list_flows_with_a_broken_manifest_still_lists_flows_without_roles() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    write(
        &root.join(".mdium/flows/a.flow.yaml"),
        &flow("nodes:\n  - { id: a, kind: command, run: [x] }\n"),
    );
    write(&root.join(".mdium/project.yaml"), "{ not yaml");
    let list = list_flows(root).unwrap();
    assert_eq!(list.len(), 1);
    assert!(list.iter().all(|s| s.role.is_none()));
}

#[cfg(windows)]
#[test]
fn lib_prefix_is_matched_case_insensitively_on_windows() {
    use crate::load::flow_kind_of;
    assert_eq!(flow_kind_of(".mdium/flows/LIB/x.flow.yaml"), FlowKind::Part);
    assert_eq!(flow_kind_of(".mdium/flows/x.flow.yaml"), FlowKind::Entry);
}

#[test]
fn artifact_references_need_a_visible_node() {
    let (_, issues) = check_text(
        &flow("nodes:\n  - { id: a, kind: command, run: [x] }\n  - { id: r, kind: approval, show: ['nodes.a.artifacts', 'nodes.a.artifacts.pic', 'nodes.zzz.artifacts'] }\nedges:\n  - { from: a, to: r }\n"),
        FlowFormat::Yaml,
    );
    assert_eq!(codes(&issues.errors), vec![FLOW_UNKNOWN_NODE_REF]);
    assert_eq!(issues.errors[0].path, "nodes[1].show[2]");
}

#[test]
fn agent_with_and_subflow_project_root_parse_and_validate() {
    let text = "schemaVersion: 1\nid: a\nname: A\nparams: { root: { type: string, default: '' } }\nnodes:\n  - { id: g, kind: agent, provider: claude, permission: read-only, promptRef: 'builtin:design', with: { requirement: 'r ${{ params.root }}' } }\n  - { id: s, kind: subflow, flow: lib/p.flow.yaml, projectRoot: '${{ params.root }}' }\nedges: [{ from: g, to: s }]\n";
    let (flow, issues) = check_text(text, FlowFormat::Yaml);
    let flow = flow.unwrap();
    let NodeKind::Agent(agent) = &flow.nodes[0].kind else {
        panic!()
    };
    assert_eq!(
        agent.with_args["requirement"],
        serde_json::json!("r ${{ params.root }}")
    );
    let NodeKind::Subflow(sub) = &flow.nodes[1].kind else {
        panic!()
    };
    assert_eq!(sub.project_root.as_deref(), Some("${{ params.root }}"));
    assert!(
        issues.errors.iter().all(|i| i.code != FLOW_UNKNOWN_FIELD),
        "{issues:?}"
    );
}

#[test]
fn action_inputs_are_checked_against_the_spec() {
    let ok = flow(
        "nodes:\n  - { id: a, kind: action, uses: mdium/git-merge-local, with: { worktree: '${{ params.w }}', acknowledgeReviewPaths: true } }\n",
    );
    let ok = ok.replace("nodes:", "params: { w: { type: string } }\nnodes:");
    assert!(errors_of(&ok).is_empty(), "{:?}", errors_of(&ok));
    let bad = flow(
        "nodes:\n  - { id: a, kind: action, uses: mdium/screen-input, with: { txt: hi } }\n",
    );
    let report = check_text(&bad, FlowFormat::Yaml).1;
    let found: Vec<(String, String, String)> = report
        .errors
        .iter()
        .map(|e| {
            (
                e.code.clone(),
                e.path.clone(),
                e.params["reason"].as_str().unwrap().to_string(),
            )
        })
        .collect();
    assert_eq!(
        found,
        vec![
            (FLOW_INVALID_VALUE.into(), "nodes[0].with.txt".into(), "unknown-input".into()),
            (FLOW_INVALID_VALUE.into(), "nodes[0].with.text".into(), "input-missing".into()),
        ]
    );
    // Optional inputs may be left out.
    let optional = flow("nodes:\n  - { id: a, kind: action, uses: mdium/project-setup }\n");
    assert!(errors_of(&optional).is_empty());
}
