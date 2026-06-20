# PPTX プレビュー Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `.pptx` を開いたとき、PPTX→Markdown 変換と同じ見た目でプレビュー表示する。

**Architecture:** PPTX をメモリ上で Markdown 化（画像は data URL で埋め込み、ディスク書き込みなし）し、既存の Markdown 描画パイプライン（`renderMarkdownWithSourceLines` → `marked` → DOM 注入）にそのまま流す。変換ロジックは `pptxToMarkdown.ts` から共通コア `extractPptxMarkdown` を抽出して DRY 化。`.pptx` は専用フラグ `pptxFileType` のバイナリタブで開き、PreviewPanel 内で非同期生成して描画に分岐入力する（ビュー専用、元 `.pptx` を上書きしない）。

**Tech Stack:** TypeScript, React 19, Tauri v2, JSZip（既存）, DOMParser, `marked`（既存の Markdown 描画）, Vitest 4 + happy-dom, react-i18next。

## Global Constraints

- 新規 npm / Cargo 依存を追加しない（`jszip` は既存、`DOMParser`/`btoa` は標準）。
- すべてのコードコメントは英語で書く。
- UI 表示文字列はハードコード禁止、i18n (`t()`) 経由。スライド/ノートのラベルは既存キー `pptxSlideLabel`（"スライド {{n}}" / "Slide {{n}}"）と `pptxNotesLabel`（"ノート:" / "Notes:"）を再利用。
- プレビューはディスクに書き込まない（`.md` も `_images/` も生成しない）。ビュー専用で元 `.pptx` を上書きしない。
- `pptxToMarkdown` の公開シグネチャ・外部挙動は不変（共通コア抽出は内部リファクタ）。
- happy-dom 20.8.9 は `getElementsByTagNameNS`/`getAttributeNS` が壊れている。既存コードは prefix 付き `getElementsByTagName` / 修飾名 `getAttribute("r:id")` を使う。新規コードもこれを踏襲（XML を新規にパースする箇所がある場合）。
- パーサ/プレビューの単体テストは先頭に `// @vitest-environment happy-dom` を付ける。
- テスト実行: `npm run test`（= `vitest run`）。単一ファイル: `npx vitest run <path>`。型チェック: `npx tsc --noEmit`。

---

### Task 1: 共通コア `extractPptxMarkdown` を抽出

`pptxToMarkdown.ts` から「JSZip 展開〜`renderSlides`」の共通コアを named export として切り出し、既存 `pptxToMarkdown` をそれを使う形にリファクタする。外部挙動は不変。

**Files:**
- Modify: `src/features/export/lib/pptxToMarkdown.ts`
- Test: `src/features/export/lib/__tests__/extractPptxMarkdown.test.ts`

**Interfaces:**
- Consumes: `parseSlide`, `renderSlides`, `PptxLabels`, `SlideSource`, `RenderedImage`（`pptxParser.ts`）。
- Produces:
  ```ts
  export interface ExtractedPptx {
    zip: JSZip;
    markdown: string;
    images: import("./pptxParser").RenderedImage[];
  }
  export async function extractPptxMarkdown(
    data: Uint8Array,
    baseName: string,
    labels: PptxLabels,
  ): Promise<ExtractedPptx>;
  ```

- [ ] **Step 1: 失敗するテストを書く**

