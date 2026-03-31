# Excel to Markdown Conversion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Excel (.xlsx/.xlsm) to Markdown conversion using xlsx2md as a vendored ES module, with a "Markdownに変換" button on the preview panel.

**Architecture:** Vendor xlsx2md's entire conversion pipeline as a single ES module (`src/vendor/xlsx2md.js`) by transpiling and concatenating all 36 TypeScript source files in dependency order. Create a thin wrapper (`xlsxToMarkdown.ts`) following the existing `docxToMarkdown.ts` pattern, and extend `PreviewPanel.tsx` to trigger conversion for Excel files.

**Tech Stack:** xlsx2md (vendored, Apache 2.0), TypeScript, Tauri filesystem APIs (`@tauri-apps/plugin-fs`), Vite

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `scripts/vendor-xlsx2md.mjs` | Create | Clones xlsx2md, transpiles TS→JS, concatenates, wraps as ES module |
| `src/vendor/xlsx2md.js` | Generate | Vendored ES module (build artifact, committed to repo) |
| `src/vendor/xlsx2md.d.ts` | Create | TypeScript type declarations for the vendored module |
| `src/features/export/lib/xlsxToMarkdown.ts` | Create | Thin wrapper: calls xlsx2md API, saves markdown + images via Tauri FS |
| `src/features/preview/components/PreviewPanel.tsx` | Modify (lines 640-692) | Add `isXlsx` detection, extend convert-bar condition, add xlsx branch in handler |
| `package.json` | Modify (scripts) | Add `vendor:xlsx2md` npm script |

---

### Task 1: Create vendoring build script

**Files:**
- Create: `scripts/vendor-xlsx2md.mjs`
- Modify: `package.json` (scripts section)

- [ ] **Step 1: Create `scripts/vendor-xlsx2md.mjs`**

