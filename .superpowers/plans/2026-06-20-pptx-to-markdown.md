# PPTX→Markdown 一括変換 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 一括変換機能に PowerPoint (.pptx) → Markdown 変換を追加する。

**Architecture:** PPTX は XML の ZIP。ロジックは純粋関数モジュール `pptxParser.ts`（DOMParser でスライド XML を解析し中間モデル → Markdown 文字列を生成。fs/jszip 非依存、happy-dom 環境で単体テスト可能）と、薄いオーケストレータ `pptxToMarkdown.ts`（JSZip で展開し、`@tauri-apps/plugin-fs` で書き出し）に分離する。配線は既存の docx/xlsx/pdf と同じ型ベースディスパッチに `"pptx"` を足す。

**Tech Stack:** TypeScript, React 19, Tauri v2, JSZip (既存依存), DOMParser (WebView/happy-dom 標準), Vitest 4, react-i18next。

## Global Constraints

- 新規 npm / Cargo 依存を追加しない（`jszip` は既存、`DOMParser` は標準）。
- すべてのコードコメントは英語で書く。
- UI に表示される文字列・生成 Markdown 内のラベルはハードコード禁止。i18n (`t()`) 経由で渡す。
- 全変換は WebView (TypeScript) 側で完結。Rust 側の変更は行わない（既存の `{stem}.md` 存在チェックは拡張子非依存のため不要）。
- 既存パターン踏襲: 変換器は `ConvertResult { mdPath: string }` を返す。出力パス計算・画像保存・`.mdium` 切替は `docxToMarkdown.ts` と同一ロジック。
- パーサ単体テストは先頭に `// @vitest-environment happy-dom` を付ける（DOMParser のため）。
- テスト実行: `npm run test`（= `vitest run`）。単一ファイル: `npx vitest run <path>`。
- 型チェック: `npx tsc --noEmit`。

---

### Task 1: パーサ骨格 — スライド見出しと箇条書き

中間モデル型・`parseSlide`・`renderSlides` を定義し、タイトル(`##` / フォールバック)と段落の箇条書き(ネスト対応)を実装する。

**Files:**
- Create: `src/features/export/lib/pptxParser.ts`
- Test: `src/features/export/lib/__tests__/pptxParser.test.ts`

**Interfaces:**
- Consumes: なし。
- Produces:
  ```ts
  export type PptxBlock =
    | { kind: "bullets"; items: { text: string; level: number }[] }
    | { kind: "table"; rows: string[][] }
    | { kind: "image"; mediaPath: string }; // e.g. "ppt/media/image1.png"

  export interface PptxSlide {
    title: string | null;
    blocks: PptxBlock[];
    notes: string | null;
  }

  export interface SlideSource {
    slideXml: string;
    relsXml: string | null;  // ppt/slides/_rels/slideN.xml.rels
    notesXml: string | null; // 解決済み notesSlide XML（無ければ null）
  }

  export interface PptxLabels {
    slideFallback: (n: number) => string; // n は 1 始まり
    notes: string;                        // 例: "ノート:"
  }

  export interface RenderedImage { mediaPath: string; fileName: string }

  export function parseSlide(src: SlideSource): PptxSlide;
  export function renderSlides(
    slides: PptxSlide[],
    baseName: string,
    labels: PptxLabels,
  ): { markdown: string; images: RenderedImage[] };
  ```

- [ ] **Step 1: 失敗するテストを書く**

`src/features/export/lib/__tests__/pptxParser.test.ts`:
```ts
// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { parseSlide, renderSlides } from "../pptxParser";

const labels = { slideFallback: (n: number) => `スライド ${n}`, notes: "ノート:" };

// Minimal slide XML helper: a title placeholder + body paragraphs.
function slideXml(body: string): string {
  return `<?xml version="1.0"?>
  <p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
         xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
    <p:cSld><p:spTree>${body}</p:spTree></p:cSld>
  </p:sld>`;
}
const titleSp = (t: string) =>
  `<p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
   <p:txBody><a:p><a:r><a:t>${t}</a:t></a:r></a:p></p:txBody></p:sp>`;
const bodySp = (paras: string) =>
  `<p:sp><p:nvSpPr><p:nvPr/></p:nvSpPr><p:txBody>${paras}</p:txBody></p:sp>`;
const para = (text: string, lvl?: number) =>
  `<a:p>${lvl ? `<a:pPr lvl="${lvl}"/>` : ""}<a:r><a:t>${text}</a:t></a:r></a:p>`;

describe("pptxParser: title + bullets", () => {
  it("uses title placeholder as heading and paragraphs as nested bullets", () => {
    const slide = parseSlide({
      slideXml: slideXml(titleSp("My Title") + bodySp(para("First") + para("Child", 1))),
      relsXml: null,
      notesXml: null,
    });
    const { markdown } = renderSlides([slide], "deck", labels);
    expect(markdown).toContain("## My Title");
    expect(markdown).toContain("- First");
    expect(markdown).toContain("  - Child");
  });

  it("falls back to slideFallback label when no title placeholder", () => {
    const slide = parseSlide({
      slideXml: slideXml(bodySp(para("Only body"))),
      relsXml: null,
      notesXml: null,
    });
    const { markdown } = renderSlides([slide], "deck", labels);
    expect(markdown).toContain("## スライド 1");
  });

  it("separates multiple slides with a horizontal rule", () => {
    const s = parseSlide({ slideXml: slideXml(bodySp(para("x"))), relsXml: null, notesXml: null });
    const { markdown } = renderSlides([s, s], "deck", labels);
    expect(markdown).toContain("\n---\n");
  });
});
```