`src/features/export/lib/__tests__/extractPptxMarkdown.test.ts`:
```ts
// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import JSZip from "jszip";
import { extractPptxMarkdown } from "../pptxToMarkdown";

const labels = { slideFallback: (n: number) => `スライド ${n}`, notes: "ノート:" };

async function buildPptx(): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file(
    "ppt/presentation.xml",
    `<?xml version="1.0"?>
     <p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
                     xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
       <p:sldIdLst><p:sldId r:id="rA"/></p:sldIdLst>
     </p:presentation>`,
  );
  zip.file(
    "ppt/_rels/presentation.xml.rels",
    `<?xml version="1.0"?>
     <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
       <Relationship Id="rA" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
     </Relationships>`,
  );
  zip.file(
    "ppt/slides/slide1.xml",
    `<?xml version="1.0"?>
     <p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
            xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
       <p:cSld><p:spTree>
         <p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
           <p:txBody><a:p><a:r><a:t>Hello</a:t></a:r></a:p></p:txBody></p:sp>
       </p:spTree></p:cSld></p:sld>`,
  );
  return zip.generateAsync({ type: "uint8array" });
}

describe("extractPptxMarkdown", () => {
  it("returns markdown and the loaded zip without writing files", async () => {
    const data = await buildPptx();
    const result = await extractPptxMarkdown(data, "pptx", labels);
    expect(result.markdown).toContain("## Hello");
    expect(result.zip.file("ppt/slides/slide1.xml")).not.toBeNull();
    expect(Array.isArray(result.images)).toBe(true);
  });

  it("throws on a pptx missing presentation.xml", async () => {
    const empty = await new JSZip().generateAsync({ type: "uint8array" });
    await expect(extractPptxMarkdown(empty, "pptx", labels)).rejects.toThrow();
  });
});
```

- [ ] **Step 2: テストが失敗するのを確認**

Run: `npx vitest run src/features/export/lib/__tests__/extractPptxMarkdown.test.ts`
Expected: FAIL（`extractPptxMarkdown` is not exported）

- [ ] **Step 3: リファクタを実装**

`src/features/export/lib/pptxToMarkdown.ts` を次のように変更する。`import` 行に `RenderedImage` を追加し、共通コアを抽出する:

`import` 行を:
```ts
import { parseSlide, renderSlides, type PptxLabels, type SlideSource, type RenderedImage } from "./pptxParser";
```
に変更（`RenderedImage` が `pptxParser.ts` から export されていない場合は、`pptxParser.ts` に `export` を追加すること。型 `RenderedImage { mediaPath: string; fileName: string }` は既存）。

`pptxToMarkdown` 関数の手前に共通コアを追加:
```ts
export interface ExtractedPptx {
  zip: JSZip;
  markdown: string;
  images: RenderedImage[];
}

// Load a pptx and render it to Markdown + image list, without any I/O.
// Returns the loaded zip so callers can pull image bytes (write to disk vs. inline).
export async function extractPptxMarkdown(
  data: Uint8Array,
  baseName: string,
  labels: PptxLabels,
): Promise<ExtractedPptx> {
  const zip = await JSZip.loadAsync(data);
  const readText = async (p: string): Promise<string | null> => {
    const f = zip.file(p);
    return f ? f.async("text") : null;
  };

  const presentationXml = await readText("ppt/presentation.xml");
  const presRels = await readText("ppt/_rels/presentation.xml.rels");
  if (!presentationXml || !presRels) {
    throw new Error("Invalid PPTX: missing presentation.xml");
  }

  const slideOrder = resolveSlideOrder(presentationXml, presRels);
  const slides = [];
  for (const slidePath of slideOrder) {
    const slideXml = await readText(slidePath);
    if (!slideXml) continue; // Skip slides whose XML is missing rather than crash
    const relsPath = slidePath.replace(/slides\/([^/]+)$/, "slides/_rels/$1.rels");
    const relsXml = await readText(relsPath);
    const notesPath = findNotesTarget(relsXml);
    const notesXml = notesPath ? await readText(notesPath) : null;
    const src: SlideSource = { slideXml, relsXml, notesXml };
    slides.push(parseSlide(src));
  }

  const { markdown, images } = renderSlides(slides, baseName, labels);
  return { zip, markdown, images };
}
```

