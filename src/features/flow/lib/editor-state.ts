import { KNOWN_ACTIONS } from "./known-actions";
import { collectIds } from "./flow-ports";
import type { FlowDef, FlowEdge, FlowInlineBody, FlowLoopNode, FlowNode, FlowNodeKind } from "@/shared/types/flow";

/** `nodes[i]` or `nodes[i].body.nodes[j]`: the graph's node id. */
export type NodePath = string;

type Position = { x: number; y: number };
type Scope = { nodes: FlowNode[]; edges?: FlowEdge[] };

const NODE_INDEX = /nodes\[(\d+)\]/g;
/** `edges[i]` or `<loop node path>.body.edges[j]`: group 1 is the owning loop's path (`""` at the top level). */
export const EDGE_PATH = /^(.*?)(?:\.body\.)?edges\[(\d+)\]$/;

/** Indices of every `nodes[i]` segment, outermost first. */
function nodeIndices(path: string): number[] {
  return [...path.matchAll(NODE_INDEX)].map((m) => Number(m[1]));
}

function inlineBody(node: FlowNode | undefined): FlowInlineBody | null {
  return node && node.kind === "loop" && typeof node.body !== "string" ? node.body : null;
}

/** Rewrites the scope reached through the loop nodes `loops` (indices); `[]` is the top level. */
function editScope<T extends Scope>(scope: T, loops: number[], fn: (s: Scope) => Partial<Scope>): T {
  if (loops.length === 0) return { ...scope, ...fn(scope) };
  const [first, ...rest] = loops;
  const node = scope.nodes[first];
  const body = inlineBody(node);
  if (!node || !body) return scope;
  const nextBody = editScope(body, rest, fn);
  const nextNode: FlowLoopNode = { ...(node as FlowLoopNode), body: nextBody };
  return { ...scope, nodes: scope.nodes.map((n, i) => (i === first ? nextNode : n)) };
}

/** Loop-node indices leading to the scope that owns the node at `path`. */
function ownerLoops(path: NodePath): number[] {
  return nodeIndices(path).slice(0, -1);
}

function scopeAt(def: FlowDef, loops: number[]): Scope | null {
  let scope: Scope = def;
  for (const i of loops) {
    const body = inlineBody(scope.nodes[i]);
    if (!body) return null;
    scope = body;
  }
  return scope;
}

export function nodeAt(def: FlowDef, path: NodePath): FlowNode | undefined {
  const idx = nodeIndices(path);
  const scope = scopeAt(def, idx.slice(0, -1));
  return scope?.nodes[idx[idx.length - 1]];
}

export function parentList(def: FlowDef, path: NodePath): { list: FlowNode[]; index: number; edges: FlowEdge[] } {
  const idx = nodeIndices(path);
  const scope = scopeAt(def, idx.slice(0, -1));
  return { list: scope?.nodes ?? [], index: idx[idx.length - 1] ?? -1, edges: scope?.edges ?? [] };
}

function positionsOf(def: FlowDef): Record<string, Position> {
  const ui = def.ui as { positions?: Record<string, Position> } | undefined;
  return ui?.positions ?? {};
}

function withPositions(def: FlowDef, positions: Record<string, Position>): FlowDef {
  return { ...def, ui: { ...(def.ui as object | undefined), positions } };
}

export function addNode(def: FlowDef, node: FlowNode, position?: Position): FlowDef {
  const next: FlowDef = { ...def, nodes: [...def.nodes, node] };
  return position ? withPositions(next, { ...positionsOf(def), [node.id]: position }) : next;
}

export function removeNode(def: FlowDef, path: NodePath): FlowDef {
  const idx = nodeIndices(path);
  const target = nodeAt(def, path);
  if (!target) return def;
  const at = idx[idx.length - 1];
  const next = editScope(def, ownerLoops(path), (s) => ({
    nodes: s.nodes.filter((_, i) => i !== at),
    ...(s.edges ? { edges: s.edges.filter((e) => e.from !== target.id && e.to !== target.id) } : {}),
  }));
  if (idx.length === 1) {
    const positions = { ...positionsOf(next) };
    if (target.id in positions) {
      delete positions[target.id];
      return withPositions(next, positions);
    }
  }
  return next;
}

export function moveNode(def: FlowDef, nodeId: string, position: Position): FlowDef {
  return withPositions(def, { ...positionsOf(def), [nodeId]: position });
}

/** The port an edge leaves by (`port` omitted means `success`). */
const portOf = (edge: FlowEdge): string => edge.port ?? "success";

const sameEdge = (a: FlowEdge, b: FlowEdge): boolean => a.from === b.from && a.to === b.to && portOf(a) === portOf(b);

export function addEdge(def: FlowDef, scopePath: "" | NodePath, edge: FlowEdge): FlowDef {
  return editScope(def, nodeIndices(scopePath), (s) => {
    const edges = s.edges ?? [];
    return edges.some((e) => sameEdge(e, edge)) ? {} : { edges: [...edges, edge] };
  });
}

/** The scope (`""` or the owning loop's node path) of the node at `nodePath`. */
export function scopeOf(nodePath: NodePath): string {
  const i = nodePath.lastIndexOf(".body.");
  return i < 0 ? "" : nodePath.slice(0, i);
}

/** The edges and nodes of a scope (`""` or a loop node path with an inline body), or `null`. */
function scopeLists(def: FlowDef, scope: string): { edges: FlowEdge[]; nodes: FlowNode[] } | null {
  if (scope === "") return { edges: def.edges ?? [], nodes: def.nodes };
  const body = inlineBody(nodeAt(def, scope));
  return body ? { edges: body.edges ?? [], nodes: body.nodes } : null;
}

