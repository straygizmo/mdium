import type { FlowSummary } from "@/shared/types/flow";

function dirOf(path: string): string[] {
  return path.replace(/\\/g, "/").split("/").slice(0, -1);
}

/** Path of `target` relative to the directory of `from` (both project-relative, forward slashes). */
export function relativeRef(from: string, target: string): string {
  const base = dirOf(from);
  const dest = target.replace(/\\/g, "/").split("/");
  const file = dest.pop() ?? "";
  let i = 0;
  while (i < base.length && i < dest.length && base[i] === dest[i]) i++;
  return [...base.slice(i).map(() => ".."), ...dest.slice(i), file].join("/");
}

/** File name of a part without the `.flow.yaml` suffix. */
export function partLabel(part: FlowSummary): string {
  return part.path.replace(/\\/g, "/").split("/").pop()?.replace(/\.flow\.ya?ml$/, "") ?? part.path;
}

/** One key per callee param: its default when declared, otherwise an empty string. */
export function paramsFor(part: FlowSummary): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, def] of Object.entries(part.params)) out[name] = def.default !== undefined ? def.default : "";
  return out;
}
