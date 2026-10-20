// Line-delimited JSON-RPC loop over stdin/stdout for an MCP server.
import { createInterface } from "node:readline";
import type { JsonRpcResponse } from "./jsonrpc-server";

/** Send console output to stderr, keeping stdout free for the protocol. */
export function routeConsoleToStderr(): void {
  const toStderr = (...args: unknown[]) => {
    process.stderr.write(`${args.map((a) => (typeof a === "string" ? a : String(a))).join(" ")}\n`);
  };
  console.log = toStderr;
  console.info = toStderr;
  console.warn = toStderr;
  console.debug = toStderr;
}

/** Read one request per stdin line and write each defined response to stdout. */
export function runStdioServer(
  handleLine: (line: string) => Promise<JsonRpcResponse | undefined>,
): void {
  routeConsoleToStderr();
  const inFlight = new Set<Promise<void>>();
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    const handled: Promise<void> = handleLine(line)
      .then((response) => {
        if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
      })
      .finally(() => inFlight.delete(handled));
    inFlight.add(handled);
  });
  // Answer every request already received before exiting on stdin EOF.
  rl.on("close", () => {
    void Promise.allSettled([...inFlight]).then(() => process.exit(0));
  });
}