`pptxToMarkdown` 本体を共通コア利用へ置き換える。`const zip = ...` から `const { markdown, images } = renderSlides(...)` までを削除し、次に置き換える:
```ts
export async function pptxToMarkdown(
  data: Uint8Array,
  pptxPath: string,
  saveToMdium: boolean,
  labels: PptxLabels,
): Promise<ConvertResult> {
  // Derive output paths (preserve input path separator so the result matches
  // the OS-native paths delivered by the file tree — otherwise a mixed
  // separator path creates duplicate tabs when the same file is reopened).
  const sep = pptxPath.includes("\\") ? "\\" : "/";
  const dir = pptxPath.replace(/[\\/][^\\/]*$/, "");
  const baseName = pptxPath.replace(/^.*[\\/]/, "").replace(/\.pptx$/i, "");
  const outputDir = saveToMdium ? `${dir}${sep}.mdium` : dir;
  const imagesDir = `${outputDir}${sep}${baseName}_images`;
  const mdPath = `${outputDir}${sep}${baseName}.md`;

  const { zip, markdown, images } = await extractPptxMarkdown(data, baseName, labels);

  if (images.length > 0) {
    await mkdir(imagesDir, { recursive: true });
    for (const img of images) {
      const f = zip.file(img.mediaPath);
      if (!f) continue; // Skip images whose media file is absent in the zip
      const bytes = await f.async("uint8array");
      await writeFile(`${imagesDir}${sep}${img.fileName}`, bytes);
    }
  }

  // Ensure output dir exists (needed when saving into .mdium/)
  if (saveToMdium) {
    await mkdir(outputDir, { recursive: true });
  }

  // Save .md file
  await writeTextFile(mdPath, markdown);
  return { mdPath };
}
```

`resolveSlideOrder` と `findNotesTarget` と `parseXml` は既存のまま（共通コアから参照される）。

- [ ] **Step 4: テスト通過を確認（新規 + 既存リグレッション）**

Run: `npx vitest run src/features/export/lib/__tests__/extractPptxMarkdown.test.ts src/features/export/lib/__tests__/pptxToMarkdown.test.ts`
Expected: PASS（新規 2 件 + 既存 pptxToMarkdown テストが緑のまま）

- [ ] **Step 5: コミット**

```bash
git add src/features/export/lib/pptxToMarkdown.ts src/features/export/lib/pptxParser.ts src/features/export/lib/__tests__/extractPptxMarkdown.test.ts
git commit -m "refactor(pptx): extract shared extractPptxMarkdown core"
```

---

### Task 2: プレビュー用 `pptxToMarkdownPreview`

PPTX バイナリから「画像を data URL で埋め込んだ自己完結 Markdown 文字列」を生成する。ディスク書き込みなし。

**Files:**
- Create: `src/features/export/lib/pptxToMarkdownPreview.ts`
- Test: `src/features/export/lib/__tests__/pptxToMarkdownPreview.test.ts`

**Interfaces:**
- Consumes: `extractPptxMarkdown`（Task 1）, `PptxLabels`（`pptxParser.ts`）。
- Produces:
  ```ts
  export async function pptxToMarkdownPreview(
    data: Uint8Array,
    labels: import("./pptxParser").PptxLabels,
  ): Promise<string>;
  ```

- [ ] **Step 1: 失敗するテストを書く**

