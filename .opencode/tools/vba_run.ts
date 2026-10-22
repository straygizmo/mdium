// mdium-tool-version: 1
// .opencode/tools/vba_run.ts
//
// Runs macros of an .xlsm/.xlam on a disposable copy by asking the running
// mdium app over its local HTTP bridge.
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

async function callVbaRun(body: Record<string, unknown>, timeoutMs: number | undefined): Promise<string> {
  const bridge = await readBridgeInfo();
  if (!bridge) {
    return "Cannot reach mdium (no active connection). Open the mdium app and connect opencode for this folder.";
  }
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${bridge.port}/vba/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${bridge.token}` },
      body: JSON.stringify(body),
      // Approval wait (120 s) + run budget + Excel start-up grace + exit wait.
      signal: AbortSignal.timeout(120_000 + (timeoutMs ?? 120_000) + 45_000),
    });
  } catch (e: any) {
    if (e?.name === "TimeoutError") {
      return "vba_run did not finish within the client timeout; the run may still be executing in mdium — wait, then check run_in_progress / runCopyPath instead of retrying immediately.";
    }
    return `Failed to reach mdium: ${e?.message ?? e}.`;
  }
  let data: any;
  try {
    data = await res.json();
  } catch {
    return `mdium returned a non-JSON response (HTTP ${res.status}).`;
  }
  if (!res.ok) {
    return `vba_run failed (${data?.error ?? `HTTP ${res.status}`}): ${data?.message ?? ""}`.trim();
  }
  return JSON.stringify(data, null, 2);
}

export default tool({
  description:
    "Run macros of an .xlsm/.xlam on a disposable copy built from the workbook plus the current <stem>_assets/macros/ sources (source=macros_dir, default) or from the workbook as-is (source=workbook, for a baseline). Excel runs hidden; MsgBox/InputBox are answered from msgbox_responses/inputs; run-time errors are returned per macro; `read` returns cell values (Value2) after the run. Never writes the original workbook. Each call costs 1 of 6 runs per user instruction (run_budget_exhausted); side-effecting code needs allow_side_effects and the user's approval in MDium.",
  args: {
    xlsm_path: tool.schema
      .string()
      .describe("Absolute path of the .xlsm/.xlam workbook (from <mdium_context> active_file or the user)."),
    source: tool.schema
      .enum(["macros_dir", "workbook"])
      .optional()
      .describe("macros_dir (default): overlay the current <stem>_assets/macros/ sources. workbook: run the workbook as-is."),
    macros: tool.schema
      .array(
        tool.schema.object({
          name: tool.schema.string().describe("Macro name, optionally Module.Macro."),
          args: tool.schema
            .array(tool.schema.union([tool.schema.string(), tool.schema.number(), tool.schema.boolean()]))
            .optional()
            .describe("Arguments passed to the macro."),
        }),
      )
      .optional()
      .describe("Macros to run in order."),
    inputs: tool.schema
      .array(tool.schema.string())
      .optional()
      .describe("Answers for InputBox calls, consumed in order."),
    msgbox_responses: tool.schema
      .array(tool.schema.enum(["ok", "cancel", "yes", "no", "retry", "ignore", "abort"]))
      .optional()
      .describe("Answers for MsgBox calls, consumed in order."),
    read: tool.schema
      .array(
        tool.schema.object({
          sheet: tool.schema.string().describe("Sheet name."),
          range: tool.schema.string().optional().describe("A1-style range; omit for the used range."),
        }),
      )
      .optional()
      .describe("Cell ranges to return (Value2) after the run."),
    allow_side_effects: tool.schema
      .boolean()
      .optional()
      .describe("Allow code with side effects (file, network, shell access); requires the user's approval in MDium."),
    timeout_ms: tool.schema
      .number()
      .optional()
      .describe("Run timeout in milliseconds (default 120000, max 300000)."),
  },
  async execute(args) {
    return callVbaRun(args as Record<string, unknown>, args.timeout_ms);
  },
});
