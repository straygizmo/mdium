import type { Node, Edge } from "@xyflow/react";
import type { KityMinderNode, MindmapInternalNode } from "./types";
import type { ThemeColors } from "./themes";

export type LayoutDirection = "right" | "mind" | "bottom" | "filetree";

export interface MindmapNodeData {
  label: string;
  depth: number;
  direction: "right" | "left" | "bottom";
  themeColors: ThemeColors;
  priority?: number;
  progress?: number;
  hyperlink?: string;
  hyperlinkTitle?: string;
  note?: string;
  image?: string;
  imageSize?: { width: number; height: number };
  expandState?: "expand" | "collapse";
  internalId: string;
  isRoot: boolean;
  hasChildren: boolean;
}

const V_GAP = 16;
const H_GAP = 48;
const FILETREE_INDENT = 30;
const FILETREE_ROW = 34;

function estimateNodeWidth(text: string, depth: number): number {
  const fontSize = depth === 0 ? 16 : depth === 1 ? 14 : 13;
  const padding = depth === 0 ? 48 : depth === 1 ? 32 : 24;
  const charWidth = fontSize * 0.55;
  // Wider chars for CJK
  const cjkCount = (text.match(/[\u3000-\u9fff\uf900-\ufaff]/g) || []).length;
  const asciiCount = text.length - cjkCount;
  return Math.max(80, asciiCount * charWidth + cjkCount * fontSize + padding);
}

function estimateNodeHeight(depth: number, _text: string, imageSize?: { width: number; height: number }): number {
  const base = depth === 0 ? 44 : depth === 1 ? 36 : 30;
  if (!imageSize) return base;
  // imageSize stores the actual display dimensions (explicit width/height on img element)
  return base + (imageSize.height || 200) + 8;
}

function visibleChildren(node: MindmapInternalNode): MindmapInternalNode[] {
  if (node.data.expandState === "collapse") return [];
  return node.children;
}

function makeNodeData(
  node: MindmapInternalNode,
  depth: number,
  direction: "right" | "left" | "bottom",
  themeColors: ThemeColors,
): MindmapNodeData {
  return {
    label: node.data.text,
    depth,
    direction,
    themeColors,
    priority: node.data.priority,
    progress: node.data.progress,
    hyperlink: node.data.hyperlink,
    hyperlinkTitle: node.data.hyperlinkTitle,
    note: node.data.note,
    image: node.data.image,
    imageSize: node.data.imageSize,
    expandState: node.data.expandState,
    internalId: node.id,
    isRoot: depth === 0,
    hasChildren: node.children.length > 0,
  };
}

// --- Compact tree layout: fixed gap between nodes, variable node heights ---

function subtreeSpan(node: MindmapInternalNode, depth: number, cache: Map<string, number>): number {
  const cached = cache.get(node.id);
  if (cached !== undefined) return cached;

  const nodeH = estimateNodeHeight(depth, node.data.text, node.data.imageSize);
  const children = visibleChildren(node);
  if (children.length === 0) {
    cache.set(node.id, nodeH);
    return nodeH;
  }

  let childrenSpan = 0;
  for (let i = 0; i < children.length; i++) {
    if (i > 0) childrenSpan += V_GAP;
    childrenSpan += subtreeSpan(children[i], depth + 1, cache);
  }

  const span = Math.max(nodeH, childrenSpan);
  cache.set(node.id, span);
  return span;
}

interface PlacedNode {
  node: MindmapInternalNode;
  depth: number;
  cx: number; // center x (depth direction)
  cy: number; // center y (spread direction)
  w: number;
  h: number;
}

function placeSubtree(
  node: MindmapInternalNode,
  depth: number,
  top: number,
  cache: Map<string, number>,
  result: PlacedNode[],
) {
  const nodeH = estimateNodeHeight(depth, node.data.text, node.data.imageSize);
  const w = estimateNodeWidth(node.data.text, depth);
  const span = subtreeSpan(node, depth, cache);
  const cy = top + span / 2;

  result.push({ node, depth, cx: 0, cy, w, h: nodeH });

  const children = visibleChildren(node);
  if (children.length === 0) return;

  let childrenSpan = 0;
  for (let i = 0; i < children.length; i++) {
    if (i > 0) childrenSpan += V_GAP;
    childrenSpan += subtreeSpan(children[i], depth + 1, cache);
  }

  let childTop = top + (span - childrenSpan) / 2;
  for (const child of children) {
    const childSpan = subtreeSpan(child, depth + 1, cache);
    placeSubtree(child, depth + 1, childTop, cache, result);
    childTop += childSpan + V_GAP;
  }
}

