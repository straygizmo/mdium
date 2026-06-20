# PPTX プレビュー AI 意味解釈 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** PPTX プレビューに「AI で図を解釈」オプトインを追加し、各スライドの図形配置・コネクタを LLM に解釈させて、原文の下に「AI 解釈」（Mermaid/要約）を併記する。

**Architecture:** AI ペイロード用に位置・コネクタを抽出する純粋関数 `extractPptxLayout`（既存の決定論パースは不変）。`pptxAiEnrich` が決定論プレビュー MD（`pptxToMarkdownPreview`）とレイアウトを取り、スライド単位で既存ワンショット `callAI`（`invoke("ai_chat")`、reqwest 経由でプロキシ安全）を並列に呼び、各スライド末尾に「### AI 解釈」を挿入した強化 MD を返す。PreviewPanel にオプトインボタンと原文↔AI トグルを追加し、既存 Markdown 描画パイプライン（Mermaid 対応）に流す。

**Tech Stack:** TypeScript, React 19, Tauri v2, JSZip（既存）, DOMParser, `callAI`/`ai_chat`（既存）, Vitest 4 + happy-dom, react-i18next。

## Global Constraints

- 新規 npm / Cargo 依存を追加しない。
- すべてのコードコメントは英語で書く。
- UI 表示文字列はハードコード禁止、i18n (`t()`) 経由。
- 既存の決定論パース／レンダリング（`pptxParser.ts` / `pptxToMarkdown.ts` / `pptxToMarkdownPreview.ts`）の外部挙動は変更しない。
- LLM 呼び出しは既存の `callAI(settings, systemPrompt, userContent, maxTokens?)`（`src/shared/lib/callAI.ts`）を使う。WebView から直接 fetch しない（プロキシでハングするため必ず `callAI` 経由）。
- プレビューはディスクに書き込まない。ビュー専用で元 `.pptx` を上書きしない。
- happy-dom 20.8.9 は `getElementsByTagNameNS`/`getAttributeNS` が壊れている。prefix 付き `getElementsByTagName` / 修飾名 `getAttribute("r:id")` を使う。
- XML/レイアウトのテストは先頭に `// @vitest-environment happy-dom`。
- テスト実行: `npm run test`。単一: `npx vitest run <path>`。型チェック: `npx tsc --noEmit`。

---

### Task 1: レイアウト抽出 `extractPptxLayout`

各スライドの図形（id・テキスト・正規化位置）とコネクタ（矢印 from→to）を抽出する純粋関数。決定論パースは変更しない。

**Files:**
- Create: `src/features/export/lib/pptxLayout.ts`
- Modify: `src/features/export/lib/pptxToMarkdown.ts`（`resolveSlideOrder` を named export 化）
- Test: `src/features/export/lib/__tests__/pptxLayout.test.ts`

**Interfaces:**
- Consumes: `resolveSlideOrder`（`pptxToMarkdown.ts` から export）。
- Produces:
  ```ts
  export interface LayoutShape { id: string; text: string; x: number; y: number; w: number; h: number }
  export interface LayoutConnector { from: string | null; to: string | null }
  export interface SlideLayout { shapes: LayoutShape[]; connectors: LayoutConnector[] }
  export async function extractPptxLayout(data: Uint8Array): Promise<SlideLayout[]>;
  ```

- [ ] **Step 1: `resolveSlideOrder` を export 化**

`src/features/export/lib/pptxToMarkdown.ts` の `function resolveSlideOrder(` を
`export function resolveSlideOrder(` に変更する（実装は不変）。

- [ ] **Step 2: 失敗するテストを書く**

