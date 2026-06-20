#!/usr/bin/env node
/**
 * Vendor miku-md2xlsx as a single self-contained ES module.
 *
 * Clones https://github.com/igapyon/miku-md2xlsx (Apache-2.0), installs its
 * dependencies, then bundles src/ts/core.ts into one ESM file with esbuild
 * (all dependencies inlined) and writes the result to src/vendor/md2xlsx.js.
 *
 * Unlike xlsx2md (module-registry concatenation), miku-md2xlsx uses standard
 * ESM imports, so esbuild bundling is the correct approach.
 *
 * Usage: node scripts/vendor-md2xlsx.mjs
 */

import { execSync } from "child_process";
import { readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync } from "fs";
import { join, dirname } from "path";
import { build } from "esbuild";

const ROOT = join(import.meta.dirname, "..");
const OUTPUT = join(ROOT, "src", "vendor", "md2xlsx.js");
const LICENSE_OUT = join(ROOT, "src", "vendor", "LICENSE-md2xlsx");
const CLONE_DIR = join(ROOT, ".vendor-tmp", "miku-md2xlsx");
const REPO_URL = "https://github.com/igapyon/miku-md2xlsx.git";

const HEADER = `// miku-md2xlsx – vendored build
// https://github.com/igapyon/miku-md2xlsx
// Copyright Toshiki Iga
// SPDX-License-Identifier: Apache-2.0
// See LICENSE-md2xlsx in this directory for the full license text.
//
// Modifications: TypeScript sources bundled into a single ES module with
// esbuild; all dependencies inlined.
// AUTO-GENERATED – do not edit by hand. Regenerate with: npm run vendor:md2xlsx
`;

try {
  // 1. Clone fresh
  rmSync(CLONE_DIR, { recursive: true, force: true });
  mkdirSync(dirname(CLONE_DIR), { recursive: true });
  console.log(`Cloning ${REPO_URL} …`);
  execSync(`git clone --depth 1 ${REPO_URL} "${CLONE_DIR}"`, { stdio: "inherit" });

  // 2. Install the engine's deps (remark-parse, remark-gfm, unified) so esbuild
  //    can resolve them from the clone's node_modules.
  console.log("Installing engine dependencies …");
  execSync("npm install --no-audit --no-fund", { cwd: CLONE_DIR, stdio: "inherit" });

  // 3. Bundle core.ts → single ESM, all deps inlined.
  const entry = join(CLONE_DIR, "src", "ts", "core.ts");
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2020",
    absWorkingDir: CLONE_DIR,
    write: false,
    legalComments: "none",
  });

  const bundled = result.outputFiles[0].text;

  // 4. Write output with attribution header.
  mkdirSync(dirname(OUTPUT), { recursive: true });
  writeFileSync(OUTPUT, HEADER + "\n" + bundled, "utf-8");

  // 5. Copy LICENSE.
  copyFileSync(join(CLONE_DIR, "LICENSE"), LICENSE_OUT);

  console.log(`\nVendored miku-md2xlsx → ${OUTPUT}`);

  // 6. Clean up.
  rmSync(join(ROOT, ".vendor-tmp"), { recursive: true, force: true });
  console.log("Done.");
} catch (err) {
  console.error("vendor-md2xlsx failed:", err);
  try {
    rmSync(join(ROOT, ".vendor-tmp"), { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
  process.exit(1);
}