- [ ] **Step 2: テストが失敗するのを確認**

Run: `npx vitest run src/features/export/lib/__tests__/pptxParser.test.ts`
Expected: FAIL（`parseSlide` is not a function / module not found）

- [ ] **Step 3: 最小実装を書く**

`src/features/export/lib/pptxParser.ts`:
```ts
// Pure PPTX → Markdown logic. No filesystem or JSZip access; operates on
// already-extracted XML strings so it can be unit-tested under happy-dom.

export type PptxBlock =
  | { kind: "bullets"; items: { text: string; level: number }[] }
  | { kind: "table"; rows: string[][] }
  | { kind: "image"; mediaPath: string };

export interface PptxSlide {
  title: string | null;
  blocks: PptxBlock[];
  notes: string | null;
}

export interface SlideSource {
  slideXml: string;
  relsXml: string | null;
  notesXml: string | null;
}

export interface PptxLabels {
  slideFallback: (n: number) => string;
  notes: string;
}

export interface RenderedImage {
  mediaPath: string;
  fileName: string;
}

const A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main";

function parseXml(xml: string): Document {
  return new DOMParser().parseFromString(xml, "application/xml");
}

// Concatenate all <a:t> text inside a paragraph, treating <a:br> as a space.
function paragraphText(p: Element): string {
  let out = "";
  for (const node of Array.from(p.childNodes)) {
    if (node.nodeType !== 1) continue;
    const el = node as Element;
    if (el.localName === "r") {
      const t = el.getElementsByTagNameNS(A_NS, "t")[0];
      if (t) out += t.textContent ?? "";
    } else if (el.localName === "br") {
      out += " ";
    }
  }
  return out.trim();
}

function paragraphLevel(p: Element): number {
  const pPr = p.getElementsByTagNameNS(A_NS, "pPr")[0];
  const lvl = pPr?.getAttribute("lvl");
  return lvl ? parseInt(lvl, 10) || 0 : 0;
}

// True when this shape carries a title/ctrTitle placeholder.
function isTitleShape(sp: Element): boolean {
  const ph = sp.getElementsByTagName("p:ph")[0] ?? sp.getElementsByTagNameNS(
    "http://schemas.openxmlformats.org/presentationml/2006/main",
    "ph",
  )[0];
  const type = ph?.getAttribute("type");
  return type === "title" || type === "ctrTitle";
}

function shapeBullets(sp: Element): PptxBlock | null {
  const items: { text: string; level: number }[] = [];
  for (const p of Array.from(sp.getElementsByTagNameNS(A_NS, "p"))) {
    const text = paragraphText(p);
    if (text) items.push({ text, level: paragraphLevel(p) });
  }
  return items.length ? { kind: "bullets", items } : null;
}

export function parseSlide(src: SlideSource): PptxSlide {
  const doc = parseXml(src.slideXml);
  const spTree = doc.getElementsByTagName("p:spTree")[0];
  let title: string | null = null;
  const blocks: PptxBlock[] = [];

  if (spTree) {
    for (const sp of Array.from(spTree.getElementsByTagName("p:sp"))) {
      if (title === null && isTitleShape(sp)) {
        const p = sp.getElementsByTagNameNS(A_NS, "p")[0];
        title = p ? paragraphText(p) : "";
        continue;
      }
      const bullets = shapeBullets(sp);
      if (bullets) blocks.push(bullets);
    }
  }

  return { title: title || null, blocks, notes: null };
}

function escapeCell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

export function renderSlides(
  slides: PptxSlide[],
  baseName: string,
  labels: PptxLabels,
): { markdown: string; images: RenderedImage[] } {
  const images: RenderedImage[] = [];
  const mediaToName = new Map<string, string>();
  const parts: string[] = [];

  slides.forEach((slide, idx) => {
    const lines: string[] = [];
    lines.push(`## ${slide.title ?? labels.slideFallback(idx + 1)}`);

    for (const block of slide.blocks) {
      if (block.kind === "bullets") {
        lines.push("");
        for (const item of block.items) {
          lines.push(`${"  ".repeat(item.level)}- ${item.text}`);
        }
      } else if (block.kind === "table") {
        lines.push("");
        lines.push(...renderTable(block.rows));
      } else if (block.kind === "image") {
        let name = mediaToName.get(block.mediaPath);
        if (!name) {
          const ext = block.mediaPath.split(".").pop() || "png";
          name = `image${mediaToName.size + 1}.${ext}`;
          mediaToName.set(block.mediaPath, name);
          images.push({ mediaPath: block.mediaPath, fileName: name });
        }
        lines.push("");
        lines.push(`![](${baseName}_images/${name})`);
      }
    }

    if (slide.notes) {
      lines.push("");
      lines.push(`> **${labels.notes}** ${slide.notes.replace(/\n/g, " ")}`);
    }

    parts.push(lines.join("\n"));
  });

  const markdown = parts.join("\n\n---\n\n") + "\n";
  return { markdown, images };
}