```javascript
// scripts/vendor-xlsx2md.mjs
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const TEMP_DIR = join(ROOT, ".tmp-xlsx2md");
const OUTPUT = join(ROOT, "src", "vendor", "xlsx2md.js");

// Module load order — must match xlsx2md's xlsx2md-module-order.mjs exactly
const CORE_MODULES = [
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

async function main() {
  // 1. Clone xlsx2md
  if (existsSync(TEMP_DIR)) {
    rmSync(TEMP_DIR, { recursive: true });
  }
  console.log("Cloning xlsx2md...");
  execSync(
    `git clone --depth 1 https://github.com/igapyon/xlsx2md.git "${TEMP_DIR}"`,
    { stdio: "inherit" }
  );

  // 2. Transpile each TypeScript file using ts.transpileModule
  const ts = (await import("typescript")).default;
  const compilerOptions = {
    target: ts.ScriptTarget.ES2019,
    module: ts.ModuleKind.None,
    lib: ["ES2020", "DOM"],
    strict: false,
    skipLibCheck: true,
  };

  const jsChunks = [];
  for (const mod of CORE_MODULES) {
    const tsPath = join(TEMP_DIR, "src", "xlsx2md", "ts", `${mod}.ts`);
    if (!existsSync(tsPath)) {
      throw new Error(`Module not found: ${tsPath}`);
    }
    const source = readFileSync(tsPath, "utf-8");
    const result = ts.transpileModule(source, { compilerOptions });
    jsChunks.push(`// --- ${mod} ---\n${result.outputText}`);
  }

  // 3. Assemble ES module
  const banner = [
    "// @generated — vendored from https://github.com/igapyon/xlsx2md",
    "// License: Apache 2.0",
    "// Do not edit manually. Re-generate with: npm run vendor:xlsx2md",
    "",
  ].join("\n");

  const footer = `
// --- ES module exports ---
const __xlsx2md = globalThis.__xlsx2mdModuleRegistry.getModule("xlsx2md");
export default __xlsx2md;
export const parseWorkbook = __xlsx2md.parseWorkbook;
export const convertWorkbookToMarkdownFiles = __xlsx2md.convertWorkbookToMarkdownFiles;
export const createCombinedMarkdownExportFile = __xlsx2md.createCombinedMarkdownExportFile;
export const createExportEntries = __xlsx2md.createExportEntries;
`;

  const output = banner + jsChunks.join("\n\n") + footer;

  // 4. Write output
  mkdirSync(dirname(OUTPUT), { recursive: true });
  writeFileSync(OUTPUT, output, "utf-8");
  console.log(`Wrote ${OUTPUT} (${(output.length / 1024).toFixed(1)} KB)`);

  // 5. Cleanup
  rmSync(TEMP_DIR, { recursive: true });
  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  // Cleanup on failure
  if (existsSync(TEMP_DIR)) {
    rmSync(TEMP_DIR, { recursive: true });
  }
  process.exit(1);
});
```

- [ ] **Step 2: Add npm script to `package.json`**

In the `"scripts"` section of `package.json`, add:

```json
"vendor:xlsx2md": "node scripts/vendor-xlsx2md.mjs"
```

- [ ] **Step 3: Commit**

```bash
git add scripts/vendor-xlsx2md.mjs package.json
git commit -m "feat: add xlsx2md vendoring build script"
```

---

### Task 2: Run vendoring script and produce xlsx2md.js

**Files:**
- Create: `src/vendor/xlsx2md.js` (generated)

- [ ] **Step 1: Run the vendoring script**

```bash
npm run vendor:xlsx2md
```

Expected: Script clones xlsx2md, transpiles 36 TypeScript files, concatenates them, wraps as ES module, and writes `src/vendor/xlsx2md.js`. Output should be ~200-400 KB.

- [ ] **Step 2: Verify output file exists**

```bash
ls -la src/vendor/xlsx2md.js
wc -l src/vendor/xlsx2md.js
```

Expected: File exists with several thousand lines.

- [ ] **Step 3: Inspect the exported API to verify function signatures**

Open `src/vendor/xlsx2md.js` and search for the `xlsx2mdApi` object near the end of `core` module (before the ES module exports). Confirm the function names and parameter counts match what we expect. Key functions to verify:

- `parseWorkbook` — should accept `(arrayBuffer, name?)`
- `convertWorkbookToMarkdownFiles` — should accept `(workbook, options?)`
- `createCombinedMarkdownExportFile` — check if it takes `(files)` or `(workbook, files)`
- `createExportEntries` — check if it takes `(files)` or `(workbook, files)`

If signatures differ from the plan, adjust `xlsxToMarkdown.ts` (Task 4) accordingly.

- [ ] **Step 4: Commit the vendored module**

```bash
git add src/vendor/xlsx2md.js
git commit -m "feat: vendor xlsx2md as ES module"
```

---

### Task 3: Create type declarations for vendored xlsx2md

**Files:**
- Create: `src/vendor/xlsx2md.d.ts`

- [ ] **Step 1: Create `src/vendor/xlsx2md.d.ts`**

Define minimal types that cover the API surface used by `xlsxToMarkdown.ts`. Verify against the actual vendored module from Task 2 Step 3 and adjust if needed.

```typescript
// src/vendor/xlsx2md.d.ts

export interface ParsedWorkbook {
  name: string;
  sheets: ParsedSheet[];
}

export interface ParsedSheet {
  name: string;
}

export interface MarkdownOptions {
  formattingMode?: "plain" | "github";
  tableDetectionMode?: "balanced" | "border";
  outputMode?: "display" | "raw" | "both";
  treatFirstRowAsHeader?: boolean;
  trimText?: boolean;
  removeEmptyRows?: boolean;
  removeEmptyColumns?: boolean;
}

export interface MarkdownFile {
  fileName: string;
  content: string;
  sheetName: string;
}

export interface ExportEntry {
  path: string;
  data: Uint8Array;
}

export function parseWorkbook(
  arrayBuffer: ArrayBuffer,
  name?: string
): Promise<ParsedWorkbook>;