`src/features/export/lib/__tests__/pptxLayout.test.ts`:
```ts
// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import JSZip from "jszip";
import { extractPptxLayout } from "../pptxLayout";

// Slide size 9144000 x 6858000 EMU. Two shapes + one connector A->B.
async function buildPptx(): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file(
    "ppt/presentation.xml",
    `<?xml version="1.0"?>
     <p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
                     xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
       <p:sldSz cx="9144000" cy="6858000"/>
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
         <p:sp>
           <p:nvSpPr><p:cNvPr id="2" name="A"/></p:nvSpPr>
           <p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="4572000" cy="3429000"/></a:xfrm></p:spPr>
           <p:txBody><a:p><a:r><a:t>Start</a:t></a:r></a:p></p:txBody>
         </p:sp>
         <p:sp>
           <p:nvSpPr><p:cNvPr id="3" name="B"/></p:nvSpPr>
           <p:spPr><a:xfrm><a:off x="4572000" y="3429000"/><a:ext cx="4572000" cy="3429000"/></a:xfrm></p:spPr>
           <p:txBody><a:p><a:r><a:t>End</a:t></a:r></a:p></p:txBody>
         </p:sp>
         <p:cxnSp>
           <p:nvCxnSpPr><p:cNvPr id="4" name="c"/><p:cNvCxnSpPr>
             <a:stCxn id="2" idx="0"/><a:endCxn id="3" idx="0"/>
           </p:cNvCxnSpPr></p:nvCxnSpPr>
           <p:spPr/>
         </p:cxnSp>
       </p:spTree></p:cSld></p:sld>`,
  );
  return zip.generateAsync({ type: "uint8array" });
}

describe("extractPptxLayout", () => {
  it("extracts shapes with normalized positions and resolves connectors", async () => {
    const data = await buildPptx();
    const layouts = await extractPptxLayout(data);
    expect(layouts).toHaveLength(1);
    const { shapes, connectors } = layouts[0];
    expect(shapes.map((s) => s.text)).toEqual(["Start", "End"]);
    // Shape A at origin, half width/height -> 0,0,50,50
    expect(shapes[0]).toMatchObject({ id: "2", text: "Start", x: 0, y: 0, w: 50, h: 50 });
    // Shape B offset by half -> 50,50,50,50
    expect(shapes[1]).toMatchObject({ id: "3", x: 50, y: 50, w: 50, h: 50 });
    expect(connectors).toEqual([{ from: "2", to: "3" }]);
  });
});
```

- [ ] **Step 3: 失敗を確認**

Run: `npx vitest run src/features/export/lib/__tests__/pptxLayout.test.ts`
Expected: FAIL（module not found）

- [ ] **Step 4: 実装を書く**

