import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { useTabStore } from "@/stores/tab-store";
import type { FlowSummary, ProjectLoadResult } from "@/shared/types/flow";
import { flowApi, isFlowCommandError } from "../lib/flow-api";
import { useFlowViewStore } from "../flow-store";
import { ProjectSetupDialog } from "./ProjectSetupDialog";
import "./Flow.css";

type ListState =
  | { status: "loading" }
  | { status: "error"; code: string }
  | { status: "ready"; flows: FlowSummary[] };

/** `params → outputs` of a part, for the list. */
export function signatureText(flow: FlowSummary, t: TFunction<"flow">): string {
  const params = Object.keys(flow.params);
  const outputs = flow.outputs;
  return t("list.signature", {
    params: params.length ? params.join(", ") : t("list.noParams"),
    outputs: outputs.length ? outputs.join(", ") : t("list.noOutputs"),
  });
}

/** Left panel: the project header and the open folder's flow files (entries, then parts). */
export function FlowPanel() {
  const { t } = useTranslation("flow");
  const folder = useTabStore((s) => s.activeFolderPath);
  const selected = useFlowViewStore((s) => (folder ? s.selected[folder] : undefined));
  const setSelected = useFlowViewStore((s) => s.setSelected);
  const [state, setState] = useState<ListState>({ status: "loading" });
  const [project, setProject] = useState<ProjectLoadResult | null>(null);
  const [setupOpen, setSetupOpen] = useState(false);
  const requestId = useRef(0);

  const refresh = useCallback(async () => {
    if (!folder) return;
    const id = ++requestId.current;
    setState({ status: "loading" });
    try {
      const flows = await flowApi.list(folder);
      const loaded = await flowApi.projectLoad(folder);
      if (id === requestId.current) {
        setProject(loaded);
        setState({ status: "ready", flows });
      }
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

  const flows = state.status === "ready" ? state.flows : [];
  const entries = flows.filter((f) => f.kind === "entry");
  const parts = flows.filter((f) => f.kind === "part");

  const renderItem = (flow: FlowSummary) => (
    <li key={flow.path}>
      <button
        type="button"
        className={`flow-panel__item${flow.path === selected ? " flow-panel__item--selected" : ""}`}
        onClick={() => setSelected(folder, flow.path)}
        aria-current={flow.path === selected ? "true" : undefined}
      >
        <span className="flow-panel__item-name">{flow.name ?? flow.path.split("/").pop()}</span>
        {flow.role && <span className="flow-panel__role">{flow.role}</span>}
        <span className="flow-panel__item-path">{flow.path}</span>
        {flow.kind === "part" && <span className="flow-panel__item-signature">{signatureText(flow, t)}</span>}
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
  );

  return (
    <div className="flow-panel">
      <div className="flow-panel__toolbar">
        <span className="flow-panel__badge">{t("experimentalBadge")}</span>
        <button type="button" className="flow-panel__refresh" onClick={() => void refresh()}>
          {t("list.refresh")}
        </button>
      </div>
      {project && (
        <div className="flow-panel__project">
          <div className="flow-panel__project-name">
            {project.project?.name ?? (project.exists ? t("project.title") : t("project.noManifest"))}
          </div>
          {project.errors.length > 0 && (
            <div className="flow-panel__message flow-panel__message--error">{t("project.invalid", { count: project.errors.length })}</div>
          )}
          {project.project && (project.project.setup?.length ?? 0) > 0 && (
            <button type="button" className="flow-panel__setup" onClick={() => setSetupOpen(true)}>
              {t("project.setup")}
            </button>
          )}
        </div>
      )}
      {setupOpen && project?.project && (
        <ProjectSetupDialog projectRoot={folder} project={project.project} onClose={() => setSetupOpen(false)} />
      )}
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
        <>
          <div className="flow-panel__group-title">{t("list.groupEntries")}</div>
          <ul className="flow-panel__list">{entries.map(renderItem)}</ul>
          {parts.length > 0 && (
            <>
              <div className="flow-panel__group-title">{t("list.groupParts")}</div>
              <ul className="flow-panel__list">{parts.map(renderItem)}</ul>
            </>
          )}
        </>
      )}
    </div>
  );
}
