# PDFプレビュータブ実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** MDプレビュータブの隣にPDFプレビュータブを追加し、CSSベースのA4ページシミュレーション + ボタンクリックによる実際のPDFプレビュー生成を実現する。

**Architecture:** PreviewPanelにタブ切替UIを追加し、新しいPdfPreviewPanelコンポーネントでA4用紙風のCSS表示を提供する。「PDFプレビュー生成」ボタンで html2pdf.js を使い実際のPDFを生成し、blob URL + iframe で表示する（OfficePreviewの既存パターンを踏襲）。

**Tech Stack:** React, TypeScript, html2pdf.js, Zustand (ui-store), CSS, i18next

---

## ファイル構成

| ファイル | 操作 | 責務 |
|---------|------|------|
| `src/stores/ui-store.ts` | 修正 | ViewTab型に `"pdf-preview"` を追加 |
| `src/features/preview/components/PreviewPanel.tsx` | 修正 | タブ切替UI、activeViewTabに応じた表示分岐 |
| `src/features/preview/components/PdfPreviewPanel.tsx` | 新規 | PDFプレビューコンポーネント（CSSモード + 実PDF生成） |
| `src/features/preview/components/PdfPreviewPanel.css` | 新規 | A4ページシミュレーション + PDF表示スタイル |
| `src/features/preview/components/PreviewPanel.css` | 修正 | タブの非アクティブスタイル調整 |
| `src/shared/i18n/locales/ja/editor.json` | 修正 | 日本語キー追加 |
| `src/shared/i18n/locales/en/editor.json` | 修正 | 英語キー追加 |

---

### Task 1: ui-store にPDFプレビュータブ状態を追加

**Files:**
- Modify: `src/stores/ui-store.ts:5`

- [ ] **Step 1: ViewTab型に "pdf-preview" を追加**

```typescript
type ViewTab = "preview" | "table" | "pdf-preview";
```

変更はこの1行のみ。既存の `setActiveViewTab` アクションはジェネリックなのでそのまま動作する。

- [ ] **Step 2: ビルド確認**

Run: `npm run build` (型エラーがないことを確認)

- [ ] **Step 3: コミット**

```bash
git add src/stores/ui-store.ts
git commit -m "feat: add pdf-preview to ViewTab type"
```

---

### Task 2: i18n キーを追加

**Files:**
- Modify: `src/shared/i18n/locales/ja/editor.json`
- Modify: `src/shared/i18n/locales/en/editor.json`

- [ ] **Step 1: 日本語キーを追加**

`editor.json`（ja）に以下を追加:

```json
"pdfPreview": "PDFプレビュー",
"generatePdfPreview": "PDFプレビュー生成",
"generatingPdf": "PDF生成中..."
```

- [ ] **Step 2: 英語キーを追加**

`editor.json`（en）に以下を追加:

```json
"pdfPreview": "PDF Preview",
"generatePdfPreview": "Generate PDF Preview",
"generatingPdf": "Generating PDF..."
```

- [ ] **Step 3: コミット**

```bash
git add src/shared/i18n/locales/ja/editor.json src/shared/i18n/locales/en/editor.json
git commit -m "feat: add i18n keys for PDF preview tab"
```

---

### Task 3: PdfPreviewPanel コンポーネントを作成

**Files:**
- Create: `src/features/preview/components/PdfPreviewPanel.tsx`
- Create: `src/features/preview/components/PdfPreviewPanel.css`

- [ ] **Step 1: PdfPreviewPanel.css を作成**

A4用紙シミュレーションCSS:

```css
/* ========== PDF Preview Panel ========== */
.pdf-preview-panel {
  display: flex;
  flex-direction: column;
  flex: 1;
  overflow: hidden;
  min-width: 0;
}

.pdf-preview-panel__toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: var(--bg-overlay);
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.pdf-preview-panel__toolbar button {
  padding: 4px 14px;
  font-size: 12px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg-surface);
  color: var(--text);
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s, color 0.15s;
}

.pdf-preview-panel__toolbar button:hover:not(:disabled) {
  background: var(--primary);
  border-color: var(--primary);
  color: white;
}

.pdf-preview-panel__toolbar button:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.pdf-preview-panel__status {
  font-size: 11px;
  color: var(--text-muted);
}

/* CSS-based A4 page simulation */
.pdf-preview-panel__css-mode {
  flex: 1;
  overflow-y: auto;
  background: var(--bg-overlay);
  padding: 24px;
}

.pdf-preview-panel__page {
  width: 210mm;
  min-height: 297mm;
  margin: 0 auto 24px auto;
  padding: 20mm;
  background: white;
  color: #1a1a1a;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
  box-sizing: border-box;
  overflow: hidden;
}

[data-theme="dark"] .pdf-preview-panel__css-mode {
  background: #1a1a1a;
}

/* PDF iframe viewer */
.pdf-preview-panel__pdf-mode {
  flex: 1;
  overflow: hidden;
}

.pdf-preview-panel__pdf-mode iframe {
  width: 100%;
  height: 100%;
  border: none;
}
```

