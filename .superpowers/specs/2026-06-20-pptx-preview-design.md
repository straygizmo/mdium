# PPTX プレビュー 設計仕様

- 日付: 2026-06-20
- 機能: `.pptx` ファイルを開いたとき、PPTX→Markdown 変換と同じ見た目でプレビュー表示する
- アプローチ: PPTX を保存せずメモリ上で Markdown 化し、既存の Markdown 描画パイプラインで描画する

## 1. 背景と目的

`mdium` は Office ファイル（PDF/DOCX/XLSX）をバイナリで開き、`OfficePreview` 経由で
「変換せず直接プレビュー」する。先日 PPTX→Markdown 変換（`pptxParser.ts` /
`pptxToMarkdown.ts`）を追加したが、`.pptx` のプレビューは存在しない。

本機能では、`.pptx` を開いたときに **PPTX→Markdown 変換した結果と同一の見た目** で
プレビューを表示する。ユーザー要件は「変換時の見た目と同じになること」。したがって、
変換と同じ Markdown を、`.md` プレビューと同じレンダラ・同じ CSS で描画する。

## 2. 方針

PPTX をメモリ上で Markdown 化し（ディスクに保存しない）、既存の Markdown 描画
パイプライン（`renderMarkdownWithSourceLines` → `marked` → DOM 注入、`PreviewPanel.tsx`）
にそのまま流す。スライド間は変換と同じく `---`（水平線）で区切られ、見た目が一致する。

画像は **data URL** として Markdown に直接埋め込む。既存の画像解決エフェクトは
`src` が `data:` の場合そのまま通す実装（`PreviewPanel.tsx:697`）のため、ディスク非依存で
描画できる。CSP も `img-src 'self' data: blob:`（`tauri.conf.json:26`）で許可済み。

`.pptx` タブの `content` には Markdown を入れず、バイナリのまま保持する（専用フラグで
判別）。プレビュー用 Markdown は PreviewPanel 内で非同期生成して描画に流すだけにする。
これにより、ユーザーが誤って Markdown テキストを元の `.pptx` に上書き保存する危険を
構造的に排除する（ビュー専用）。

## 3. 変換ロジックの再利用（DRY）

現状 `pptxToMarkdown.ts` は「JSZip 展開 → `resolveSlideOrder` → 各 `parseSlide` →
`renderSlides` で `{ markdown, images }` 取得 → ディスク書き込み」という流れ。
展開〜`renderSlides` までの共通コアを切り出し、ファイル保存とプレビューで共有する。

### 3.1 共通コアの抽出

`pptxToMarkdown.ts` に共通コア関数を追加して **named export** する（既存
`pptxToMarkdown` の公開シグネチャ・外部挙動は不変）。プレビュー用モジュールから
import して再利用するため `export` する:

```ts
// Load a pptx and render it to Markdown + image list, without any I/O.
// Returns the loaded zip so callers can pull image bytes (write to disk vs. inline).
export async function extractPptxMarkdown(
  data: Uint8Array,
  baseName: string,
  labels: PptxLabels,
): Promise<{ zip: JSZip; markdown: string; images: RenderedImage[] }>;
```

- 既存 `pptxToMarkdown(data, pptxPath, saveToMdium, labels)` はこれを呼び、
  画像と `.md` をディスクへ書き出す（**外部挙動・公開 API は不変**）。
- `resolveSlideOrder` / `findNotesTarget` / 不正 PPTX 時の `throw` は共通コアに移す。

### 3.2 プレビュー用関数（新規）

新規ファイル `src/features/export/lib/pptxToMarkdownPreview.ts`:

```ts
import type { PptxLabels } from "./pptxParser";

// Render a pptx (binary) to a self-contained Markdown string for preview:
// images are inlined as data URLs, nothing is written to disk.
export async function pptxToMarkdownPreview(
  data: Uint8Array,
  labels: PptxLabels,
): Promise<string>;
```

実装:
1. `extractPptxMarkdown(data, "pptx", labels)` で `{ zip, markdown, images }` を得る
   （`baseName` はプレビューでは固定値 `"pptx"`。画像参照は後段で全て data URL へ
   置換するため値は表示に影響しない）。
2. `images` の各 `{ mediaPath, fileName }` について、`zip.file(mediaPath)` から
   バイトを取得（無ければスキップ）。MIME は拡張子から判定（png/jpg/jpeg/gif/bmp/
   svg/webp、既定 `image/png`）。`btoa` でバイナリ→base64 にして
   `data:{mime};base64,{...}` を生成。
3. Markdown 内の画像参照 `pptx_images/{fileName}` を対応する data URL に文字列置換。
4. 置換後の Markdown 文字列を返す。

不正 PPTX（`presentation.xml` 欠落）は `extractPptxMarkdown` 内の既存 `throw` が伝播し、
呼び出し側（PreviewPanel）でエラー表示する。

`extractPptxMarkdown` を別モジュールから使えるよう、`pptxToMarkdown.ts` から
`extractPptxMarkdown` を named export する（`RenderedImage` 型は `pptxParser.ts` から
再エクスポート済み or import）。

## 4. タブと配線

### 4.1 タブ型

`src/stores/tab-store.ts` の `Tab` に光学的に他フラグ（`csvFileType` 等）と同様の
プロパティを追加:

```ts
pptxFileType?: ".pptx";
```

`officeFileType` は **使わない**（`isOfficeFile` 経由で `OfficePreview` に流れ、未対応で
失敗するため）。`.pptx` 専用フラグで判別する。

