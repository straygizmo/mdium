import type { FlowDef, FlowEdge, FlowIssue, FlowNode, FlowNodeKind } from "@/shared/types/flow";

/** One line of a node's summary: an i18n key under `flow:detail.*` and its value. */
export interface NodeDetail {
  key: string;
  value: string;
}

/** A node to draw. `id` is the node's path in the file (unique even when ids clash). */
export interface GraphNode {
  id: string;
  /** The node's `id` as written in the flow file. */
  nodeId: string;
  kind: FlowNodeKind;
  label: string;
  details: NodeDetail[];
  estimateUsd?: number;
  /** Parent group (an expanded loop with an inline body). */
  parentId?: string;
  /** True for an expanded loop whose inline body is drawn inside it. */
  isGroup: boolean;
  /** True for a loop with an inline body (can be expanded/collapsed). */
  collapsible: boolean;
  /** Number of body nodes hidden while collapsed. */
  hiddenChildren: number;
  errorCount: number;
  warningCount: number;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  port: string;
  isFailure: boolean;
  /** A back-edge (has `maxTraversals`). */
  isBack: boolean;
  maxTraversals?: number;
}

export interface FlowGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

const NODE_PATH = /^(nodes\[\d+\](?:\.body\.nodes\[\d+\])*)/;

/** The path of the node an issue path points into (`nodes[1].body.nodes[0].run[2]` → `nodes[1].body.nodes[0]`). */
export function issueNodePath(issuePath: string): string | null {
  const match = NODE_PATH.exec(issuePath);
  return match ? match[1] : null;
}

function truncate(text: string, max = 48): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length > max ? `${single.slice(0, max - 1)}…` : single;
}

function nodeDetails(node: FlowNode): NodeDetail[] {
  switch (node.kind) {
    case "agent":
      return [
        { key: "provider", value: node.model ? `${node.provider} / ${node.model}` : node.provider },
        { key: "permission", value: node.permission },
      ];
    case "command": {
      const program = Array.isArray(node.run) ? (node.run[0] ?? "") : truncate(node.run, 32);
      return [{ key: node.shell ? "shell" : "program", value: program }];
    }
    case "approval": {
      const details: NodeDetail[] = [];
      if (node.message) details.push({ key: "message", value: truncate(node.message) });
      details.push({ key: "options", value: (node.options ?? ["approve", "reject"]).join(" / ") });
      return details;
    }
    case "loop": {
      const details: NodeDetail[] = [];
      if (node.mode === "foreach") {
        const items = typeof node.items === "string" ? truncate(node.items, 40) : `[${(node.items ?? []).length}]`;
        details.push({ key: "foreach", value: items });
      } else {
        details.push({ key: "while", value: "until" });
      }
      const limits = [`≤${node.maxIterations ?? "?"}`];
      if (node.parallelism && node.parallelism > 1) limits.push(`×${node.parallelism}`);
      details.push({ key: "iterations", value: limits.join(" ") });
      if (typeof node.body === "string") details.push({ key: "body", value: node.body });
      return details;
    }
    case "branch":
      return [
        {
          key: "cases",
          value: [...node.cases.map((c) => c.port), ...(node.default ? [`(${node.default})`] : [])].join(" / "),
        },
      ];
    case "subflow":
      return [{ key: "flow", value: node.flow }];
    case "action":
      return [{ key: "uses", value: node.uses }];
  }
}

function countBody(node: FlowNode): number {
  if (node.kind !== "loop" || typeof node.body === "string") return 0;
  return node.body.nodes.reduce((sum, child) => sum + 1 + countBody(child), 0);
}

/**
 * Converts a flow definition into nodes and edges to draw. Loops with an
 * inline body are drawn as groups unless their path is in `collapsed`.
 * Issues are counted on the deepest visible node they point into.
 */
export function buildFlowGraph(
  def: FlowDef,
  collapsed: ReadonlySet<string>,
  issues: { errors: FlowIssue[]; warnings: FlowIssue[] } = { errors: [], warnings: [] },
): FlowGraph {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const visible = new Set<string>();

  const walk = (scopeNodes: FlowNode[], scopeEdges: FlowEdge[] | undefined, prefix: string, parentId?: string) => {
    // Map ids to paths within this scope (first occurrence wins on duplicates).
    const pathOf = new Map<string, string>();
    scopeNodes.forEach((node, i) => {
      const path = `${prefix}nodes[${i}]`;
      if (!pathOf.has(node.id)) pathOf.set(node.id, path);
      const inlineBody = node.kind === "loop" && typeof node.body !== "string" ? node.body : null;
      const expanded = inlineBody !== null && !collapsed.has(path);
      nodes.push({
        id: path,
        nodeId: node.id,
        kind: node.kind,
        label: node.name ?? node.id,
        details: nodeDetails(node),
        estimateUsd: node.cost?.estimateUsd,
        parentId,
        isGroup: expanded,
        collapsible: inlineBody !== null,
        hiddenChildren: expanded ? 0 : countBody(node),
        errorCount: 0,
        warningCount: 0,
      });
      visible.add(path);
      if (inlineBody && expanded) {
        walk(inlineBody.nodes, inlineBody.edges, `${path}.body.`, path);
      }
    });
    (scopeEdges ?? []).forEach((edge, i) => {
      const source = pathOf.get(edge.from);
      const target = pathOf.get(edge.to);
      if (!source || !target) return; // reported by the validator
      const port = edge.port ?? "success";
      edges.push({
        id: `${prefix}edges[${i}]`,
        source,
        target,
        port,
        isFailure: port === "failure",
        isBack: edge.maxTraversals !== undefined,
        maxTraversals: edge.maxTraversals,
      });
    });
  };
  walk(def.nodes, def.edges, "");

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const nearestVisible = (path: string): GraphNode | undefined => {
    let current = path;
    while (current) {
      if (visible.has(current)) return byId.get(current);
      const cut = current.lastIndexOf(".body.");
      if (cut < 0) return undefined;
      current = current.slice(0, cut);
    }
    return undefined;
  };
  for (const [list, field] of [
    [issues.errors, "errorCount"],
    [issues.warnings, "warningCount"],
  ] as const) {
    for (const issue of list) {
      const path = issueNodePath(issue.path);
      const node = path ? nearestVisible(path) : undefined;
      if (node) node[field] += 1;
    }
  }
  return { nodes, edges };
}

/** The flow node (definition) at a node path, if any. */
export function nodeAtPath(def: FlowDef, path: string): FlowNode | undefined {
  let scope: FlowNode[] | undefined = def.nodes;
  let node: FlowNode | undefined;
  for (const part of path.split(".body.")) {
    const match = /^nodes\[(\d+)\]$/.exec(part);
    if (!match || !scope) return undefined;
    node = scope[Number(match[1])];
    if (!node) return undefined;
    scope = node.kind === "loop" && typeof node.body !== "string" ? node.body.nodes : undefined;
  }
  return node;
}

/** Issues that point into the node at `path` (or its body). */
export function issuesForNode(issues: FlowIssue[], path: string): FlowIssue[] {
  return issues.filter((issue) => {
    const nodePath = issueNodePath(issue.path);
    return nodePath !== null && (nodePath === path || nodePath.startsWith(`${path}.body.`));
  });
}
