import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { DialogShell } from "@/features/workflow/components/DialogShell";
import type { FlowDef } from "@/shared/types/flow";
import type { CommandReview, FlowRunError } from "@/shared/types/flow-run";
import { flowRunApi, toFlowRunError } from "../lib/flow-run-api";
import { describeError } from "../lib/run-format";

interface RunStartDialogProps {
  projectRoot: string;
  flowPath: string;
  flow: FlowDef;
  onClose(): void;
  onStarted(runId: string): void;
}

type ParamValue = string | boolean;

/** Initial form values from the parameter defaults. */
export function initialParamValues(flow: FlowDef): Record<string, ParamValue> {
  const values: Record<string, ParamValue> = {};
  for (const [name, def] of Object.entries(flow.params ?? {})) {
    if (def.type === "bool") values[name] = def.default === true;
    else values[name] = def.default === undefined || def.default === null ? "" : String(def.default);
  }
  return values;
}

/** Converts form values to the JSON the engine expects (empty → omitted). */
export function paramsFromForm(flow: FlowDef, values: Record<string, ParamValue>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, def] of Object.entries(flow.params ?? {})) {
    const value = values[name];
    if (def.type === "bool") {
      out[name] = value === true;
    } else if (typeof value === "string" && value.trim() !== "") {
      out[name] = def.type === "number" ? Number(value) : value;
    }
  }
  return out;
}

/** Start a run: parameters plus the one-time command confirmation (spec 7.2). */
export function RunStartDialog({ projectRoot, flowPath, flow, onClose, onStarted }: RunStartDialogProps) {
  const { t } = useTranslation("flow");
  const [review, setReview] = useState<CommandReview | null>(null);
  const [values, setValues] = useState(() => initialParamValues(flow));
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<FlowRunError | null>(null);

  useEffect(() => {
    let cancelled = false;
    flowRunApi.reviewCommands(projectRoot, flowPath).then(
      (r) => !cancelled && setReview(r),
      (err) => !cancelled && setError(toFlowRunError(err) ?? { code: "FLOW_COMMAND_FAILED", message: String(err) }),
    );
    return () => {
      cancelled = true;
    };
  }, [projectRoot, flowPath]);

  const needsConfirmation = !!review && !review.confirmed && review.commands.length > 0;
  const canStart = !!review && !busy && (!needsConfirmation || accepted);

  const start = async () => {
    if (!review) return;
    setBusy(true);
    setError(null);
    try {
      if (needsConfirmation) await flowRunApi.confirmCommands(projectRoot, flowPath, review.sha256);
      const summary = await flowRunApi.start(projectRoot, flowPath, paramsFromForm(flow, values), review.sha256);
      onStarted(summary.runId);
    } catch (err) {
      setError(toFlowRunError(err) ?? { code: "FLOW_COMMAND_FAILED", message: String(err) });
      setBusy(false);
    }
  };

  const described = error ? describeError(t, error) : null;
  const params = Object.entries(flow.params ?? {});

  return (
    <DialogShell overlayClassName="flow-dialog-overlay" className="flow-dialog" labelledBy="flow-run-start-title" onClose={onClose}>
      <h2 id="flow-run-start-title" className="flow-dialog__title">
        {t("run.startTitle")}: {flow.name}
      </h2>
      <section className="flow-dialog__section">
        <h3 className="flow-dialog__heading">{t("run.params")}</h3>
        {params.length === 0 && <div className="flow-dialog__muted">{t("run.noParams")}</div>}
        {params.map(([name, def]) => (
          <label key={name} className="flow-dialog__field">
            <span className="flow-dialog__label">
              {name}
              {def.required ? " *" : ""}
            </span>
            {def.type === "bool" ? (
              <input
                type="checkbox"
                data-switch
                role="switch"
                checked={values[name] === true}
                onChange={(e) => setValues({ ...values, [name]: e.target.checked })}
              />
            ) : (
              <input
                className="flow-dialog__input"
                type={def.type === "number" ? "number" : "text"}
                value={String(values[name] ?? "")}
                onChange={(e) => setValues({ ...values, [name]: e.target.value })}
              />
            )}
            {def.description && <span className="flow-dialog__muted">{def.description}</span>}
          </label>
        ))}
      </section>
      <section className="flow-dialog__section">
        <h3 className="flow-dialog__heading">{t("run.commandsTitle")}</h3>
        {review && review.commands.length === 0 && <div className="flow-dialog__muted">{t("run.noCommands")}</div>}
        {review && review.commands.length > 0 && (
          <>
            <div className="flow-dialog__muted">{t("run.commandsHint")}</div>
            <ul className="flow-dialog__commands">
              {review.commands.map((command) => (
                <li key={`${command.file}|${(command.within ?? []).join("/")}|${command.nodeId}`} className="flow-dialog__command">
                  <div className="flow-dialog__command-head">
                    <strong>{[...(command.within ?? []), command.nodeId].join(" / ")}</strong>
                    {command.file !== flowPath && <span className="flow-dialog__badge">{command.file}</span>}
                    {command.shell && <span className="flow-dialog__badge">{t("run.shell")}</span>}
                    {command.templated && <span className="flow-dialog__badge">{t("run.templated")}</span>}
                  </div>
                  <code className="flow-dialog__code">
                    {Array.isArray(command.run) ? command.run.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ") : command.run}
                  </code>
                  {command.workingDir && (
                    <div className="flow-dialog__muted">{t("run.workingDir", { dir: command.workingDir })}</div>
                  )}
                  {Object.entries(command.env).map(([k, v]) => (
                    <code key={k} className="flow-dialog__code flow-dialog__code--env">
                      {k}={v}
                    </code>
                  ))}
                </li>
              ))}
            </ul>
            {needsConfirmation ? (
              <label className="flow-dialog__confirm">
                <input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} />
                <span>{t("run.confirmLabel")}</span>
              </label>
            ) : (
              <div className="flow-dialog__muted">{t("run.alreadyConfirmed")}</div>
            )}
          </>
        )}
      </section>
      {described && (
        <div className="flow-dialog__error" role="alert">
          <div>{described.message}</div>
          {described.details.length > 0 && (
            <ul>
              {described.details.map((d, i) => (
                <li key={i}>{d}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      <div className="flow-dialog__footer">
        <button type="button" className="flow-dialog__button" onClick={onClose}>
          {t("run.close")}
        </button>
        <button type="button" className="flow-dialog__button flow-dialog__button--primary" disabled={!canStart} onClick={() => void start()}>
          {busy ? t("run.starting") : t("run.startButton")}
        </button>
      </div>
    </DialogShell>
  );
}