`src/features/export/lib/pptxLayout.ts`:
```ts
import JSZip from "jszip";
import { resolveSlideOrder } from "./pptxToMarkdown";

export interface LayoutShape {
  id: string;
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface LayoutConnector {
  from: string | null;
  to: string | null;
}
export interface SlideLayout {
  shapes: LayoutShape[];
  connectors: LayoutConnector[];
}

function parseXml(xml: string): Document {
  return new DOMParser().parseFromString(xml, "application/xml");
}

// Slide size in EMU from presentation.xml; defaults to standard 16:9 if absent.
function slideSize(presentationXml: string): { cx: number; cy: number } {
  const sz = parseXml(presentationXml).getElementsByTagName("p:sldSz")[0];
  const cx = parseInt(sz?.getAttribute("cx") ?? "", 10) || 9144000;
  const cy = parseInt(sz?.getAttribute("cy") ?? "", 10) || 6858000;
  return { cx, cy };
}

// Concatenate a shape's txBody paragraph text (newline-joined).
function shapeText(sp: Element): string {
  const txBody = sp.getElementsByTagName("p:txBody")[0];
  if (!txBody) return "";
  const lines: string[] = [];
  for (const p of Array.from(txBody.getElementsByTagName("a:p"))) {
    let line = "";
    for (const t of Array.from(p.getElementsByTagName("a:t"))) line += t.textContent ?? "";
    if (line.trim()) lines.push(line.trim());
  }
  return lines.join("\n");
}

// Normalized bounding box (0-100) from a shape's a:xfrm, or zeros if absent.
function shapeBox(sp: Element, size: { cx: number; cy: number }): { x: number; y: number; w: number; h: number } {
  const xfrm = sp.getElementsByTagName("a:xfrm")[0];
  const off = xfrm?.getElementsByTagName("a:off")[0];
  const ext = xfrm?.getElementsByTagName("a:ext")[0];
  const ox = parseInt(off?.getAttribute("x") ?? "", 10) || 0;
  const oy = parseInt(off?.getAttribute("y") ?? "", 10) || 0;
  const ex = parseInt(ext?.getAttribute("cx") ?? "", 10) || 0;
  const ey = parseInt(ext?.getAttribute("cy") ?? "", 10) || 0;
  const round = (n: number) => Math.round(n * 10) / 10;
  return {
    x: round((ox / size.cx) * 100),
    y: round((oy / size.cy) * 100),
    w: round((ex / size.cx) * 100),
    h: round((ey / size.cy) * 100),
  };
}

function shapeId(sp: Element): string {
  const cNvPr = sp.getElementsByTagName("p:cNvPr")[0];
  return cNvPr?.getAttribute("id") ?? "";
}

// Recursively collect p:sp shapes (descending into p:grpSp groups).
function collectShapes(parent: Element, size: { cx: number; cy: number }, out: LayoutShape[]): void {
  for (const node of Array.from(parent.childNodes)) {
    if (node.nodeType !== 1) continue;
    const el = node as Element;
    if (el.localName === "sp") {
      const text = shapeText(el);
      const box = shapeBox(el, size);
      out.push({ id: shapeId(el), text, ...box });
    } else if (el.localName === "grpSp") {
      collectShapes(el, size, out);
    }
  }
}

function collectConnectors(spTree: Element): LayoutConnector[] {
  const connectors: LayoutConnector[] = [];
  for (const cxn of Array.from(spTree.getElementsByTagName("p:cxnSp"))) {
    const st = cxn.getElementsByTagName("a:stCxn")[0];
    const end = cxn.getElementsByTagName("a:endCxn")[0];
    connectors.push({ from: st?.getAttribute("id") ?? null, to: end?.getAttribute("id") ?? null });
  }
  return connectors;
}

export async function extractPptxLayout(data: Uint8Array): Promise<SlideLayout[]> {
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

  const size = slideSize(presentationXml);
  const slideOrder = resolveSlideOrder(presentationXml, presRels);
  const layouts: SlideLayout[] = [];
  for (const slidePath of slideOrder) {
    const slideXml = await readText(slidePath);
    if (!slideXml) continue;
    const spTree = parseXml(slideXml).getElementsByTagName("p:spTree")[0];
    if (!spTree) {
      layouts.push({ shapes: [], connectors: [] });
      continue;
    }
    const shapes: LayoutShape[] = [];
    collectShapes(spTree, size, shapes);
    layouts.push({ shapes, connectors: collectConnectors(spTree) });
  }
  return layouts;
}
```

- [ ] **Step 5: テスト通過を確認**

Run: `npx vitest run src/features/export/lib/__tests__/pptxLayout.test.ts`
Expected: PASS

- [ ] **Step 6: コミット**

```bash
git add src/features/export/lib/pptxLayout.ts src/features/export/lib/pptxToMarkdown.ts src/features/export/lib/__tests__/pptxLayout.test.ts
git commit -m "feat(pptx): extract slide layout (positions + connectors) for AI"
```

---

### Task 2: AI 強化アセンブリ `pptxToMarkdownPreviewEnriched`

決定論プレビュー MD とレイアウトを取り、スライド単位で `callAI` を並列に呼び、各スライド末尾に「### AI 解釈」を挿入する。

**Files:**
- Create: `src/features/export/lib/pptxAiEnrich.ts`
- Modify: `src/shared/lib/constants.ts`（システムプロンプト関数を追加）
- Test: `src/features/export/lib/__tests__/pptxAiEnrich.test.ts`

**Interfaces:**
- Consumes: `pptxToMarkdownPreview`（既存）, `extractPptxLayout`（Task 1）, `callAI`（`@/shared/lib/callAI`）, `useSettingsStore`（`@/stores/settings-store`）, `pptxAiEnrichSystemPrompt`（constants）, `PptxLabels`（`pptxParser`）。
- Produces:
  ```ts
  export interface EnrichLabels { aiSection: string; lang: string }
  export async function pptxToMarkdownPreviewEnriched(
    data: Uint8Array,
    labels: PptxLabels,
    enrich: EnrichLabels,
  ): Promise<string>;
  ```

