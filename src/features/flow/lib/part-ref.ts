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

/**
 * Initial values for declared inputs: the declared default, else `""` for a required input.
 * Optional inputs without a default are left out (an empty value would change their meaning).
 */
export function initialValues(inputs: Record<string, { required?: boolean; default?: unknown }>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, input] of Object.entries(inputs)) {
    if (input.default !== undefined) out[name] = input.default;
    else if (input.required === true) out[name] = "";
  }
  return out;
}

/** Initial `params` for a call of `part` (see `initialValues`). */
export function paramsFor(part: FlowSummary): Record<string, unknown> {
  return initialValues(part.params);
}

/**
 * Values for the inputs `declared` now: the current value of a key the user already set,
 * else its initial value. Keys no longer declared are dropped.
 */
export function mergeValues(
  declared: string[],
  initial: Record<string, unknown>,
  current: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of declared) {
    if (current && Object.hasOwn(current, key)) out[key] = current[key];
    else if (Object.hasOwn(initial, key)) out[key] = initial[key];
  }
  return out;
}
