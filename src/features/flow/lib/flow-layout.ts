import type { ElkExtendedEdge, ElkNode } from "elkjs/lib/elk-api";
import type { FlowGraph } from "./flow-graph";

/** Size of a leaf node card. */
export const NODE_WIDTH = 220;
export const NODE_HEIGHT = 88;
/** Space above a group's children for its header. */
export const GROUP_HEADER = 44;
const GROUP_PADDING = 16;
const BACK_EDGE_ROOM = 32;

export interface NodeBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Positions relative to the parent group (React Flow's convention for `parentId`). */
export type FlowLayout = Record<string, NodeBox>;

interface ElkLike {
  layout(graph: ElkNode): Promise<ElkNode>;
}

let elkPromise: Promise<ElkLike> | null = null;

/**
 * The ELK instance. In the app, layout runs in a Web Worker (elk-api +
 * the worker script); where workers are unavailable (tests), the bundled
 * build runs on the calling thread instead.
 */
function getElk(): Promise<ElkLike> {
  if (!elkPromise) {
    elkPromise = (async () => {
      if (typeof Worker !== "undefined" && import.meta.env.MODE !== "test") {
        const [{ default: ElkApi }, { default: workerUrl }] = await Promise.all([
          import("elkjs/lib/elk-api"),
          import("elkjs/lib/elk-worker.min.js?url"),
        ]);
        return new ElkApi({ workerUrl });
      }
      const { default: ElkBundled } = await import("elkjs/lib/elk.bundled.js");
      return new ElkBundled();
    })();
  }
  return elkPromise;
}

const ROOT_OPTIONS: Record<string, string> = {
  "elk.algorithm": "layered",
  "elk.direction": "RIGHT",
  "elk.hierarchyHandling": "INCLUDE_CHILDREN",
  "elk.layered.spacing.nodeNodeBetweenLayers": "64",
  "elk.spacing.nodeNode": "32",
  "elk.spacing.edgeNode": "24",
  "elk.layered.cycleBreaking.strategy": "DEPTH_FIRST",
  "elk.edgeRouting": "SPLINES",
};

const GROUP_OPTIONS: Record<string, string> = {
  // Extra room at the bottom for back-edges, which are routed below the nodes.
  "elk.padding": `[top=${GROUP_HEADER + GROUP_PADDING},left=${GROUP_PADDING},bottom=${GROUP_PADDING + BACK_EDGE_ROOM},right=${GROUP_PADDING}]`,
};

/** Builds the ELK graph (exported for tests). */
export function toElkGraph(graph: FlowGraph): ElkNode {
  const elkNodes = new Map<string, ElkNode>();
  const root: ElkNode = { id: "__root__", layoutOptions: ROOT_OPTIONS, children: [], edges: [] };
  for (const node of graph.nodes) {
    const elkNode: ElkNode = node.isGroup
      ? { id: node.id, layoutOptions: GROUP_OPTIONS, children: [], edges: [] }
      : { id: node.id, width: NODE_WIDTH, height: NODE_HEIGHT };
    elkNodes.set(node.id, elkNode);
    const parent = node.parentId ? elkNodes.get(node.parentId) : root;
    (parent ?? root).children!.push(elkNode);
  }
  const parentOf = new Map(graph.nodes.map((n) => [n.id, n.parentId]));
  for (const edge of graph.edges) {
    const elkEdge: ElkExtendedEdge = { id: edge.id, sources: [edge.source], targets: [edge.target] };
    // Edges never leave their scope, so source and target share a container.
    const container = parentOf.get(edge.source);
    const owner = (container && elkNodes.get(container)) || root;
    owner.edges!.push(elkEdge);
  }
  return root;
}

/**
 * Lays out the graph left to right. Top-level nodes with a saved position
 * (`ui.positions` in the flow file) keep it; everything else is placed by ELK.
 */
export async function layoutFlowGraph(
  graph: FlowGraph,
  savedPositions: Record<string, { x: number; y: number }> = {},
): Promise<FlowLayout> {
  const elk = await getElk();
  const result = await elk.layout(toElkGraph(graph));
  const layout: FlowLayout = {};
  const visit = (node: ElkNode) => {
    for (const child of node.children ?? []) {
      layout[child.id] = {
        x: child.x ?? 0,
        y: child.y ?? 0,
        width: child.width ?? NODE_WIDTH,
        height: child.height ?? NODE_HEIGHT,
      };
      visit(child);
    }
  };
  visit(result);
  for (const node of graph.nodes) {
    const saved = node.parentId ? undefined : savedPositions[node.nodeId];
    if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y) && layout[node.id]) {
      layout[node.id] = { ...layout[node.id], x: saved.x, y: saved.y };
    }
  }
  return layout;
}

/** Reads `ui.positions` from a flow's opaque editor data. */
export function savedPositions(ui: unknown): Record<string, { x: number; y: number }> {
  if (typeof ui !== "object" || ui === null) return {};
  const positions = (ui as { positions?: unknown }).positions;
  if (typeof positions !== "object" || positions === null) return {};
  const out: Record<string, { x: number; y: number }> = {};
  for (const [id, value] of Object.entries(positions as Record<string, unknown>)) {
    const { x, y } = (value ?? {}) as { x?: unknown; y?: unknown };
    if (typeof x === "number" && typeof y === "number") out[id] = { x, y };
  }
  return out;
}
