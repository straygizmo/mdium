import { useMemo } from "react";
import {
  Background,
  Controls,
  MarkerType,
  ReactFlow,
  ReactFlowProvider,
  type Edge,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { FlowGraph } from "../lib/flow-graph";
import type { FlowLayout } from "../lib/flow-layout";
import {
  HANDLE_BACK_IN,
  HANDLE_BACK_OUT,
  HANDLE_IN,
  HANDLE_OUT,
  flowNodeTypes,
  type FlowRfNode,
} from "./FlowNodes";

interface FlowCanvasProps {
  graph: FlowGraph;
  layout: FlowLayout;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onToggle: (id: string) => void;
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
  selectedId: string | null,
  onToggle: (id: string) => void,
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
        data: { node, onToggle },
        selected: node.id === selectedId,
        draggable: false,
        connectable: false,
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
    ]
      .filter(Boolean)
      .join(" "),
    markerEnd: { type: MarkerType.ArrowClosed },
    focusable: false,
    // Child-to-child edges inside a group must render above the group frame.
    zIndex: 1,
  }));
  return { nodes, edges };
}

/** Read-only React Flow canvas of a flow definition. */
export function FlowCanvas({ graph, layout, selectedId, onSelect, onToggle }: FlowCanvasProps) {
  const { nodes, edges } = useMemo(
    () => toReactFlow(graph, layout, selectedId, onToggle),
    [graph, layout, selectedId, onToggle],
  );
  return (
    <ReactFlowProvider>
      <ReactFlow
        className="flow-canvas"
        nodes={nodes}
        edges={edges}
        nodeTypes={flowNodeTypes}
        nodesDraggable={false}
        nodesConnectable={false}
        edgesReconnectable={false}
        elementsSelectable
        fitView
        fitViewOptions={{ padding: 0.15 }}
        minZoom={0.1}
        proOptions={{ hideAttribution: true }}
        onNodeClick={(_, node) => onSelect(node.id)}
        onPaneClick={() => onSelect(null)}
      >
        <Background gap={16} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </ReactFlowProvider>
  );
}