- [ ] **Step 2: PdfPreviewPanel.tsx を作成**

コンポーネントの責務:
- CSSモード（デフォルト）: レンダリング済みHTMLをA4用紙風コンテナに表示
- PDFモード: html2pdf.jsでPDF生成 → iframe表示

```tsx
import { useState, useRef, useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import "./PdfPreviewPanel.css";

interface PdfPreviewPanelProps {
  html: string;
  frontMatter: Record<string, string> | null;
  previewRef: React.RefObject<HTMLDivElement | null>;
}

export function PdfPreviewPanel({ html, frontMatter, previewRef }: PdfPreviewPanelProps) {
  const { t } = useTranslation("editor");
  const [pdfBlobUrl, setPdfBlobUrl] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const cssContentRef = useRef<HTMLDivElement>(null);

  // Cleanup blob URL on unmount
  useEffect(() => {
    return () => {
      if (pdfBlobUrl) URL.revokeObjectURL(pdfBlobUrl);
    };
  }, [pdfBlobUrl]);

  // Reset PDF when HTML changes (content edited)
  useEffect(() => {
    if (pdfBlobUrl) {
      URL.revokeObjectURL(pdfBlobUrl);
      setPdfBlobUrl(null);
    }
  }, [html]);

  const handleGeneratePdf = useCallback(async () => {
    // Use the hidden preview DOM for PDF generation (it has images resolved to blob URLs)
    const el = previewRef.current;
    if (!el) return;

    setGenerating(true);
    try {
      const prevScrollTop = el.scrollTop;
      el.scrollTop = 0;

      const html2pdf = (await import("html2pdf.js")).default;
      const opt = {
        margin: 10,
        image: { type: "jpeg" as const, quality: 0.98 },
        html2canvas: { scale: 2, useCORS: true },
        jsPDF: { unit: "mm" as const, format: "a4" as const, orientation: "portrait" as const },
        pagebreak: { before: ".pagebreak-marker" },
      };

      const arrayBuffer: ArrayBuffer = await html2pdf().set(opt).from(el).outputPdf("arraybuffer");

      el.scrollTop = prevScrollTop;

      // Revoke previous blob URL
      if (pdfBlobUrl) URL.revokeObjectURL(pdfBlobUrl);

      const blob = new Blob([new Uint8Array(arrayBuffer)], { type: "application/pdf" });
      setPdfBlobUrl(URL.createObjectURL(blob));
    } catch (error) {
      console.error("PDF preview generation error:", error);
    } finally {
      setGenerating(false);
    }
  }, [previewRef, pdfBlobUrl]);

  return (
    <div className="pdf-preview-panel">
      <div className="pdf-preview-panel__toolbar">
        <button onClick={handleGeneratePdf} disabled={generating}>
          {generating ? t("generatingPdf") : t("generatePdfPreview")}
        </button>
        {pdfBlobUrl && (
          <span className="pdf-preview-panel__status">
            ✓ PDF
          </span>
        )}
      </div>

      {pdfBlobUrl ? (
        <div className="pdf-preview-panel__pdf-mode">
          <iframe src={pdfBlobUrl} title="PDF Preview" />
        </div>
      ) : (
        <div className="pdf-preview-panel__css-mode">
          <div className="pdf-preview-panel__page md-preview">
            {frontMatter && (
              <div className="yaml-front-matter">
                {Object.entries(frontMatter).map(([k, v]) => (
                  <div key={k} className="yaml-entry">
                    <span className="yaml-key">{k}</span>
                    <span className="yaml-value">{v}</span>
                  </div>
                ))}
              </div>
            )}
            <div ref={cssContentRef} dangerouslySetInnerHTML={{ __html: html }} />
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: 動作確認**

ファイルが正しく作成されたことをビルドで確認: `npm run build`

- [ ] **Step 4: コミット**

```bash
git add src/features/preview/components/PdfPreviewPanel.tsx src/features/preview/components/PdfPreviewPanel.css
git commit -m "feat: create PdfPreviewPanel component with CSS A4 simulation and PDF generation"
```

---

### Task 4: PreviewPanel にタブ切替とPdfPreviewPanel統合

**Files:**
- Modify: `src/features/preview/components/PreviewPanel.tsx:606-625`
- Modify: `src/features/preview/components/PreviewPanel.css:50-68`

- [ ] **Step 1: PreviewPanel.tsx にインポートとタブ切替を追加**

インポート追加:
```typescript
import { PdfPreviewPanel } from "./PdfPreviewPanel";
```

ui-storeから `activeViewTab` と `setActiveViewTab` を取得:
```typescript
const activeViewTab = useUiStore((s) => s.activeViewTab);
const setActiveViewTab = useUiStore((s) => s.setActiveViewTab);
```

- [ ] **Step 2: タブバーUIを変更**

現在のタブバー（`preview-panel__tabs`内、約L607-625）を修正:

```tsx
<div className="preview-panel__tabs">
  <button
    className={`preview-panel__tab ${activeViewTab !== "pdf-preview" ? "preview-panel__tab--active" : ""}`}
    onClick={() => setActiveViewTab("preview")}
  >
    {t("preview")}
  </button>
  <button
    className={`preview-panel__tab ${activeViewTab === "pdf-preview" ? "preview-panel__tab--active" : ""}`}
    onClick={() => setActiveViewTab("pdf-preview")}
  >
    {t("pdfPreview")}
  </button>
  <div className="preview-panel__export-group">
    <span className="preview-panel__export-label">{t("export")}</span>
    <button onClick={exportPdf} title={t("exportPdfTitle")}>PDF</button>
    <button onClick={exportHtml} title={t("exportHtmlTitle")}>HTML</button>
    <button onClick={exportDocx} title={t("exportDocxTitle")}>DOCX</button>
  </div>
