// @vitest-environment node
// Builds the mdium-rag bundle outside the repository and drives it over stdio.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let dir: string;
let bundle: string;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mdium-rag-bundle-"));
  bundle = path.join(dir, "index.mjs");
  await build({
    entryPoints: [path.resolve(__dirname, "../mcp-main.ts")],
    bundle: true,
    platform: "node",
    target: "node20",
    format: "esm",
    outfile: bundle,
    banner: {
      js: 'import { createRequire as createRagRequire } from "node:module"; const require = createRagRequire(import.meta.url);',
    },
    logLevel: "silent",
  });
}, 60_000);

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("mdium-rag bundle", () => {
  it("lists only read tools in a read-only session", () => {
    const input = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
    ]
      .map((m) => JSON.stringify(m))
      .join("\n");
    const stdout = execFileSync("node", [bundle], {
      cwd: dir,
      input: `${input}\n`,
      encoding: "utf8",
      env: { ...process.env, MDIUM_RAG_PERMISSION: "read-only" },
    });
    const replies = stdout
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(replies[0].result.serverInfo.name).toBe("mdium-rag");
    expect(replies[1].result.tools).toHaveLength(2);
  });
});
