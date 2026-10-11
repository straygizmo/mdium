import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { NodeState } from "@/shared/types/flow-run";
import { flowRunApi } from "../lib/flow-run-api";
import { describeReason } from "../lib/run-format";
import { ArtifactPreview } from "./ArtifactPreview";

interface RunNodeDetailProps {
  projectRoot: string;
  runId: string;
  nodeKey: string;
  node: NodeState;
  name: string;
  canRerun: boolean;
  canMarkSucceeded: boolean;
  isApproval: boolean;
  onAct(op: () => Promise<void>): Promise<void>;
  onLog(nodeKey: string, attempt: number): void;
}

type DetailTab = "overview" | "artifacts";

const fileName = (path: string) => path.replace(/\\/g, "/").split("/").pop() || path;

/** Details of the selected node: outputs, recorded artifacts and the node actions. */
export function RunNodeDetail({
  projectRoot,
  runId,
  nodeKey,
  node,
  name,
  canRerun,
  canMarkSucceeded,
  isApproval,
  onAct,
  onLog,
}: RunNodeDetailProps) {
  const { t } = useTranslation("flow");
  const [tab, setTab] = useState<DetailTab>("overview");
  const outputs = Object.entries(node.outputs ?? {});
  const artifacts = node.artifacts ?? [];

  return (
    <div className="flow-node-detail">
      <div className="flow-run__node-head">
        <span className="flow-run__node-name" title={nodeKey}>
          {name}
        </span>
        <span className="flow-run__node-status">{t(`nodeStatus.${node.status}`)}</span>
        {node.attempt > 1 && <span className="flow-run__muted">{t("run.attempt", { n: node.attempt })}</span>}
      </div>
      {node.progress && <div className="flow-run__muted">{node.progress.text}</div>}
      {node.reason && <div className="flow-run__reason">{describeReason(t, node.reason)}</div>}
      <div className="flow-dialog__tabs flow-node-detail__tabs" role="tablist">
        {(["overview", "artifacts"] as const).map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={`flow-dialog__tab${tab === id ? " flow-dialog__tab--active" : ""}`}
            onClick={() => setTab(id)}
          >
            {t(`run.tab.${id}`)}
          </button>
        ))}
      </div>
      {tab === "overview" && (
        <>
          <h5 className="flow-node-detail__heading">{t("run.outputs")}</h5>
          {outputs.length === 0 ? (
            <div className="flow-run__muted">{t("run.noOutputs")}</div>
          ) : (
            <dl className="flow-node-detail__outputs">
              {outputs.map(([key, value]) => (
                <div key={key}>
                  <dt>{key}</dt>
                  <dd>
                    <code>{typeof value === "string" ? value : JSON.stringify(value)}</code>
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </>
      )}
      {tab === "artifacts" &&
        (artifacts.length === 0 ? (
          <div className="flow-run__muted">{t("run.noArtifacts")}</div>
        ) : (
          <ul className="flow-node-detail__artifacts">
            {artifacts.map((artifact) => (
              <li key={`${artifact.index}:${artifact.path}`} className="flow-artifact">
                <div className="flow-artifact__head">
                  <span title={artifact.path}>{artifact.label ?? fileName(artifact.path)}</span>
                  <span className="flow-run__muted">{artifact.mediaType}</span>
                  {artifact.bytes !== undefined && <span className="flow-run__muted">{t("run.bytes", { n: artifact.bytes })}</span>}
                </div>
                <ArtifactPreview projectRoot={projectRoot} runId={runId} nodeKey={nodeKey} attempt={node.attempt} artifact={artifact} />
              </li>
            ))}
          </ul>
        ))}
      <div className="flow-run__node-actions">
        {!isApproval && node.attempt > 0 && (node.process || node.startedAt) && (
          <button type="button" onClick={() => onLog(nodeKey, node.attempt)}>
            {t("run.log")}
          </button>
        )}
        {canRerun && (
          <button type="button" onClick={() => void onAct(() => flowRunApi.rerunNode(projectRoot, runId, nodeKey))}>
            {t("run.rerun")}
          </button>
        )}
        {canMarkSucceeded && (
          <button type="button" onClick={() => void onAct(() => flowRunApi.markSucceeded(projectRoot, runId, nodeKey))}>
            {t("run.markSucceeded")}
          </button>
        )}
      </div>
    </div>
  );
}