function renderTable(rows: string[][]): string[] {
  if (!rows.length) return [];
  const out: string[] = [];
  const header = rows[0];
  out.push(`| ${header.map(escapeCell).join(" | ")} |`);
  out.push(`| ${header.map(() => "---").join(" | ")} |`);
  for (const row of rows.slice(1)) {
    out.push(`| ${row.map(escapeCell).join(" | ")} |`);
  }
  return out;
}
```

- [ ] **Step 4: テストが通るのを確認**

Run: `npx vitest run src/features/export/lib/__tests__/pptxParser.test.ts`
Expected: PASS（3 tests）

- [ ] **Step 5: コミット**

```bash
git add src/features/export/lib/pptxParser.ts src/features/export/lib/__tests__/pptxParser.test.ts
git commit -m "feat(pptx): add parser skeleton with slide heading and bullets"
```

---

### Task 2: 表（テーブル）の抽出

`<a:tbl>` を `PptxBlock { kind: "table" }` として spTree 出現順に取り込む。

**Files:**
- Modify: `src/features/export/lib/pptxParser.ts`（`parseSlide` のループにテーブル抽出を追加）
- Test: `src/features/export/lib/__tests__/pptxParser.test.ts`（追記）

**Interfaces:**
- Consumes: Task 1 の `parseSlide` / `renderSlides` / `renderTable`。
- Produces: 既存型のまま（`PptxBlock` の `table` を実際に生成）。

- [ ] **Step 1: 失敗するテストを追記**

`pptxParser.test.ts` に追加:
```ts
describe("pptxParser: tables", () => {
  const tableFrame = `
    <p:graphicFrame><a:graphic><a:graphicData>
      <a:tbl>
        <a:tr><a:tc><a:txBody><a:p><a:r><a:t>H1</a:t></a:r></a:p></a:txBody></a:tc>
              <a:tc><a:txBody><a:p><a:r><a:t>H2</a:t></a:r></a:p></a:txBody></a:tc></a:tr>
        <a:tr><a:tc><a:txBody><a:p><a:r><a:t>a|b</a:t></a:r></a:p></a:txBody></a:tc>
              <a:tc><a:txBody><a:p><a:r><a:t>d</a:t></a:r></a:p></a:txBody></a:tc></a:tr>
      </a:tbl>
    </a:graphicData></a:graphic></p:graphicFrame>`;

  function frameSlide(frame: string) {
    return `<?xml version="1.0"?>
      <p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
             xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
        <p:cSld><p:spTree>${frame}</p:spTree></p:cSld></p:sld>`;
  }

  it("converts a:tbl to a Markdown table with header row and escaped pipes", () => {
    const slide = parseSlide({ slideXml: frameSlide(tableFrame), relsXml: null, notesXml: null });
    const { markdown } = renderSlides([slide], "deck", { slideFallback: (n) => `S${n}`, notes: "N:" });
    expect(markdown).toContain("| H1 | H2 |");
    expect(markdown).toContain("| --- | --- |");
    expect(markdown).toContain("| a\\|b | d |");
  });
});
```

- [ ] **Step 2: 失敗を確認**

Run: `npx vitest run src/features/export/lib/__tests__/pptxParser.test.ts -t tables`
Expected: FAIL（テーブルが出力されない）

- [ ] **Step 3: 実装を追加**

`pptxParser.ts` の `parseSlide` を、spTree 直下の子要素を出現順に走査する形へ変更する。既存の `for (const sp of ...getElementsByTagName("p:sp"))` ループを次で置き換える:
```ts
  if (spTree) {
    for (const node of Array.from(spTree.childNodes)) {
      if (node.nodeType !== 1) continue;
      const el = node as Element;

      if (el.localName === "sp") {
        if (title === null && isTitleShape(el)) {
          const p = el.getElementsByTagNameNS(A_NS, "p")[0];
          title = p ? paragraphText(p) : "";
          continue;
        }
        const bullets = shapeBullets(el);
        if (bullets) blocks.push(bullets);
      } else if (el.localName === "graphicFrame") {
        const tbl = el.getElementsByTagNameNS(A_NS, "tbl")[0];
        if (tbl) blocks.push(parseTable(tbl));
      }
    }
  }
