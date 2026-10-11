import { useCallback, useMemo, useRef, type KeyboardEvent, type PointerEvent } from "react";
import {
  Background,
  Controls,
  MarkerType,
  ReactFlow,
  ReactFlowProvider,
  type Edge,
  type EdgeMouseHandler,
  type IsValidConnection,
  type OnNodeDrag,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { FlowGraph } from "../lib/flow-graph";
import type { FlowLayout } from "../lib/flow-layout";
import type { Selection } from "../editor-store";
import {
  HANDLE_BACK_IN,
  HANDLE_BACK_OUT,
  HANDLE_IN,
  HANDLE_OUT,
  flowNodeTypes,
  type FlowRfNode,
} from "./FlowNodes";

/** A new edge drawn on the canvas; `anchor` is the drop point relative to the canvas wrapper. */
export interface ConnectRequest {
  sourcePath: string;
  targetPath: string;
  anchor?: { x: number; y: number };
}

interface FlowCanvasProps {
  graph: FlowGraph;
  layout: FlowLayout;
  selection: Selection;
  editable: boolean;
  onSelect: (selection: Selection) => void;
  onToggle: (id: string) => void;
  onMoveNode: (nodeId: string, position: { x: number; y: number }) => void;
  onConnect: (req: ConnectRequest) => void;
  onDeleteSelection: () => void;
}

/** Builds the edge click handler: selects the edge by its graph path. */
export function handleEdgeClick(onSelect: (selection: Selection) => void): EdgeMouseHandler {
  return (_event, edge) => onSelect({ kind: "edge", path: edge.id });
}

/** Builds the React Flow drag-stop handler: reports the flow node id (not the path) and its position. */
export function handleNodeDragStop(
  onMoveNode: (nodeId: string, position: { x: number; y: number }) => void,
): OnNodeDrag<FlowRfNode> {
  return (_event, node) => {
    onMoveNode(node.data.node.nodeId, { x: node.position.x, y: node.position.y });
  };
}

/** Edge label: the port unless it is `success`, plus the bound of a back-edge. */
export function edgeLabel(port: string, maxTraversals?: number): string {
  const parts: string[] = [];
  if (port !== "success") parts.push(port);
  if (maxTraversals !== undefined) parts.push(`↺ ≤${maxTraversals}`);
  return parts.join(" ");
}

/** Converts the graph + layout into React Flow nodes and edges. */
export function toReactFlow(
  graph: FlowGraph,
  layout: FlowLayout,
  selection: Selection,
  onToggle: (id: string) => void,
  editable = false,
): { nodes: FlowRfNode[]; edges: Edge[] } {
  const nodes: FlowRfNode[] = graph.nodes
    .filter((node) => layout[node.id])
    .map((node) => {
      const box = layout[node.id];
      return {
        id: node.id,
        type: node.isGroup ? "flowGroup" : "flowNode",
        position: { x: box.x, y: box.y },
        parentId: node.parentId,
        extent: node.parentId ? ("parent" as const) : undefined,
        data: { node, onToggle, editable },
        selected: selection?.kind === "node" && node.id === selection.path,
        // Children of a loop group stay inside it; only top-level nodes move.
        draggable: editable && !node.parentId,
        connectable: editable,
        style: { width: box.width, height: box.height },
      };
    });
  const edges: Edge[] = graph.edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    // Back-edges leave and re-enter through the bottom, routed below the nodes.
    sourceHandle: edge.isBack ? HANDLE_BACK_OUT : HANDLE_OUT,
    targetHandle: edge.isBack ? HANDLE_BACK_IN : HANDLE_IN,
    type: edge.isBack ? "smoothstep" : "default",
    label: edgeLabel(edge.port, edge.maxTraversals) || undefined,
    className: [
      "flow-edge",
      edge.isFailure ? "flow-edge--failure" : "",
      edge.isBack ? "flow-edge--back" : "",
      selection?.kind === "edge" && edge.id === selection.path ? "flow-edge--selected" : "",
    ]
      .filter(Boolean)
      .join(" "),
    markerEnd: { type: MarkerType.ArrowClosed },
    focusable: false,
    selected: selection?.kind === "edge" && edge.id === selection.path,
    // Child-to-child edges inside a group must render above the group frame.
    zIndex: 1,
  }));
  return { nodes, edges };
}

/** React Flow canvas of a flow definition; read-only unless `editable`. */
export function FlowCanvas({
  graph,
  layout,
  selection,
  editable,
  onSelect,
  onToggle,
  onMoveNode,
  onConnect,
  onDeleteSelection,
}: FlowCanvasProps) {
  const { nodes, edges } = useMemo(
    () => toReactFlow(graph, layout, selection, onToggle, editable),
    [graph, layout, selection, onToggle, editable],
  );
  const parentOf = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n.parentId])), [graph]);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const pointer = useRef<{ x: number; y: number } | undefined>(undefined);
  const edgeClick = useMemo(() => handleEdgeClick(onSelect), [onSelect]);
  const dragStop = useMemo(() => handleNodeDragStop(onMoveNode), [onMoveNode]);

  // Connections never cross loop scopes: both ends need the same parent.
  const isValidConnection = useCallback<IsValidConnection>(
    (connection) => parentOf.get(connection.source) === parentOf.get(connection.target),
    [parentOf],
  );

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const rect = wrapperRef.current?.getBoundingClientRect();
    if (rect) pointer.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!editable || !selection || (e.key !== "Delete" && e.key !== "Backspace")) return;
    const target = e.target as HTMLElement;
    if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;
    e.preventDefault();
    onDeleteSelection();
  };

  return (
    <div
      ref={wrapperRef}
      className="flow-canvas-wrapper"
      tabIndex={0}
      onKeyDown={onKeyDown}
      onPointerMove={editable ? onPointerMove : undefined}
    >
      <ReactFlowProvider>
        <ReactFlow
          className={editable ? "flow-canvas flow-canvas--editable" : "flow-canvas"}
          nodes={nodes}
          edges={edges}
          nodeTypes={flowNodeTypes}
          nodesDraggable={editable}
          nodesConnectable={editable}
          edgesReconnectable={false}
          elementsSelectable
          deleteKeyCode={null}
          isValidConnection={isValidConnection}
          fitView
          fitViewOptions={{ padding: 0.15 }}
          minZoom={0.1}
          proOptions={{ hideAttribution: true }}
          onNodeClick={(_, node) => onSelect({ kind: "node", path: node.id })}
          onEdgeClick={editable ? edgeClick : undefined}
          onNodeDragStop={editable ? dragStop : undefined}
          onConnect={(c) => onConnect({ sourcePath: c.source, targetPath: c.target, anchor: pointer.current })}
          onPaneClick={() => onSelect(null)}
        >
          <Background gap={16} />
          <Controls showInteractive={false} />
        </ReactFlow>
      </ReactFlowProvider>
    </div>
  );
}
