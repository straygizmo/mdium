import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const FLOW_ROOT = resolve(__dirname, "../..");
/** The only module that may talk to Tauri directly (spec 2026-10-10, 10.2). */
const ALLOWED = new Set(["lib/tauri-transport.ts"]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "__tests__" ? [] : sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

describe("flow feature isolation", () => {
  it("imports @tauri-apps only from the Tauri transport", () => {
    const offenders = sourceFiles(FLOW_ROOT)
      .filter((file) => /from\s+["']@tauri-apps\//.test(readFileSync(file, "utf8")))
      .map((file) => relative(FLOW_ROOT, file).replace(/\\/g, "/"))
      .filter((file) => !ALLOWED.has(file));
    expect(offenders).toEqual([]);
  });
});
