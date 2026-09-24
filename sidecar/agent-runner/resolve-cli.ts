import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import * as path from "node:path";

export interface ResolveCliDeps {
  platform: NodeJS.Platform;
  arch: string;
  env: NodeJS.ProcessEnv;
  /** Candidate paths for a command name (like `where` / `which`). */
  which: (name: string) => Promise<string[]>;
  exists: (p: string) => boolean;
}

function defaultWhich(platform: NodeJS.Platform) {
  const cmd = platform === "win32" ? "where.exe" : "which";
  return (name: string) =>
    new Promise<string[]>((resolve, reject) => {
      execFile(cmd, [name], { windowsHide: true }, (err, stdout) => {
        if (err) return reject(err);
        resolve(stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
      });
    });
}

function withDefaults(deps?: Partial<ResolveCliDeps>): ResolveCliDeps {
  const platform = deps?.platform ?? process.platform;
  return {
    platform,
    arch: deps?.arch ?? process.arch,
    env: deps?.env ?? process.env,
    which: deps?.which ?? defaultWhich(platform),
    exists: deps?.exists ?? existsSync,
  };
}

async function candidates(d: ResolveCliDeps, name: string): Promise<string[]> {
  try {
    return await d.which(name);
  } catch {
    return [];
  }
}

const isShim = (p: string) => /\.(cmd|ps1)$/i.test(p) || !path.extname(p);

/** Native Codex binary locations inside an npm prefix (nested and hoisted, new and legacy layouts). */
function codexBinaryCandidates(prefix: string, arch: string): string[] {
  const pkg = arch === "arm64" ? "codex-win32-arm64" : "codex-win32-x64";
  const triple = arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
  const roots = [
    path.join(prefix, "node_modules", "@openai", "codex", "node_modules", "@openai", pkg),
    path.join(prefix, "node_modules", "@openai", pkg),
  ];
  return roots.flatMap((root) => [
    path.join(root, "vendor", triple, "bin", "codex.exe"),
    path.join(root, "vendor", triple, "codex", "codex.exe"),
  ]);
}

export async function resolveCodexPath(deps?: Partial<ResolveCliDeps>): Promise<string | null> {
  const d = withDefaults(deps);
  const override = d.env.MDIUM_CODEX_PATH?.trim();
  if (override) return override;
  const found = await candidates(d, "codex");
  if (d.platform !== "win32") return found[0] ?? null;
  for (const c of found) {
    if (/\.exe$/i.test(c)) return c;
  }
  for (const c of found) {
    if (!isShim(c)) continue;
    const hit = codexBinaryCandidates(path.dirname(c), d.arch).find((p) => d.exists(p));
    if (hit) return hit;
  }
  return null;
}

export async function resolveCopilotPath(deps?: Partial<ResolveCliDeps>): Promise<string | null> {
  const d = withDefaults(deps);
  const override = d.env.COPILOT_CLI_PATH?.trim();
  if (override) return override;
  const found = await candidates(d, "copilot");
  for (const c of found) {
    if (/\.(exe|js)$/i.test(c)) return c;
    if (d.platform !== "win32" && !path.extname(c)) return c;
    if (/\.(cmd|ps1)$/i.test(c) || !path.extname(c)) {
      const loader = path.join(path.dirname(c), "node_modules", "@github", "copilot", "npm-loader.js");
      if (d.exists(loader)) return loader;
    }
  }
  return null;
}