### 4.2 ファイルオープン（`App.tsx` `handleFileSelect`）

`getPptxExt(filePath)` 判定を追加（`shared` のヘルパに `.pptx` 用 getter を追加、
他の `getOfficeExt` 等に倣う）。`.pptx` の場合:

```ts
} else if (pptxExt) {
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
}
```

- `getOfficeExt` が `.pptx` を拾わないことを確認（拾う場合は除外する）。
- 末尾の `setEditorVisible(...)` は `.pptx` で `false`（非 `.md` のためエディタ非表示）。

### 4.3 プレビュー描画（`PreviewPanel.tsx`）

1. **判別**: `const isPptx = !!(activeTab?.binaryData && activeTab?.pptxFileType);`
2. **生成エフェクト（新規）**: `isPptx` かつ `binaryData` 変化時に非同期で
   `pptxToMarkdownPreview(binaryData, { slideFallback: (n) => t("pptxSlideLabel", { n }),
   notes: t("pptxNotesLabel") })` を呼び、結果を `pptxMarkdown` state にセット。
   生成中は `pptxLoading`、失敗時は `pptxError` を立てる。`activeTab` 切替時に state を
   リセット（前タブの内容が残らないこと）。
3. **描画ソースの分岐**: 既存の Markdown 描画エフェクト（`PreviewPanel.tsx:653`）の
   入力を `content` 固定から「`isPptx ? pptxMarkdown : content`」に変更し、
   `isRenderableMarkdown` 判定も pptx を含めるよう拡張する。これにより `marked` 描画・
   CSS・data URL 画像処理がそのまま再利用され、変換と同一の見た目になる。
   依存配列に `pptxMarkdown` / `isPptx` を追加。
4. **状態表示**: `isPptx && pptxLoading` の間はローディング表示、`pptxError` 時は
   既存の `renderError` 同様のエラー表示。
5. `filePath` がドキュメント画像解決に使われる箇所（`PreviewPanel.tsx:688` 以降）は、
   pptx の画像が全て data URL のため到達しない（`data:` は `continue`）。挙動に影響なし。

### 4.4 i18n

ラベルは変換機能で追加済みの既存キーを再利用する（新規キー不要）:
`pptxSlideLabel`（"スライド {{n}}" / "Slide {{n}}"）、`pptxNotesLabel`（"ノート:" /
"Notes:"）。これらを `t()` でプレビューに渡すことで、変換と見た目が一致する。
ローディング/エラー文言が新規に必要な場合のみ i18n キーを追加（ハードコード禁止）。

### 4.5 CSP

変更不要（`img-src ... data:` 許可済み）。

## 5. エラーハンドリング

- 不正 PPTX（`presentation.xml` 欠落）→ `extractPptxMarkdown` が `throw` →
  PreviewPanel が `pptxError` を表示。
- ZIP 内に存在しない画像 media → その画像のみスキップ（参照は置換されず残るが、
  既存の画像解決でも `data:`/`http` 以外の未解決相対パスは表示されないだけで、
  描画全体は継続）。望ましくは、未解決画像参照は Markdown から除去して
  壊れた画像アイコンを避ける（任意・軽微）。
- 巨大デッキ: data URL 埋め込みでメモリ増だが、プレビュー用途として許容。

## 6. テスト

`src/features/export/lib/__tests__/pptxToMarkdownPreview.test.ts`
（`// @vitest-environment happy-dom`、`pptxToMarkdown.test.ts` 同様にメモリ内 JSZip で
PPTX を組み立てて検証。fs は使わないためモック不要）:

1. 画像を含む 1 スライドの PPTX で、返り値 Markdown に
   `data:image/png;base64,` を含む画像参照が埋め込まれ、`pptx_images/...` の
   相対参照が残っていないこと。
2. スライド順が `presentation.xml` の提示順に従うこと（変換と同じ）。
3. スピーカーノートが `> **ノート:** ...` 形式で含まれること（labels が反映されること）。
4. 不正 PPTX（`presentation.xml` 欠落）で reject すること。

既存 `pptxToMarkdown` のリファクタ（共通コア抽出）後も
`pptxToMarkdown.test.ts` が緑のままであること（外部挙動不変の確認）。

PreviewPanel の配線は UI のため新規ユニットテストは設けず、`npx tsc --noEmit` と
全テスト緑、手動検証で確認する。

## 7. 手動検証

1. `npm run tauri dev` 起動。
2. ファイルツリーで `.pptx` をクリック → プレビューペインにスライド内容が
   `---` 区切りで表示される。
3. 同じ `.pptx` を一括変換した `.md` のプレビューと**見た目が一致**することを確認
   （見出し/箇条書き/表/画像/ノート）。
4. 画像がインライン表示されること、`.mdium` や `_images` フォルダが**生成されない**
   こと（プレビューはディスクに書かない）を確認。
5. 日本語/英語でスライドフォールバック・ノートラベルが切り替わること。
6. プレビュータブで編集不可・元 `.pptx` が上書きされないこと。

## 8. 非対象 (YAGNI)

- レイアウト/テーマ/配色/座標の忠実再現（コンテンツ＝変換と同じ見た目に限定）。
- スライドのカルーセル/サムネイル UI（`---` 区切りの連続表示で要件を満たす）。
- プレビューからの保存/エクスポート操作（変換は既存の一括変換が担う）。
- アニメーション・トランジション・SmartArt 構造の再現。
