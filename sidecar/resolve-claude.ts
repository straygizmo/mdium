import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";

export interface ResolvedClaude {
  executablePath: string;
  /** Set to "node" when executablePath is a JS entry (npm install layout). */
  executable?: "node";
}

export interface ResolveDeps {
  platform: NodeJS.Platform;
  /** Returns candidate paths for the `claude` command (like `where`/`which`). */
  whichClaude: () => Promise<string[]>;
  exists: (p: string) => boolean;
  homeDir: string;
}

function defaultWhich(platform: NodeJS.Platform): () => Promise<string[]> {
  const cmd = platform === "win32" ? "where.exe" : "which";
  return () =>
    new Promise((resolve, reject) => {
      execFile(cmd, ["claude"], (err, stdout) => {
        if (err) return reject(err);
        resolve(stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
      });
    });
}

export async function resolveClaudeExecutable(
  deps?: Partial<ResolveDeps>,
): Promise<ResolvedClaude | null> {
  const platform = deps?.platform ?? process.platform;
  const d: ResolveDeps = {
    platform,
    whichClaude: deps?.whichClaude ?? defaultWhich(platform),
    exists: deps?.exists ?? existsSync,
    homeDir: deps?.homeDir ?? homedir(),
  };

  let candidates: string[] = [];
  try {
    candidates = await d.whichClaude();
  } catch {
    // fall through to fixed locations
  }

  for (const c of candidates) {
    const lower = c.toLowerCase();
    if (lower.endsWith(".cmd") || lower.endsWith(".ps1")) {
      // npm global shim: the real entry is node_modules/@anthropic-ai/claude-code/cli.js
      const cliJs = path.join(
        path.dirname(c), "node_modules", "@anthropic-ai", "claude-code", "cli.js",
      );
      if (d.exists(cliJs)) return { executablePath: cliJs, executable: "node" };
    } else if (lower.endsWith(".js")) {
      return { executablePath: c, executable: "node" };
    } else {
      // Native binary (claude.exe on Windows, claude elsewhere).
      return { executablePath: c };
    }
  }

  // Native installer default location.
  const native = path.join(
    d.homeDir, ".local", "bin", platform === "win32" ? "claude.exe" : "claude",
  );
  if (d.exists(native)) return { executablePath: native };
  return null;
}
