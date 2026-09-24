import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Availability } from "../../src/shared/types/agent-runner";

export const MINIMUM_CODEX_VERSION = "0.152.0";
export const MINIMUM_COPILOT_VERSION = "1.0.0";

type ExecFileError = NodeJS.ErrnoException & {
  code?: string | number;
  killed?: boolean;
  stdout?: string;
  stderr?: string;
};

export type CommandRunner = (
  command: string,
  args: string[],
) => Promise<{ status: number | null; stdout: string; stderr: string; error?: NodeJS.ErrnoException }>;

const execFilePromise = promisify(execFile);

export const runCommand: CommandRunner = async (command, args) => {
  try {
    const { stdout, stderr } = await execFilePromise(command, args, {
      encoding: "utf8",
      windowsHide: true,
      timeout: 15_000,
    });
    return { status: 0, stdout: stdout ?? "", stderr: stderr ?? "" };
  } catch (error) {
    const err = error as ExecFileError;

    // Timeout: killed === true
    if (err.killed) {
      const timeoutError = Object.assign(new Error("timeout"), { code: "ETIMEDOUT" });
      return { status: null, stdout: String(err.stdout ?? ""), stderr: String(err.stderr ?? ""), error: timeoutError };
    }

    // Spawn failure: code is a string (e.g., "ENOENT", "EACCES")
    if (typeof err.code === "string") {
      return { status: null, stdout: "", stderr: "", error: err };
    }

    // Non-zero exit: code is a number
    if (typeof err.code === "number") {
      return { status: err.code, stdout: String(err.stdout ?? ""), stderr: String(err.stderr ?? "") };
    }

    return { status: 1, stdout: "", stderr: "" };
  }
};

function parseVersion(text: string): string | undefined {
  return text.match(/\bv?(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)/)?.[1];
}

/** Compare the numeric major.minor.patch of `version` against `minimum`. */
export function isAtLeast(version: string, minimum: string): boolean {
  const parts = (v: string) => v.split(/[-+]/)[0].split(".").map(Number);
  const a = parts(version);
  const b = parts(minimum);
  if (a.length !== 3 || a.some(Number.isNaN)) return false;
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return true;
}

/**
 * Probe a resolved Codex executable. `detail` carries a machine-readable hint
 * (minimum version or the login command); the UI renders localized text.
 */
export async function probeCodex(executable: string | null, run: CommandRunner = runCommand): Promise<Availability> {
  if (!executable) return { kind: "missing", detail: "codex" };
  const v = await run(executable, ["--version"]);
  if (v.error) {
    if (v.error.code === "ENOENT") return { kind: "missing", detail: "codex" };
    return { kind: "error", detail: "spawn" };
  }
  const version = parseVersion(`${v.stdout}\n${v.stderr}`);
  if (v.status !== 0 || !version) return { kind: "error", detail: "version" };
  if (!isAtLeast(version, MINIMUM_CODEX_VERSION)) {
    return { kind: "too_old", detail: MINIMUM_CODEX_VERSION, detectedVersion: version };
  }
  const auth = await run(executable, ["login", "status"]);
  if (auth.status !== 0) return { kind: "unauthenticated", detail: "codex login", detectedVersion: version };
  return { kind: "available", version };
}
