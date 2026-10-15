import { Document, isMap, isScalar, isSeq, parse, parseDocument, visit } from "yaml";
import type { Node, Pair, Scalar, YAMLMap, YAMLSeq } from "yaml";
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
// Node-level typed collections the Rust model drops when empty (`skip_serializing_if`).
const NODE_EMPTY_OMITTED = ["with", "params", "env", "show"] as const;
// Maps with at most this many scalar entries are written in flow style.
const FLOW_MAP_MAX_ENTRIES = 3;

type Rec = Record<string, unknown>;

/** Where a map sits in a flow, for the serde defaults below. */
type Role = "top" | "paramDefs" | "paramDef" | "nodes" | "node" | "body" | "other";

function childRole(role: Role, key: string): Role {
  if (role === "top") return key === "params" ? "paramDefs" : key === "nodes" ? "nodes" : "other";
  if (role === "paramDefs") return "paramDef";
  if (role === "node") return key === "body" ? "body" : "other";
  if (role === "body") return key === "nodes" ? "nodes" : "other";
  return "other";
}

/**
 * Values the Rust model (flow-core `model.rs`, `#[serde(default)]` without
 * `skip_serializing_if`) always serializes. A flow loaded through Rust carries them even when
 * the file leaves them out, so they are not written into a map that lacks them.
 */
/**
 * Whether the Rust model drops `key` of a map in `role` when it is empty, so an empty one in the
 * text is not a value the definition removed. Empty `[]` / `{}` inside `Value` content (a param
 * `default`, argument values, `items`) are serialized by Rust and are not covered.
 */
function omitsEmpty(role: Role, key: string): boolean {
  const keys: readonly string[] =
    role === "top" ? EMPTY_OMITTED : role === "node" ? NODE_EMPTY_OMITTED : role === "body" ? BODY_EMPTY_OMITTED : [];
  return keys.includes(key);
}

function serdeDefaults(role: Role, obj: Rec): Rec | undefined {
  if (role === "paramDef") return { required: false };
  if (role === "node" && obj.kind === "command") return { shell: false, protocol: "mdium-v1" };
  if (role === "node" && obj.kind === "agent") return { outputContract: "outcome" };
  return undefined;
}

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
  if (doc.contents) applyFlowStyle(doc.contents as Node);
  return doc.toString({ lineWidth: 0, indent: 2 });
}

/** Double-quote single-line strings carrying a `${{ ... }}` template. */
function styleScalar(scalar: Scalar): void {
  // Multi-line ones (agent prompts) keep their block scalar so they stay readable in diffs.
  if (typeof scalar.value === "string" && scalar.value.includes("${{") && !scalar.value.includes("\n")) {
    scalar.type = "QUOTE_DOUBLE";
  }
}

/** Flow style for small scalar-only `with` / `params` maps and for `edges` items. */
function stylePair(pair: Pair): void {
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
}

/** Apply the canonical writing style to `node` and everything below it. */
function applyFlowStyle(node: Node): void {
  if (isScalar(node)) {
    styleScalar(node);
    return;
  }
  visit(node, {
    Scalar(_, scalar) {
      styleScalar(scalar);
    },
    Pair(_, pair) {
      stylePair(pair as Pair);
    },
  });
}

/**
 * Update the YAML `text` in place to represent `def`: existing nodes keep their comments, key
 * order and scalar styles, new keys are appended to their map, items with an `id` are matched by
 * id and reordered to `def`'s order, and removed keys and items are deleted. Serde defaults the
 * text leaves out are not added, and empty collections the text has are kept. Output lines that
 * differ from a source line only in spacing get the source line back. Text that does not parse
 * as a mapping falls back to `stringifyFlow(def)`.
 */
export function mergeFlowIntoText(text: string, def: FlowDef): string {
  const doc = parseDocument(text, { uniqueKeys: true });
  if (doc.errors.length > 0 || !isMap(doc.contents)) return stringifyFlow(def);
  const folded = foldedScalars(doc, text);
  mergeMap(doc, doc.contents, canonicalTop(def), "top");
  const out = doc.toString(STRINGIFY);
  return restoreSourceLines(text, restoreFoldedScalars(doc, folded, out));
}

const STRINGIFY = { lineWidth: 0, indent: 2 } as const;

/** A folded block scalar (`>`) of the source: the node, its value and its source text. */
interface FoldedScalar {
  scalar: Scalar;
  value: string;
  /** The block from its `>` indicator to the end of its last line, as written. */
  block: string;
  /** Indentation of the line the indicator sits on. */
  indent: number;
}