```

そして同ファイルにヘルパを追加:
```ts
// Extract an <a:tbl> into a rows-of-cells matrix.
function parseTable(tbl: Element): PptxBlock {
  const rows: string[][] = [];
  for (const tr of Array.from(tbl.getElementsByTagNameNS(A_NS, "tr"))) {
    const cells: string[] = [];
    for (const tc of Array.from(tr.getElementsByTagNameNS(A_NS, "tc"))) {
      const texts = Array.from(tc.getElementsByTagNameNS(A_NS, "p"))
        .map((p) => paragraphText(p))
        .filter(Boolean);
      cells.push(texts.join(" "));
    }
    rows.push(cells);
  }
  return { kind: "table", rows };
}
```

- [ ] **Step 4: テスト通過を確認**

Run: `npx vitest run src/features/export/lib/__tests__/pptxParser.test.ts`
Expected: PASS（既存 + 新規すべて）

- [ ] **Step 5: コミット**

```bash
git add src/features/export/lib/pptxParser.ts src/features/export/lib/__tests__/pptxParser.test.ts
git commit -m "feat(pptx): extract a:tbl tables in slide appearance order"
```

---

### Task 3: 画像参照の抽出と rels 解決

`<p:pic>` の `r:embed` を slide rels で media パスに解決し、`PptxBlock { kind: "image" }` を生成。`renderSlides` は media パス単位で連番ファイル名を割り当て重複排除する（Task 1 で実装済みのロジックを実データで検証）。

**Files:**
- Modify: `src/features/export/lib/pptxParser.ts`（rels 解決ヘルパ + `<p:pic>` 抽出）
- Test: `src/features/export/lib/__tests__/pptxParser.test.ts`（追記）

**Interfaces:**
- Consumes: Task 1/2。
- Produces: `parseSlide` が `SlideSource.relsXml` を使い image block を `mediaPath`（`ppt/media/...` 正規化済み）で生成。`renderSlides` の戻り `images: RenderedImage[]` が一意。

- [ ] **Step 1: 失敗するテストを追記**

```ts
describe("pptxParser: images", () => {
  const picSlide = `<?xml version="1.0"?>
    <p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
           xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
           xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
      <p:cSld><p:spTree>
        <p:pic><p:blipFill><a:blip r:embed="rId2"/></p:blipFill></p:pic>
        <p:pic><p:blipFill><a:blip r:embed="rId2"/></p:blipFill></p:pic>
      </p:spTree></p:cSld></p:sld>`;
  const rels = `<?xml version="1.0"?>
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/>
    </Relationships>`;

  it("resolves r:embed to media path, dedupes by media, and emits one image file", () => {
    const slide = parseSlide({ slideXml: picSlide, relsXml: rels, notesXml: null });
    const { markdown, images } = renderSlides([slide], "deck", { slideFallback: (n) => `S${n}`, notes: "N:" });
    expect(markdown).toContain("![](deck_images/image1.png)");
    expect(images).toEqual([{ mediaPath: "ppt/media/image1.png", fileName: "image1.png" }]);
  });
});
```

- [ ] **Step 2: 失敗を確認**

Run: `npx vitest run src/features/export/lib/__tests__/pptxParser.test.ts -t images`
Expected: FAIL（image block 未生成）

- [ ] **Step 3: 実装を追加**

`pptxParser.ts` に rels パースと正規化ヘルパを追加:
```ts
const R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

// Map relationship Id -> Target (raw, relative to ppt/slides/).
function parseRels(relsXml: string | null): Map<string, string> {
  const map = new Map<string, string>();
  if (!relsXml) return map;
  const doc = parseXml(relsXml);
  for (const rel of Array.from(doc.getElementsByTagName("Relationship"))) {
    const id = rel.getAttribute("Id");
    const target = rel.getAttribute("Target");
    if (id && target) map.set(id, target);
  }
  return map;
}