export function convertWorkbookToMarkdownFiles(
  workbook: ParsedWorkbook,
  options?: MarkdownOptions
): MarkdownFile[];

export function createCombinedMarkdownExportFile(
  workbook: ParsedWorkbook,
  files: MarkdownFile[]
): { fileName: string; content: string };

export function createExportEntries(
  workbook: ParsedWorkbook,
  files: MarkdownFile[]
): ExportEntry[];

declare const xlsx2md: {
  parseWorkbook: typeof parseWorkbook;
  convertWorkbookToMarkdownFiles: typeof convertWorkbookToMarkdownFiles;
  createCombinedMarkdownExportFile: typeof createCombinedMarkdownExportFile;
  createExportEntries: typeof createExportEntries;
};

export default xlsx2md;
```

**Note:** The `ParsedWorkbook`, `ParsedSheet`, `MarkdownFile`, and `ExportEntry` interfaces above are minimal stubs covering only the fields we use. If additional fields are needed later, extend the declarations.

**Note:** The signatures for `createCombinedMarkdownExportFile` and `createExportEntries` should be verified in Task 2 Step 3. Based on source analysis, they likely take `(workbook, files)`, but if they only take `(files)`, remove the `workbook` parameter.

- [ ] **Step 2: Commit**

```bash
git add src/vendor/xlsx2md.d.ts
git commit -m "feat: add type declarations for vendored xlsx2md"
```

---

### Task 4: Create xlsxToMarkdown.ts

**Files:**
- Create: `src/features/export/lib/xlsxToMarkdown.ts`

- [ ] **Step 1: Create `src/features/export/lib/xlsxToMarkdown.ts`**

This follows the same pattern as `docxToMarkdown.ts` (lines 1-78). It imports xlsx2md, parses the workbook, converts to markdown, saves images, and writes the `.md` file.

```typescript
import { writeTextFile, writeFile, mkdir } from "@tauri-apps/plugin-fs";
import type { ConvertResult } from "./docxToMarkdown";

/**
 * Convert a .xlsx/.xlsm file (as Uint8Array) to Markdown.
 * Images/charts/shapes are extracted and saved to `{baseName}_images/`.
 * Returns the path of the generated .md file.
 */
export async function xlsxToMarkdown(
  data: Uint8Array,
  xlsxPath: string
): Promise<ConvertResult> {
  const {
    parseWorkbook,
    convertWorkbookToMarkdownFiles,
    createCombinedMarkdownExportFile,
    createExportEntries,
  } = await import("@/vendor/xlsx2md");

  // Derive output paths (same pattern as docxToMarkdown.ts lines 20-23)
  const dir = xlsxPath.replace(/[\\/][^\\/]*$/, "");
  const baseName = xlsxPath
    .replace(/^.*[\\/]/, "")
    .replace(/\.(xlsx|xlsm)$/i, "");
  const imagesDir = `${dir}/${baseName}_images`;
  const mdPath = `${dir}/${baseName}.md`;

  // Parse workbook from binary data
  const workbook = await parseWorkbook(data.buffer as ArrayBuffer, baseName);

  // Convert all sheets to markdown
  const files = convertWorkbookToMarkdownFiles(workbook, {
    formattingMode: "github",
    tableDetectionMode: "balanced",
    treatFirstRowAsHeader: true,
    trimText: true,
    removeEmptyRows: true,
    removeEmptyColumns: true,
  });

  // Get combined markdown text (all sheets merged)
  const combined = createCombinedMarkdownExportFile(workbook, files);

  // Extract image/chart/shape assets
  const entries = createExportEntries(workbook, files);
  const imageEntries = entries.filter(
    (e) => !e.path.endsWith(".md")
  );

  // Save images if any
  if (imageEntries.length > 0) {
    await mkdir(imagesDir, { recursive: true });
    for (const entry of imageEntries) {
      const fileName = entry.path.replace(/^.*[\\/]/, "");
      await writeFile(`${imagesDir}/${fileName}`, entry.data);
    }
  }

  // Save .md file
  await writeTextFile(mdPath, combined.content);

  return { mdPath };
}
```

**Note:** If API signatures differ from expectations (verified in Task 2 Step 3), adjust the function calls accordingly. Specifically:
- If `createCombinedMarkdownExportFile` takes only `(files)`, remove the `workbook` argument
- If `createExportEntries` takes only `(files)`, remove the `workbook` argument
- If the combined result property is `text` instead of `content`, adjust `combined.content` to `combined.text`

- [ ] **Step 2: Commit**

```bash
git add src/features/export/lib/xlsxToMarkdown.ts
git commit -m "feat: add xlsxToMarkdown conversion wrapper"
```

---

### Task 5: Modify PreviewPanel.tsx

**Files:**
- Modify: `src/features/preview/components/PreviewPanel.tsx` (lines 640-692)

- [ ] **Step 1: Add `isXlsx` variable**

At line 642 in `PreviewPanel.tsx`, after the existing `isPdf` declaration, add the `isXlsx` variable:

```typescript
// Existing (lines 640-642):
  const isOfficeFile = !!(activeTab?.binaryData && activeTab?.officeFileType);
  const isDocx = activeTab?.filePath?.toLowerCase().endsWith(".docx");
  const isPdf = activeTab?.filePath?.toLowerCase().endsWith(".pdf");

