import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";

export interface OpencodeServerOptions {
  /** Server configuration, passed as OPENCODE_CONFIG_CONTENT. */
  config: object;
  spawnImpl?: typeof spawn;
  /** How long to wait for the listening line (default 20 s). */
  timeoutMs?: number;
}

export interface StartedOpencodeServer {
  url: string;
  /** Basic-auth password of the server (user name `opencode`). */
  password: string;
  close(): void;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const LISTENING = /listening on (https?:\/\/\S+)/i;
const SERVE_ARGS = ["serve", "--hostname=127.0.0.1", "--port=0"];

/**
 * Command line of `opencode serve`. The npm install is a .cmd shim on Windows, so it runs
 * through cmd.exe with constant arguments (the same resolution the availability probe uses).
 */
function serveCommand(): { command: string; args: string[] } {
  if (process.platform === "win32") {
    return { command: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", `opencode ${SERVE_ARGS.join(" ")}`] };
  }
  return { command: "opencode", args: SERVE_ARGS };
}

/** Kill a process and its children (cmd.exe and the opencode process it started on Windows). */
function killTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32" && child.pid) {
    const result = spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
    if (!result.error && result.status === 0) return;
  }
  child.kill();
}

/**
 * Start a dedicated `opencode serve` on an OS-assigned loopback port, hidden, with project
 * configuration disabled and a random per-server password.
 */
export function startOpencodeServer(options: OpencodeServerOptions): Promise<StartedOpencodeServer> {
  const spawnImpl = options.spawnImpl ?? spawn;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const password = randomBytes(16).toString("hex");
  const { command, args } = serveCommand();
  const child = spawnImpl(command, args, {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      OPENCODE_CONFIG_CONTENT: JSON.stringify(options.config),
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      OPENCODE_SERVER_PASSWORD: password,
    },
  });

  return new Promise<StartedOpencodeServer>((resolve, reject) => {
    let settled = false;
    let stdoutBuffer = "";
    let output = "";

    const finish = (outcome: { url: string } | { error: Error }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if ("error" in outcome) {
        killTree(child);
        reject(outcome.error);
      } else {
        resolve({ url: outcome.url, password, close: () => killTree(child) });
      }
    };

    const timer = setTimeout(
      () => finish({ error: new Error(`Timeout waiting for server to start after ${timeoutMs}ms`) }),
      timeoutMs,
    );

    // Both pipes are drained for the server's lifetime so a full pipe never blocks it.
    child.stdout?.on("data", (chunk: Buffer | string) => {
      if (settled) return;
      const text = chunk.toString();
      output += text;
      stdoutBuffer += text;
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) {
        const match = LISTENING.exec(line);
        if (match) return finish({ url: match[1] });
      }
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      if (!settled) output += chunk.toString();
    });
    child.on("exit", (code) => {
      const detail = output.trim() ? `\nServer output: ${output.trim()}` : "";
      finish({ error: new Error(`Server exited with code ${code}${detail}`) });
    });
    child.on("error", (error) => finish({ error }));
  });
}