- [ ] **Step 1: システムプロンプトを constants に追加**

`src/shared/lib/constants.ts` の末尾付近（他のプロンプト定数の近く）に追加:
```ts
// System prompt for interpreting a single PPTX slide's diagram (shapes with
// normalized positions + connector arrows) into Markdown/Mermaid.
export function pptxAiEnrichSystemPrompt(lang: string): string {
  return (
    "You are a diagram-analysis assistant for presentation slides. " +
    "You receive the shapes on ONE slide (each with normalized coordinates 0-100 and text) " +
    "and connectors (arrows as from->to shape ids). " +
    "Infer what the diagram is trying to convey from the spatial layout and arrows. " +
    "If it represents a flow, relationship, hierarchy, or comparison, express it as a Mermaid diagram " +
    "wrapped in a ```mermaid fenced code block. Otherwise, explain the key points concisely in 2-4 lines. " +
    `Output ONLY the interpretation body, written in ${lang}. ` +
    "No preamble, no trailing commentary."
  );
}
```

- [ ] **Step 2: 失敗するテストを書く**

`src/features/export/lib/__tests__/pptxAiEnrich.test.ts`:
```ts
// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock callAI to return a deterministic interpretation per slide.
const callAI = vi.fn(async (_s: unknown, _sys: string, user: string) =>
  user.includes("Start") ? "INTERP-A" : "INTERP-B",
);
vi.mock("@/shared/lib/callAI", () => ({ callAI }));
// Provide Ai settings via the settings store.
vi.mock("@/stores/settings-store", () => ({
  useSettingsStore: { getState: () => ({ aiSettings: { apiKey: "k", model: "m", baseUrl: "u", apiFormat: "openai" } }) },
}));

import JSZip from "jszip";
import { pptxToMarkdownPreviewEnriched } from "../pptxAiEnrich";

const labels = { slideFallback: (n: number) => `スライド ${n}`, notes: "ノート:" };
const enrich = { aiSection: "AI解釈", lang: "Japanese" };

// Two slides; slide 1 has shape "Start", slide 2 has shape "Other".
async function buildPptx(): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file("ppt/presentation.xml",
    `<?xml version="1.0"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldSz cx="9144000" cy="6858000"/><p:sldIdLst><p:sldId r:id="rA"/><p:sldId r:id="rB"/></p:sldIdLst></p:presentation>`);
  zip.file("ppt/_rels/presentation.xml.rels",
    `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rA" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/><Relationship Id="rB" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/></Relationships>`);
  const sld = (title: string) =>
    `<?xml version="1.0"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="2"/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>${title}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
  zip.file("ppt/slides/slide1.xml", sld("Start"));
  zip.file("ppt/slides/slide2.xml", sld("Other"));
  return zip.generateAsync({ type: "uint8array" });
}

describe("pptxToMarkdownPreviewEnriched", () => {
  beforeEach(() => callAI.mockClear());

  it("appends an AI interpretation section per slide, preserving order/separators", async () => {
    const data = await buildPptx();
    const md = await pptxToMarkdownPreviewEnriched(data, labels, enrich);
    expect(md).toContain("## Start");
    expect(md).toContain("## Other");
    expect(md).toContain("### AI解釈");
    expect(md).toContain("INTERP-A");
    expect(md).toContain("INTERP-B");
    // Slide order preserved: Start (and its interp) before Other.
    expect(md.indexOf("## Start")).toBeLessThan(md.indexOf("## Other"));
    expect(md.indexOf("INTERP-A")).toBeLessThan(md.indexOf("## Other"));
    expect(callAI).toHaveBeenCalledTimes(2);
  });

  it("keeps a slide's deterministic markdown when its AI call fails", async () => {
    callAI.mockImplementationOnce(async () => { throw new Error("rate limit"); });
    const data = await buildPptx();
    const md = await pptxToMarkdownPreviewEnriched(data, labels, enrich);
    // First slide failed -> no INTERP for it, but its title remains.
    expect(md).toContain("## Start");
    expect(md).toContain("## Other");
    // Exactly one AI section survived.
    expect(md.match(/### AI解釈/g)?.length).toBe(1);
  });
});
```

