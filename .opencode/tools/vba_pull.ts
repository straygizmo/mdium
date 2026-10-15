// mdium-tool-version: 1
// .opencode/tools/vba_pull.ts
//
// Extracts the VBA modules of an .xlsm/.xlam workbook into <stem>_assets/macros/
// by asking the running mdium app over its local HTTP bridge.
import { tool } from "@opencode-ai/plugin";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";

const ROUTE = "pull";

async function readBridgeInfo(): Promise<{ port: number; token: string } | null> {
  const path = join(homedir(), ".config", "opencode", ".mdium-bridge.json");
  try {
    const info = JSON.parse(await readFile(path, "utf-8"));
    if (typeof info?.port === "number" && typeof info?.token === "string") return info;
    return null;
  } catch {
    return null;
  }
}

async function callVbaBridge(xlsmPath: string): Promise<string> {
  const bridge = await readBridgeInfo();
  if (!bridge) {
    return "Cannot reach mdium (no active connection). Open the mdium app and connect opencode for this folder.";
  }
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${bridge.port}/vba/${ROUTE}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${bridge.token}` },
      body: JSON.stringify({ xlsm_path: xlsmPath }),
    });
  } catch (e: any) {
    return `Failed to reach mdium: ${e?.message ?? e}.`;
  }
  let data: any;
  try {
    data = await res.json();
  } catch {
    return `mdium returned a non-JSON response (HTTP ${res.status}).`;
  }
  if (!res.ok) {
    return `vba_${ROUTE} failed (${data?.error ?? `HTTP ${res.status}`}): ${data?.message ?? ""}`.trim();
  }
  return JSON.stringify(data, null, 2);
}

export default tool({
  description:
    "Extract every VBA module of the workbook into <stem>_assets/macros/ as .bas (standard) and .cls (class/document) files, overwriting existing files there. Call before editing when the folder does not exist yet or the workbook is newer than the files.",
  args: {
    xlsm_path: tool.schema
      .string()
      .describe("Absolute path of the .xlsm/.xlam workbook (from <mdium_context> active_file or the user)."),
  },
  async execute(args) {
    return callVbaBridge(args.xlsm_path);
  },
});
