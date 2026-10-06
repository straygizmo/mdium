import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useTabStore } from "@/stores/tab-store";
import type { FlowSummary } from "@/shared/types/flow";
import { flowApi, isFlowCommandError } from "../lib/flow-api";
import { useFlowViewStore } from "../flow-store";
import "./Flow.css";

type ListState =
  | { status: "loading" }
  | { status: "error"; code: string }
  | { status: "ready"; flows: FlowSummary[] };

/** Left panel: the open folder's flow files with their validation summary. */
export function FlowPanel() {
  const { t } = useTranslation("flow");
  const folder = useTabStore((s) => s.activeFolderPath);
  const selected = useFlowViewStore((s) => (folder ? s.selected[folder] : undefined));
  const setSelected = useFlowViewStore((s) => s.setSelected);
  const [state, setState] = useState<ListState>({ status: "loading" });
  const requestId = useRef(0);

  const refresh = useCallback(async () => {
    if (!folder) return;
    const id = ++requestId.current;
    setState({ status: "loading" });
    try {
      const flows = await flowApi.list(folder);
      if (id === requestId.current) setState({ status: "ready", flows });
    } catch (err) {
      if (id === requestId.current) {
        setState({ status: "error", code: isFlowCommandError(err) ? err.code : "FLOW_COMMAND_FAILED" });
      }
    }
  }, [folder]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!folder) return null;

  return (
    <div className="flow-panel">
      <div className="flow-panel__toolbar">
        <span className="flow-panel__badge">{t("experimentalBadge")}</span>
        <button type="button" className="flow-panel__refresh" onClick={() => void refresh()}>
          {t("list.refresh")}
        </button>
      </div>
      {state.status === "loading" && <div className="flow-panel__message">{t("list.loading")}</div>}
      {state.status === "error" && (
        <div className="flow-panel__message flow-panel__message--error">{t("list.loadFailed", { code: state.code })}</div>
      )}
      {state.status === "ready" && state.flows.length === 0 && (
        <div className="flow-panel__message">
          <div>{t("list.empty")}</div>
          <div className="flow-panel__hint">{t("list.emptyHint")}</div>
        </div>
      )}
      {state.status === "ready" && state.flows.length > 0 && (
        <ul className="flow-panel__list">
          {state.flows.map((flow) => (
            <li key={flow.path}>
              <button
                type="button"
                className={`flow-panel__item${flow.path === selected ? " flow-panel__item--selected" : ""}`}
                onClick={() => setSelected(folder, flow.path)}
                aria-current={flow.path === selected ? "true" : undefined}
              >
                <span className="flow-panel__item-name">{flow.name ?? flow.path.split("/").pop()}</span>
                <span className="flow-panel__item-path">{flow.path}</span>
                {(flow.errorCount > 0 || flow.warningCount > 0) && (
                  <span className="flow-panel__item-counts">
                    {flow.errorCount > 0 && (
                      <span className="flow-panel__count flow-panel__count--error">
                        {t("list.errorCount", { count: flow.errorCount })}
                      </span>
                    )}
                    {flow.warningCount > 0 && (
                      <span className="flow-panel__count flow-panel__count--warning">
                        {t("list.warningCount", { count: flow.warningCount })}
                      </span>
                    )}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