- [ ] **Step 3: 失敗を確認**

Run: `npx vitest run src/features/export/lib/__tests__/pptxAiEnrich.test.ts`
Expected: FAIL（module not found）

- [ ] **Step 4: 実装を書く**

`src/features/export/lib/pptxAiEnrich.ts`:
```ts
import { callAI } from "@/shared/lib/callAI";
import { useSettingsStore } from "@/stores/settings-store";
import { pptxAiEnrichSystemPrompt } from "@/shared/lib/constants";
import { pptxToMarkdownPreview } from "./pptxToMarkdownPreview";
import { extractPptxLayout, type SlideLayout } from "./pptxLayout";
import type { PptxLabels } from "./pptxParser";

export interface EnrichLabels {
  aiSection: string;
  lang: string;
}

const SLIDE_SEPARATOR = "\n\n---\n\n";
const MAX_CONCURRENCY = 4;

// Serialize a slide layout into a compact textual payload for the LLM.
function layoutToPayload(layout: SlideLayout): string {
  const shapeLines = layout.shapes.map(
    (s) => `[${s.id}] (${s.x},${s.y} ${s.w}x${s.h}): ${s.text.replace(/\n/g, " / ")}`,
  );
  const connLines = layout.connectors.map((c) => `${c.from ?? "?"} -> ${c.to ?? "?"}`);
  return (
    "Shapes:\n" + (shapeLines.join("\n") || "(none)") +
    "\n\nConnectors:\n" + (connLines.join("\n") || "(none)")
  );
}

// Run async tasks with a bounded concurrency, preserving input order in output.
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

// Build AI-enriched preview markdown: deterministic markdown per slide with an
// "AI interpretation" section appended. Slides whose AI call fails keep only
// their deterministic markdown. Throws only if deterministic extraction fails.
export async function pptxToMarkdownPreviewEnriched(
  data: Uint8Array,
  labels: PptxLabels,
  enrich: EnrichLabels,
): Promise<string> {
  const md = await pptxToMarkdownPreview(data, labels);
  const layouts = await extractPptxLayout(data);

  const chunks = md.split(SLIDE_SEPARATOR);
  // Safety: if slide boundaries don't line up with layouts, skip AI insertion.
  if (chunks.length !== layouts.length) {
    return md;
  }

  const aiSettings = useSettingsStore.getState().aiSettings;
  const systemPrompt = pptxAiEnrichSystemPrompt(enrich.lang);

  const enriched = await mapWithConcurrency(chunks, MAX_CONCURRENCY, async (chunk, i) => {
    try {
      const interpretation = await callAI(aiSettings, systemPrompt, layoutToPayload(layouts[i]));
      const body = interpretation.trim();
      if (!body) return chunk;
      return `${chunk}\n\n### ${enrich.aiSection}\n\n${body}`;
    } catch {
      // Per-slide failure: keep deterministic markdown only.
      return chunk;
    }
  });

  return enriched.join(SLIDE_SEPARATOR);
}
```

- [ ] **Step 5: テスト通過を確認**

Run: `npx vitest run src/features/export/lib/__tests__/pptxAiEnrich.test.ts`
Expected: PASS（2 件）

- [ ] **Step 6: コミット**

```bash
git add src/features/export/lib/pptxAiEnrich.ts src/shared/lib/constants.ts src/features/export/lib/__tests__/pptxAiEnrich.test.ts
git commit -m "feat(pptx): assemble AI-enriched preview markdown per slide"
```

---

### Task 3: PreviewPanel に「AI で図を解釈」ボタンとトグルを追加

PPTX プレビューにオプトインボタン・原文↔AI トグル・ローディング/エラーを追加し、強化 MD を既存描画に流す。

**Files:**
- Modify: `src/features/preview/components/PreviewPanel.tsx`
- Modify: `src/features/preview/components/PreviewPanel.css`
- Modify: `src/shared/i18n/locales/ja/editor.json`
- Modify: `src/shared/i18n/locales/en/editor.json`

**Interfaces:**
- Consumes: `pptxToMarkdownPreviewEnriched`（Task 2）, 既存 `isPptx`/`pptxMarkdown`/`markdownSource`（PreviewPanel）。
- Produces: なし（最終配線）。

注意:
- `PreviewPanel` の `useTranslation` は `editor` 名前空間。新規ローディング/エラー/ラベルは
  `editor` に追加し `t("...")` で参照。`enrich.lang` は現在の i18n 言語に対応する英語名
  （ja → "Japanese"、en → "English"）を渡す。
- `aiSettings` 未設定（API キー空）の場合は LLM を呼ばずエラー表示。

- [ ] **Step 1: i18n キーを追加**

`src/shared/i18n/locales/ja/editor.json` に追加（既存 `pptxPreviewError` の近く）:
```json
  "pptxAiButton": "AIで図を解釈",
  "pptxAiLoading": "AIで解釈中…",
  "pptxAiError": "AI解釈に失敗しました",
  "pptxAiNotConfigured": "AI設定（APIキー）が未設定です",
  "pptxAiShowOriginal": "原文を表示",
  "pptxAiShowEnriched": "AI解釈を表示",
  "pptxAiSection": "AI解釈",
