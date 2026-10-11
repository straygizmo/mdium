import { useTranslation } from "react-i18next";
import type { FlowDef, FlowEdge, FlowIssue, FlowNode, FlowSummary, ProjectLoadResult } from "@/shared/types/flow";
import type { Selection } from "../../editor-store";
import { nodeAt } from "../../lib/editor-state";
import { portsOf } from "../../lib/flow-ports";
import { EdgeForm } from "./EdgeForm";
import { FlowAttrsForm, type FlowAttrsPatch } from "./FlowAttrsForm";
import { NodeCommonForm } from "./NodeCommonForm";

interface AttributePanelProps {
  def: FlowDef;
  selection: Selection;
  issues: FlowIssue[];
  /** Reusable parts and the project (consumed by the kind forms). */
  parts: FlowSummary[];
  project: ProjectLoadResult | null;
  onEditNode: (path: string, patch: Partial<FlowNode>) => void;
  onRenameNode: (path: string, id: string) => void;
  onEditEdge: (path: string, patch: Partial<FlowEdge>) => void;
  onDeleteEdge: (path: string) => void;
  onEditFlow: (patch: FlowAttrsPatch) => void;
}

const EDGE_PATH = /^(.*?)(?:\.body\.)?edges\[(\d+)\]$/;

/** The edge at `edgePath` (`edges[i]` or `nodes[i].body.edges[j]`) and the nodes of its scope. */
function edgeAt(def: FlowDef, edgePath: string): { edge: FlowEdge; scope: FlowNode[] } | null {
  const m = EDGE_PATH.exec(edgePath);
  if (!m) return null;
  const index = Number(m[2]);
  if (m[1] === "") {
    const edge = def.edges?.[index];
    return edge ? { edge, scope: def.nodes } : null;
  }
  const owner = nodeAt(def, m[1]);
  if (!owner || owner.kind !== "loop" || typeof owner.body === "string") return null;
  const edge = owner.body.edges?.[index];
  return edge ? { edge, scope: owner.body.nodes } : null;
}

/** Right-hand attribute panel: routes by what is selected. */
export function AttributePanel({ def, selection, issues, onEditNode, onRenameNode, onEditEdge, onDeleteEdge, onEditFlow }: AttributePanelProps) {
  const { t } = useTranslation("flow");
  if (selection?.kind === "node") {
    const node = nodeAt(def, selection.path);
    if (!node) return <div className="flow-attrs__empty">{t("workspace.noNodeSelected")}</div>;
    return (
      <div className="flow-attrs__panel">
        <NodeCommonForm node={node} path={selection.path} issues={issues} onChange={onEditNode} onRename={onRenameNode} />
        {/* Kind-specific forms are added per kind; until then show the raw node. */}
        <pre className="flow-attrs__json">{JSON.stringify(node, null, 2)}</pre>
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
