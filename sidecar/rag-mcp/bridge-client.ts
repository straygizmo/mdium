// Client for mdium's local HTTP bridge. The port and token change on every app
// launch, so they are discovered from env vars or the sidecar files mdium writes.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface BridgeInfo {
  port: number;
  token: string;
}

async function readInfoFile(file: string): Promise<BridgeInfo | null> {
  try {
    const info = JSON.parse(await readFile(file, "utf-8"));
    if (typeof info?.port === "number" && typeof info?.token === "string") {
      return { port: info.port, token: info.token };
    }
  } catch {
    // Missing or malformed file: treat as not available.
  }
  return null;
}

/** env MDIUM_BRIDGE_PORT/TOKEN, then ~/.mdium/bridge.json, then the opencode-compat file. */
export async function readBridgeInfo(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): Promise<BridgeInfo | null> {
  const port = Number(env.MDIUM_BRIDGE_PORT);
  if (Number.isInteger(port) && port > 0 && env.MDIUM_BRIDGE_TOKEN) {
    return { port, token: env.MDIUM_BRIDGE_TOKEN };
  }
  return (
    (await readInfoFile(join(home, ".mdium", "bridge.json"))) ??
    (await readInfoFile(join(home, ".config", "opencode", ".mdium-bridge.json")))
  );
}

/** POST a JSON body to the bridge; resolves with the HTTP status and parsed JSON body. */
export async function callBridge(
  info: BridgeInfo,
  route: string,
  body: unknown,
  timeoutMs: number,
  fetchImpl: typeof fetch = fetch,
): Promise<{ status: number; json: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`http://127.0.0.1:${info.port}${route}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${info.token}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      // Non-JSON body: leave json null so the caller reports the HTTP status.
    }
    return { status: res.status, json };
  } finally {
    clearTimeout(timer);
  }
}
