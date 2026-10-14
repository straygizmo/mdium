import { mapScope, nodeAt, parentList, scopeOf } from "./editor-state";
import { collectIds } from "./flow-ports";
import { resolvePartPath } from "./flow-graph";
import { relativeRef } from "./part-ref";
import type {
  FlowDef,
  FlowEdge,
  FlowInlineBody,
  FlowNode,
  FlowParamDef,
  FlowParamType,
  FlowSubflowNode,
} from "@/shared/types/flow";

export type ExtractFailure =
  | "empty"
  | "mixed-scopes"
  | "multiple-entries"
  | "multiple-exits"
  | "unsupported-exit"
  | "invalid-name";

export interface ExtractResult {
  /** The new part file: id = name, inferred params / outputs, the selected nodes (ids kept) and their inner edges. */
  part: FlowDef;
  /** The caller with the selection replaced by one `subflow` node. */
  updated: FlowDef;
  signature: { params: string[]; outputs: string[] };
  /** Graph path of the new `subflow` node in `updated`. */
  newNodePath: string;
}

export type ExtractOutcome = ({ ok: true } & ExtractResult) | { ok: false; reason: ExtractFailure; detail?: string };

/** Same grammar as `template.rs`: `${{ a.b.c }}`. */
const TEMPLATE_REF = /\$\{\{\s*([A-Za-z_][\w-]*(?:\.[A-Za-z_][\w-]*)*)\s*\}\}/g;
/** Flow ids: lowercase letters, digits and hyphens. */
const FLOW_ID = /^[a-z0-9-]+$/;
/** Where extracted parts are written (project-relative). */
const LIB_DIR = ".mdium/flows/lib";

type Position = { x: number; y: number };
type RefMapper = (ref: string) => string;

// ---------------------------------------------------------------------------
// Reference walking
// ---------------------------------------------------------------------------

const template = (ref: string): string => "${{ " + ref + " }}";

/** A condition leaf `{ ref, op }`: its `ref` holds plain reference text (no `${{ }}`). */
function isConditionLeaf(obj: Record<string, unknown>): boolean {
  return typeof obj.ref === "string" && typeof obj.op === "string";
}

/** An approval node: its `show` entries hold plain reference text (no `${{ }}`). */
function isApproval(obj: Record<string, unknown>): boolean {
  return obj.kind === "approval" && Array.isArray(obj.show);
}

/** Maps one plain reference text, keeping the original text (and its spacing) when unchanged. */
function mapPlainRef(text: unknown, fn: RefMapper): unknown {
  if (typeof text !== "string") return text;
  const ref = text.trim();
  const next = fn(ref);
  return next === ref ? text : next;
}

/**
 * Returns a copy of `value` with every reference passed through `fn`: the references
 * of `${{ }}` templates inside strings, the `ref` of condition leaves and the `show`
 * entries of approval nodes.
 */
function mapValueRefs(value: unknown, fn: RefMapper): unknown {
  if (typeof value === "string") {
    return value.replace(TEMPLATE_REF, (whole, ref: string) => {
      const next = fn(ref);
      return next === ref ? whole : template(next);
    });
  }
  if (Array.isArray(value)) return value.map((v) => mapValueRefs(v, fn));
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const leaf = isConditionLeaf(obj);
    const approval = isApproval(obj);
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(obj)) {
      if (leaf && key === "ref") {
        out[key] = mapPlainRef(v, fn);
      } else if (approval && key === "show") {
        out[key] = (v as unknown[]).map((entry) => mapPlainRef(entry, fn));
      } else {
        out[key] = mapValueRefs(v, fn);
      }
    }
    return out;
  }
  return value;
}

/** Every reference text inside a JSON value (templates in strings, condition `ref` fields, approval `show`), unique, in order. */
export function collectReferences(value: unknown): string[] {
  const seen = new Set<string>();
  mapValueRefs(value, (ref) => {
    seen.add(ref);
    return ref;
  });
  return [...seen];
}

/** What a reference can see at its place: the bound loop variables and whether `iteration` is bound. */
interface RefContext {
  vars: string[];
  iteration: boolean;
}

type ContextMapper = (ref: string, ctx: RefContext) => string;

/**
 * Maps the references of a node, tracking the loop variables an inner loop binds
 * (same scoping as the validator: a loop's `params` and body see its variable, `until` sees `iteration`).
 */
function mapNodeRefs(node: FlowNode, ctx: RefContext, fn: ContextMapper): FlowNode {
  const plain = (v: unknown, c: RefContext) => mapValueRefs(v, (ref) => fn(ref, c));
  if (node.kind !== "loop") return plain(node, ctx) as FlowNode;
  const inner: RefContext = { ...ctx, vars: [...ctx.vars, node.as ?? "item"] };
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(node)) {
    if (key === "until") out[key] = plain(v, { ...ctx, iteration: true });
    else if (key === "params") out[key] = plain(v, inner);
    else if (key === "body" && typeof v !== "string") out[key] = mapBodyRefs(v as FlowInlineBody, inner, fn);
    else out[key] = plain(v, ctx);
  }
  return out as unknown as FlowNode;
}

