import { Document, isMap, isScalar, isSeq, parse, parseDocument, visit } from "yaml";
import type { FlowDef, FlowEdge, FlowFormat, FlowInlineBody, FlowNode } from "@/shared/types/flow";

export const CANONICAL_TOP_KEYS = [
  "schemaVersion", "id", "name", "description", "params", "defaults", "limits",
  "env", "envPassthrough", "nodes", "edges", "outputs", "ui",
] as const;
export const CANONICAL_NODE_HEAD_KEYS = ["id", "kind", "name", "description"] as const;
export const CANONICAL_NODE_TAIL_KEYS = ["timeout", "retry", "cost", "when", "concurrencyKey"] as const;
export const CANONICAL_EDGE_KEYS = ["from", "to", "port", "maxTraversals"] as const;

// Top-level keys that are dropped when empty.
const EMPTY_OMITTED = ["params", "defaults", "limits", "env", "envPassthrough", "edges", "outputs"] as const;
// Inline loop body keys that are dropped when empty.
const BODY_EMPTY_OMITTED = ["edges", "outputs"] as const;
// Maps with at most this many scalar entries are written in flow style.
const FLOW_MAP_MAX_ENTRIES = 3;

type Rec = Record<string, unknown>;

/** Copy `obj` with keys ordered head, then remaining keys (insertion order), then tail. Drops undefined. */
function ordered(obj: Rec, head: readonly string[], tail: readonly string[] = []): Rec {
  const out: Rec = {};
  const put = (k: string) => {
    if (obj[k] !== undefined) out[k] = obj[k];
  };
  head.forEach(put);
  Object.keys(obj)
    .filter((k) => !head.includes(k) && !tail.includes(k))
    .forEach(put);
  tail.forEach(put);
  return out;
}

function isEmpty(v: unknown): boolean {
  return (
    v === undefined ||
    (Array.isArray(v) && v.length === 0) ||
    (typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v).length === 0)
  );
}

function canonicalEdge(e: FlowEdge): Rec {
  return ordered(e as unknown as Rec, CANONICAL_EDGE_KEYS);
}

function canonicalBody(body: FlowInlineBody): Rec {
  const b = ordered(body as unknown as Rec, ["nodes", "edges", "outputs"]);
  for (const k of BODY_EMPTY_OMITTED) if (isEmpty(b[k])) delete b[k];
  b.nodes = body.nodes.map(canonicalNode);
  if (b.edges) b.edges = (body.edges ?? []).map(canonicalEdge);
  return b;
}

function canonicalNode(node: FlowNode): Rec {
  const n = ordered(node as unknown as Rec, CANONICAL_NODE_HEAD_KEYS, CANONICAL_NODE_TAIL_KEYS);
  if (node.kind === "loop" && typeof node.body === "object" && node.body !== null) {
    n.body = canonicalBody(node.body);
  }
  return n;
}

/** The flow as a plain object with canonical key order and empty collections dropped. */
function canonicalTop(def: FlowDef): Rec {
  const top = ordered(def as unknown as Rec, CANONICAL_TOP_KEYS);
  for (const k of EMPTY_OMITTED) if (isEmpty(top[k])) delete top[k];
  top.nodes = def.nodes.map(canonicalNode);
  if (top.edges) top.edges = (def.edges ?? []).map(canonicalEdge);
  return top;
}

/** Serialize a flow definition in the given file format (`.flow.json` files stay JSON). */
export function stringifyFlowAs(def: FlowDef, format: FlowFormat): string {
  return format === "json" ? `${JSON.stringify(canonicalTop(def), null, 2)}\n` : stringifyFlow(def);
}

/** Serialize a flow definition to canonical, stable YAML text. */
export function stringifyFlow(def: FlowDef): string {
  const doc = new Document(canonicalTop(def));
  visit(doc, {
    Scalar(_, scalar) {
      // Always double-quote strings carrying a `${{ ... }}` template.
      if (typeof scalar.value === "string" && scalar.value.includes("${{")) {
        scalar.type = "QUOTE_DOUBLE";
      }
    },
    Pair(_, pair) {
      const key = isScalar(pair.key) ? String(pair.key.value) : "";
      const value = pair.value;
      if (
        (key === "with" || key === "params") &&
        isMap(value) &&
        value.items.length <= FLOW_MAP_MAX_ENTRIES &&
        value.items.every((p) => isScalar(p.value))
      ) {
        value.flow = true;
      }
      // Edge lists (top-level and in inline loop bodies): one flow object per line.
      if (key === "edges" && isSeq(value)) {
        for (const item of value.items) if (isMap(item)) item.flow = true;
      }
    },
  });
  return doc.toString({ lineWidth: 0, indent: 2 });
}

/** Thin wrapper over yaml.parse; duplicate keys are errors. Rust remains the validator. */
export function parseFlowText(
  text: string,
): { value: unknown } | { error: { message: string; line: number; column: number } } {
  try {
    return { value: parse(text, { uniqueKeys: true }) };
  } catch (err) {
    const e = err as { message?: string; linePos?: Array<{ line: number; col: number }> };
    const pos = e.linePos?.[0];
    return {
      error: { message: e.message ?? String(err), line: pos?.line ?? 0, column: pos?.col ?? 0 },
    };
  }
}

/** True when the YAML document carries any comment. */
export function hasComments(text: string): boolean {
  if (!text.trim()) return false;
  const doc = parseDocument(text);
  if (doc.commentBefore || doc.comment) return true;
  let found = false;
  visit(doc, (_, node) => {
    const n = node as { comment?: string | null; commentBefore?: string | null };
    if (n && (n.comment || n.commentBefore)) {
      found = true;
      return visit.BREAK;
    }
    return undefined;
  });
  return found;
}
