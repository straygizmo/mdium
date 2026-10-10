//! Runs a manifest's `setup` steps (spec 2026-10-10, 2.2): sequentially,
//! stopping at the first failure, logging each step to
//! `.mdium/setup-runs/<id>/`, reporting progress through a callback.

use crate::fsutil;
use crate::project::ProjectDef;
use crate::run::process::{tail_file, LaunchSpec, Launcher};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::Duration;

const TAIL_BYTES: u64 = 4096;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SetupStatus {
    Started,
    Succeeded,
    Failed,
    /// Sent once after the last step (or the first failure).
    Finished,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupProgress {
    pub setup_id: String,
    /// 1-based step number (the last step reached on `Finished`).
    pub step: usize,
    pub total: usize,
    pub status: SetupStatus,
    pub run: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupStepResult {
    pub index: usize,
    pub run: Vec<String>,
    pub working_dir: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    /// Spawn / wait failure (the step never produced an exit code).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub stdout_tail: String,
    pub stderr_tail: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupResult {
    pub setup_id: String,
    pub ok: bool,
    /// Project-relative log directory.
    pub log_dir: String,
    pub steps: Vec<SetupStepResult>,
}

/// Runs every setup step of `project` in order.
pub fn run_setup(
    project_root: &Path,
    project: &ProjectDef,
    launcher: &dyn Launcher,
    poll: Duration,
    progress: &dyn Fn(&SetupProgress),
) -> SetupResult {
    let setup_id = fsutil::new_id();
    let log_rel = format!(".mdium/setup-runs/{setup_id}");
    let log_dir: PathBuf = project_root.join(&log_rel);
    let total = project.setup.len();
    let mut steps = Vec::new();
    let mut ok = true;
    for (i, step) in project.setup.iter().enumerate() {
        let index = i + 1;
        let report = |status: SetupStatus, exit_code: Option<i32>| {
            progress(&SetupProgress {
                setup_id: setup_id.clone(),
                step: index,
                total,
                status,
                run: step.run.clone(),
                exit_code,
            })
        };
        report(SetupStatus::Started, None);
        let working_dir = step.working_dir.clone().unwrap_or_else(|| ".".to_string());
        let stdout = log_dir.join(format!("step-{index}.stdout.log"));
        let stderr = log_dir.join(format!("step-{index}.stderr.log"));
        let mut result = SetupStepResult {
            index,
            run: step.run.clone(),
            working_dir: working_dir.clone(),
            exit_code: None,
            error: None,
            stdout_tail: String::new(),
            stderr_tail: String::new(),
        };
        let outcome = std::fs::create_dir_all(&log_dir).and_then(|_| {
            let spec = LaunchSpec {
                argv: step.run.clone(),
                shell: false,
                working_dir: project_root.join(&working_dir),
                env: Vec::new(),
                stdout: stdout.clone(),
                stderr: stderr.clone(),
                node_dir: log_dir.clone(),
                new_group: true,
            };
            let mut handle = launcher.launch(&spec)?;
            loop {
                if let Some(code) = handle.try_wait()? {
                    return Ok(code);
                }
                std::thread::sleep(poll);
            }
        });
        result.stdout_tail = tail_file(&stdout, TAIL_BYTES).unwrap_or_default();
        result.stderr_tail = tail_file(&stderr, TAIL_BYTES).unwrap_or_default();
        let failed = match outcome {
            Ok(code) => {
                result.exit_code = Some(code);
                code != 0
            }
            Err(err) => {
                result.error = Some(err.to_string());
                true
            }
        };
        report(
            if failed {
                SetupStatus::Failed
            } else {
                SetupStatus::Succeeded
            },
            result.exit_code,
        );
        steps.push(result);
        if failed {
            ok = false;
            break;
        }
    }
    progress(&SetupProgress {
        setup_id: setup_id.clone(),
        step: steps.len(),
        total,
        status: SetupStatus::Finished,
        run: Vec::new(),
        exit_code: None,
    });
    SetupResult {
        setup_id,
        ok,
        log_dir: log_rel,
        steps,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::{check_project_text, ProjectDef};
    use crate::run::process::AttachedLauncher;
    use std::sync::Mutex;

    fn exit_step(code: i32) -> String {
        if cfg!(windows) {
            format!("{{ run: [cmd, /C, 'exit {code}'] }}")
        } else {
            format!("{{ run: [sh, -c, 'exit {code}'] }}")
        }
    }

    fn project(steps: &[String]) -> ProjectDef {
        let text = format!(
            "schemaVersion: 1\nid: p\nname: P\nsetup:\n{}",
            steps
                .iter()
                .map(|s| format!("  - {s}\n"))
                .collect::<String>()
        );
        check_project_text(&text).project.expect("valid manifest")
    }

    #[test]
    fn runs_steps_in_order_and_stops_at_the_first_failure() {
        let tmp = tempfile::tempdir().unwrap();
        let project = project(&[exit_step(0), exit_step(3), exit_step(0)]);
        let seen = Mutex::new(Vec::new());
        let result = run_setup(
            tmp.path(),
            &project,
            &AttachedLauncher,
            Duration::from_millis(20),
            &|p| {
                seen.lock().unwrap().push((p.step, p.status, p.exit_code));
            },
        );
        assert!(!result.ok);
        assert_eq!(result.steps.len(), 2, "third step never ran");
        assert_eq!(result.steps[0].exit_code, Some(0));
        assert_eq!(result.steps[1].exit_code, Some(3));
        let seen = seen.lock().unwrap();
        assert_eq!(
            *seen,
            vec![
                (1, SetupStatus::Started, None),
                (1, SetupStatus::Succeeded, Some(0)),
                (2, SetupStatus::Started, None),
                (2, SetupStatus::Failed, Some(3)),
                (2, SetupStatus::Finished, None),
            ]
        );
        assert!(tmp
            .path()
            .join(".mdium/setup-runs")
            .join(&result.setup_id)
            .join("step-1.stdout.log")
            .exists());
    }

    #[test]
    fn a_missing_program_is_a_failed_step_with_the_os_error() {
        // Review Focus 4.
        let tmp = tempfile::tempdir().unwrap();
        let project = project(&[
            "{ run: [mdium-no-such-program-xyz, sync] }".to_string(),
            exit_step(0),
        ]);
        let result = run_setup(
            tmp.path(),
            &project,
            &AttachedLauncher,
            Duration::from_millis(20),
            &|_| {},
        );
        assert!(!result.ok);
        assert_eq!(result.steps.len(), 1);
        assert!(result.steps[0].exit_code.is_none());
        assert!(result.steps[0]
            .error
            .as_deref()
            .is_some_and(|e| !e.is_empty()));
    }

    #[test]
    fn all_steps_succeeding_is_ok() {
        let tmp = tempfile::tempdir().unwrap();
        let project = project(&[exit_step(0), exit_step(0)]);
        let result = run_setup(
            tmp.path(),
            &project,
            &AttachedLauncher,
            Duration::from_millis(20),
            &|_| {},
        );
        assert!(result.ok);
        assert_eq!(result.steps.len(), 2);
    }
}