`src/features/export/lib/__tests__/pptxToMarkdownPreview.test.ts`:
```ts
// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import JSZip from "jszip";
import { pptxToMarkdownPreview } from "../pptxToMarkdownPreview";

const labels = { slideFallback: (n: number) => `スライド ${n}`, notes: "ノート:" };

// One slide with a title, a picture (rId2 -> media/image1.png), and notes.
async function buildPptxWithImage(): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file(
    "ppt/presentation.xml",
    `<?xml version="1.0"?>
     <p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
                     xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
       <p:sldIdLst><p:sldId r:id="rA"/></p:sldIdLst>
     </p:presentation>`,
  );
  zip.file(
    "ppt/_rels/presentation.xml.rels",
    `<?xml version="1.0"?>
     <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
       <Relationship Id="rA" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
     </Relationships>`,
  );
  zip.file(
    "ppt/slides/slide1.xml",
    `<?xml version="1.0"?>
     <p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
            xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
            xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
       <p:cSld><p:spTree>
         <p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
           <p:txBody><a:p><a:r><a:t>Deck</a:t></a:r></a:p></p:txBody></p:sp>
         <p:pic><p:blipFill><a:blip r:embed="rId2"/></p:blipFill></p:pic>
       </p:spTree></p:cSld></p:sld>`,
  );
  zip.file(
    "ppt/slides/_rels/slide1.xml.rels",
    `<?xml version="1.0"?>
     <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
       <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/>
       <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide1.xml"/>
     </Relationships>`,
  );
  zip.file(
    "ppt/notesSlides/notesSlide1.xml",
    `<?xml version="1.0"?>
     <p:notes xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
              xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
       <p:cSld><p:spTree>
         <p:sp><p:nvSpPr><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr>
           <p:txBody><a:p><a:r><a:t>Talk slowly</a:t></a:r></a:p></p:txBody></p:sp>
       </p:spTree></p:cSld></p:notes>`,
  );
  // 1x1 PNG bytes
  zip.file("ppt/media/image1.png", new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
  return zip.generateAsync({ type: "uint8array" });
}

describe("pptxToMarkdownPreview", () => {
  it("inlines images as data URLs and leaves no relative image refs", async () => {
    const data = await buildPptxWithImage();
    const md = await pptxToMarkdownPreview(data, labels);
    expect(md).toContain("## Deck");
    expect(md).toContain("data:image/png;base64,");
    expect(md).not.toContain("pptx_images/");
    expect(md).toContain("> **ノート:** Talk slowly");
  });

  it("rejects an invalid pptx missing presentation.xml", async () => {
    const empty = await new JSZip().generateAsync({ type: "uint8array" });
    await expect(pptxToMarkdownPreview(empty, labels)).rejects.toThrow();
  });
});
```

- [ ] **Step 2: 失敗を確認**

Run: `npx vitest run src/features/export/lib/__tests__/pptxToMarkdownPreview.test.ts`
Expected: FAIL（module not found）

- [ ] **Step 3: 実装を書く**

`src/features/export/lib/pptxToMarkdownPreview.ts`:
```ts
import { extractPptxMarkdown } from "./pptxToMarkdown";
import type { PptxLabels } from "./pptxParser";

// Fixed baseName for preview: image refs (`pptx_images/...`) are all replaced
// with data URLs below, so the value only needs to be stable, not meaningful.
const PREVIEW_BASE = "pptx";

const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  bmp: "image/bmp",
  svg: "image/svg+xml",
  webp: "image/webp",
};

// Encode bytes to base64 in chunks (avoids call-stack limits on large images).
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// Render a pptx (binary) to a self-contained Markdown string for preview:
// images are inlined as data URLs, nothing is written to disk.
export async function pptxToMarkdownPreview(
  data: Uint8Array,
  labels: PptxLabels,
): Promise<string> {
  const { zip, markdown, images } = await extractPptxMarkdown(data, PREVIEW_BASE, labels);

  let out = markdown;
  for (const img of images) {
    const f = zip.file(img.mediaPath);
    if (!f) continue; // Media absent in the zip — leave ref out of replacement
    const bytes = await f.async("uint8array");
    const ext = img.fileName.split(".").pop()?.toLowerCase() ?? "png";
    const mime = IMAGE_MIME[ext] ?? "image/png";
    const dataUrl = `data:${mime};base64,${bytesToBase64(bytes)}`;
    out = out.split(`${PREVIEW_BASE}_images/${img.fileName}`).join(dataUrl);
  }
  return out;
}
```

- [ ] **Step 4: テスト通過を確認**

Run: `npx vitest run src/features/export/lib/__tests__/pptxToMarkdownPreview.test.ts`
Expected: PASS（2 件）

- [ ] **Step 5: コミット**

```bash
git add src/features/export/lib/pptxToMarkdownPreview.ts src/features/export/lib/__tests__/pptxToMarkdownPreview.test.ts
git commit -m "feat(pptx): add in-memory pptxToMarkdownPreview with data-URL images"
```

---

### Task 3: 拡張子判定・Tab 型・ファイルオープン配線

