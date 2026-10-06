import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useTabStore } from "@/stores/tab-store";
import type { FlowLoadResult } from "@/shared/types/flow";
import { flowApi, isFlowCommandError } from "../lib/flow-api";
import { buildFlowGraph, issuesForNode, nodeAtPath } from "../lib/flow-graph";
import { layoutFlowGraph, savedPositions, type FlowLayout } from "../lib/flow-layout";
import { useFlowViewStore } from "../flow-store";
import { FlowCanvas } from "./FlowCanvas";
import { FlowIssueList } from "./FlowIssueList";
import "./Flow.css";

type LoadState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; code: string }
  | { status: "ready"; result: FlowLoadResult };

/** Main area of the Flows view: the selected flow's graph and its validation issues. */
export function FlowWorkspace() {
  const { t } = useTranslation("flow");
  const folder = useTabStore((s) => s.activeFolderPath);
  const path = useFlowViewStore((s) => (folder ? s.selected[folder] : undefined));
  const [state, setState] = useState<LoadState>({ status: "idle" });
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [layout, setLayout] = useState<FlowLayout | null>(null);
  const [layoutFailed, setLayoutFailed] = useState(false);
  const requestId = useRef(0);

  const load = useCallback(async () => {
    if (!folder || !path) {
      setState({ status: "idle" });
      return;
    }
    const id = ++requestId.current;
    setState({ status: "loading" });
    try {
      const result = await flowApi.load(folder, path);
      if (id === requestId.current) setState({ status: "ready", result });
    } catch (err) {
      if (id === requestId.current) {
        setState({ status: "error", code: isFlowCommandError(err) ? err.code : "FLOW_COMMAND_FAILED" });
      }
    }
  }, [folder, path]);

  useEffect(() => {
    setCollapsed(new Set());
    setSelectedId(null);
    void load();
  }, [load]);

  const result = state.status === "ready" ? state.result : null;
  const graph = useMemo(
    () => (result?.flow ? buildFlowGraph(result.flow, collapsed, result) : null),
    [result, collapsed],
  );

  useEffect(() => {
    let cancelled = false;
    setLayout(null);
    setLayoutFailed(false);
    if (!graph || !result?.flow) return;
    layoutFlowGraph(graph, savedPositions(result.flow.ui)).then(
      (next) => !cancelled && setLayout(next),
      () => !cancelled && setLayoutFailed(true),
    );
    return () => {
      cancelled = true;
    };
  }, [graph, result]);

  const onToggle = useCallback((id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectNode = useCallback(
    (nodePath: string | null) => {
      if (!nodePath || !graph) {
        setSelectedId(null);
        return;
      }
      // Select the deepest node that is currently drawn.
      let current = nodePath;
      const drawn = new Set(graph.nodes.map((n) => n.id));
      while (!drawn.has(current) && current.includes(".body.")) {
        current = current.slice(0, current.lastIndexOf(".body."));
      }
      setSelectedId(drawn.has(current) ? current : null);
    },
    [graph],
  );

  if (!path) {
    return <div className="flow-workspace flow-workspace--empty">{t("workspace.noSelection")}</div>;
  }

  const selectedNode = result?.flow && selectedId ? nodeAtPath(result.flow, selectedId) : undefined;
  const selectedIssues = result && selectedId ? issuesForNode([...result.errors, ...result.warnings], selectedId) : [];

  return (
    <div className="flow-workspace">
      <div className="flow-workspace__header">
        <div className="flow-workspace__title">
          <span className="flow-workspace__name">{result?.flow?.name ?? path}</span>
          <span className="flow-workspace__path">
            {path}
            {result && ` · ${result.format.toUpperCase()}`}
          </span>
        </div>
        <span className="flow-workspace__readonly">{t("workspace.readOnly")}</span>
        <button type="button" className="flow-workspace__reload" onClick={() => void load()}>
          {t("workspace.reload")}
        </button>
      </div>
      {state.status === "loading" && <div className="flow-workspace__message">{t("workspace.loading")}</div>}
      {state.status === "error" && (
        <div className="flow-workspace__message flow-workspace__message--error">
          {t("workspace.loadFailed", { code: state.code })}
        </div>
      )}
      {result && (
        <div className="flow-workspace__body">
          <div className="flow-workspace__canvas">
            {!result.flow && <div className="flow-workspace__message">{t("workspace.notDecoded")}</div>}
            {layoutFailed && (
              <div className="flow-workspace__message flow-workspace__message--error">{t("workspace.layoutFailed")}</div>
            )}
            {graph && layout && (
              <FlowCanvas
                graph={graph}
                layout={layout}
                selectedId={selectedId}
                onSelect={selectNode}
                onToggle={onToggle}
              />
            )}
          </div>
          <aside className="flow-workspace__side">
            <section className="flow-workspace__section">
              <h3 className="flow-workspace__section-title">{t("workspace.issues")}</h3>
              <FlowIssueList errors={result.errors} warnings={result.warnings} onSelectNode={selectNode} />
            </section>
            {result.flow && (
              <section className="flow-workspace__section">
                <h3 className="flow-workspace__section-title">{t("workspace.selectedNode")}</h3>
                {selectedNode ? (
                  <>
                    {selectedIssues.length > 0 && (
                      <FlowIssueList
                        errors={selectedIssues.filter((i) => result.errors.includes(i))}
                        warnings={selectedIssues.filter((i) => result.warnings.includes(i))}
                      />
                    )}
                    <pre className="flow-workspace__node-json">{JSON.stringify(selectedNode, null, 2)}</pre>
                  </>
                ) : (
                  <div className="flow-issues__empty">{t("workspace.noNodeSelected")}</div>
                )}
              </section>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}
