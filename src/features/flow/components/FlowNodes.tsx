import { memo } from "react";
import { useTranslation } from "react-i18next";
import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import type { GraphNode } from "../lib/flow-graph";

export interface FlowNodeData extends Record<string, unknown> {
  node: GraphNode;
  onToggle: (id: string) => void;
}

export type FlowRfNode = Node<FlowNodeData>;

/** Handle ids: forward edges enter left / leave right; back-edges use the bottom side. */
export const HANDLE_IN = "in";
export const HANDLE_OUT = "out";
export const HANDLE_BACK_IN = "back-in";
export const HANDLE_BACK_OUT = "back-out";

function Handles() {
  return (
    <>
      <Handle type="target" id={HANDLE_IN} position={Position.Left} isConnectable={false} />
      <Handle type="source" id={HANDLE_OUT} position={Position.Right} isConnectable={false} />
      <Handle
        type="target"
        id={HANDLE_BACK_IN}
        position={Position.Bottom}
        isConnectable={false}
        style={{ left: "30%" }}
      />
      <Handle
        type="source"
        id={HANDLE_BACK_OUT}
        position={Position.Bottom}
        isConnectable={false}
        style={{ left: "70%" }}
      />
    </>
  );
}

function IssueBadges({ node }: { node: GraphNode }) {
  const { t } = useTranslation("flow");
  if (node.errorCount === 0 && node.warningCount === 0) return null;
  return (
    <span className="flow-node__issues">
      {node.errorCount > 0 && (
        <span className="flow-node__issue flow-node__issue--error" title={t("workspace.errors")}>
          {node.errorCount}
        </span>
      )}
      {node.warningCount > 0 && (
        <span className="flow-node__issue flow-node__issue--warning" title={t("workspace.warnings")}>
          {node.warningCount}
        </span>
      )}
    </span>
  );
}

function Header({ node, onToggle }: FlowNodeData) {
  const { t } = useTranslation("flow");
  return (
    <div className="flow-node__header">
      <span className="flow-node__kind">{t(`kind.${node.kind}`)}</span>
      <span className="flow-node__label" title={node.nodeId}>
        {node.label}
      </span>
      <IssueBadges node={node} />
      {node.collapsible && (
        <button
          type="button"
          className="flow-node__toggle nodrag"
          onClick={(e) => {
            e.stopPropagation();
            onToggle(node.id);
          }}
          aria-expanded={node.isGroup}
          title={node.isGroup ? t("workspace.collapse") : t("workspace.expand")}
          aria-label={node.isGroup ? t("workspace.collapse") : t("workspace.expand")}
        >
          {node.isGroup ? "−" : "+"}
        </button>
      )}
    </div>
  );
}

function Details({ node }: { node: GraphNode }) {
  const { t } = useTranslation("flow");
  return (
    <div className="flow-node__details">
      {node.details.map((detail) => (
        <div key={detail.key} className="flow-node__detail">
          <span className="flow-node__detail-key">{t(`detail.${detail.key}`)}</span>
          <span className="flow-node__detail-value" title={detail.value}>
            {detail.value}
          </span>
        </div>
      ))}
      {node.hiddenChildren > 0 && (
        <div className="flow-node__detail flow-node__detail--muted">
          {t("workspace.hiddenNodes", { count: node.hiddenChildren })}
        </div>
      )}
      {node.estimateUsd !== undefined && (
        <div className="flow-node__detail flow-node__detail--muted">
          {t("workspace.estimate", { usd: node.estimateUsd })}
        </div>
      )}
    </div>
  );
}

/** A leaf node (or a collapsed loop). */
export const FlowNodeCard = memo(function FlowNodeCard({ data, selected }: NodeProps<FlowRfNode>) {
  const { node } = data;
  const classes = [
    "flow-node",
    `flow-node--${node.kind}`,
    selected ? "flow-node--selected" : "",
    node.errorCount > 0 ? "flow-node--has-errors" : node.warningCount > 0 ? "flow-node--has-warnings" : "",
  ];
  return (
    <div className={classes.filter(Boolean).join(" ")} data-node-path={node.id}>
      <Handles />
      <Header {...data} />
      <Details node={node} />
    </div>
  );
});

/** An expanded loop: a frame whose inline body nodes are drawn inside. */
export const FlowGroupNode = memo(function FlowGroupNode({ data, selected }: NodeProps<FlowRfNode>) {
  const { node } = data;
  const classes = [
    "flow-group",
    `flow-node--${node.kind}`,
    selected ? "flow-group--selected" : "",
    node.errorCount > 0 ? "flow-node--has-errors" : "",
  ];
  return (
    <div className={classes.filter(Boolean).join(" ")} data-node-path={node.id}>
      <Handles />
      <Header {...data} />
      <div className="flow-group__summary">
        {node.details.map((detail) => (
          <span key={detail.key} title={detail.value}>
            {detail.value}
          </span>
        ))}
      </div>
    </div>
  );
});

export const flowNodeTypes = { flowNode: FlowNodeCard, flowGroup: FlowGroupNode };
