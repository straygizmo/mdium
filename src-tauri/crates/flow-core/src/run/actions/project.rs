//! The project actions: `mdium/project-setup`, `mdium/flow-run-latest` and
//! `mdium/metrics-compare`. Thin adapters over `setup`, the run store and
//! the project manifest.

use super::{
    input_invalid, required_obj, required_str, ActionContext, ActionEnd, FLOW_ACTION_FAILED,
};
use crate::fsutil;
use crate::project::{self, Better, MetricDef};
use crate::run::engine::sha256_hex;
use crate::run::model::{NodeStatus, Reason, RunState, RunStatus};
use crate::run::store::RunStore;
use crate::setup;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::PathBuf;

/// The project root has no readable `.mdium/project.yaml`.
const FLOW_PROJECT_REQUIRED: &str = "FLOW_PROJECT_REQUIRED";
/// The manifest has validation errors.
const FLOW_PROJECT_INVALID: &str = "FLOW_PROJECT_INVALID";
/// A setup step failed (`step`, `exitCode`).
const FLOW_SETUP_FAILED: &str = "FLOW_SETUP_FAILED";
/// `FLOW_ACTION_FAILED` code: no completed run of the flow exists.
const FLOW_RUN_NOT_FOUND: &str = "FLOW_RUN_NOT_FOUND";
/// `FLOW_ACTION_FAILED` code: the project declares no metrics.
const FLOW_METRICS_MISSING: &str = "FLOW_METRICS_MISSING";

/// `FLOW_ACTION_FAILED` with a `code` and `message`.
fn failed(code: &str, message: impl Into<String>) -> Reason {
    Reason::new(FLOW_ACTION_FAILED)
        .with("code", code)
        .with("message", message.into())
}

/// `mdium/project-setup` `{ projectRoot? }` -> `{ ok: true }`: runs the setup
/// steps of the manifest. A manifest other than the confirmed one asks first.
pub(super) fn project_setup(
    with: &BTreeMap<String, Value>,
    ctx: &ActionContext,
) -> Result<ActionEnd, Reason> {
    let root = match with.get("projectRoot") {
        None | Some(Value::Null) => ctx.project_root.clone(),
        Some(Value::String(text)) => ctx.project_root.join(text),
        Some(_) => return Err(input_invalid("projectRoot", "not-a-string")),
    };
    if !root.is_dir() {
        return Err(input_invalid("projectRoot", "not-a-directory"));
    }
    let Some((bytes, report)) = project::load_project_bytes(&root) else {
        return Err(Reason::new(FLOW_PROJECT_REQUIRED).with("projectRoot", root.to_string_lossy()));
    };
    let project = match report.project {
        Some(project) if report.errors.is_empty() => project,
        _ => {
            return Err(Reason::new(FLOW_PROJECT_INVALID)
                .with("projectRoot", root.to_string_lossy())
                .with("errors", report.errors.len()))
        }
    };
    let sha256 = sha256_hex(&bytes);
    let steps: Vec<Value> = project.setup.iter().map(|step| json!(step.run)).collect();
    let show = BTreeMap::from([
        ("setup".to_string(), Value::Array(steps)),
        ("sha256".to_string(), Value::String(sha256.clone())),
    ]);
    // The confirmed manifest runs as is; any other needs the user's go-ahead
    // for exactly what is shown now.
    if ctx.project_sha256.as_deref() != Some(sha256.as_str())
        && ctx.acknowledged.as_ref() != Some(&show)
    {
        return Ok(ActionEnd::NeedsApproval {
            show,
            outputs: BTreeMap::new(),
        });
    }
    let result = setup::run_setup(
        &root,
        &project,
        &*ctx.launcher,
        ctx.poll,
        &|progress| {
            (ctx.progress)(format!(
                "setup {}/{}: {:?}",
                progress.step, progress.total, progress.status
            ))
        },
        Some(&ctx.cancel),
    );
    if result.cancelled {
        return Ok(ActionEnd::Cancelled);
    }
    if result.ok {
        return Ok(ActionEnd::done(BTreeMap::from([(
            "ok".to_string(),
            Value::Bool(true),
        )])));
    }
    let step = result
        .steps
        .iter()
        .find(|step| step.exit_code != Some(0))
        .or(result.steps.last());
    Err(Reason::new(FLOW_SETUP_FAILED)
        .with("step", step.map(|s| s.index).unwrap_or(0))
        .with("exitCode", step.and_then(|s| s.exit_code)))
}

/// `mdium/flow-run-latest` `{ flow }` -> the newest completed run of that flow
/// file: `{ runId, runDir, status, outputs, costUsd, failedNodes }`.
pub(super) fn flow_run_latest(
    with: &BTreeMap<String, Value>,
    ctx: &ActionContext,
) -> Result<ActionEnd, Reason> {
    let flow = required_str(with, "flow")?.replace('\\', "/");
    let store = RunStore::new(&ctx.project_root);
    let ids = store
        .list_ids()
        .map_err(|err| failed("RUN_STORE_FAILED", err.to_string()))?;
    let mut best: Option<(String, String, RunState)> = None;
    for id in ids {
        let Ok(meta) = store.load_meta(&id) else {
            continue;
        };
        if meta.flow_path.replace('\\', "/") != flow {
            continue;
        }
        let Ok(state) = store.load_state(&id, &meta) else {
            continue;
        };
        if state.status != RunStatus::Completed {
            continue;
        }
        if best.as_ref().map_or(true, |(_, at, _)| meta.created_at > *at) {
            best = Some((id, meta.created_at, state));
        }
    }
    let Some((run_id, _, state)) = best else {
        return Err(failed(
            FLOW_RUN_NOT_FOUND,
            format!("no completed run of {flow}"),
        ));
    };
    let run_dir = store
        .run_dir(&run_id)
        .map_err(|err| failed("RUN_STORE_FAILED", err.to_string()))?;
    let outputs: serde_json::Map<String, Value> = state
        .scopes
        .get("")
        .map(|scope| scope.outputs.clone().into_iter().collect())
        .unwrap_or_default();
    let failed_nodes: Vec<Value> = state
        .nodes
        .iter()
        .filter(|(_, node)| node.status == NodeStatus::Failed)
        .map(|(key, _)| Value::String(key.clone()))
        .collect();
    Ok(ActionEnd::done(BTreeMap::from([
        ("runId".to_string(), Value::String(run_id)),
        (
            "runDir".to_string(),
            Value::String(run_dir.to_string_lossy().into_owned()),
        ),
        ("status".to_string(), json!("completed")),
        ("outputs".to_string(), Value::Object(outputs)),
        ("costUsd".to_string(), json!(state.cost.total())),
        ("failedNodes".to_string(), Value::Array(failed_nodes)),
    ])))
}

