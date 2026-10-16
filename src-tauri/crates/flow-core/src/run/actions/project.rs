//! The project actions: `mdium/project-setup`, `mdium/project-test`,
//! `mdium/flow-run-latest` and `mdium/metrics-compare`. Thin adapters over
//! `setup`, the run store and the project manifest.

use super::{
    input_invalid, required_obj, required_str, ActionContext, ActionEnd, FLOW_ACTION_FAILED,
};
use crate::fsutil;
use crate::project::{self, Better, MetricDef, ProjectDef, SetupStep};
use crate::run::engine::sha256_hex;
use crate::run::model::{NodeStatus, Reason, RunState, RunStatus};
use crate::run::store::{RunMeta, RunStore};
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

/// `with.projectRoot` (default: the run's project) as an existing directory.
fn root_of(with: &BTreeMap<String, Value>, ctx: &ActionContext) -> Result<PathBuf, Reason> {
    let root = match with.get("projectRoot") {
        None | Some(Value::Null) => ctx.project_root.clone(),
        Some(Value::String(text)) => ctx.project_root.join(text),
        Some(_) => return Err(input_invalid("projectRoot", "not-a-string")),
    };
    if !root.is_dir() {
        return Err(input_invalid("projectRoot", "not-a-directory"));
    }
    Ok(root)
}

/// The manifest at `root`: its definition and content hash; `None` without one.
fn manifest_at(root: &std::path::Path) -> Result<Option<(ProjectDef, String)>, Reason> {
    let Some((bytes, report)) = project::load_project_bytes(root) else {
        return Ok(None);
    };
    let project = match report.project {
        Some(project) if report.errors.is_empty() => project,
        _ => {
            return Err(Reason::new(FLOW_PROJECT_INVALID)
                .with("projectRoot", root.to_string_lossy())
                .with("errors", report.errors.len()))
        }
    };
    Ok(Some((project, sha256_hex(&bytes))))
}

/// The approval a manifest other than the confirmed one needs before its
/// `list` (`setup` / `test`) steps run: `None` when they may run now.
fn unconfirmed(ctx: &ActionContext, list: &str, steps: &[SetupStep], sha256: &str) -> Option<ActionEnd> {
    // Shown as the run-start review lists them: argv and working directory.
    let runs: Vec<Value> = steps
        .iter()
        .map(|step| json!({ "run": step.run, "workingDir": step.working_dir }))
        .collect();
    let show = BTreeMap::from([
        (list.to_string(), Value::Array(runs)),
        ("sha256".to_string(), Value::String(sha256.to_string())),
    ]);
    // The confirmed manifest runs as is; any other needs the user's go-ahead
    // for exactly what is shown now.
    if ctx.project_sha256 == Some(sha256.to_string()) || ctx.acknowledged.as_ref() == Some(&show) {
        return None;
    }
    Some(ActionEnd::NeedsApproval {
        show,
        outputs: BTreeMap::new(),
    })
}

/// Runs `steps` of the manifest at `root` with the action's progress and cancel.
fn run_steps(ctx: &ActionContext, root: &std::path::Path, label: &str, steps: &[SetupStep]) -> setup::SetupResult {
    setup::run_steps(
        root,
        steps,
        &*ctx.launcher,
        ctx.poll,
        &|progress| {
            (ctx.progress)(format!(
                "{label} {}/{}: {:?}",
                progress.step, progress.total, progress.status
            ))
        },
        Some(&ctx.cancel),
    )
}