// "../media/image1.png" (relative to ppt/slides/) -> "ppt/media/image1.png".
function resolveMediaPath(target: string): string {
  const cleaned = target.replace(/^\.\//, "");
  if (cleaned.startsWith("../")) return `ppt/${cleaned.slice(3)}`;
  if (cleaned.startsWith("/")) return cleaned.slice(1);
  return `ppt/slides/${cleaned}`;
}
```

`parseSlide` を rels 対応に変更する。冒頭で rels をパースし、走査ループに `<p:pic>` 分岐を追加:
```ts
export function parseSlide(src: SlideSource): PptxSlide {
  const doc = parseXml(src.slideXml);
  const rels = parseRels(src.relsXml);
  const spTree = doc.getElementsByTagName("p:spTree")[0];
  let title: string | null = null;
  const blocks: PptxBlock[] = [];

  if (spTree) {
    for (const node of Array.from(spTree.childNodes)) {
      if (node.nodeType !== 1) continue;
      const el = node as Element;

      if (el.localName === "sp") {
        if (title === null && isTitleShape(el)) {
          const p = el.getElementsByTagNameNS(A_NS, "p")[0];
          title = p ? paragraphText(p) : "";
          continue;
        }
        const bullets = shapeBullets(el);
        if (bullets) blocks.push(bullets);
      } else if (el.localName === "graphicFrame") {
        const tbl = el.getElementsByTagNameNS(A_NS, "tbl")[0];
        if (tbl) blocks.push(parseTable(tbl));
      } else if (el.localName === "pic") {
        const blip = el.getElementsByTagNameNS(A_NS, "blip")[0];
        const rId = blip?.getAttributeNS(R_NS, "embed") ?? blip?.getAttribute("r:embed");
        const target = rId ? rels.get(rId) : undefined;
        if (target) blocks.push({ kind: "image", mediaPath: resolveMediaPath(target) });
      }
    }
  }

  return { title: title || null, blocks, notes: null };
}
```

- [ ] **Step 4: テスト通過を確認**

Run: `npx vitest run src/features/export/lib/__tests__/pptxParser.test.ts`
Expected: PASS（すべて）

- [ ] **Step 5: コミット**

```bash
git add src/features/export/lib/pptxParser.ts src/features/export/lib/__tests__/pptxParser.test.ts
git commit -m "feat(pptx): resolve p:pic images via slide rels with dedup"
```

---

### Task 4: スピーカーノートの抽出

`SlideSource.notesXml`（解決済み）から本文プレースホルダのテキストを取り、`PptxSlide.notes` に格納。`renderSlides` は引用ブロックで末尾に付加（Task 1 実装済み）。

**Files:**
- Modify: `src/features/export/lib/pptxParser.ts`（`parseSlide` に notes 抽出）
- Test: `src/features/export/lib/__tests__/pptxParser.test.ts`（追記）

**Interfaces:**
- Consumes: Task 1–3。
- Produces: `parseSlide` が `notesXml` を解析し `notes` を設定。

- [ ] **Step 1: 失敗するテストを追記**

```ts
describe("pptxParser: speaker notes", () => {
  const simpleSlide = `<?xml version="1.0"?>
    <p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
           xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
      <p:cSld><p:spTree>
        <p:sp><p:nvSpPr><p:nvPr/></p:nvSpPr><p:txBody>
          <a:p><a:r><a:t>Body</a:t></a:r></a:p></p:txBody></p:sp>
      </p:spTree></p:cSld></p:sld>`;
  const notesXml = `<?xml version="1.0"?>
    <p:notes xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
             xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
      <p:cSld><p:spTree>
        <p:sp><p:nvSpPr><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr><p:txBody>
          <a:p><a:r><a:t>Remember the demo</a:t></a:r></a:p></p:txBody></p:sp>
      </p:spTree></p:cSld></p:notes>`;

  it("emits notes as a quote block when present", () => {
    const slide = parseSlide({ slideXml: simpleSlide, relsXml: null, notesXml });
    const { markdown } = renderSlides([slide], "deck", { slideFallback: (n) => `S${n}`, notes: "ノート:" });
    expect(markdown).toContain("> **ノート:** Remember the demo");
  });

  it("emits no notes line when notesXml is null", () => {
    const slide = parseSlide({ slideXml: simpleSlide, relsXml: null, notesXml: null });
    const { markdown } = renderSlides([slide], "deck", { slideFallback: (n) => `S${n}`, notes: "ノート:" });
    expect(markdown).not.toContain("ノート:");
  });
});
```

- [ ] **Step 2: 失敗を確認**

Run: `npx vitest run src/features/export/lib/__tests__/pptxParser.test.ts -t notes`
Expected: FAIL（notes 未抽出）

- [ ] **Step 3: 実装を追加**

`pptxParser.ts` に notes 抽出ヘルパを追加:
```ts
const P_NS = "http://schemas.openxmlformats.org/presentationml/2006/main";

// Extract body-placeholder text from a notesSlide, skipping non-body
// placeholders (slide-number, date, etc.). Paragraphs joined by newlines.
function parseNotes(notesXml: string | null): string | null {
  if (!notesXml) return null;
  const doc = parseXml(notesXml);
  const lines: string[] = [];
  for (const sp of Array.from(doc.getElementsByTagNameNS(P_NS, "sp"))) {
    const ph = sp.getElementsByTagNameNS(P_NS, "ph")[0];
    const type = ph?.getAttribute("type");
    if (type && type !== "body") continue;
    for (const p of Array.from(sp.getElementsByTagNameNS(A_NS, "p"))) {
      const text = paragraphText(p);
      if (text) lines.push(text);
    }
  }
  return lines.length ? lines.join("\n") : null;
}
```

`parseSlide` の `return` を変更:
```ts
  return { title: title || null, blocks, notes: parseNotes(src.notesXml) };
```

- [ ] **Step 4: テスト通過を確認**

Run: `npx vitest run src/features/export/lib/__tests__/pptxParser.test.ts`
Expected: PASS（すべて）

- [ ] **Step 5: コミット**

```bash
git add src/features/export/lib/pptxParser.ts src/features/export/lib/__tests__/pptxParser.test.ts
git commit -m "feat(pptx): extract speaker notes body text"
```

---

### Task 5: オーケストレータ `pptxToMarkdown.ts`

JSZip で `.pptx` を展開し、`presentation.xml` のスライド提示順を解決、各スライドの rels/notes を集めて `parseSlide`→`renderSlides`、画像と `.md` を fs に書き出す。

**Files:**
- Create: `src/features/export/lib/pptxToMarkdown.ts`
- Test: `src/features/export/lib/__tests__/pptxToMarkdown.test.ts`

**Interfaces:**
- Consumes: `pptxParser.ts` の `parseSlide` / `renderSlides` / 型 `PptxLabels` / `SlideSource`。
- Produces:
  ```ts
  export interface ConvertResult { mdPath: string }
  export type { PptxLabels } from "./pptxParser";
  export async function pptxToMarkdown(
    data: Uint8Array,
    pptxPath: string,
    saveToMdium: boolean,
    labels: import("./pptxParser").PptxLabels,
  ): Promise<ConvertResult>;
  ```

- [ ] **Step 1: 失敗するテストを書く**

`src/features/export/lib/__tests__/pptxToMarkdown.test.ts`:
```ts
// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";

const writeTextFile = vi.fn(async () => {});
const writeFile = vi.fn(async () => {});
const mkdir = vi.fn(async () => {});
vi.mock("@tauri-apps/plugin-fs", () => ({ writeTextFile, writeFile, mkdir }));

import JSZip from "jszip";
import { pptxToMarkdown } from "../pptxToMarkdown";

const labels = { slideFallback: (n: number) => `スライド ${n}`, notes: "ノート:" };

// Build a minimal two-slide pptx where presentation order is slide2 then slide1.
async function buildPptx(): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file(
    "ppt/presentation.xml",
    `<?xml version="1.0"?>
     <p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
                     xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
       <p:sldIdLst><p:sldId r:id="rA"/><p:sldId r:id="rB"/></p:sldIdLst>
     </p:presentation>`,
  );
  zip.file(
    "ppt/_rels/presentation.xml.rels",
    `<?xml version="1.0"?>
     <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
       <Relationship Id="rA" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/>
       <Relationship Id="rB" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
     </Relationships>`,
  );
  const sld = (t: string) =>
    `<?xml version="1.0"?>
     <p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
            xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
       <p:cSld><p:spTree>
         <p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
           <p:txBody><a:p><a:r><a:t>${t}</a:t></a:r></a:p></p:txBody></p:sp>
       </p:spTree></p:cSld></p:sld>`;
  zip.file("ppt/slides/slide1.xml", sld("First"));
  zip.file("ppt/slides/slide2.xml", sld("Second"));
  return zip.generateAsync({ type: "uint8array" });
}