function mapBodyRefs(body: FlowInlineBody, ctx: RefContext, fn: ContextMapper): FlowInlineBody {
  const out: FlowInlineBody = { ...body, nodes: body.nodes.map((n) => mapNodeRefs(n, ctx, fn)) };
  if (body.outputs) out.outputs = mapValueRefs(body.outputs, (ref) => fn(ref, ctx)) as Record<string, string>;
  return out;
}

// ---------------------------------------------------------------------------
// File references
// ---------------------------------------------------------------------------

/** A file reference that is relative to the flow file holding it (not `builtin:`, `mdium:`, `project:`, absolute or templated). */
function isRelativeFileRef(ref: string): boolean {
  return (
    ref.trim() !== "" &&
    !ref.startsWith("builtin:") &&
    !ref.startsWith("mdium:") &&
    !ref.startsWith("project:") &&
    !/^([\\/]|[A-Za-z]:)/.test(ref) &&
    !ref.includes("${{")
  );
}

/**
 * Re-expresses the relative file references of moved nodes (`subflow.flow`, a file
 * `loop.body`, `agent.promptRef`, inline loop bodies included) from `fromFile`'s
 * directory to `toFile`'s directory.
 */
function rebaseFileRefs(node: FlowNode, fromFile: string, toFile: string): FlowNode {
  const rebase = (ref: string) => (isRelativeFileRef(ref) ? relativeRef(toFile, resolvePartPath(fromFile, ref)) : ref);
  switch (node.kind) {
    case "subflow":
      return { ...node, flow: rebase(node.flow) };
    case "agent":
      return node.promptRef === undefined ? node : { ...node, promptRef: rebase(node.promptRef) };
    case "loop":
      if (typeof node.body === "string") return { ...node, body: rebase(node.body) };
      return { ...node, body: { ...node.body, nodes: node.body.nodes.map((n) => rebaseFileRefs(n, fromFile, toFile)) } };
    default:
      return node;
  }
}

// ---------------------------------------------------------------------------
// Signature inference
// ---------------------------------------------------------------------------

