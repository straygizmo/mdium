#!/usr/bin/env node
/**
 * Vendor xlsx2md as a single ES module.
 *
 * Clones https://github.com/igapyon/xlsx2md (Apache-2.0), transpiles each
 * TypeScript source file to JavaScript with `ts.transpileModule`, concatenates
 * the 36 modules in dependency order, wraps them with an ES-module footer that
 * re-exports the public API, and writes the result to src/vendor/xlsx2md.js.
 *
 * Usage: node scripts/vendor-xlsx2md.mjs
 */

import { execSync } from "child_process";
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { join, dirname } from "path";
import ts from "typescript";

// ── paths ───────────────────────────────────────────────────────────────────
const ROOT = join(import.meta.dirname, "..");
const OUTPUT = join(ROOT, "src", "vendor", "xlsx2md.js");
const CLONE_DIR = join(ROOT, ".vendor-tmp", "xlsx2md");
const REPO_URL = "https://github.com/igapyon/xlsx2md.git";

// ── module load order (36 files, must be exact) ─────────────────────────────
const MODULE_ORDER = [
  "module-registry",
  "module-registry-access",
  "runtime-env",
  "office-drawing",
  "zip-io",
  "border-grid",
  "markdown-normalize",
  "markdown-escape",
  "markdown-table-escape",
  "rich-text-parser",
  "rich-text-plain-formatter",
  "rich-text-github-formatter",
  "rich-text-renderer",
  "narrative-structure",
  "table-detector",
  "markdown-export",
  "sheet-markdown",
  "styles-parser",
  "shared-strings",
  "address-utils",
  "rels-parser",
  "worksheet-tables",
  "cell-format",
  "xml-utils",
  "sheet-assets",
  "worksheet-parser",
  "workbook-loader",
  "formula-reference-utils",
  "formula-engine",
  "formula-legacy",
  "formula-ast",
  "formula-resolver",
  "formula/tokenizer",
  "formula/parser",
  "formula/evaluator",
  "core",
];

// ── ES-module footer ────────────────────────────────────────────────────────
const ES_MODULE_FOOTER = `
// ── ES module exports ───────────────────────────────────────────────────────
const __xlsx2md = globalThis.__xlsx2mdModuleRegistry.getModule("xlsx2md");
export default __xlsx2md;
export const parseWorkbook = __xlsx2md.parseWorkbook;
export const convertWorkbookToMarkdownFiles = __xlsx2md.convertWorkbookToMarkdownFiles;
export const createCombinedMarkdownExportFile = __xlsx2md.createCombinedMarkdownExportFile;
export const createExportEntries = __xlsx2md.createExportEntries;
`;

// ── helpers ─────────────────────────────────────────────────────────────────

function cloneRepo() {
  console.log(`Cloning ${REPO_URL} …`);
  mkdirSync(dirname(CLONE_DIR), { recursive: true });
  execSync(`git clone --depth 1 ${REPO_URL} "${CLONE_DIR}"`, {
    stdio: "inherit",
  });
}

function transpile(sourceText, fileName) {
  const result = ts.transpileModule(sourceText, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.None,
      removeComments: false,
      esModuleInterop: true,
    },
    fileName,
  });
  return result.outputText;
}

// ── main ────────────────────────────────────────────────────────────────────

try {
  // 1. Clone
  rmSync(CLONE_DIR, { recursive: true, force: true });
  cloneRepo();

  const tsDir = join(CLONE_DIR, "src", "ts");

  // 2. Transpile & concatenate in order
  const parts = [];

  parts.push(
    "// xlsx2md – vendored build",
    "// https://github.com/igapyon/xlsx2md",
    "// SPDX-License-Identifier: Apache-2.0",
    "// AUTO-GENERATED – do not edit by hand",
    ""
  );

  for (const mod of MODULE_ORDER) {
    const tsPath = join(tsDir, `${mod}.ts`);
    const source = readFileSync(tsPath, "utf-8");
    const js = transpile(source, `${mod}.ts`);
    parts.push(`// ── ${mod} ${"─".repeat(Math.max(0, 60 - mod.length))}`, js);
  }

  parts.push(ES_MODULE_FOOTER);

  // 3. Write output
  mkdirSync(dirname(OUTPUT), { recursive: true });
  writeFileSync(OUTPUT, parts.join("\n"), "utf-8");

  console.log(`\nVendored xlsx2md → ${OUTPUT}`);
  console.log(`Modules: ${MODULE_ORDER.length}`);

  // 4. Clean up clone
  rmSync(CLONE_DIR, { recursive: true, force: true });
  // Also remove the .vendor-tmp dir if empty
  try {
    rmSync(join(ROOT, ".vendor-tmp"), { recursive: true, force: true });
  } catch {
    // ignore
  }

  console.log("Done.");
} catch (err) {
  console.error("vendor-xlsx2md failed:", err);
  try {
    rmSync(join(ROOT, ".vendor-tmp"), { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
  process.exit(1);
}