</div>
```

- [ ] **Step 3: コンテンツ表示の分岐を追加**

タブバーの下、コンテンツ部分を `activeViewTab` で分岐:

```tsx
{activeViewTab === "pdf-preview" ? (
  <PdfPreviewPanel
    html={html}
    frontMatter={frontMatter}
    previewRef={previewRef}
  />
) : (
  <>
    <div
      className="preview-panel__content md-preview"
      ref={previewRef}
      onClick={() => setContextMenu(null)}
    >
      {/* 既存のプレビュー内容 ... */}
    </div>
    {/* 既存のコンテキストメニュー ... */}
  </>
)}
```

重要: MDプレビューの `previewRef` をPdfPreviewPanelに渡す。PDF生成時にはMDプレビューのDOMを使う（画像のblob URL解決済みのため）。ただしPDFプレビュータブ表示中もMDプレビューのDOMを維持する必要がある。

**解決策**: PDFプレビュータブ表示中もMDプレビューをhidden状態で維持する。

```tsx
<div
  className="preview-panel__content md-preview"
  ref={previewRef}
  onClick={() => setContextMenu(null)}
  style={activeViewTab === "pdf-preview" ? { position: "absolute", left: "-9999px", top: 0 } : undefined}
>
  {frontMatter && (
    <div className="yaml-front-matter">
      {Object.entries(frontMatter).map(([k, v]) => (
        <div key={k} className="yaml-entry">
          <span className="yaml-key">{k}</span>
          <span className="yaml-value">{v}</span>
        </div>
      ))}
    </div>
  )}
  <div ref={contentRef} />
</div>

{activeViewTab === "pdf-preview" && (
  <PdfPreviewPanel
    html={html}
    frontMatter={frontMatter}
    previewRef={previewRef}
  />
)}

{activeViewTab !== "pdf-preview" && contextMenu && (
  /* 既存のコンテキストメニュー */
)}
```

- [ ] **Step 4: ビルド確認**

Run: `npm run build`

- [ ] **Step 5: 手動テスト**

1. アプリを起動し、MDファイルを開く
2. 「プレビュー」タブと「PDFプレビュー」タブが表示されることを確認
3. タブ切替が動作することを確認
4. PDFプレビュータブでA4用紙風表示になることを確認
5. 「PDFプレビュー生成」ボタンクリックでPDFが生成されiframeに表示されることを確認
6. MD内容を編集すると生成済みPDFがリセットされることを確認
7. プレビュータブに戻るとMDプレビューが正常に表示されることを確認

- [ ] **Step 6: コミット**

```bash
git add src/features/preview/components/PreviewPanel.tsx src/features/preview/components/PreviewPanel.css
git commit -m "feat: integrate PDF preview tab with tab switching in PreviewPanel"
```