// Add after line 642:
  const isXlsx =
    activeTab?.filePath?.toLowerCase().endsWith(".xlsx") ||
    activeTab?.filePath?.toLowerCase().endsWith(".xlsm");
```

- [ ] **Step 2: Add xlsx branch in `handleConvertToMarkdown`**

In the `handleConvertToMarkdown` callback (lines 644-663), add an xlsx branch. The existing code has an if/else for PDF vs DOCX. Add xlsx as a third branch:

```typescript
// Replace the try block content (lines 649-655) with:
      let mdPath: string;
      if (activeTab.filePath.toLowerCase().endsWith(".pdf")) {
        const { pdfToMarkdown } = await import(
          "@/features/export/lib/pdfToMarkdown"
        );
        ({ mdPath } = await pdfToMarkdown(
          activeTab.binaryData,
          activeTab.filePath
        ));
      } else if (
        activeTab.filePath.toLowerCase().endsWith(".xlsx") ||
        activeTab.filePath.toLowerCase().endsWith(".xlsm")
      ) {
        const { xlsxToMarkdown } = await import(
          "@/features/export/lib/xlsxToMarkdown"
        );
        ({ mdPath } = await xlsxToMarkdown(
          activeTab.binaryData,
          activeTab.filePath
        ));
      } else {
        ({ mdPath } = await docxToMarkdown(
          activeTab.binaryData,
          activeTab.filePath
        ));
      }
```

- [ ] **Step 3: Extend convert-bar visibility condition**

At line 669, change the condition to include xlsx:

```typescript
// Before:
        {(isDocx || isPdf) && (

// After:
        {(isDocx || isPdf || isXlsx) && (
```

- [ ] **Step 4: Commit**

```bash
git add src/features/preview/components/PreviewPanel.tsx
git commit -m "feat: add xlsx/xlsm conversion button to preview panel"
```

---

### Task 6: Build verification

- [ ] **Step 1: Run TypeScript compilation check**

```bash
npx tsc --noEmit
```

Expected: No type errors. If there are errors related to the xlsx2md vendor types, adjust `src/vendor/xlsx2md.d.ts` accordingly.

- [ ] **Step 2: Run Vite build**

```bash
npm run build
```

Expected: Build succeeds. The vendored `xlsx2md.js` should be bundled by Vite without issues.

- [ ] **Step 3: Run existing tests**

```bash
npm test
```

Expected: All existing tests pass (this change should not break any existing tests).

- [ ] **Step 4: Final commit if any fixes were needed**

If any adjustments were required during verification, commit them:

```bash
git add -A
git commit -m "fix: adjust xlsx2md integration for build compatibility"
```
