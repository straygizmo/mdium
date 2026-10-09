import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { showConfirm } from "@/stores/dialog-store";
import type { FlowDef } from "@/shared/types/flow";
import {
  ACTIVE_RUN_STATUSES,
  isLiveInstance,
  splitNodeKey,
  type ApprovalRequest,
  type FlowRunError,
  type NodeState,
  type RunSnapshot,
  type RunSummary,
} from "@/shared/types/flow-run";
import { flowRunApi, subscribeFlowRunEvents, toFlowRunError } from "../lib/flow-run-api";
import { describeError, describeReason, formatUsd } from "../lib/run-format";
import { RunStartDialog } from "./RunStartDialog";
import { RunLogDialog } from "./RunLogDialog";

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

  const act = async (op: () => Promise<void>) => {
    setError(null);
    try {
      await op();
    } catch (err) {
      setError(toFlowRunError(err) ?? { code: "FLOW_COMMAND_FAILED", message: String(err) });
    }
    await loadRuns();
    if (selected) await loadSnapshot(selected);
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
          snapshot={snapshot}
          onAct={act}
          projectRoot={projectRoot}
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
  onAct(op: () => Promise<void>): Promise<void>;
  onLog(nodeKey: string, attempt: number): void;
}

function RunDetail({ projectRoot, snapshot, onAct, onLog }: RunDetailProps) {
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
  // Nested scopes' edges are not known here; the backend rejects what it cannot do.
  const hasFailureEdge = (key: string) =>
    splitNodeKey(key).prefix === "" &&
    (meta.flow.edges ?? []).some((e) => e.from === splitNodeKey(key).id && e.port === "failure" && e.maxTraversals === undefined);

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
      {(state.approvals ?? []).length > 0 && (
        <div className="flow-run__approvals">
          {(state.approvals ?? []).map((request) => (
            <ApprovalCard
              key={request.nodeKey ?? "__budget__"}
              request={request}
              onChoose={(choice, comment) =>
                onAct(() => flowRunApi.approve(projectRoot, runId, request.nodeKey ?? null, choice, comment || null))
              }
            />
          ))}
        </div>
      )}
      <h4 className="flow-run__heading">{t("run.nodes")}</h4>
      <ul className="flow-run__nodes">
        {Object.entries(state.nodes).map(([key, node]: [string, NodeState]) => {
          const def = rootDef(key);
          const needsAction =
            !isActive &&
            !active &&
            isLiveInstance(state, key) &&
            (node.status === "interrupted" || node.status === "cancelled" || (node.status === "failed" && !hasFailureEdge(key)));
          return (
            <li key={key} className={`flow-run__node flow-run__node--${node.status}`}>
              <div className="flow-run__node-head">
                <span className="flow-run__node-name" title={key}>
                  {def?.name && splitNodeKey(key).pass === 1 ? def.name : key}
                </span>
                <span className="flow-run__node-status">{t(`nodeStatus.${node.status}`)}</span>
                {node.attempt > 1 && <span className="flow-run__muted">{t("run.attempt", { n: node.attempt })}</span>}
              </div>
              {node.progress && <div className="flow-run__muted">{node.progress.text}</div>}
              {node.reason && <div className="flow-run__reason">{describeReason(t, node.reason)}</div>}
              <div className="flow-run__node-actions">
                {!isApproval(key) && node.attempt > 0 && (node.process || node.startedAt) && (
                  <button type="button" onClick={() => onLog(key, node.attempt)}>
                    {t("run.log")}
                  </button>
                )}
                {needsAction && (
                  <button type="button" onClick={() => void onAct(() => flowRunApi.rerunNode(projectRoot, runId, key))}>
                    {t("run.rerun")}
                  </button>
                )}
                {needsAction && node.status === "failed" && (
                  <button type="button" onClick={() => void onAct(() => flowRunApi.markSucceeded(projectRoot, runId, key))}>
                    {t("run.markSucceeded")}
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function ApprovalCard({ request, onChoose }: { request: ApprovalRequest; onChoose(choice: string, comment: string): Promise<void> }) {
  const { t } = useTranslation("flow");
  const [comment, setComment] = useState("");
  return (
    <div className="flow-run__approval">
      <div className="flow-run__approval-title">{request.nodeKey ? `${t("run.approvals")}: ${request.nodeKey}` : t("run.budget")}</div>
      {request.message && <div>{request.message}</div>}
      {!request.message && <div className="flow-run__muted">{describeReason(t, request.reason)}</div>}
      {Object.entries(request.show ?? {}).map(([name, value]) => (
        <div key={name} className="flow-run__muted">
          {name}: <code>{typeof value === "string" ? value : JSON.stringify(value)}</code>
        </div>
      ))}
      <input
        className="flow-dialog__input"
        placeholder={t("run.comment")}
        aria-label={t("run.comment")}
        value={comment}
        onChange={(e) => setComment(e.target.value)}
      />
      <div className="flow-run__actions">
        {request.options.map((option) => (
          <button key={option} type="button" onClick={() => void onChoose(option, comment)}>
            {/* Built-in options are localized; options named in the flow file are shown as written. */}
            {t(`run.option.${option}`, { defaultValue: option })}
          </button>
        ))}
      </div>
    </div>
  );
}
