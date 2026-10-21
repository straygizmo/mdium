// mdium-tool-version: 1
// .opencode/tools/xlsx_read.ts
//
// Reads saved cell values of a workbook (no Excel) via the running mdium app's
// local HTTP bridge.
import { tool } from "@opencode-ai/plugin";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";

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

async function callXlsxRead(path: string, ranges: { sheet: string; range?: string }[]): Promise<string> {
  const bridge = await readBridgeInfo();
  if (!bridge) {
    return "Cannot reach mdium (no active connection). Open the mdium app and connect opencode for this folder.";
  }
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${bridge.port}/xlsx/read`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${bridge.token}` },
      body: JSON.stringify({ path, ranges }),
      signal: AbortSignal.timeout(60_000),
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
    return `xlsx_read failed (${data?.error ?? `HTTP ${res.status}`}): ${data?.message ?? ""}`.trim();
  }
  return JSON.stringify(data, null, 2);
}

export default tool({
  description:
    "Read saved cell values of an .xlsx/.xlsm/.xlam (no Excel; values as of the last save). Use it on a run copy right after vba_run, or on the original workbook.",
  args: {
    path: tool.schema.string().describe("Absolute path of the .xlsx/.xlsm/.xlam workbook."),
    ranges: tool.schema
      .array(
        tool.schema.object({
          sheet: tool.schema.string().describe("Sheet name."),
          range: tool.schema.string().optional().describe("A1-style range; omit for the used range."),
        }),
      )
      .describe("Cell ranges to read."),
  },
  async execute(args) {
    return callXlsxRead(args.path, args.ranges);
  },
});
