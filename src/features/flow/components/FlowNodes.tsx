import { memo } from "react";
import { useTranslation } from "react-i18next";
import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import type { GraphNode } from "../lib/flow-graph";

export interface FlowNodeData extends Record<string, unknown> {
  node: GraphNode;
  onToggle: (id: string) => void;
  /** True when the canvas is editable (handles become connectable). */
  editable?: boolean;
}

export type FlowRfNode = Node<FlowNodeData>;

/** Handle ids: forward edges enter left / leave right; back-edges use the bottom side. */
export const HANDLE_IN = "in";
export const HANDLE_OUT = "out";
export const HANDLE_BACK_IN = "back-in";
export const HANDLE_BACK_OUT = "back-out";

function Handles({ editable }: { editable: boolean }) {
  return (
    <>
      <Handle type="target" id={HANDLE_IN} position={Position.Left} isConnectable={editable} />
      <Handle type="source" id={HANDLE_OUT} position={Position.Right} isConnectable={editable} />
      <Handle
        type="target"
        id={HANDLE_BACK_IN}
        position={Position.Bottom}
        isConnectable={editable}
        style={{ left: "30%" }}
      />
      <Handle
        type="source"
        id={HANDLE_BACK_OUT}
        position={Position.Bottom}
        isConnectable={editable}
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
      <span className="flow-node__kind" title={node.signature ? t("editor.drillDown") : undefined}>{t(`kind.${node.kind}`)}</span>
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

function Signature({ node }: { node: GraphNode }) {
  const { t } = useTranslation("flow");
  const signature = node.signature;
  if (!signature) return null;
  if (signature.missing) {
    return (
      <div className="flow-node__signature flow-node__signature--missing" title={signature.file}>
        {t("signature.missing")}
      </div>
    );
  }
  return (
    <div className="flow-node__signature" title={signature.file}>
      {signature.params.length > 0 && (
        <div className="flow-node__signature-params">
          <span className="flow-node__signature-title">{t("signature.params")}</span>
          {signature.params.map((param) => (
            <div key={param.name} className="flow-node__param">
              <span className="flow-node__param-name">{param.name}</span>
              {param.value !== undefined ? (
                <span className="flow-node__param-value">{` = ${param.value}`}</span>
              ) : (
                <span className="flow-node__param-note">{t("signature.unset")}</span>
              )}
              {!param.declared && <span className="flow-node__param-note">{t("signature.undeclared")}</span>}
            </div>
          ))}
        </div>
      )}
      {signature.outputs.length > 0 && (
        <div className="flow-node__signature-outputs">
          <span className="flow-node__signature-title">{t("signature.outputs")}</span>
          {signature.outputs.map((output) => (
            <span key={output} className="flow-node__chip">
              {output}
            </span>
          ))}
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
      <Handles editable={data.editable === true} />
      <Header {...data} />
      <Details node={node} />
      <Signature node={node} />
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
      <Handles editable={data.editable === true} />
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
