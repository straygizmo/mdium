import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { DialogShell } from "@/features/workflow/components/DialogShell";
import { flowRunApi, toFlowRunError } from "../lib/flow-run-api";

interface RunLogDialogProps {
  projectRoot: string;
  runId: string;
  nodeKey: string;
  attempt: number;
  onClose(): void;
}

/** Bytes of log tail shown at once. */
export const LOG_TAIL_BYTES = 64 * 1024;

/** The tail of a node attempt's stdout / stderr. */
export function RunLogDialog({ projectRoot, runId, nodeKey, attempt, onClose }: RunLogDialogProps) {
  const { t } = useTranslation("flow");
  const [stream, setStream] = useState<"stdout" | "stderr">("stdout");
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setText(await flowRunApi.log(projectRoot, runId, nodeKey, attempt, stream, LOG_TAIL_BYTES));
      setError(null);
    } catch (err) {
      const e = toFlowRunError(err);
      setError(t(`runError.${e?.code ?? "FLOW_COMMAND_FAILED"}`, { defaultValue: e?.code ?? String(err) }));
    }
  }, [projectRoot, runId, nodeKey, attempt, stream, t]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <DialogShell overlayClassName="flow-dialog-overlay" className="flow-dialog flow-dialog--wide" labelledBy="flow-run-log-title" onClose={onClose}>
      <h2 id="flow-run-log-title" className="flow-dialog__title">
        {t("run.logTitle", { node: nodeKey, attempt })}
      </h2>
      <div className="flow-dialog__tabs" role="tablist">
        {(["stdout", "stderr"] as const).map((s) => (
          <button
            key={s}
            type="button"
            role="tab"
            aria-selected={stream === s}
            className={`flow-dialog__tab${stream === s ? " flow-dialog__tab--active" : ""}`}
            onClick={() => setStream(s)}
          >
            {t(`run.${s}`)}
          </button>
        ))}
        <button type="button" className="flow-dialog__button" onClick={() => void load()}>
          {t("run.refresh")}
        </button>
      </div>
      {error ? (
        <div className="flow-dialog__error" role="alert">
          {error}
        </div>
      ) : (
        <pre className="flow-dialog__log">{text || t("run.emptyLog")}</pre>
      )}
      <div className="flow-dialog__footer">
        <button type="button" className="flow-dialog__button" onClick={onClose}>
          {t("run.close")}
        </button>
      </div>
    </DialogShell>
  );
}