`.pptx` を認識する getter を追加し、Tab 型に `pptxFileType` を足し、`App.tsx` で `.pptx` をバイナリタブとして開く。

**Files:**
- Modify: `src/shared/lib/constants.ts`
- Modify: `src/shared/lib/__tests__/constants.test.ts`
- Modify: `src/stores/tab-store.ts`
- Modify: `src/app/App.tsx`

**Interfaces:**
- Consumes: 既存 `openTab`, `read_binary_file`。
- Produces: `getPptxExt(filePath): string | null`、`Tab.pptxFileType?: ".pptx"`。

- [ ] **Step 1: 失敗するテストを書く**

`src/shared/lib/__tests__/constants.test.ts` に追記（既存 import の `getOfficeExt` 等の隣に `getPptxExt` を追加 import）:
```ts
import { getPptxExt } from "../constants";

describe("getPptxExt", () => {
  it("matches .pptx case-insensitively", () => {
    expect(getPptxExt("/a/Deck.PPTX")).toBe(".pptx");
    expect(getPptxExt("/a/deck.pptx")).toBe(".pptx");
  });
  it("returns null for non-pptx", () => {
    expect(getPptxExt("/a/deck.docx")).toBeNull();
    expect(getPptxExt("/a/deck.md")).toBeNull();
  });
});
```

- [ ] **Step 2: 失敗を確認**

Run: `npx vitest run src/shared/lib/__tests__/constants.test.ts`
Expected: FAIL（`getPptxExt` is not exported）

- [ ] **Step 3: 実装を変更**

`src/shared/lib/constants.ts`:

`PDF_EXTENSIONS` 付近に追加:
```ts
export const PPTX_EXTENSIONS = [".pptx"];
```
`getPdfExt` の隣に getter を追加:
```ts
export function getPptxExt(filePath: string): string | null {
  const lower = filePath.toLowerCase();
  return PPTX_EXTENSIONS.find((ext) => lower.endsWith(ext)) ?? null;
}
```
`isCodeFile` に pptx 除外を追加（`getPdfExt` 行の直後）:
```ts
  if (getPptxExt(lower)) return false;
```

`src/stores/tab-store.ts` の `Tab` インターフェース、`csvFileType` の直後に追加:
```ts
  /** PowerPoint file extension (preview-only, rendered as markdown) */
  pptxFileType?: ".pptx";
```

`src/app/App.tsx`:

`handleFileSelect` 冒頭の ext 判定群（`const pdfExt = getPdfExt(filePath);` 付近）に追加:
```ts
        const pptxExt = getPptxExt(filePath);
```
（`getPptxExt` を `@/shared/lib/constants` の import に追加すること。）

ディスパッチで `.pptx` を `officeExt` より**前**に処理する（`.pptx` が誤って office 扱いにならないようにする。現状 `OFFICE_EXTENSIONS` に `.pptx` は無いが、明示優先で安全側に）。`if (pdfExt) {` ブロックの直後に分岐を追加:
```ts
        } else if (pptxExt) {
          // PPTX: open as a binary tab; PreviewPanel renders it as markdown.
          const bytes = await invoke<number[]>("read_binary_file", { path: filePath });
          const binaryData = new Uint8Array(bytes);
          openTab({
            filePath,
            folderPath: activeFolderPath ?? "",
            fileName,
            content: "",
            binaryData,
            pptxFileType: ".pptx",
          });
```
（注: 既存チェーンは `if (pdfExt) { ... } else if (officeExt) { ... }`。`pptxExt` 分岐は `pdfExt` の後・`officeExt` の前に挿入する。）

末尾の `setEditorVisible` 行は変更不要（`.pptx` は `isMd` 偽・`csvExt` 偽のため `false` になりエディタ非表示）。

- [ ] **Step 4: テスト通過と型チェック**

Run: `npx vitest run src/shared/lib/__tests__/constants.test.ts`
Expected: PASS

Run: `npx tsc --noEmit`
Expected: エラーなし