/// `mdium/project-setup` `{ projectRoot? }` -> `{ ok: true }`: runs the setup
/// steps of the manifest. A manifest other than the confirmed one asks first.
pub(super) fn project_setup(
    with: &BTreeMap<String, Value>,
    ctx: &ActionContext,
) -> Result<ActionEnd, Reason> {
    let root = root_of(with, ctx)?;
    let (project, sha256) = manifest_at(&root)?
        .ok_or_else(|| Reason::new(FLOW_PROJECT_REQUIRED).with("projectRoot", root.to_string_lossy()))?;
    if let Some(ask) = unconfirmed(ctx, "setup", &project.setup, &sha256) {
        return Ok(ask);
    }
    let result = run_steps(ctx, &root, "setup", &project.setup);
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

/// `mdium/project-test` `{ projectRoot? }` -> `{ ran, ok, exitCode, logDir, tail }`:
/// runs the manifest's `test` steps. Unlike setup, a failing step is a result
/// (`ok: false`, that step's exit code and output tail; both `null` / `""`
/// when every step passed), not a failed node, so a review stage can read
/// it. No manifest or no steps: `ran: false, ok: true`. A manifest other
/// than the confirmed one asks first. The steps run code the worktree holds,
/// including what an agent changed there (the point of testing it): the
/// confirmation covers the commands, not the files they run.
pub(super) fn project_test(
    with: &BTreeMap<String, Value>,
    ctx: &ActionContext,
) -> Result<ActionEnd, Reason> {
    let root = root_of(with, ctx)?;
    let Some((project, sha256)) = manifest_at(&root)?.filter(|(project, _)| !project.test.is_empty()) else {
        return Ok(ActionEnd::done(BTreeMap::from([
            ("ran".to_string(), Value::Bool(false)),
            ("ok".to_string(), Value::Bool(true)),
            ("exitCode".to_string(), Value::Null),
            ("logDir".to_string(), Value::String(String::new())),
            ("tail".to_string(), Value::String(String::new())),
        ])));
    };
    if let Some(ask) = unconfirmed(ctx, "test", &project.test, &sha256) {
        return Ok(ask);
    }
    let result = run_steps(ctx, &root, "test", &project.test);
    if result.cancelled {
        return Ok(ActionEnd::Cancelled);
    }
    // The failing step, if any; a passed run reports no code and no tail.
    let step = result.steps.iter().find(|step| step.exit_code != Some(0));
    let tail = step.map_or(String::new(), |s| {
        let mut tail = s.stdout_tail.clone();
        if !s.stderr_tail.is_empty() {
            if !tail.is_empty() {
                tail.push('\n');
            }
            tail.push_str(&s.stderr_tail);
        }
        if let Some(err) = &s.error {
            if !tail.is_empty() {
                tail.push('\n');
            }
            tail.push_str(err);
        }
        tail
    });
    Ok(ActionEnd::done(BTreeMap::from([
        ("ran".to_string(), Value::Bool(true)),
        ("ok".to_string(), Value::Bool(result.ok)),
        ("exitCode".to_string(), step.and_then(|s| s.exit_code).map_or(Value::Null, Value::from)),
        (
            "logDir".to_string(),
            Value::String(root.join(&result.log_dir).to_string_lossy().into_owned()),
        ),
        ("tail".to_string(), Value::String(tail)),
    ])))
}

/// `mdium/flow-run-latest` `{ flow }` -> the newest completed run of that flow
/// file: `{ runId, runDir, status, outputs, params, costUsd, failedNodes }`
/// (`params`: the run's arguments with defaults applied).
pub(super) fn flow_run_latest(
    with: &BTreeMap<String, Value>,
    ctx: &ActionContext,
) -> Result<ActionEnd, Reason> {
    let flow = required_str(with, "flow")?.replace('\\', "/");
    let flow = if flow == crate::load::PROJECT_MAIN_REF {
        ctx.project
            .as_ref()
            .and_then(crate::project::main_flow_display)
            .ok_or_else(|| failed(FLOW_RUN_NOT_FOUND, "the project declares no main flow"))?
    } else {
        flow
    };
    // Runs live in the project's store even inside a worktree scope.
    let store = RunStore::new(&ctx.store_root);
    let ids = store
        .list_ids()
        .map_err(|err| failed("RUN_STORE_FAILED", err.to_string()))?;
    let mut best: Option<(String, RunMeta, RunState)> = None;
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
        if best
            .as_ref()
            .map_or(true, |(_, best_meta, _)| meta.created_at > best_meta.created_at)
        {
            best = Some((id, meta, state));
        }
    }
    let Some((run_id, meta, state)) = best else {
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
        (
            "params".to_string(),
            Value::Object(meta.params.into_iter().collect()),
        ),
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
    let (improved, mut report) = compare_metrics(metrics, &baseline, &candidate);
    // Both sides' run arguments, when given: a comparison across different
    // arguments is reported as such instead of looking like a regression.
    let differing = match (with.get("baselineParams"), with.get("candidateParams")) {
        (Some(Value::Object(base)), Some(Value::Object(cand))) => differing_params(base, cand),
        _ => Vec::new(),
    };
    if !differing.is_empty() {
        let mut note = String::from("Parameters differ between the baseline and the candidate run:\n\n");
        for (name, base, cand) in &differing {
            note.push_str(&format!("- `{name}`: {base} -> {cand}\n"));
        }
        note.push('\n');
        report.insert_str(0, &note);
    }
    let path: PathBuf = ctx.node_dir.join("report.md");
    fsutil::atomic_write(&path, report.as_bytes())
        .map_err(|err| failed("IO_ERROR", err.to_string()))?;
    let outputs = BTreeMap::from([
        ("improved".to_string(), Value::Bool(improved)),
        ("report".to_string(), Value::String(report)),
        (
            "differingParams".to_string(),
            Value::Array(differing.iter().map(|(name, _, _)| Value::String(name.clone())).collect()),
        ),
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

/// The arguments whose values differ between two runs, by name: `(name,
/// baseline, candidate)` with a missing side shown as `-`.
pub fn differing_params(
    base: &serde_json::Map<String, Value>,
    cand: &serde_json::Map<String, Value>,
) -> Vec<(String, String, String)> {
    let names: std::collections::BTreeSet<&String> = base.keys().chain(cand.keys()).collect();
    let show = |value: Option<&Value>| value.map_or("-".to_string(), Value::to_string);
    names
        .into_iter()
        .filter(|name| base.get(*name) != cand.get(*name))
        .map(|name| (name.clone(), show(base.get(name)), show(cand.get(name))))
        .collect()
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