```
`src/shared/i18n/locales/en/editor.json` に追加:
```json
  "pptxAiButton": "Interpret diagram with AI",
  "pptxAiLoading": "Interpreting with AI…",
  "pptxAiError": "AI interpretation failed",
  "pptxAiNotConfigured": "AI is not configured (API key missing)",
  "pptxAiShowOriginal": "Show original",
  "pptxAiShowEnriched": "Show AI interpretation",
  "pptxAiSection": "AI interpretation",
```

- [ ] **Step 2: import と状態を追加**

`src/features/preview/components/PreviewPanel.tsx`:

import に追加:
```ts
import { pptxToMarkdownPreviewEnriched } from "@/features/export/lib/pptxAiEnrich";
```
（`useSettingsStore` は PreviewPanel で既に import 済み。追加 import は上記のみ。）

現在の言語は `useTranslation` フックの `i18n` から取得する（既存パターン。例:
`ImageCanvas.tsx:66` の `i18n.language === "ja"`）。`PreviewPanel.tsx:223` の
`const { t } = useTranslation("editor");` を次に変更する:
```ts
  const { t, i18n } = useTranslation("editor");
```

既存の pptx 状態（`pptxError` を定義している箇所、~266 行）の直後に追加:
```ts
  const [aiEnrichedMarkdown, setAiEnrichedMarkdown] = useState<string | null>(null);
  const [aiEnriching, setAiEnriching] = useState(false);
  const [aiEnrichError, setAiEnrichError] = useState<string | null>(null);
  const [showAiEnriched, setShowAiEnriched] = useState(false);
```

既存の pptx 生成エフェクト（`activeTab?.filePath` をキーにするもの、~268-296 行）の
依存配列・本体冒頭で、タブが変わったら AI 状態もリセットする。エフェクト冒頭の
リセット節（`setPptxMarkdown(null)` 等のブロック）に次を追加:
```ts
      setAiEnrichedMarkdown(null);
      setAiEnriching(false);
      setAiEnrichError(null);
      setShowAiEnriched(false);
```
（pptx でない場合の早期リターン節と、pptx の場合の再生成開始節の両方で、AI 状態が
前タブの値を引き継がないようにする。最小限、`activeTab?.filePath` 変化時にリセットされれば良い。）

- [ ] **Step 3: 描画ソースに AI 強化を反映**

`markdownSource` の派生（~300 行 `const markdownSource = isPptx ? (pptxMarkdown ?? "") : content;`）を
次に変更:
```ts
  const markdownSource = isPptx
    ? (showAiEnriched && aiEnrichedMarkdown ? aiEnrichedMarkdown : (pptxMarkdown ?? ""))
    : content;