- [ ] **Step 5: コミット**

```bash
git add src/shared/lib/constants.ts src/shared/lib/__tests__/constants.test.ts src/stores/tab-store.ts src/app/App.tsx
git commit -m "feat(pptx): open .pptx as preview-only binary tab"
```

---

### Task 4: PreviewPanel でプレビュー Markdown を生成・描画

`isPptx` を検出し、非同期で `pptxToMarkdownPreview` を呼び、生成 Markdown を既存の Markdown 描画エフェクトに流す。ローディング/エラーを表示する。

**Files:**
- Modify: `src/features/preview/components/PreviewPanel.tsx`
- Modify: `src/shared/i18n/locales/ja/editor.json`
- Modify: `src/shared/i18n/locales/en/editor.json`

**Interfaces:**
- Consumes: `pptxToMarkdownPreview`（Task 2）, `Tab.pptxFileType`（Task 3）, 既存 i18n キー `pptxSlideLabel`/`pptxNotesLabel`（`common` 名前空間）。
- Produces: なし（最終配線）。

注意（実装前に必ず確認）:
- `PreviewPanel` の `useTranslation` は `"editor"` 名前空間（`PreviewPanel.tsx:223`）。スライド/ノートのラベルキーは `common` 名前空間にあるため、`t("pptxSlideLabel", ...)` ではなく**明示的に common から引く**。`react-i18next` では `t("common:pptxSlideLabel", { n })` のように名前空間プレフィックスで参照できる。実装では下記のとおり `t("common:pptxSlideLabel", { n })` / `t("common:pptxNotesLabel")` を使う。
- 既存 `isRenderableMarkdown`（`PreviewPanel.tsx:254-259`）は `binaryData` を持つタブを除外する。pptx タブは `binaryData` を持つため、別途 pptx 用の描画ゲートを設ける（下記）。

- [ ] **Step 1: i18n（ローディング/エラー文言）を追加**

`src/shared/i18n/locales/ja/editor.json` に追加（既存 `renderError` の近く）:
```json
  "pptxPreviewLoading": "PowerPoint を読み込み中…",
  "pptxPreviewError": "PowerPoint の表示に失敗しました",
```
`src/shared/i18n/locales/en/editor.json` に追加:
```json
  "pptxPreviewLoading": "Loading PowerPoint…",
  "pptxPreviewError": "Failed to render PowerPoint",
```

- [ ] **Step 2: import と状態・生成エフェクトを追加**

`src/features/preview/components/PreviewPanel.tsx`:

ファイル上部の import に追加:
```ts
import { pptxToMarkdownPreview } from "@/features/export/lib/pptxToMarkdownPreview";
```

`PreviewPanel` 本体、`isRenderableMarkdown` 定義（254 行付近）の直後に追加:
```ts
  // PPTX preview: render the file as in-memory markdown (data-URL images).
  const isPptx = !!(activeTab?.binaryData && activeTab?.pptxFileType);
  const [pptxMarkdown, setPptxMarkdown] = useState<string | null>(null);
  const [pptxLoading, setPptxLoading] = useState(false);
  const [pptxError, setPptxError] = useState<string | null>(null);

  useEffect(() => {
    if (!isPptx || !activeTab?.binaryData) {
      setPptxMarkdown(null);
      setPptxLoading(false);
      setPptxError(null);
      return;
    }
    let cancelled = false;
    setPptxLoading(true);
    setPptxError(null);
    setPptxMarkdown(null);
    const data = activeTab.binaryData;
    pptxToMarkdownPreview(data, {
      slideFallback: (n: number) => t("common:pptxSlideLabel", { n }),
      notes: t("common:pptxNotesLabel"),
    })
      .then((md) => {
        if (!cancelled) setPptxMarkdown(md);
      })
      .catch(() => {
        if (!cancelled) setPptxError(t("pptxPreviewError"));
      })
      .finally(() => {
        if (!cancelled) setPptxLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isPptx, activeTab?.filePath, activeTab?.binaryData, t]);
```

