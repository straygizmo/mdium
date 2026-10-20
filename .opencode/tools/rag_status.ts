// mdium-tool-version: 1
// .opencode/tools/rag_status.ts
//
// Reports the document index state, unconverted Office documents and any background job.
// Thin client: delegates to the running mdium app over its local HTTP bridge.
import { tool } from "@opencode-ai/plugin";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";

interface BridgeInfo {
  port: number;
  token: string;
}

// mdium writes this sidecar on every opencode connection (port/token change per
// run). It lives at the global opencode config root, so resolve it from home.
async function readBridgeInfo(): Promise<BridgeInfo | null> {
  const path = join(homedir(), ".config", "opencode", ".mdium-bridge.json");
  try {
    const raw = await readFile(path, "utf-8");
    const info = JSON.parse(raw);
    if (typeof info?.port === "number" && typeof info?.token === "string") {
      return info as BridgeInfo;
    }
    return null;
  } catch {
    return null;
  }
}

// POST to the bridge; every failure is returned as a plain string.
async function callBridge(
  route: string,
  body: Record<string, unknown>,
  toolName: string
): Promise<string> {
  const bridge = await readBridgeInfo();
  if (!bridge) {
    return (
      "Cannot reach mdium (no active connection). Make sure the mdium app is " +
      "open and connected to opencode for this folder."
    );
  }

  let res: Response;
  try {
    // Bound the call so the tool never hangs if mdium is unreachable. The
    // bridge may wait for the user to answer an in-app confirm dialog.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 150_000);
    try {
      res = await fetch(`http://127.0.0.1:${bridge.port}${route}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${bridge.token}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  } catch (e: any) {
    return `Failed to reach mdium RAG bridge: ${e?.message ?? e}. Make sure the mdium app is open.`;
  }

  let data: any;
  try {
    data = await res.json();
  } catch {
    return `mdium RAG bridge returned a non-JSON response (HTTP ${res.status}).`;
  }

  if (!res.ok || data?.ok === false) {
    const msg = data?.message ?? data?.error ?? `HTTP ${res.status}`;
    return `${toolName} failed: ${msg}`;
  }
  return JSON.stringify(data, null, 2);
}

export default tool({
  description:
    "Report the state of the document index for the current folder: index state, Office documents " +
    "not yet converted, and any background job. Call this first for any question about the documents " +
    "in the folder. If `unconverted_office_docs` is not empty, tell the user how many and which files, " +
    "and ask whether to convert them before searching. If `state` is `empty`, ask whether to build the " +
    "index. Never start a conversion or index update without the user's consent.",
  args: {},
  async execute(args, context) {
    return callBridge("/rag/status", { folder_path: context.worktree }, "rag_status");
  },
});
