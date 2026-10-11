import { useTranslation } from "react-i18next";
import type { FlowDef, FlowEdge, FlowIssue, FlowNode, FlowSummary, ProjectLoadResult } from "@/shared/types/flow";
import type { Selection } from "../../editor-store";
import { edgeAt, nodeAt } from "../../lib/editor-state";
import { collectIds, portsOf } from "../../lib/flow-ports";
import { EdgeForm } from "./EdgeForm";
import { FlowAttrsForm, type FlowAttrsPatch } from "./FlowAttrsForm";
import { NodeCommonForm } from "./NodeCommonForm";
import { ActionForm } from "./kinds/ActionForm";
import { AgentForm } from "./kinds/AgentForm";
import { ApprovalForm } from "./kinds/ApprovalForm";
import { BranchForm } from "./kinds/BranchForm";
import { CommandForm } from "./kinds/CommandForm";
import { LoopForm } from "./kinds/LoopForm";
import { PythonForm } from "./kinds/PythonForm";
import { SubflowForm } from "./kinds/SubflowForm";

interface AttributePanelProps {
  def: FlowDef;
  selection: Selection;
  issues: FlowIssue[];
  /** Reusable parts and the project (consumed by the kind forms). */
  parts: FlowSummary[];
  project: ProjectLoadResult | null;
  /** Project folder (python stages are described by the runtime worker started there). */
  projectRoot: string;
  /** Project-relative path of the open file (decides how parts are referenced). */
  currentFile: string;
  onEditNode: (path: string, patch: Partial<FlowNode>) => void;
  onRenameNode: (path: string, id: string) => void;
  onEditEdge: (path: string, patch: Partial<FlowEdge>) => void;
  onDeleteEdge: (path: string) => void;
  onEditFlow: (patch: FlowAttrsPatch) => void;
}

interface KindContext {
  parts: FlowSummary[];
  project: ProjectLoadResult | null;
  projectRoot: string;
  currentFile: string;
  onChange: (path: string, patch: Partial<FlowNode>) => void;
}

function renderKindForm(node: FlowNode, path: string, ctx: KindContext) {
  const { projectRoot, ...common } = ctx;
  switch (node.kind) {
    case "command":
      return <CommandForm node={node} path={path} {...common} />;
    case "approval":
      return <ApprovalForm node={node} path={path} {...common} />;
    case "branch":
      return <BranchForm node={node} path={path} {...common} />;
    case "loop":
      return <LoopForm node={node} path={path} {...common} />;
    case "subflow":
      return <SubflowForm node={node} path={path} {...common} />;
    case "agent":
      return <AgentForm node={node} path={path} {...common} />;
    case "python":
      return <PythonForm node={node} path={path} projectRoot={projectRoot} {...common} />;
    case "action":
      return <ActionForm node={node} path={path} {...common} />;
  }
}

/** Right-hand attribute panel: routes by what is selected. */
export function AttributePanel({ def, selection, issues, parts, project, projectRoot, currentFile, onEditNode, onRenameNode, onEditEdge, onDeleteEdge, onEditFlow }: AttributePanelProps) {
  const { t } = useTranslation("flow");
  if (selection?.kind === "node") {
    const node = nodeAt(def, selection.path);
    if (!node) return <div className="flow-attrs__empty">{t("workspace.noNodeSelected")}</div>;
    const usedIds = new Set<string>();
    collectIds(def.nodes, usedIds);
    return (
      <div key={`${selection.path}:${node.id}`} className="flow-attrs__panel">
        <NodeCommonForm node={node} path={selection.path} issues={issues} usedIds={usedIds} onChange={onEditNode} onRename={onRenameNode} />
        {renderKindForm(node, selection.path, { parts, project, projectRoot, currentFile, onChange: onEditNode })}
      </div>
    );
  }
  if (selection?.kind === "edge") {
    const found = edgeAt(def, selection.path);
    if (!found) return <div className="flow-attrs__empty">{t("workspace.noNodeSelected")}</div>;
    const source = found.scope.find((n) => n.id === found.edge.from);
    return (
      <EdgeForm edge={found.edge} path={selection.path} ports={source ? portsOf(source) : []} onChange={onEditEdge} onDelete={onDeleteEdge} />
    );
  }
  return <FlowAttrsForm def={def} onChange={onEditFlow} />;
}