/** `base`, or `base_2`, `base_3`, ... — the first one not in `taken`. */
function uniqueName(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}_${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * The param a reference inside the selection needs, or `null` when the reference
 * stays as is (selected nodes, variables bound inside the selection, ambient values).
 */
function inboundParam(
  ref: string,
  ctx: RefContext,
  internal: Set<string>,
  callerParams: Record<string, FlowParamDef>,
): { name: string; type: FlowParamType } | null {
  const seg = ref.split(".");
  if (seg.length === 1) {
    if (seg[0] === "index") return ctx.vars.length > 0 ? null : { name: "index", type: "number" };
    return ctx.vars.includes(seg[0]) ? null : { name: seg[0], type: "string" };
  }
  if (seg[0] === "params" && seg.length === 2) {
    return { name: seg[1], type: callerParams[seg[1]]?.type ?? "string" };
  }
  if (seg[0] === "nodes" && seg.length >= 3 && !internal.has(seg[1])) {
    const [, node, field, key] = seg;
    if (field === "outputs" && seg.length === 4) return { name: key, type: "string" };
    if (field === "outputs" && seg.length === 3) return { name: `${node}_outputs`, type: "string" };
    if (field === "artifacts" && seg.length === 3) return { name: `${node}_artifacts`, type: "string" };
    if (field === "artifacts" && seg.length === 4) return { name: key, type: "string" };
    return null;
  }
  if (seg[0] === "iteration" && seg[1] === "outputs" && seg.length === 3 && !ctx.iteration) {
    return { name: seg[2], type: "string" };
  }
  // run.*, node.dir, project.root, env.* are ambient; anything else is left alone.
  return null;
}

/** Rewrites the selected nodes to read outside values from params and records those params. */
function inferParams(selected: FlowNode[], internal: Set<string>, callerParams: Record<string, FlowParamDef>) {
  const byRef = new Map<string, string>();
  const taken = new Set<string>();
  const partParams: Record<string, FlowParamDef> = {};
  const callParams: Record<string, unknown> = {};
  const nodes = selected.map((node) =>
    mapNodeRefs(node, { vars: [], iteration: false }, (ref, ctx) => {
      const wanted = inboundParam(ref, ctx, internal, callerParams);
      if (!wanted) return ref;
      let name = byRef.get(ref);
      if (name === undefined) {
        name = uniqueName(wanted.name, taken);
        taken.add(name);
        byRef.set(ref, name);
        partParams[name] = { type: wanted.type };
        callParams[name] = template(ref);
      }
      return `params.${name}`;
    }),
  );
  return { nodes, partParams, callParams, names: [...taken] };
}

/**
 * Rewrites references from outside the selection to the new node and records the
 * part outputs they need (`nodes.<selected>.outputs.<k>` becomes a part output).
 */
function inferOutputs(def: FlowDef, internal: Set<string>, newId: string) {
  const byRef = new Map<string, string>();
  const outputs: Record<string, string> = {};
  const { ui, ...rest } = def;
  const rewritten = mapValueRefs(rest, (ref) => {
    const seg = ref.split(".");
    if (seg[0] !== "nodes" || seg.length < 3 || !internal.has(seg[1])) return ref;
    if (seg[2] === "outputs" && seg.length === 4) {
      let key = byRef.get(ref);
      if (key === undefined) {
        key = uniqueName(seg[3], new Set(Object.keys(outputs)));
        byRef.set(ref, key);
        outputs[key] = template(ref);
      }
      return `nodes.${newId}.outputs.${key}`;
    }
    // Whole outputs objects and artifacts: point at the new node.
    return ["nodes", newId, ...seg.slice(2)].join(".");
  }) as FlowDef;
  if (ui !== undefined) rewritten.ui = ui;
  return { updated: rewritten, outputs };
}

// ---------------------------------------------------------------------------
// Boundary analysis
// ---------------------------------------------------------------------------

const portOf = (edge: FlowEdge): string => edge.port ?? "success";

/**
 * Selected nodes where execution enters: targets of forward edges from outside, and
 * nodes no forward edge leads to (scope roots). Back edges (`maxTraversals`) do not count.
 */
function entryPoints(ids: string[], selected: Set<string>, edges: FlowEdge[]): string[] {
  const forward = edges.filter((e) => e.maxTraversals === undefined);
  return ids.filter(
    (id) =>
      forward.some((e) => e.to === id && !selected.has(e.from)) || !forward.some((e) => e.to === id),
  );
}

/** Edges leaving the selection. */
function exitEdges(selected: Set<string>, edges: FlowEdge[]): FlowEdge[] {
  return edges.filter((e) => selected.has(e.from) && !selected.has(e.to));
}

/** Distinct `(from, port)` pairs of edges leaving the selection. */
function exitPorts(selected: Set<string>, edges: FlowEdge[]): string[] {
  const keys = exitEdges(selected, edges).map((e) => `${e.from}.${portOf(e)}`);
  return [...new Set(keys)];
}

/** The scope's edges with the selection collapsed into `newId`. */
function repointEdges(edges: FlowEdge[], selected: Set<string>, newId: string): FlowEdge[] {
  const out: FlowEdge[] = [];
  const seen = new Set<string>();
  for (const edge of edges) {
    const fromIn = selected.has(edge.from);
    const toIn = selected.has(edge.to);
    if (fromIn && toIn) continue;
    let next: FlowEdge = edge;
    if (toIn) next = { ...edge, to: newId };
    if (fromIn) {
      const { port, ...others } = edge;
      // The call node only has `success` and `failure` (other exit ports are refused earlier).
      next = { ...others, from: newId, ...(port === "failure" ? { port } : {}) };
    }
    const key = `${next.from}>${next.to}>${portOf(next)}>${next.maxTraversals ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(next);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Positions
// ---------------------------------------------------------------------------

function positionsOf(ui: unknown): Record<string, Position> | undefined {
  return (ui as { positions?: Record<string, Position> } | undefined)?.positions;
}

/** Positions of the moved nodes, shifted so the minimum lands on the origin. */
function partPositions(positions: Record<string, Position>, moved: Set<string>): Record<string, Position> {
  const entries = Object.entries(positions).filter(([id]) => moved.has(id));
  if (entries.length === 0) return {};
  const minX = Math.min(...entries.map(([, p]) => p.x));
  const minY = Math.min(...entries.map(([, p]) => p.y));
  return Object.fromEntries(entries.map(([id, p]) => [id, { x: p.x - minX, y: p.y - minY }]));
}

/** Caller positions without the moved nodes; the new node takes the entry node's place. */
function callerPositions(
  positions: Record<string, Position>,
  moved: Set<string>,
  entryId: string,
  newId: string,
): Record<string, Position> {
  const out: Record<string, Position> = {};
  for (const [id, p] of Object.entries(positions)) if (!moved.has(id)) out[id] = { ...p };
  if (positions[entryId]) out[newId] = { ...positions[entryId] };
  return out;
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/**
 * Extracts the nodes at `selectedPaths` (one scope) into a new part file named `name`
 * and replaces them in the caller by one `subflow` node. Never mutates `def`.
 */
export function extractSubflow(def: FlowDef, selectedPaths: string[], name: string, currentFile: string): ExtractOutcome {
  const paths = [...new Set(selectedPaths)];
  if (paths.length === 0) return { ok: false, reason: "empty" };
  const missing = paths.find((p) => nodeAt(def, p) === undefined);
  if (missing !== undefined) return { ok: false, reason: "empty", detail: missing };
  if (!FLOW_ID.test(name)) return { ok: false, reason: "invalid-name", detail: name };
  const scope = scopeOf(paths[0]);
  if (paths.some((p) => scopeOf(p) !== scope)) return { ok: false, reason: "mixed-scopes" };

  const { list, edges } = parentList(def, paths[0]);
  const selected = new Set(paths.map((p) => nodeAt(def, p)!.id));
  const selectedNodes = list.filter((n) => selected.has(n.id));
  const selectedIds = selectedNodes.map((n) => n.id);

  const entries = entryPoints(selectedIds, selected, edges);
  if (entries.length > 1) return { ok: false, reason: "multiple-entries", detail: entries.join(",") };
  const exits = exitPorts(selected, edges);
  if (exits.length > 1) return { ok: false, reason: "multiple-exits", detail: exits.join(",") };
  // The call node only exits through `success` or `failure`; any other port would change the run.
  const exitPort = exitEdges(selected, edges).map(portOf)[0];
  if (exitPort !== undefined && exitPort !== "success" && exitPort !== "failure") {
    return { ok: false, reason: "unsupported-exit", detail: exitPort };
  }
  const entryId = entries[0] ?? selectedIds[0];
  // An outside back edge can only re-enter through the entry node (it is re-targeted to the call node).
  const backInto = edges.find(
    (e) => e.maxTraversals !== undefined && !selected.has(e.from) && selected.has(e.to) && e.to !== entryId,
  );
  if (backInto) return { ok: false, reason: "multiple-entries", detail: `${entryId},${backInto.to}` };

  // Ids inside the selection, inline loop bodies included.
  const internal = new Set<string>();
  collectIds(selectedNodes, internal);
  const taken = new Set<string>();
  collectIds(def.nodes, taken);
  for (const id of internal) taken.delete(id);
  const newId = uniqueName(name.replace(/-/g, "_"), taken);

  const partFile = `${LIB_DIR}/${name}.flow.yaml`;
  const inbound = inferParams(selectedNodes, internal, def.params ?? {});
  const call: FlowSubflowNode = {
    id: newId,
    kind: "subflow",
    flow: relativeRef(currentFile, partFile),
    ...(inbound.names.length > 0 ? { params: inbound.callParams } : {}),
  };
  const insertAt = list.findIndex((n) => selected.has(n.id));
  const collapsed = mapScope(def, scope, (s) => ({
    nodes: s.nodes.flatMap((n, i) => (i === insertAt ? [call] : selected.has(n.id) ? [] : [n])),
    ...(s.edges ? { edges: repointEdges(s.edges, selected, newId) } : {}),
  }));
  const outbound = inferOutputs(collapsed, internal, newId);

  const positions = positionsOf(def.ui);
  let updated = outbound.updated;
  if (positions) {
    updated = { ...updated, ui: { ...(def.ui as object), positions: callerPositions(positions, internal, entryId, newId) } };
  }

  const innerEdges = edges.filter((e) => selected.has(e.from) && selected.has(e.to)).map((e) => ({ ...e }));
  const movedPositions = positions ? partPositions(positions, internal) : {};
  const outputNames = Object.keys(outbound.outputs);
  const part: FlowDef = {
    schemaVersion: 1,
    id: name,
    name,
    ...(inbound.names.length > 0 ? { params: inbound.partParams } : {}),
    // The part runs with the caller's flow-level context.
    ...(def.defaults !== undefined ? { defaults: structuredClone(def.defaults) } : {}),
    ...(def.env !== undefined ? { env: { ...def.env } } : {}),
    ...(def.envPassthrough !== undefined ? { envPassthrough: [...def.envPassthrough] } : {}),
    nodes: inbound.nodes.map((n) => rebaseFileRefs(n, currentFile, partFile)),
    ...(innerEdges.length > 0 ? { edges: innerEdges } : {}),
    ...(outputNames.length > 0 ? { outputs: outbound.outputs } : {}),
    ...(Object.keys(movedPositions).length > 0 ? { ui: { positions: movedPositions } } : {}),
  };

  const newNodePath = `${scope === "" ? "" : `${scope}.body.`}nodes[${insertAt}]`;
  return { ok: true, part, updated, signature: { params: inbound.names, outputs: outputNames }, newNodePath };
}
