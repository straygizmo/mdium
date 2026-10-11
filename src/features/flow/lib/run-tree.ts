import type { FlowDef } from "@/shared/types/flow";
import { splitNodeKey, type NodeState, type RunState } from "@/shared/types/flow-run";

export interface RunAggregate { running: number; failed: number; awaiting: number; costUsd: number; progress?: string }
export interface RunTreeRow {
  /** Node instance key, or the scope prefix for an iteration row. */
  key: string;
  kind: "node" | "iteration";
  /** Display name: the definition name for a root node on pass 1, else the id (with `@pass`), or the iteration index. */
  label: string;
  depth: number;
  node?: NodeState;
  iterationIndex?: number;
  children: RunTreeRow[];
  agg: RunAggregate;
}

const EMPTY: RunAggregate = { running: 0, failed: 0, awaiting: 0, costUsd: 0 };

export function buildRunTree(state: RunState, flow: FlowDef): RunTreeRow[] {
  const rows = new Map<string, RunTreeRow>();
  const roots: RunTreeRow[] = [];
  const order = new Map(flow.nodes.map((d, i) => [d.id, i] as const));
  const rowFor = (key: string): RunTreeRow => {
    let row = rows.get(key);
    if (!row) {
      const { prefix, id, pass } = splitNodeKey(key);
      const def = prefix === "" ? flow.nodes.find((d) => d.id === id) : undefined;
      const base = def?.name && pass === 1 ? def.name : pass > 1 ? `${id}@${pass}` : id;
      row = { key, kind: "node", label: base, depth: 0, node: state.nodes[key], children: [], agg: { ...EMPTY } };
      rows.set(key, row);
      attach(row, prefix);
    }
    return row;
  };
  const iterationFor = (prefix: string, owner: string, index: number): RunTreeRow => {
    let row = rows.get(prefix);
    if (!row) {
      row = { key: prefix, kind: "iteration", label: String(index), depth: 0, iterationIndex: index, children: [], agg: { ...EMPTY } };
      rows.set(prefix, row);
      rowFor(owner).children.push(row);
    }
    return row;
  };
  const attach = (row: RunTreeRow, prefix: string) => {
    const scope = prefix === "" ? undefined : state.scopes?.[prefix];
    if (prefix === "" || !scope?.owner) { roots.push(row); return; }
    const parent = scope.index === undefined ? rowFor(scope.owner) : iterationFor(prefix, scope.owner, scope.index);
    parent.children.push(row);
  };
  for (const key of Object.keys(state.nodes)) rowFor(key);
  const sortRows = (list: RunTreeRow[], root: boolean) =>
    list.sort((a, b) => {
      if (a.kind === "iteration" && b.kind === "iteration") return (a.iterationIndex ?? 0) - (b.iterationIndex ?? 0);
      if (root) {
        const oa = order.get(splitNodeKey(a.key).id) ?? Number.MAX_SAFE_INTEGER;
        const ob = order.get(splitNodeKey(b.key).id) ?? Number.MAX_SAFE_INTEGER;
        if (oa !== ob) return oa - ob;
      }
      return a.key.localeCompare(b.key);
    });
  const finish = (row: RunTreeRow, depth: number): RunAggregate => {
    row.depth = depth;
    sortRows(row.children, false);
    const own = aggregateOf(row.node);
    const agg = row.children.reduce((acc, c) => merge(acc, finish(c, depth + 1)), own);
    row.agg = agg;
    return agg;
  };
  sortRows(roots, true);
  for (const r of roots) finish(r, 0);
  return roots;
}

function aggregateOf(node?: NodeState): RunAggregate {
  if (!node) return { ...EMPTY };
  const s = node.status;
  return {
    running: s === "running" || s === "retry_wait" ? 1 : 0,
    failed: s === "failed" ? 1 : 0,
    awaiting: s === "awaiting_approval" ? 1 : 0,
    costUsd: node.cost.actual + node.cost.estimated,
    progress: s === "running" ? node.progress?.text : undefined,
  };
}

function merge(a: RunAggregate, b: RunAggregate): RunAggregate {
  return { running: a.running + b.running, failed: a.failed + b.failed, awaiting: a.awaiting + b.awaiting, costUsd: a.costUsd + b.costUsd, progress: a.progress ?? b.progress };
}

export function defaultExpandedKeys(rows: RunTreeRow[]): Set<string> {
  const out = new Set<string>();
  const visit = (row: RunTreeRow) => {
    if (row.children.length === 0) return;
    const hot = row.agg.running + row.agg.failed + row.agg.awaiting - (row.node ? aggregateOf(row.node).running + aggregateOf(row.node).failed + aggregateOf(row.node).awaiting : 0);
    if (hot > 0) out.add(row.key);
    row.children.forEach(visit);
  };
  rows.forEach(visit);
  return out;
}

export function flattenVisible(rows: RunTreeRow[], expanded: Set<string>): RunTreeRow[] {
  const out: RunTreeRow[] = [];
  const visit = (row: RunTreeRow) => { out.push(row); if (expanded.has(row.key)) row.children.forEach(visit); };
  rows.forEach(visit);
  return out;
}