function layoutTree(
  root: MindmapInternalNode,
  direction: "right" | "left" | "bottom",
  themeColors: ThemeColors,
  xOffset = 0,
  yOffset = 0,
): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = [];
  const edges: Edge[] = [];

  const cache = new Map<string, number>();
  const placed: PlacedNode[] = [];
  placeSubtree(root, 0, 0, cache, placed);

  // --- Compute dynamic depth offsets based on actual node sizes ---
  let maxDepth = 0;
  const maxWidthPerDepth = new Map<number, number>();
  const maxHeightPerDepth = new Map<number, number>();
  for (const p of placed) {
    if (p.depth > maxDepth) maxDepth = p.depth;
    maxWidthPerDepth.set(p.depth, Math.max(maxWidthPerDepth.get(p.depth) || 0, p.w));
    maxHeightPerDepth.set(p.depth, Math.max(maxHeightPerDepth.get(p.depth) || 0, p.h));
  }

  // Left-edge x per depth (for right/left layouts)
  const depthX = new Map<number, number>();
  {
    let cum = 0;
    for (let d = 0; d <= maxDepth; d++) {
      depthX.set(d, cum);
      cum += (maxWidthPerDepth.get(d) || 0) + H_GAP;
    }
  }

  // Top-edge y per depth (for bottom layout)
  const depthY = new Map<number, number>();
  {
    let cum = 0;
    for (let d = 0; d <= maxDepth; d++) {
      depthY.set(d, cum);
      cum += (maxHeightPerDepth.get(d) || 0) + H_GAP;
    }
  }

  // Build parent map
  const parentMap = new Map<string, string>();
  for (const p of placed) {
    for (const child of visibleChildren(p.node)) {
      parentMap.set(child.id, p.node.id);
    }
  }

  // Center the spread axis around 0
  const totalSpan = subtreeSpan(root, 0, cache);
  const spreadShift = -totalSpan / 2;

  for (const p of placed) {
    let x: number, y: number;
    const dx = depthX.get(p.depth) || 0;
    const dy = depthY.get(p.depth) || 0;

    if (direction === "right") {
      x = dx + xOffset;
      y = p.cy + spreadShift + yOffset - p.h / 2;
    } else if (direction === "left") {
      x = -(dx + p.w) + xOffset;
      y = p.cy + spreadShift + yOffset - p.h / 2;
    } else {
      // bottom: depth → y, spread → x
      x = p.cy + spreadShift + xOffset - p.w / 2;
      y = dy + yOffset;
    }

    nodes.push({
      id: p.node.id,
      type: "mindmap",
      position: { x, y },
      data: makeNodeData(p.node, p.depth, direction, themeColors) as unknown as Record<string, unknown>,
    });

    const parentId = parentMap.get(p.node.id);
    if (parentId) {
      const sourceHandle =
        direction === "bottom" ? "source-bottom" : direction === "left" ? "source-left" : "source-right";
      const targetHandle =
        direction === "bottom" ? "target-top" : direction === "left" ? "target-right" : "target-left";

      edges.push({
        id: `e-${parentId}-${p.node.id}`,
        source: parentId,
        target: p.node.id,
        sourceHandle,
        targetHandle,
        type: "mindmap",
        data: { color: themeColors.connection, depth: p.depth } as unknown as Record<string, unknown>,
      });
    }
  }

  return { nodes, edges };
}