```
`renderAsMarkdown`（~299 行）は `pptxMarkdown != null` を見ているため変更不要
（AI 強化は決定論 MD 生成後にのみ可能で、`pptxMarkdown` は既に非 null）。

- [ ] **Step 4: ハンドラを追加**

`PreviewPanel` 本体内（他の `useCallback` ハンドラ群の近く）に追加:
```ts
  const handleAiInterpret = useCallback(async () => {
    if (!activeTab?.binaryData) return;
    const aiSettings = useSettingsStore.getState().aiSettings;
    if (!aiSettings.apiKey) {
      setAiEnrichError(t("pptxAiNotConfigured"));
      return;
    }
    setAiEnriching(true);
    setAiEnrichError(null);
    try {
      const md = await pptxToMarkdownPreviewEnriched(
        activeTab.binaryData,
        {
          slideFallback: (n: number) => t("common:pptxSlideLabel", { n }),
          notes: t("common:pptxNotesLabel"),
        },
        { aiSection: t("pptxAiSection"), lang: i18n.language.startsWith("ja") ? "Japanese" : "English" },
      );
      setAiEnrichedMarkdown(md);
      setShowAiEnriched(true);
    } catch {
      setAiEnrichError(t("pptxAiError"));
    } finally {
      setAiEnriching(false);
    }
  }, [activeTab?.binaryData, t]);
```

- [ ] **Step 5: ボタン/トグル/状態の JSX を追加**

既存の pptx ステータス JSX（`{isPptx && pptxLoading && ...}` のブロック、~1370 行）の
直前に、ツールバー相当の UI を追加:
```tsx
          {isPptx && pptxMarkdown != null && (
            <div className="preview-panel__pptx-toolbar">
              {!aiEnrichedMarkdown ? (
                <button
                  className="preview-panel__pptx-ai-btn"
                  onClick={handleAiInterpret}
                  disabled={aiEnriching}
                >
                  {aiEnriching ? t("pptxAiLoading") : t("pptxAiButton")}
                </button>
              ) : (
                <button
                  className="preview-panel__pptx-ai-btn"
                  onClick={() => setShowAiEnriched((v) => !v)}
                >
                  {showAiEnriched ? t("pptxAiShowOriginal") : t("pptxAiShowEnriched")}
                </button>
              )}
              {aiEnrichError && (
                <span className="preview-panel__pptx-status preview-panel__pptx-status--error">
                  {aiEnrichError}
                </span>
              )}
            </div>
          )}
```

- [ ] **Step 6: 最小 CSS を追加**

`src/features/preview/components/PreviewPanel.css` に追加（既存のステータス系クラスに倣う）:
```css
.preview-panel__pptx-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.preview-panel__pptx-ai-btn {
  font-size: 0.85em;
  padding: 4px 10px;
  cursor: pointer;
}
.preview-panel__pptx-ai-btn:disabled {
  opacity: 0.6;
  cursor: default;
}
```

- [ ] **Step 7: 型チェックと全テストを実行**

Run: `npx tsc --noEmit`
Expected: エラーなし

Run: `npm run test`
Expected: 全 PASS（既存 + Task 1–2 の新規）

- [ ] **Step 8: コミット**

```bash
git add src/features/preview/components/PreviewPanel.tsx src/features/preview/components/PreviewPanel.css src/shared/i18n/locales/ja/editor.json src/shared/i18n/locales/en/editor.json
git commit -m "feat(pptx): add opt-in AI diagram interpretation to preview"
```

---

## 手動検証（実装完了後）

1. AI 設定（プロバイダ/モデル/API キー）を構成。
2. 図（箱＋矢印）を含む `.pptx` をプレビューし「AIで図を解釈」を押す。
3. 各スライドに原文＋「AI解釈」（フロー図は Mermaid 描画）が併記される。
4. トグルで原文表示↔AI解釈を切り替えられる。
5. AI 未設定時に「AI設定（APIキー）が未設定です」が出る。一部スライドの失敗で全体が壊れない。
6. 保存操作で `.pptx` が上書きされない（ビュー専用）。日本語/英語でラベル切替。