/** Graph path of the edge `from → to (port)` in `scope`, or `null` when absent. */
export function edgePathOf(def: FlowDef, scope: string, edge: FlowEdge): string | null {
  const index = (scopeLists(def, scope)?.edges ?? []).findIndex((e) => sameEdge(e, edge));
  if (index < 0) return null;
  return scope ? `${scope}.body.edges[${index}]` : `edges[${index}]`;
}

/** The edge at `edgePath` (`edges[i]` or `nodes[i].body.edges[j]`) and the nodes of its scope. */
export function edgeAt(def: FlowDef, edgePath: string): { edge: FlowEdge; scope: FlowNode[] } | null {
  const m = EDGE_PATH.exec(edgePath);
  if (!m) return null;
  const lists = scopeLists(def, m[1]);
  const edge = lists?.edges[Number(m[2])];
  return lists && edge ? { edge, scope: lists.nodes } : null;
}

/** Splits an edge id into the owning loop indices and the edge index. */
function parseEdgePath(edgePath: string): { loops: number[]; index: number } | null {
  const m = EDGE_PATH.exec(edgePath);
  return m ? { loops: nodeIndices(m[1]), index: Number(m[2]) } : null;
}

function normalizeEdge(edge: FlowEdge): FlowEdge {
  const out: FlowEdge = { ...edge };
  if (out.port === undefined || out.port === "success") delete out.port;
  if (out.maxTraversals === undefined) delete out.maxTraversals;
  return out;
}

export function updateEdge(def: FlowDef, edgePath: string, patch: Partial<FlowEdge>): FlowDef {
  const p = parseEdgePath(edgePath);
  if (!p) return def;
  return editScope(def, p.loops, (s) => ({
    edges: (s.edges ?? []).map((e, i) => (i === p.index ? normalizeEdge({ ...e, ...patch }) : e)),
  }));
}

export function removeEdge(def: FlowDef, edgePath: string): FlowDef {
  const p = parseEdgePath(edgePath);
  if (!p) return def;
  return editScope(def, p.loops, (s) => ({ edges: (s.edges ?? []).filter((_, i) => i !== p.index) }));
}

/** The minimal valid node per kind (without an id). */
export type NodeDefaults = FlowNode extends infer N ? (N extends FlowNode ? Omit<N, "id"> : never) : never;

export function defaultsFor(kind: FlowNodeKind): NodeDefaults {
  switch (kind) {
    case "command":
      return { kind, run: [""], shell: false, protocol: "mdium-v1" };
    case "approval":
      return { kind };
    case "branch":
      return { kind, cases: [] };
    case "loop":
      return { kind, mode: "foreach", items: "${{ params.items }}", maxIterations: 10, body: "" };
    case "subflow":
      return { kind, flow: "" };
    case "agent":
      return { kind, provider: "claude", permission: "read-only", outputContract: "outcome", prompt: "" };
    case "python":
      return { kind, runtime: "", entry: "" };
    case "action":
      return { kind, uses: KNOWN_ACTIONS[0] };
  }
}

export function updateNode(def: FlowDef, path: NodePath, patch: Partial<FlowNode>): FlowDef {
  const current = nodeAt(def, path);
  if (!current) return def;
  const at = nodeIndices(path).slice(-1)[0];
  const { id: _ignoredId, ...rest } = patch;
  let merged: Record<string, unknown>;
  if (rest.kind !== undefined && rest.kind !== current.kind) {
    merged = { id: current.id, ...defaultsFor(rest.kind) };
    if (current.name !== undefined) merged.name = current.name;
    if (current.description !== undefined) merged.description = current.description;
    Object.assign(merged, rest);
  } else {
    merged = { ...current, ...rest };
  }
  for (const key of Object.keys(merged)) if (merged[key] === undefined) delete merged[key];
  return editScope(def, ownerLoops(path), (s) => ({
    nodes: s.nodes.map((n, i) => (i === at ? (merged as unknown as FlowNode) : n)),
  }));
}

export function renameNode(def: FlowDef, path: NodePath, newId: string): FlowDef {
  const current = nodeAt(def, path);
  if (!current || current.id === newId) return def;
  // An id used anywhere in the flow would merge the two nodes' edges irreversibly.
  const used = new Set<string>();
  collectIds(def.nodes, used);
  if (used.has(newId)) return def;
  const oldId = current.id;
  const at = nodeIndices(path).slice(-1)[0];
  const topLevel = nodeIndices(path).length === 1;
  const next = editScope(def, ownerLoops(path), (s) => ({
    nodes: s.nodes.map((n, i) => (i === at ? ({ ...n, id: newId } as FlowNode) : n)),
    ...(s.edges
      ? {
          edges: s.edges.map((e) =>
            e.from === oldId || e.to === oldId
              ? { ...e, from: e.from === oldId ? newId : e.from, to: e.to === oldId ? newId : e.to }
              : e,
          ),
        }
      : {}),
  }));
  const positions = positionsOf(next);
  if (topLevel && oldId in positions) {
    const { [oldId]: moved, ...others } = positions;
    return withPositions(next, { ...others, [newId]: moved });
  }
  return next;
}

export function updateFlowAttrs(
  def: FlowDef,
  patch: Pick<Partial<FlowDef>, "name" | "description" | "params" | "defaults" | "limits" | "env" | "envPassthrough" | "outputs">,
): FlowDef {
  const next: Record<string, unknown> = { ...def, ...patch };
  for (const key of Object.keys(next)) if (next[key] === undefined) delete next[key];
  return next as unknown as FlowDef;
}

export function emptyFlow(id: string, name: string): FlowDef {
  return { schemaVersion: 1, id, name, nodes: [] };
}