/// `mdium/metrics-compare` `{ baseline, candidate }` (each `{ outputs, costUsd }`)
/// -> `{ improved, report, reportPath }` plus the `report.md` artifact.
pub(super) fn metrics_compare(
    with: &BTreeMap<String, Value>,
    ctx: &ActionContext,
) -> Result<ActionEnd, Reason> {
    let baseline = Value::Object(required_obj(with, "baseline")?.clone());
    let candidate = Value::Object(required_obj(with, "candidate")?.clone());
    let metrics = ctx
        .project
        .as_ref()
        .map(|project| project.metrics.as_slice())
        .unwrap_or_default();
    if metrics.is_empty() {
        return Err(failed(
            FLOW_METRICS_MISSING,
            "the project declares no metrics",
        ));
    }
    let (improved, report) = compare_metrics(metrics, &baseline, &candidate);
    let path: PathBuf = ctx.node_dir.join("report.md");
    fsutil::atomic_write(&path, report.as_bytes())
        .map_err(|err| failed("IO_ERROR", err.to_string()))?;
    let outputs = BTreeMap::from([
        ("improved".to_string(), Value::Bool(improved)),
        ("report".to_string(), Value::String(report)),
        (
            "reportPath".to_string(),
            Value::String(path.to_string_lossy().into_owned()),
        ),
    ]);
    Ok(ActionEnd::Done {
        outputs,
        artifacts: vec![(path, "report".to_string())],
    })
}

/// The number at a dotted path (`outputs.score`, `costUsd`) of `side`.
fn metric_value(side: &Value, reference: &str) -> Option<f64> {
    let mut current = side;
    for part in reference.split('.') {
        current = current.get(part)?;
    }
    current.as_f64()
}

/// Judges every metric of `candidate` against `baseline`: `better`, `worse`,
/// `same` or `unknown` (a side is missing). Improved = nothing worse and at
/// least one better. The report is a markdown table.
pub fn compare_metrics(
    metrics: &[MetricDef],
    baseline: &Value,
    candidate: &Value,
) -> (bool, String) {
    let mut report = String::from("| metric | baseline | candidate | result |\n|---|---|---|---|\n");
    let (mut any_better, mut any_worse) = (false, false);
    for metric in metrics {
        let base = metric_value(baseline, &metric.reference);
        let cand = metric_value(candidate, &metric.reference);
        let verdict = match (base, cand) {
            (Some(base), Some(cand)) if base == cand => "same",
            (Some(base), Some(cand)) => {
                if (cand > base) == (metric.better == Better::Higher) {
                    any_better = true;
                    "better"
                } else {
                    any_worse = true;
                    "worse"
                }
            }
            _ => "unknown",
        };
        let cell = |value: Option<f64>| value.map_or("-".to_string(), |v| v.to_string());
        report.push_str(&format!(
            "| {} | {} | {} | {} |\n",
            metric.reference,
            cell(base),
            cell(cand),
            verdict
        ));
    }
    (any_better && !any_worse, report)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compare_metrics_judges_higher_lower_same_and_unknown() {
        let metrics = vec![
            MetricDef { reference: "outputs.coverage".into(), better: Better::Higher },
            MetricDef { reference: "outputs.coherence".into(), better: Better::Higher },
            MetricDef { reference: "costUsd".into(), better: Better::Lower },
        ];
        let base = json!({ "outputs": { "coverage": 10.0, "coherence": 8.0 }, "costUsd": 2.0 });
        let better = json!({ "outputs": { "coverage": 12.0, "coherence": 8.0 }, "costUsd": 2.0 });
        let (improved, report) = compare_metrics(&metrics, &base, &better);
        assert!(improved && report.contains("| outputs.coverage | 10 | 12 | better |") && report.contains("| same |"));
        let worse = json!({ "outputs": { "coverage": 12.0, "coherence": 7.0 }, "costUsd": 2.0 });
        assert!(!compare_metrics(&metrics, &base, &worse).0);
        let unknown = json!({ "outputs": { "coverage": 12.0 }, "costUsd": 2.0 });
        let (improved, report) = compare_metrics(&metrics, &base, &unknown);
        assert!(improved && report.contains("| unknown |"));
        assert!(!compare_metrics(&metrics, &base, &base).0, "all same is not an improvement");
        let pricier = json!({ "outputs": { "coverage": 12.0, "coherence": 8.0 }, "costUsd": 3.0 });
        assert!(!compare_metrics(&metrics, &base, &pricier).0, "a worse lower-is-better metric blocks the improvement");
    }
}