describe("pptxToMarkdown orchestrator", () => {
  beforeEach(() => { writeTextFile.mockClear(); writeFile.mockClear(); mkdir.mockClear(); });

  it("writes a .md honoring presentation slide order", async () => {
    const data = await buildPptx();
    const res = await pptxToMarkdown(data, "/decks/talk.pptx", false, labels);
    expect(res.mdPath).toBe("/decks/talk.md");
    const md = writeTextFile.mock.calls[0][1] as string;
    expect(md.indexOf("## Second")).toBeLessThan(md.indexOf("## First"));
  });
});
```

- [ ] **Step 2: 失敗を確認**

Run: `npx vitest run src/features/export/lib/__tests__/pptxToMarkdown.test.ts`
Expected: FAIL（module not found）

- [ ] **Step 3: 実装を書く**

`src/features/export/lib/pptxToMarkdown.ts`:
```ts
import JSZip from "jszip";
import { writeTextFile, writeFile, mkdir } from "@tauri-apps/plugin-fs";
import { parseSlide, renderSlides, type PptxLabels, type SlideSource } from "./pptxParser";

export interface ConvertResult {
  mdPath: string;
}
export type { PptxLabels } from "./pptxParser";

const R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

function parseXml(xml: string): Document {
  return new DOMParser().parseFromString(xml, "application/xml");
}