function foldedScalars(doc: Document, text: string): FoldedScalar[] {
  const found: FoldedScalar[] = [];
  visit(doc, {
    Scalar(_, scalar) {
      if (scalar.type !== "BLOCK_FOLDED" || typeof scalar.value !== "string" || !scalar.range) return;
      const [start, end] = scalar.range;
      const lineStart = text.lastIndexOf("\n", start - 1) + 1;
      const indent = /^[ \t]*/.exec(text.slice(lineStart, start))?.[0].length ?? 0;
      found.push({ scalar, value: scalar.value, block: text.slice(start, end).replace(/\s+$/, ""), indent });
    },
  });
  return found;
}

const FOLDED_MARK = "__mdium_folded_";

/**
 * With `lineWidth: 0` the stringifier writes a folded block scalar on one line, losing the
 * line breaks the author chose. Each folded scalar whose value the merge left unchanged and
 * that is still in the document gets its source block back (re-indented to where it now sits).
 * The result is kept only if it parses to the same data as `out`.
 */
function restoreFoldedScalars(doc: Document, folded: FoldedScalar[], out: string): string {
  const present = new Set<Scalar>();
  visit(doc, {
    Scalar(_, scalar) {
      present.add(scalar);
    },
  });
  const kept = folded.filter((f) => present.has(f.scalar) && f.scalar.value === f.value);
  if (kept.length === 0) return out;
  kept.forEach((f, i) => {
    f.scalar.type = "PLAIN";
    f.scalar.value = `${FOLDED_MARK}${i}__`;
  });
  const marked = doc.toString(STRINGIFY);
  kept.forEach((f) => {
    f.scalar.type = "BLOCK_FOLDED";
    f.scalar.value = f.value;
  });
  const restored = marked
    .split("\n")
    .map((line) => {
      const m = new RegExp(`^([ ]*)(.*?)${FOLDED_MARK}(\\d+)__$`).exec(line);
      if (!m) return line;
      const f = kept[Number(m[3])];
      const [head, ...body] = f.block.split("\n");
      const shift = m[1].length - f.indent;
      const moved = body.map((l) => (shift >= 0 ? " ".repeat(shift) + l : l.slice(Math.min(-shift, /^[ ]*/.exec(l)?.[0].length ?? 0))));
      return [m[1] + m[2] + head, ...moved].join("\n");
    })
    .join("\n");
  try {
    return JSON.stringify(parse(restored)) === JSON.stringify(parse(out)) ? restored : out;
  } catch {
    return out;
  }
}

function keyOf(pair: Pair): string {
  return isScalar(pair.key) ? String(pair.key.value) : String(pair.key);
}

function created(doc: Document, value: unknown): Node {
  const node = doc.createNode(value) as Node;
  applyFlowStyle(node);
  return node;
}

/** `next` takes the place of `prev`: it inherits the comments, spacing and flow style around it. */
function replaced(prev: Node | null, next: Node): Node {
  if (!prev) return next;
  next.commentBefore = prev.commentBefore;
  next.comment = prev.comment;
  next.spaceBefore = prev.spaceBefore;
  if (isCollection(prev) && isCollection(next) && prev.flow && !isEmptyFlow(prev)) next.flow = true;
  return next;
}

function isCollection(node: unknown): node is YAMLMap | YAMLSeq {
  return isMap(node) || isSeq(node);
}

/** `[]` / `{}`: written in flow style only because it is empty, not by choice. */
function isEmptyFlow(node: unknown): boolean {
  return isCollection(node) && node.flow === true && node.items.length === 0;
}

function mergeMap(doc: Document, map: YAMLMap, obj: Rec, role: Role): void {
  for (const pair of [...map.items]) {
    const k = keyOf(pair as Pair);
    if (!Object.prototype.hasOwnProperty.call(obj, k) || obj[k] === undefined) {
      // Rust drops empty typed collections (`params: {}`); the text's own empty one stays.
      const keptEmpty = omitsEmpty(role, k) && isCollection(pair.value) && pair.value.items.length === 0;
      if (!keptEmpty) map.delete(pair.key);
    } else {
      const wasEmptyFlow = isEmptyFlow(pair.value);
      pair.value = mergeValue(doc, pair.value as Node | null, obj[k], k, childRole(role, k));
      // A collection that just gained items takes the canonical style instead of `[ ... ]`.
      if (wasEmptyFlow && isCollection(pair.value) && pair.value.items.length > 0) {
        pair.value.flow = false;
        stylePair(pair as Pair);
      }
    }
  }
  const defaults = serdeDefaults(role, obj);
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || map.has(k)) continue;
    if (defaults && k in defaults && stableKey(defaults[k]) === stableKey(v)) continue;
    const pair = doc.createPair(k, created(doc, v)) as Pair;
    stylePair(pair);
    map.items.push(pair as never);
  }
}

