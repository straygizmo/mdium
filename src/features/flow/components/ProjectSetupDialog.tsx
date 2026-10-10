import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { DialogShell } from "@/features/workflow/components/DialogShell";
import type { ProjectDef } from "@/shared/types/flow";
import type { FlowRunError, SetupProgressEvent, SetupResult } from "@/shared/types/flow-run";
import { flowApi, isFlowCommandError, subscribeSetupProgress } from "../lib/flow-api";
import { describeError } from "../lib/run-format";

interface ProjectSetupDialogProps {
  projectRoot: string;
  project: ProjectDef;
  onClose(): void;
}

/** Confirms and runs the manifest's setup steps, showing progress (spec 2.2). */
export function ProjectSetupDialog({ projectRoot, project, onClose }: ProjectSetupDialogProps) {
  const { t } = useTranslation("flow");
  const steps = project.setup ?? [];
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<Record<number, SetupProgressEvent>>({});
  const [result, setResult] = useState<SetupResult | null>(null);
  const [error, setError] = useState<FlowRunError | null>(null);
  const unsubscribe = useRef<(() => void) | null>(null);

  useEffect(() => {
    let cancelled = false;
    void subscribeSetupProgress((event) => {
      if (event.projectRoot !== projectRoot || event.status === "finished") return;
      setProgress((p) => ({ ...p, [event.step]: event }));
    }).then((off) => {
      if (cancelled) off();
      else unsubscribe.current = off;
    });
    return () => {
      cancelled = true;
      unsubscribe.current?.();
    };
  }, [projectRoot]);

  const run = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    setProgress({});
    try {
      setResult(await flowApi.projectSetup(projectRoot));
    } catch (err) {
      setError(isFlowCommandError(err) ? { code: err.code, message: err.message } : { code: "FLOW_COMMAND_FAILED", message: String(err) });
    } finally {
      setBusy(false);
    }
  };

  const described = error ? describeError(t, error) : null;
  const argv = (cmd: string[]) => cmd.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ");

  return (
    <DialogShell overlayClassName="flow-dialog-overlay" className="flow-dialog" labelledBy="flow-project-setup-title" onClose={onClose}>
      <h2 id="flow-project-setup-title" className="flow-dialog__title">{t("project.setupTitle", { name: project.name })}</h2>
      <div className="flow-dialog__muted">{t("project.setupHint")}</div>
      <ul className="flow-dialog__commands">
        {steps.map((step, i) => {
          const index = i + 1;
          const live = progress[index];
          const done = result?.steps.find((s) => s.index === index);
          const status = done ? (done.exitCode === 0 ? "succeeded" : "failed") : live?.status;
          return (
            <li key={index} className="flow-dialog__command">
              <div className="flow-dialog__command-head">
                <strong>{t("project.setupStep", { step: index, total: steps.length })}</strong>
                {status && status !== "finished" && <span className="flow-dialog__badge">{t(`project.stepStatus.${status}`)}</span>}
              </div>
              <code className="flow-dialog__code">{argv(step.run)}</code>
              {step.workingDir && <div className="flow-dialog__muted">{t("run.workingDir", { dir: step.workingDir })}</div>}
              {done?.error && <pre className="flow-dialog__code">{done.error}</pre>}
              {done && done.exitCode !== 0 && done.stderrTail && <pre className="flow-dialog__code">{done.stderrTail}</pre>}
            </li>
          );
        })}
      </ul>
      {!result && (
        <label className="flow-dialog__confirm">
          <input type="checkbox" checked={accepted} disabled={busy} onChange={(e) => setAccepted(e.target.checked)} />
          <span>{t("project.setupConfirm")}</span>
        </label>
      )}
      {result && (
        <div className={`flow-dialog__muted${result.ok ? "" : " flow-dialog__error"}`} role="status">
          <div>{result.ok ? t("project.setupDone") : t("project.setupFailed")}</div>
          <div>{t("project.logDir", { dir: result.logDir })}</div>
        </div>
      )}
      {described && (
        <div className="flow-dialog__error" role="alert">
          <div>{described.message}</div>
        </div>
      )}
      <div className="flow-dialog__footer">
        <button type="button" className="flow-dialog__button" onClick={onClose} disabled={busy}>{t("run.close")}</button>
        {!result && (
          <button type="button" className="flow-dialog__button flow-dialog__button--primary" disabled={!accepted || busy} onClick={() => void run()}>
            {busy ? t("project.setupRunning") : t("project.setupRun")}
          </button>
        )}
      </div>
    </DialogShell>
  );
}
