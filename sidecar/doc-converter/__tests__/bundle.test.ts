// @vitest-environment node
// Builds the mdium-docs bundle into a directory outside the repository (so no
// node_modules can be resolved, as in an installed app) and runs it with node.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildPdf } from "./fixtures";

let dir: string;
let bundle: string;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mdium-docs-bundle-"));
  bundle = path.join(dir, "index.mjs");
  await build({
    entryPoints: [path.resolve(__dirname, "../mcp-main.ts")],
    bundle: true,
    platform: "node",
    target: "node20",
    format: "esm",
    outfile: bundle,
    banner: {
      js: 'import { createRequire as createDocsRequire } from "node:module"; const require = createDocsRequire(import.meta.url);',
    },
    logLevel: "silent",
  });
  fs.writeFileSync(path.join(dir, "paper.pdf"), buildPdf([[{ text: "Standalone", size: 12 }]]));
}, 60_000);

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("mdium-docs bundle", () => {
  it("converts a PDF without any node_modules next to it", () => {
    const out = path.join(dir, "out", "paper.md");
    const stdout = execFileSync("node", [bundle, "convert", path.join(dir, "paper.pdf"), out], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    // stdout carries only the JSON result (library warnings go to stderr).
    expect(JSON.parse(stdout.trim())).toEqual({ markdownPath: out, assetCount: 0 });
    expect(fs.readFileSync(out, "utf8")).toBe("Standalone\n");
  });

  it("answers MCP requests received before stdin closes", () => {
    const input = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "convert_to_markdown", arguments: { path: path.join(dir, "paper.pdf") } } },
    ]
      .map((m) => JSON.stringify(m))
      .join("\n");
    const stdout = execFileSync("node", [bundle], { cwd: dir, input: `${input}\n`, encoding: "utf8" });
    const replies = stdout.trim().split("\n").map((l) => JSON.parse(l));
    expect(replies.map((r) => r.id)).toEqual([1, 2]);
    expect(replies[1].result.content[0].text).toBe("Standalone\n");
  });
});