- [ ] **Step 3: 描画ソースとゲートを pptx 対応にする**

同ファイルで、既存 Markdown 描画エフェクト（`PreviewPanel.tsx:653`）と HTML 注入エフェクト（673 行）が `content` / `isRenderableMarkdown` を使う箇所を、pptx を含むよう拡張する。

`isRenderableMarkdown` 定義の直後（Step 2 で追加した state の後）に派生値を追加:
```ts
  // When pptx markdown is ready, render it through the same markdown pipeline.
  const renderAsMarkdown = isRenderableMarkdown || (isPptx && pptxMarkdown != null);
  const markdownSource = isPptx ? (pptxMarkdown ?? "") : content;
```

描画エフェクト（653 行）を次のように変更:
- `if (!isRenderableMarkdown) {` → `if (!renderAsMarkdown) {`
- `const { meta, body, bodyLineOffset } = splitFrontMatter(content);` → `... splitFrontMatter(markdownSource);`
- 依存配列 `[content, isRenderableMarkdown, t]` → `[markdownSource, renderAsMarkdown, t]`

HTML 注入エフェクト（673 行）の依存配列 `[html, filePath]` はそのまま（`html` 変化で再注入される）。`filePath` を使う相対画像解決は pptx では data URL のため `continue` され無害。変更不要。

- [ ] **Step 4: JSX で pptx タブに Markdown ビューを表示**

同ファイルのディスパッチ JSX（984 行以降）を確認し、pptx タブ（`isPptx`）が **既定の Markdown コンテンツ表示（`contentRef` の div）に到達する**ようにする。pptx タブは `officeFileType`/`csvFileType` 等を持たないため office/csv 分岐には入らないが、既定の Markdown ビューが `isRenderableMarkdown` でガードされている場合は `renderAsMarkdown` も許可するよう条件を広げる。

加えて、`isPptx` のとき以下を表示する（Markdown ビュー本体の手前、同じスクロール領域内）:
```tsx
{isPptx && pptxLoading && (
  <div className="preview-panel__pptx-status">{t("pptxPreviewLoading")}</div>
)}
{isPptx && pptxError && (
  <div className="preview-panel__pptx-status preview-panel__pptx-status--error">{pptxError}</div>
)}
```
（クラス名は既存のステータス/エラー表示に倣う。専用 CSS が必要なら最小限を `PreviewPanel.css` に追加。文言は必ず i18n。）

実装方針: 既存の Markdown レンダリング JSX ブロックの表示条件に `|| isPptx` を加え、`contentRef` の div が pptx でも描画されるようにする。生成完了後 `pptxMarkdown` が `html` に反映され、変換と同じ見た目で表示される。

- [ ] **Step 5: 型チェックと全テストを実行**

Run: `npx tsc --noEmit`
Expected: エラーなし

Run: `npm run test`
Expected: 全 PASS（既存 + Task 1–3 の新規）

- [ ] **Step 6: コミット**

```bash
git add src/features/preview/components/PreviewPanel.tsx src/features/preview/components/PreviewPanel.css src/shared/i18n/locales/ja/editor.json src/shared/i18n/locales/en/editor.json
git commit -m "feat(pptx): render .pptx as markdown preview in PreviewPanel"
```

---

## 手動検証（実装完了後）

1. `npm run tauri dev` でアプリ起動。
2. ファイルツリーで `.pptx` をクリック → プレビューペインにスライド内容が `---` 区切りで表示される（ローディング表示の後）。
3. 同じ `.pptx` を一括変換した `.md` のプレビューと**見た目が一致**することを確認（見出し/箇条書き/表/画像/ノート）。
4. 画像がインライン表示され、`.mdium` や `_images` フォルダが**生成されない**ことを確認。
5. 日本語/英語でスライドフォールバック・ノートラベル・ローディング/エラー文言が切り替わること。
6. プレビュータブで編集不可・元 `.pptx` が上書きされないこと。壊れた/空の `.pptx` でエラー表示が出ること。
