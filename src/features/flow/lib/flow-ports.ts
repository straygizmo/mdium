import type { FlowDef, FlowNode, FlowNodeKind } from "@/shared/types/flow";

/** Node ids: lowercase letters, digits and underscores. */
const NODE_ID = /^[a-z0-9_]+$/;
/** Identifiers (param / output / variable names). */
const IDENT = /^[A-Za-z_][A-Za-z0-9_-]*$/;
/** Output port names. */
const PORT_NAME = /^[A-Za-z0-9_-]+$/;

export const isNodeId = (s: string): boolean => NODE_ID.test(s);
export const isIdent = (s: string): boolean => IDENT.test(s);
export const isPortName = (s: string): boolean => PORT_NAME.test(s);

/** Output ports of a node; mirrors `node_ports` in flow-core's validate.rs. */
export function portsOf(node: FlowNode): string[] {
  let ports: string[];
  switch (node.kind) {
    case "approval": {
      // Like Rust's `effective_options`: only a missing list falls back; `options: []` has no ports.
      const options = node.options ?? ["approve", "reject"];
      ports = options.map((o) => (typeof o === "string" ? o : o.name));
      break;
    }
    case "branch":
      ports = node.cases.map((c) => c.port);
      if (node.default !== undefined) ports.push(node.default);
      break;
    case "agent":
      ports = node.outputContract === "outcome" ? ["success", "attention"] : ["success"];
      break;
    default:
      ports = ["success"];
  }
  if (!ports.includes("failure")) ports.push("failure");
  return ports;
}

/** Adds the id of every node in `nodes`, inline loop bodies included, to `out`. */
export function collectIds(nodes: FlowNode[], out: Set<string>): void {
  for (const node of nodes) {
    out.add(node.id);
    if (node.kind === "loop" && typeof node.body !== "string") collectIds(node.body.nodes, out);
  }
}

/** A node id based on `base` (default: the kind) that is unused anywhere in the flow. */
export function nextNodeId(def: FlowDef, kind: FlowNodeKind, base?: string): string {
  const used = new Set<string>();
  collectIds(def.nodes, used);
  const root = (base ?? kind).toLowerCase().replace(/[^a-z0-9_]/g, "_") || kind;
  if (!used.has(root)) return root;
  for (let n = 2; ; n++) {
    const candidate = `${root}_${n}`;
    if (!used.has(candidate)) return candidate;
  }
}
