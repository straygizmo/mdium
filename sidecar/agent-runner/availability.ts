import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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

/** Top-level and per-table `key = value` pairs of a TOML file (strings and booleans only). */
function tomlTables(text: string): Map<string, Map<string, string>> {
  const tables = new Map<string, Map<string, string>>([["", new Map()]]);
  let current = tables.get("")!;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, "").trim();
    if (!line || line.startsWith("#")) continue;
    const header = line.match(/^\[([^\[\]]+)\]$/);
    if (header) {
      const name = header[1].replace(/\s+/g, "").replace(/"/g, "");
      current = tables.get(name) ?? new Map();
      tables.set(name, current);
      continue;
    }
    const pair = line.match(/^([\w.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|(true|false))\s*$/);
    if (pair) current.set(pair[1], pair[2] ?? pair[3] ?? pair[4]);
  }
  return tables;
}

export interface CodexByokDeps {
  env: NodeJS.ProcessEnv;
  /** Contents of Codex's config.toml, or undefined when it does not exist. */
  readConfig: () => string | undefined;
}

const defaultByokDeps = (): CodexByokDeps => ({
  env: process.env,
  readConfig: () => {
    const home = process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
    try {
      return readFileSync(join(home, "config.toml"), "utf8");
    } catch {
      return undefined;
    }
  },
});

/**
 * True when Codex is set up with the user's own key (BYOK) instead of `codex login`:
 * an API key variable is set, or the active model provider in config.toml (top level or
 * the selected profile) is not `openai` and does not require OpenAI auth.
 */
export function hasCodexByok(deps: CodexByokDeps = defaultByokDeps()): boolean {
  if (deps.env.CODEX_API_KEY?.trim() || deps.env.OPENAI_API_KEY?.trim()) return true;
  const text = deps.readConfig();
  if (!text) return false;
  const tables = tomlTables(text);
  const top = tables.get("")!;
  const profile = top.get("profile");
  const provider = (profile ? tables.get(`profiles.${profile}`)?.get("model_provider") : undefined) ?? top.get("model_provider");
  if (!provider || provider === "openai") return false;
  return tables.get(`model_providers.${provider}`)?.get("requires_openai_auth") !== "true";
}

/**
 * Probe a resolved Codex executable. `detail` carries a machine-readable hint
 * (minimum version or the login command); the UI renders localized text.
 * Without a login, Codex still counts as available when it is set up with the
 * user's own key (`hasByok`).
 */
export async function probeCodex(
  executable: string | null,
  run: CommandRunner = runCommand,
  hasByok: () => boolean = () => hasCodexByok(),
): Promise<Availability> {
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
  if (auth.status !== 0 && !hasByok()) return { kind: "unauthenticated", detail: "codex login", detectedVersion: version };
  return { kind: "available", version };
}
