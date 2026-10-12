import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { DialogShell } from "@/features/workflow/components/DialogShell";
import type { FlowDef } from "@/shared/types/flow";
import type { CommandReview, FlowRunError } from "@/shared/types/flow-run";
import { flowRunApi, toFlowRunError } from "../lib/flow-run-api";
import { describeError } from "../lib/run-format";
import { parseDefault } from "./attrs/FlowAttrsForm";

interface RunStartDialogProps {
  projectRoot: string;
  flowPath: string;
  flow: FlowDef;
  onClose(): void;
  onStarted(runId: string): void;
}

type ParamValue = string | boolean;

/** Parameter types entered as JSON text in the form. */
function isJsonType(type: string): type is "array" | "object" {
  return type === "array" || type === "object";
}

/** Names of array/object params whose non-empty text is not JSON of the declared shape. */
export function invalidJsonParams(flow: FlowDef, values: Record<string, ParamValue>): string[] {
  const invalid: string[] = [];
  for (const [name, def] of Object.entries(flow.params ?? {})) {
    if (!isJsonType(def.type)) continue;
    const value = values[name];
    if (typeof value !== "string" || value.trim() === "") continue;
    if (parseDefault(def.type, value.trim()) === undefined) invalid.push(name);
  }
  return invalid;
}

/** Initial form values from the parameter defaults. */
export function initialParamValues(flow: FlowDef): Record<string, ParamValue> {
  const values: Record<string, ParamValue> = {};
  for (const [name, def] of Object.entries(flow.params ?? {})) {
    if (def.type === "bool") values[name] = def.default === true;
    else if (isJsonType(def.type)) values[name] = def.default === undefined || def.default === null ? "" : JSON.stringify(def.default);
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
      if (isJsonType(def.type)) {
        // Invalid JSON is omitted here; the dialog blocks Start until it is fixed.
        const parsed = parseDefault(def.type, value.trim());
        if (parsed !== undefined) out[name] = parsed;
      } else {
        out[name] = def.type === "number" ? Number(value) : value;
      }
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

  const reviewItems = review ? review.commands.length + review.runtimes.length + review.setup.length + review.stages.length : 0;
  const needsConfirmation = !!review && !review.confirmed && reviewItems > 0;
  const invalidParams = invalidJsonParams(flow, values);
  const canStart = !!review && !busy && (!needsConfirmation || accepted) && invalidParams.length === 0;

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
            {invalidParams.includes(name) && (
              <span className="flow-dialog__error" role="alert">
                {t("run.invalidJson", { type: def.type })}
              </span>
            )}
            {def.description && <span className="flow-dialog__muted">{def.description}</span>}
          </label>
        ))}
      </section>
      <section className="flow-dialog__section">
        <h3 className="flow-dialog__heading">{t("run.commandsTitle")}</h3>
        {review && review.commands.length === 0 && review.runtimes.length === 0 && review.setup.length === 0 && review.stages.length === 0 && <div className="flow-dialog__muted">{t("run.noCommands")}</div>}
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
          </>
        )}
      </section>
      {review && review.runtimes.length > 0 && (
        <section className="flow-dialog__section">
          <h3 className="flow-dialog__heading">{t("run.runtimesTitle")}</h3>
          <div className="flow-dialog__muted">{t("run.runtimesHint", { path: review.projectPath ?? ".mdium/project.yaml" })}</div>
          <ul className="flow-dialog__commands">
            {review.runtimes.map((rt) => (
              <li key={rt.name} className="flow-dialog__command">
                <div className="flow-dialog__command-head">
                  <strong>{rt.name}</strong>
                  <span className="flow-dialog__badge">{t("run.runtimePython")}</span>
                </div>
                {rt.python.map((p) => (
                  <code key={p} className="flow-dialog__code">{p}</code>
                ))}
                <div className="flow-dialog__muted">{t("run.runtimeModule", { module: rt.module })}</div>
                <div className="flow-dialog__muted">{t("run.workingDir", { dir: rt.cwd })}</div>
              </li>
            ))}
          </ul>
        </section>
      )}
      {review && review.stages.length > 0 && (
        <section className="flow-dialog__section">
          <h3 className="flow-dialog__heading">{t("run.stagesTitle")}</h3>
          <ul className="flow-dialog__commands">
            {review.stages.map((s) => (
              <li key={`${s.file}|${(s.within ?? []).join("/")}|${s.nodeId}`} className="flow-dialog__command">
                <div className="flow-dialog__command-head">
                  <strong>{[...(s.within ?? []), s.nodeId].join(" / ")}</strong>
                  {s.file !== flowPath && <span className="flow-dialog__badge">{s.file}</span>}
                </div>
                <code className="flow-dialog__code">{t("run.stageEntry", { runtime: s.runtime, entry: s.entry })}</code>
              </li>
            ))}
          </ul>
        </section>
      )}
      {review && review.setup.length > 0 && (
        <section className="flow-dialog__section">
          <h3 className="flow-dialog__heading">{t("run.setupTitle")}</h3>
          <ul className="flow-dialog__commands">
            {review.setup.map((step, i) => (
              <li key={i} className="flow-dialog__command">
                <code className="flow-dialog__code">{step.run.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ")}</code>
                {step.workingDir && <div className="flow-dialog__muted">{t("run.workingDir", { dir: step.workingDir })}</div>}
              </li>
            ))}
          </ul>
        </section>
      )}
      {review && reviewItems > 0 && (
        needsConfirmation ? (
          <label className="flow-dialog__confirm">
            <input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} />
            <span>{t("run.confirmLabel")}</span>
          </label>
        ) : (
          <div className="flow-dialog__muted">{t("run.alreadyConfirmed")}</div>
        )
      )}
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
