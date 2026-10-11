import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { showConfirm } from "@/stores/dialog-store";
import type { FlowDef } from "@/shared/types/flow";
import {
  ACTIVE_RUN_STATUSES,
  isLiveInstance,
  splitNodeKey,
  type FlowRunError,
  type RunSnapshot,
  type RunSummary,
} from "@/shared/types/flow-run";
import { flowRunApi, subscribeFlowRunEvents, toFlowRunError } from "../lib/flow-run-api";
import { describeError, describeReason, formatUsd } from "../lib/run-format";
import { RunStartDialog } from "./RunStartDialog";
import { RunLogDialog } from "./RunLogDialog";
import { RunNodeTree } from "./RunNodeTree";
import { RunNodeDetail } from "./RunNodeDetail";
import { ApprovalDialog } from "./ApprovalDialog";
import { buildRunTree, type RunTreeRow } from "../lib/run-tree";

/** Key of the budget approval, which has no node. */
const BUDGET_KEY = "__budget__";

/** Compares project roots as the backend may spell them differently. */
export function sameRoot(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return norm(a) === norm(b);
}

interface RunPanelProps {
  projectRoot: string;
  flowPath: string;
  /** Decoded flow without validation errors (enables "Run"). */
  flow: FlowDef | null;
}

/** Runs of one flow: start, list, and the selected run's controls (PR 3c). */
export function RunPanel({ projectRoot, flowPath, flow }: RunPanelProps) {
  const { t } = useTranslation("flow");
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<RunSnapshot | null>(null);
  const [error, setError] = useState<FlowRunError | null>(null);
  const [starting, setStarting] = useState(false);
  const [logTarget, setLogTarget] = useState<{ nodeKey: string; attempt: number } | null>(null);
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [approvalNotice, setApprovalNotice] = useState(false);
  const [gitignoreHint, setGitignoreHint] = useState(false);
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selected;

  const loadRuns = useCallback(async () => {
    try {
      const all = await flowRunApi.list(projectRoot);
      const mine = all.filter((r) => r.flowPath === flowPath);
      setRuns(mine);
      if (mine.length > 0) {
        flowRunApi.gitignoreStatus(projectRoot).then(
          (s) => setGitignoreHint(!s.ignored),
          () => setGitignoreHint(false),
        );
      }
    } catch (err) {
      setError(toFlowRunError(err));
    }
  }, [projectRoot, flowPath]);

  const loadSnapshot = useCallback(
    async (runId: string) => {
      try {
        const snap = await flowRunApi.get(projectRoot, runId);
        if (selectedRef.current === runId) setSnapshot(snap);
      } catch (err) {
        setError(toFlowRunError(err));
      }
    },
    [projectRoot],
  );

  useEffect(() => {
    setSelected(null);
    setSnapshot(null);
    void loadRuns();
  }, [loadRuns]);

  useEffect(() => {
    setSelectedNode(null);
    if (selected) void loadSnapshot(selected);
    else setSnapshot(null);
  }, [selected, loadSnapshot]);

  // Live updates (no polling): refetch after a short debounce.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = (runId: string) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        void loadRuns();
        if (selectedRef.current === runId) void loadSnapshot(runId);
      }, 150);
    };
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void subscribeFlowRunEvents({
      onRunChanged: (e) => sameRoot(e.projectRoot, projectRoot) && refresh(e.runId),
      onNodeChanged: (e) => sameRoot(e.projectRoot, projectRoot) && refresh(e.runId),
      onApprovalRequested: (e) => {
        if (!sameRoot(e.projectRoot, projectRoot)) return;
        setApprovalNotice(true);
        refresh(e.runId);
      },
    })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      // Outside Tauri (tests, previews) there are no events to listen to.
      .catch(() => {});
    return () => {
      disposed = true;
      clearTimeout(timer);
      unlisten?.();
    };
  }, [projectRoot, loadRuns, loadSnapshot]);

  const refresh = async () => {
    await loadRuns();
    if (selected) await loadSnapshot(selected);
  };

  const act = async (op: () => Promise<void>) => {
    setError(null);
    try {
      await op();
    } catch (err) {
      setError(toFlowRunError(err) ?? { code: "FLOW_COMMAND_FAILED", message: String(err) });
    }
    await refresh();
  };

  const described = error ? describeError(t, error) : null;

  return (
    <div className="flow-runs">
      <div className="flow-runs__toolbar">
        <button type="button" className="flow-runs__start" disabled={!flow} onClick={() => setStarting(true)}>
          {t("run.start")}
        </button>
      </div>
      {approvalNotice && (
        <button type="button" className="flow-runs__notice" onClick={() => setApprovalNotice(false)}>
          {t("run.approvalNotice")}
        </button>
      )}
      {gitignoreHint && <div className="flow-runs__hint">{t("run.gitignoreHint")}</div>}
      {described && (
        <div className="flow-runs__error" role="alert">
          <div>{described.message}</div>
          {described.details.map((d, i) => (
            <div key={i}>{d}</div>
          ))}
        </div>
      )}
      {runs.length === 0 ? (
        <div className="flow-issues__empty">{t("run.none")}</div>
      ) : (
        <ul className="flow-runs__list">
          {runs.map((run) => (
            <li key={run.runId}>
              <button
                type="button"
                className={`flow-runs__item${run.runId === selected ? " flow-runs__item--selected" : ""}`}
                onClick={() => setSelected(run.runId === selected ? null : run.runId)}
              >
                <span className={`flow-runs__status flow-runs__status--${run.status}`}>{t(`runStatus.${run.status}`)}</span>
                <span className="flow-runs__when">{t("run.created", { at: new Date(run.createdAt).toLocaleString() })}</span>
                {run.pendingApprovals > 0 && <span className="flow-runs__badge">{run.pendingApprovals}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
      {snapshot && selected && (
        <RunDetail
          key={snapshot.meta.runId}
          snapshot={snapshot}
          onAct={act}
          onRefresh={refresh}
          projectRoot={projectRoot}
          selectedNode={selectedNode}
          onSelectNode={setSelectedNode}
          onLog={(nodeKey, attempt) => setLogTarget({ nodeKey, attempt })}
        />
      )}
      {starting && flow && (
        <RunStartDialog
          projectRoot={projectRoot}
          flowPath={flowPath}
          flow={flow}
          onClose={() => setStarting(false)}
          onStarted={(runId) => {
            setStarting(false);
            setSelected(runId);
            void loadRuns();
          }}
        />
      )}
      {logTarget && selected && (
        <RunLogDialog
          projectRoot={projectRoot}
          runId={selected}
          nodeKey={logTarget.nodeKey}
          attempt={logTarget.attempt}
          onClose={() => setLogTarget(null)}
        />
      )}
    </div>
  );
}

interface RunDetailProps {
  projectRoot: string;
  snapshot: RunSnapshot;
  selectedNode: string | null;
  onSelectNode(key: string): void;
  onAct(op: () => Promise<void>): Promise<void>;
  /** Reloads the run list and the selected run. */
  onRefresh(): Promise<void>;
  onLog(nodeKey: string, attempt: number): void;
}

function RunDetail({ projectRoot, snapshot, selectedNode, onSelectNode, onAct, onRefresh, onLog }: RunDetailProps) {
  const { t } = useTranslation("flow");
  const { meta, state, active } = snapshot;
  const runId = meta.runId;
  const status = state.status;
  const isActive = ACTIVE_RUN_STATUSES.includes(status);
  const canResume = !active && ["pending", "paused", "interrupted", "failed", "awaiting_approval"].includes(status);
  const canCancel = status !== "completed" && status !== "cancelled";
  const canDelete = !active && !isActive && status !== "pending";
  /** Top-level definitions (nested nodes are labelled by their key). */
  const rootDef = (key: string) => (splitNodeKey(key).prefix === "" ? meta.flow.nodes.find((n) => n.id === splitNodeKey(key).id) : undefined);
  const isApproval = (key: string) => rootDef(key)?.kind === "approval";
  const rows = useMemo(() => buildRunTree(state, meta.flow), [state, meta.flow]);
  const labels = useMemo(() => labelsOf(rows), [rows]);
  const approvals = state.approvals ?? [];
  // Node key (or BUDGET_KEY) of the request whose dialog is open; it closes when the request is gone.
  const [openApproval, setOpenApproval] = useState<string | null>(null);
  const openRequest = openApproval === null ? undefined : approvals.find((r) => (r.nodeKey ?? BUDGET_KEY) === openApproval);
  // Forget a request that was settled elsewhere, so a later request on the same key does not reopen the dialog.
  useEffect(() => {
    if (openApproval !== null && !openRequest) setOpenApproval(null);
  }, [openApproval, openRequest]);

  const approve = async (nodeKey: string | null, choice: string, comment: string) => {
    try {
      await flowRunApi.approve(projectRoot, runId, nodeKey, choice, comment.trim() || null);
    } catch (err) {
      // The dialog shows the error; refreshing now could close it before the user reads it.
      throw toFlowRunError(err) ?? { code: "FLOW_COMMAND_FAILED", message: String(err) };
    }
    await onRefresh();
  };
  // Nested scopes' edges are not known here; the backend rejects what it cannot do.
  const hasFailureEdge = (key: string) =>
    splitNodeKey(key).prefix === "" &&
    (meta.flow.edges ?? []).some((e) => e.from === splitNodeKey(key).id && e.port === "failure" && e.maxTraversals === undefined);

  const needsAction = (key: string, node: RunSnapshot["state"]["nodes"][string]) =>
    !isActive &&
    !active &&
    isLiveInstance(state, key) &&
    (node.status === "interrupted" || node.status === "cancelled" || (node.status === "failed" && !hasFailureEdge(key)));

  return (
    <div className="flow-run">
      <div className="flow-run__head">
        <span className={`flow-runs__status flow-runs__status--${status}`}>{t(`runStatus.${status}`)}</span>
        {active && <span className="flow-run__muted">{t("run.active")}</span>}
        <span className="flow-run__muted">{t("run.cost", { usd: formatUsd(state.cost.actual + state.cost.estimated) })}</span>
      </div>
      {state.reason && <div className="flow-run__reason">{describeReason(t, state.reason)}</div>}
      <div className="flow-run__actions">
        {isActive && (
          <button type="button" onClick={() => void onAct(() => flowRunApi.stop(projectRoot, runId))}>
            {t("run.stop")}
          </button>
        )}
        {canResume && (
          <button type="button" onClick={() => void onAct(() => flowRunApi.resume(projectRoot, runId))}>
            {t("run.resume")}
          </button>
        )}
        {canCancel && (
          <button
            type="button"
            onClick={async () => {
              if (await showConfirm(t("run.confirmCancel"), { kind: "warning" })) {
                await onAct(() => flowRunApi.cancel(projectRoot, runId));
              }
            }}
          >
            {t("run.cancel")}
          </button>
        )}
        {canDelete && (
          <button
            type="button"
            onClick={async () => {
              if (await showConfirm(t("run.confirmDelete"), { kind: "warning" })) {
                await onAct(() => flowRunApi.delete(projectRoot, runId));
              }
            }}
          >
            {t("run.delete")}
          </button>
        )}
      </div>
      {approvals.length > 0 && (
        <div className="flow-run__approvals">
          {approvals.map((request) => (
            <div key={request.nodeKey ?? BUDGET_KEY} className="flow-run__approval">
              <div className="flow-run__approval-title">{request.nodeKey ? `${t("run.approvals")}: ${request.nodeKey}` : t("run.budget")}</div>
              <div>
                <button type="button" onClick={() => setOpenApproval(request.nodeKey ?? BUDGET_KEY)}>
                  {t("run.review")}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      <h4 className="flow-run__heading">{t("run.nodes")}</h4>
      <RunNodeTree
        rows={rows}
        selectedKey={selectedNode}
        onSelect={onSelectNode}
        onOpenApproval={setOpenApproval}
      />
      {selectedNode && state.nodes[selectedNode] && (
        <RunNodeDetail
          key={selectedNode}
          projectRoot={projectRoot}
          runId={runId}
          nodeKey={selectedNode}
          node={state.nodes[selectedNode]}
          name={labels.get(selectedNode) ?? selectedNode}
          canRerun={needsAction(selectedNode, state.nodes[selectedNode])}
          canMarkSucceeded={needsAction(selectedNode, state.nodes[selectedNode]) && state.nodes[selectedNode].status === "failed"}
          isApproval={isApproval(selectedNode)}
          onAct={onAct}
          onLog={onLog}
        />
      )}
      {openRequest && (
        <ApprovalDialog
          projectRoot={projectRoot}
          runId={runId}
          request={openRequest}
          onClose={() => setOpenApproval(null)}
          onChoose={(choice, comment) => approve(openRequest.nodeKey ?? null, choice, comment)}
        />
      )}
    </div>
  );
}

/** Display labels of every row in the tree, by key. */
function labelsOf(rows: RunTreeRow[]): Map<string, string> {
  const out = new Map<string, string>();
  const visit = (row: RunTreeRow) => {
    out.set(row.key, row.label);
    row.children.forEach(visit);
  };
  rows.forEach(visit);
  return out;
}
