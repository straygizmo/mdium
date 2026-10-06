import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { FlowDef } from "@/shared/types/flow";

/** The spec's doc-digest example (the JSON twin of the Rust golden fixture). */
export function docDigest(): FlowDef {
  const file = resolve(__dirname, "../../../../../src-tauri/tests/fixtures/flows/valid/doc-digest-json.flow.json");
  return JSON.parse(readFileSync(file, "utf8")) as FlowDef;
}