function layoutMind(
  root: MindmapInternalNode,
  themeColors: ThemeColors,
): { nodes: Node[]; edges: Edge[] } {
  const allNodes: Node[] = [];
  const allEdges: Edge[] = [];

  const children = visibleChildren(root);
  const rightChildren = children.filter((_, i) => i % 2 === 0);
  const leftChildren = children.filter((_, i) => i % 2 === 1);

  // Root node
  const rw = estimateNodeWidth(root.data.text, 0);
  const rh = estimateNodeHeight(0, root.data.text, root.data.imageSize);
  allNodes.push({
    id: root.id,
    type: "mindmap",
    position: { x: -rw / 2, y: -rh / 2 },
    data: makeNodeData(root, 0, "right", themeColors) as unknown as Record<string, unknown>,
  });

  // Layout right subtrees — children start H_GAP after root's right edge
  if (rightChildren.length > 0) {
    const rightRoot: MindmapInternalNode = { id: root.id + "-r", data: root.data, children: rightChildren };
    const right = layoutTree(rightRoot, "right", themeColors, -rw / 2, 0);
    // Skip the duplicate root node, keep edges from root to right children
    for (const n of right.nodes) {
      if (n.id !== rightRoot.id) allNodes.push(n);
    }
    for (const e of right.edges) {
      // Remap edges from virtual root to actual root
      if (e.source === rightRoot.id) {
        allEdges.push({ ...e, source: root.id, sourceHandle: "source-right" });
      } else {
        allEdges.push(e);
      }
    }
  }

  // Layout left subtrees — children end H_GAP before root's left edge
  if (leftChildren.length > 0) {
    const leftRoot: MindmapInternalNode = { id: root.id + "-l", data: root.data, children: leftChildren };
    const left = layoutTree(leftRoot, "left", themeColors, rw / 2, 0);
    for (const n of left.nodes) {
      if (n.id !== leftRoot.id) allNodes.push(n);
    }
    for (const e of left.edges) {
      if (e.source === leftRoot.id) {
        allEdges.push({ ...e, source: root.id, sourceHandle: "source-left" });
      } else {
        allEdges.push(e);
      }
    }
  }

  return { nodes: allNodes, edges: allEdges };
}

function layoutFiletree(
  root: MindmapInternalNode,
  themeColors: ThemeColors,
): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  let row = 0;

  function visit(node: MindmapInternalNode, depth: number) {
    const x = depth * FILETREE_INDENT;
    const y = row * FILETREE_ROW;
    row++;

    nodes.push({
      id: node.id,
      type: "mindmap",
      position: { x, y },
      data: makeNodeData(node, depth, "right", themeColors) as unknown as Record<string, unknown>,
    });

    for (const child of visibleChildren(node)) {
      edges.push({
        id: `e-${node.id}-${child.id}`,
        source: node.id,
        target: child.id,
        sourceHandle: "source-bottom",
        targetHandle: "target-left",
        type: "mindmap",
        data: { color: themeColors.connection, depth: depth + 1 } as unknown as Record<string, unknown>,
      });
      visit(child, depth + 1);
    }
  }

  visit(root, 0);
  return { nodes, edges };
}

export function computeLayout(
  root: MindmapInternalNode,
  direction: LayoutDirection,
  themeColors: ThemeColors,
): { nodes: Node[]; edges: Edge[] } {
  if (direction === "mind") return layoutMind(root, themeColors);
  if (direction === "filetree") return layoutFiletree(root, themeColors);
  return layoutTree(root, direction === "bottom" ? "bottom" : "right", themeColors);
}

// --- Tree manipulation utilities ---

export function assignIds(node: KityMinderNode): MindmapInternalNode {
  return {
    id: crypto.randomUUID(),
    data: { ...node.data },
    children: (node.children || []).map((c) => assignIds(c)),
  };
}

export function cloneTree(node: MindmapInternalNode): MindmapInternalNode {
  return {
    id: node.id,
    data: { ...node.data, imageSize: node.data.imageSize ? { ...node.data.imageSize } : undefined },
    children: node.children.map(cloneTree),
  };
}

export function findNode(tree: MindmapInternalNode, id: string): MindmapInternalNode | null {
  if (tree.id === id) return tree;
  for (const child of tree.children) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return null;
}

export function findParent(
  tree: MindmapInternalNode,
  id: string,
): { parent: MindmapInternalNode; index: number } | null {
  for (let i = 0; i < tree.children.length; i++) {
    if (tree.children[i].id === id) return { parent: tree, index: i };
    const found = findParent(tree.children[i], id);
    if (found) return found;
  }
  return null;
}

export function stripIds(node: MindmapInternalNode): KityMinderNode {
  return {
    data: { ...node.data },
    children: node.children.map(stripIds),
  };
}