// Ordered list of slide zip paths, following presentation.xml sldIdLst.
function resolveSlideOrder(presentationXml: string, presRels: string): string[] {
  const relMap = new Map<string, string>();
  for (const rel of Array.from(parseXml(presRels).getElementsByTagName("Relationship"))) {
    const id = rel.getAttribute("Id");
    const target = rel.getAttribute("Target");
    if (id && target) relMap.set(id, target.replace(/^\//, ""));
  }
  const order: string[] = [];
  const doc = parseXml(presentationXml);
  for (const sldId of Array.from(doc.getElementsByTagName("p:sldId"))) {
    const rId = sldId.getAttributeNS(R_NS, "id") ?? sldId.getAttribute("r:id");
    const target = rId ? relMap.get(rId) : undefined;
    if (target) order.push(target.startsWith("ppt/") ? target : `ppt/${target}`);
  }
  return order;
}

// Find the notesSlide target inside a slide's rels, normalized to a zip path.
function findNotesTarget(slideRels: string | null): string | null {
  if (!slideRels) return null;
  for (const rel of Array.from(parseXml(slideRels).getElementsByTagName("Relationship"))) {
    if ((rel.getAttribute("Type") ?? "").endsWith("/notesSlide")) {
      const target = rel.getAttribute("Target") ?? "";
      const cleaned = target.replace(/^\.\//, "");
      return cleaned.startsWith("../") ? `ppt/${cleaned.slice(3)}` : `ppt/slides/${cleaned}`;
    }
  }
  return null;
}

export async function pptxToMarkdown(
  data: Uint8Array,
  pptxPath: string,
  saveToMdium: boolean,
  labels: PptxLabels,
): Promise<ConvertResult> {
  const sep = pptxPath.includes("\\") ? "\\" : "/";
  const dir = pptxPath.replace(/[\\/][^\\/]*$/, "");
  const baseName = pptxPath.replace(/^.*[\\/]/, "").replace(/\.pptx$/i, "");
  const outputDir = saveToMdium ? `${dir}${sep}.mdium` : dir;
  const imagesDir = `${outputDir}${sep}${baseName}_images`;
  const mdPath = `${outputDir}${sep}${baseName}.md`;

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
    if (!slideXml) continue;
    const relsPath = slidePath.replace(/slides\/([^/]+)$/, "slides/_rels/$1.rels");
    const relsXml = await readText(relsPath);
    const notesPath = findNotesTarget(relsXml);
    const notesXml = notesPath ? await readText(notesPath) : null;
    const src: SlideSource = { slideXml, relsXml, notesXml };
    slides.push(parseSlide(src));
  }

  const { markdown, images } = renderSlides(slides, baseName, labels);

  if (images.length > 0) {
    await mkdir(imagesDir, { recursive: true });
    for (const img of images) {
      const f = zip.file(img.mediaPath);
      if (!f) continue;
      const bytes = await f.async("uint8array");
      await writeFile(`${imagesDir}${sep}${img.fileName}`, bytes);
    }
  }

  if (saveToMdium) {
    await mkdir(outputDir, { recursive: true });
  }

  await writeTextFile(mdPath, markdown);
  return { mdPath };
}
```

- [ ] **Step 4: テスト通過を確認**

Run: `npx vitest run src/features/export/lib/__tests__/pptxToMarkdown.test.ts`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add src/features/export/lib/pptxToMarkdown.ts src/features/export/lib/__tests__/pptxToMarkdown.test.ts
git commit -m "feat(pptx): add JSZip orchestrator with presentation order and fs output"
```

---

### Task 6: ファイル収集に `.pptx` を追加

`collectConvertibleFiles.ts` の型・拡張子判定・filter プルーニングに `"pptx"` を通す。

**Files:**
- Modify: `src/features/export/lib/collectConvertibleFiles.ts`
- Test: `src/features/export/lib/__tests__/collectConvertibleFiles.pptx.test.ts`

**Interfaces:**
- Consumes: 既存 `FileEntry`。
- Produces: `ConvertibleFile.type` と `ConvertibleTreeNode.fileType` に `"pptx"`、`pruneTreeByFilter` の filter 引数に `"pptx"`。

- [ ] **Step 1: 失敗するテストを書く**

`src/features/export/lib/__tests__/collectConvertibleFiles.pptx.test.ts`:
```ts
// @vitest-environment node
import { describe, it, expect } from "vitest";
import { collectConvertibleFiles, buildConvertibleTree, pruneTreeByFilter } from "../collectConvertibleFiles";
import type { FileEntry } from "@/shared/types";

const tree: FileEntry[] = [
  { name: "deck.pptx", path: "/r/deck.pptx", is_dir: false } as FileEntry,
  { name: "doc.docx", path: "/r/doc.docx", is_dir: false } as FileEntry,
];

describe("collectConvertibleFiles: pptx", () => {
  it("detects .pptx as type pptx", () => {
    const files = collectConvertibleFiles(tree);
    expect(files.find((f) => f.name === "deck.pptx")?.type).toBe("pptx");
  });

  it("filters the convertible tree by pptx", () => {
    const built = buildConvertibleTree(tree);
    const pruned = pruneTreeByFilter(built, "pptx");
    expect(pruned).toHaveLength(1);
    expect(pruned[0].name).toBe("deck.pptx");
  });
});
```

- [ ] **Step 2: 失敗を確認**

Run: `npx vitest run src/features/export/lib/__tests__/collectConvertibleFiles.pptx.test.ts`
Expected: FAIL（type が pptx にならない / 型エラー）

- [ ] **Step 3: 実装を変更**

`collectConvertibleFiles.ts` で以下を変更（`"docx" | "pdf" | "xlsx"` を `"docx" | "pdf" | "xlsx" | "pptx"` に統一）:

1. `ConvertibleFile.type`（3 行目付近）:
```ts
  type: "docx" | "pdf" | "xlsx" | "pptx";
```
2. `walkTree` 内の判定（`let type: ... = null;` ブロック）に追加:
```ts
    let type: "docx" | "pdf" | "xlsx" | "pptx" | null = null;
    if (lower.endsWith(".docx")) type = "docx";
    else if (lower.endsWith(".pdf")) type = "pdf";
    else if (lower.endsWith(".xlsx") || lower.endsWith(".xlsm") || lower.endsWith(".xls")) type = "xlsx";
    else if (lower.endsWith(".pptx")) type = "pptx";
```
3. `ConvertibleTreeNode.fileType`:
```ts
  fileType?: "docx" | "pdf" | "xlsx" | "pptx";
```
4. `buildConvertibleTree` 内の `let fileType: ... = null;` 判定に追加:
```ts
    let fileType: "docx" | "pdf" | "xlsx" | "pptx" | null = null;
    if (lower.endsWith(".docx")) fileType = "docx";
    else if (lower.endsWith(".pdf")) fileType = "pdf";
    else if (
      lower.endsWith(".xlsx") ||
      lower.endsWith(".xlsm") ||
      lower.endsWith(".xls")
    )
      fileType = "xlsx";
    else if (lower.endsWith(".pptx")) fileType = "pptx";
```
5. `pruneTreeByFilter` の `filter` 引数型:
```ts
  filter: "all" | "docx" | "pdf" | "xlsx" | "pptx"
```

- [ ] **Step 4: テスト通過を確認**

Run: `npx vitest run src/features/export/lib/__tests__/collectConvertibleFiles.pptx.test.ts`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add src/features/export/lib/collectConvertibleFiles.ts src/features/export/lib/__tests__/collectConvertibleFiles.pptx.test.ts
git commit -m "feat(pptx): detect .pptx files in batch convert collection"
```

---

### Task 7: ディスパッチ・UI・i18n の配線

`useBatchConvert` に pptx 分岐（labels を `t()` から構築）、`BatchConvertModal` にフィルタタブ、ja/en の i18n キーを追加。

**Files:**
- Modify: `src/features/export/hooks/useBatchConvert.ts`
- Modify: `src/features/export/components/BatchConvertModal.tsx`
- Modify: `src/shared/i18n/locales/ja/common.json`
- Modify: `src/shared/i18n/locales/en/common.json`

**Interfaces:**
- Consumes: Task 5 の `pptxToMarkdown(data, path, saveToMdium, labels)`、Task 6 の `type: "pptx"`。
- Produces: なし（最終配線）。

- [ ] **Step 1: i18n キーを追加**

`src/shared/i18n/locales/ja/common.json` の `batchConvertFilterPdf` 行の直後に追加:
```json
  "batchConvertFilterPptx": "PowerPoint",
  "pptxSlideLabel": "スライド {{n}}",
  "pptxNotesLabel": "ノート:",
```
`src/shared/i18n/locales/en/common.json` の `batchConvertFilterPdf` 行の直後に追加:
```json
  "batchConvertFilterPptx": "PowerPoint",
  "pptxSlideLabel": "Slide {{n}}",
  "pptxNotesLabel": "Notes:",
```

- [ ] **Step 2: `useBatchConvert` に pptx 分岐を追加**

`src/features/export/hooks/useBatchConvert.ts`:

先頭付近の import に追加:
```ts
import { useTranslation } from "react-i18next";
```
`useBatchConvert` 本体先頭（`const [isConverting...` の前）に追加:
```ts
  const { t } = useTranslation("common");
```
`convert` の `useCallback` 内、`} else if (file.type === "xlsx") {` ブロックの直後に分岐を追加:
```ts
          } else if (file.type === "pptx") {
            const { pptxToMarkdown } = await import("../lib/pptxToMarkdown");
            const result = await pptxToMarkdown(data, file.path, saveToMdium, {
              slideFallback: (n: number) => t("pptxSlideLabel", { n }),
              notes: t("pptxNotesLabel"),
            });
            results.push({ file, status: "success", mdPath: result.mdPath });
```
`useCallback` の依存配列 `[]` を `[t]` に変更:
```ts
    [t]
  );
```

- [ ] **Step 3: `BatchConvertModal` にフィルタタブを追加**

`src/features/export/components/BatchConvertModal.tsx`:

`FilterTab` 型（16 行目）:
```ts
type FilterTab = "all" | "docx" | "pdf" | "xlsx" | "pptx";
```
フィルタボタン配列（372 行目付近）:
```tsx
          {(["all", "docx", "xlsx", "pptx", "pdf"] as FilterTab[]).map((tab) => (
```
ラベルの三項（378 行目付近）を pptx 対応へ:
```tsx
              {tab === "all"
                ? t("batchConvertFilterAll")
                : tab === "docx"
                  ? t("batchConvertFilterDocx")
                  : tab === "xlsx"
                    ? t("batchConvertFilterXlsx")
                    : tab === "pptx"
                      ? t("batchConvertFilterPptx")
                      : t("batchConvertFilterPdf")}
```

- [ ] **Step 4: 型チェックと全テストを実行**

Run: `npx tsc --noEmit`
Expected: エラーなし

Run: `npm run test`
Expected: 全 PASS（既存 + 新規）

- [ ] **Step 5: コミット**

```bash
git add src/features/export/hooks/useBatchConvert.ts src/features/export/components/BatchConvertModal.tsx src/shared/i18n/locales/ja/common.json src/shared/i18n/locales/en/common.json
git commit -m "feat(pptx): wire pptx dispatch, filter tab, and i18n labels"
```

---

## 手動検証（実装完了後）

1. `npm run tauri dev` でアプリ起動。
2. 一括変換ダイアログを開き、`.pptx` を含むフォルダを選択。
3. PowerPoint フィルタタブに `.pptx` が表示されることを確認。
4. 変換実行 → 生成 `.md` に見出し/箇条書き/表/画像リンク/ノートが含まれ、`{name}_images/` に画像が出力されることを確認。
5. 日本語/英語両方でラベル（フィルタ名・ノート見出し・スライドフォールバック）が切り替わることを確認。