function mergeValue(doc: Document, existing: Node | null, value: unknown, key: string, role: Role): Node {
  if (isPlainObject(value) && isMap(existing)) {
    mergeMap(doc, existing, value, role);
    return existing;
  }
  if (Array.isArray(value) && isSeq(existing)) {
    if (value.length > 0 && value.every((v) => isPlainObject(v) && typeof v.id === "string")) {
      const byId = new Map<string, Node>();
      for (const item of existing.items) {
        if (isMap(item) && !byId.has(String(item.get("id")))) byId.set(String(item.get("id")), item as Node);
      }
      const items = value.map((v) => {
        const id = String((v as Rec).id);
        const prev = byId.get(id);
        byId.delete(id);
        return prev ? mergeValue(doc, prev, v, key, role === "nodes" ? "node" : "other") : created(doc, v);
      });
      setItems(existing, items);
      return existing;
    }
    // Items without an id (edges, options, scalars) are matched by value, ignoring key order:
    // an unchanged item keeps its node (comments, style); only new values are created.
    const json = existing.toJSON() as unknown[];
    const pool = existing.items.map((node, i) => ({ node: node as Node, key: stableKey(json[i]) }));
    const items = value.map((v) => {
      const i = pool.findIndex((p) => p.key === stableKey(v));
      if (i >= 0) return pool.splice(i, 1)[0].node;
      const node = created(doc, v);
      if (key === "edges" && isMap(node)) node.flow = true;
      return node;
    });
    setItems(existing, items);
    return existing;
  }
  if (
    isScalar(existing) &&
    (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null)
  ) {
    if (existing.value === value) return existing;
    existing.value = value;
    styleScalar(existing);
    return existing;
  }
  const node = replaced(existing, created(doc, value));
  if (key === "edges" && isSeq(node)) for (const item of node.items) if (isMap(item)) item.flow = true;
  return node;
}

/** Replace `seq`'s items; a comment above the whole list stays with the item that was first. */
function setItems(seq: YAMLSeq, items: Node[]): void {
  const first = seq.items[0] as Node | undefined;
  if (seq.commentBefore && first && items[0] !== first && items.includes(first)) {
    first.commentBefore = first.commentBefore ? `${seq.commentBefore}\n${first.commentBefore}` : seq.commentBefore;
    seq.commentBefore = undefined;
  }
  seq.items = items;
}

/** JSON of `v` with object keys sorted, so values compare regardless of key order. */
function stableKey(v: unknown): string {
  return JSON.stringify(v, (_, x: unknown) =>
    isPlainObject(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x,
  );
}

function isPlainObject(v: unknown): v is Rec {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * A line with its spacing normalised after the indentation: runs of blanks collapse to one, and
 * the blanks inside flow brackets and around commas go, so `[ a, b ]` and `[a,b]` compare equal
 * and so do trailing comments with different gaps before `#`.
 */
function normalisedLine(line: string): string {
  const indent = /^[ \t]*/.exec(line)?.[0] ?? "";
  const rest = line
    .slice(indent.length)
    .replace(/[ \t]+/g, " ")
    .replace(/([[{]) /g, "$1")
    .replace(/ ([\]}])/g, "$1")
    .replace(/ ?, ?/g, ",")
    .trimEnd();
  return indent + rest;
}

/**
 * The yaml stringifier re-spaces lines (padding inside `[ ]` / `{ }`, one space before a trailing
 * comment): each output line whose normalised form equals a source line's gets that source line
 * back (first unused match). The result is kept only if it parses to the same data.
 */
function restoreSourceLines(source: string, out: string): string {
  const index = new Map<string, string[]>();
  for (const raw of source.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const key = normalisedLine(line);
    const lines = index.get(key);
    if (lines) lines.push(line);
    else index.set(key, [line]);
  }
  const restored = out
    .split("\n")
    .map((line) => index.get(normalisedLine(line))?.shift() ?? line)
    .join("\n");
  if (restored === out) return out;
  try {
    return JSON.stringify(parse(restored)) === JSON.stringify(parse(out)) ? restored : out;
  } catch {
    return out;
  }
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
