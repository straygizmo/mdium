# PPTX→Markdown 一括変換 設計仕様

- 日付: 2026-06-20
- 機能: 一括変換 (Batch Convert) に PPTX→Markdown を追加
- アプローチ: JSZip + DOMParser による XML 直接パース（新規依存なし）

## 1. 背景と目的

`mdium` の一括変換機能は現在 DOCX / PDF / XLSX → Markdown をサポートする。本機能で
PowerPoint (`.pptx`) → Markdown 変換を追加する。すべての変換は WebView (TypeScript)
側で完結しており、本機能も同じ方針に従う。

要件として、各スライドから以下の 4 要素をすべて再現する:

1. テキスト本文（見出し + 箇条書き）
2. 画像の抽出
3. 表（テーブル）
4. スピーカーノート

## 2. アプローチ

PPTX の実体は XML ファイルの ZIP である。既存依存の `jszip` で展開し、WebView 標準の
`DOMParser` で各 XML を解析する。新規ライブラリ依存は追加しない。

`pptxtojson` 等のライブラリ案は、(1) スピーカーノート抽出が非対応の可能性が高い、
(2) 描画用途向けで位置・スタイル情報が過剰、(3) 新規依存が増える、という理由で不採用。
XML 直接パースは出力 Markdown を完全に制御でき、既存の `xlsx2md` vendoring 思想や
`docxToMarkdown` の画像抽出パターンとも一致する。

## 3. PPTX 解析フロー

```
ppt/presentation.xml             → スライド順序 (<p:sldIdLst><p:sldId r:id="...">)
ppt/_rels/presentation.xml.rels  → rId → ppt/slides/slideN.xml を解決
ppt/slides/slideN.xml            → タイトル / 本文 / 表 / 画像参照
ppt/slides/_rels/slideN.xml.rels → 画像 rId → ../media/* を解決、notesSlide を解決
ppt/notesSlides/notesSlideN.xml  → スピーカーノート本文
ppt/media/*                      → 画像バイナリ
```

### 3.1 スライド順序の決定

`ppt/presentation.xml` の `<p:sldIdLst>` 内 `<p:sldId r:id="rIdN">` を順に読み、
`ppt/_rels/presentation.xml.rels` の `<Relationship Id="rIdN" Target="slides/slideN.xml">`
で実ファイルへ解決する。ファイル名の数値順ではなく、この提示順を正とする。

### 3.2 各スライドの抽出ルール

スライド XML 内の shape ツリー (`<p:spTree>`) を走査する。

- **タイトル**: `<p:nvSpPr><p:nvPr><p:ph type="title">` または `type="ctrTitle"` を持つ
  `<p:sp>` のテキスト → `##` 見出し。見つからなければフォールバックでラベル
  「スライド N」（i18n）を見出しにする。
- **本文（箇条書き）**: タイトル以外の `<p:sp>` 内の各段落 `<a:p>` を 1 箇条書き項目に
  する。インデントは `<a:pPr lvl="N">` の N（0 始まり）に応じて半角スペース 2×N で
  ネスト。空段落（テキストなし）はスキップ。段落テキストは内部の `<a:r><a:t>` を順に
  連結し、`<a:br>` は改行ではなくスペースとして扱う（Markdown 箇条書き 1 行に収める）。
- **表**: `<a:graphicFrame>` 配下の `<a:tbl>` を Markdown テーブルへ変換。各行 `<a:tr>`、
  各セル `<a:tc>` のテキストを抽出。先頭行をヘッダ行として `| --- |` 区切りを挿入。
  セル内改行や `|` は適切にエスケープ（`|` → `\|`、改行 → スペース）。
- **画像**: `<p:pic>` の `<a:blip r:embed="rIdN">` を slide rels で `../media/imageX.ext`
  に解決し、バイナリを抽出。`{baseName}_images/` に連番 `image{N}.{ext}` で保存し、
  Markdown に `![](baseName_images/image{N}.png)` を挿入。同一画像の重複参照は
  rId 単位でキャッシュし二重保存しない。
- **スピーカーノート**: slide rels 内 `Type` が
  `.../relationships/notesSlide` の Relationship から notesSlide XML を解決。
  本文プレースホルダ (`<p:ph type="body">`) のテキストを抽出。スライド番号などの
  自動生成プレースホルダは除外。ノートがあれば引用ブロックで付加。

### 3.3 出力順序

各スライド内は「見出し → 本文/表/画像（spTree の出現順）→ ノート」の順で出力する。
本文・表・画像は spTree 上の出現順を尊重して並べる（本文箇条書きを先にまとめてしまわず、
shape の登場順にブロックを生成する）。ノートは常にスライド末尾。

## 4. Markdown 出力フォーマット

スライドごとに出力し、スライド間は水平線 `---` で区切る。

```markdown
## スライドのタイトル

- 箇条書き1
  - ネストした箇条書き

| 列1 | 列2 |
| --- | --- |
| a | b |

![](sample_images/image1.png)

> **ノート:** 発表者ノートの本文

---
```

- 見出しはタイトルがあればそれ、無ければ i18n の「スライド N」フォールバック。
- ノートラベル「ノート:」は i18n。
- 最終スライド後の末尾 `---` は付けない（または許容）。

## 5. ファイル構成とインターフェース

### 5.1 新規ファイル: `src/features/export/lib/pptxToMarkdown.ts`

```ts
export interface ConvertResult {
  mdPath: string;
}

export interface PptxLabels {
  /** "スライド N" のフォーマッタ（N は 1 始まり） */
  slideFallback: (n: number) => string;
  /** ノート見出しラベル（例: "ノート:"） */
  notes: string;
}

export async function pptxToMarkdown(
  data: Uint8Array,
  pptxPath: string,
  saveToMdium: boolean,
  labels: PptxLabels,
): Promise<ConvertResult>;
```

- 出力パス計算は `docxToMarkdown` と同一ロジック（パス区切り保持、`.mdium` 切替、
  `{baseName}_images/`、`{baseName}.md`）。
- 画像保存・ディレクトリ作成・`.md` 書き出しは `@tauri-apps/plugin-fs` の
  `writeTextFile` / `writeFile` / `mkdir` を使用（docx と同様）。

### 5.2 配線変更（5 箇所）

1. **`src/features/export/lib/collectConvertibleFiles.ts`**
   - `ConvertibleFile.type` / `ConvertibleTreeNode.fileType` の型ユニオンに `"pptx"` 追加。
   - `walkTree` と `buildConvertibleTree` の拡張子判定に `.pptx` → `"pptx"` を追加。
   - `pruneTreeByFilter` の `filter` 引数型に `"pptx"` を追加。
2. **`src/features/export/hooks/useBatchConvert.ts`**
   - `file.type === "pptx"` 分岐を追加し、`pptxToMarkdown(data, file.path, saveToMdium, labels)`
     を動的 import で呼ぶ（既存パターン踏襲）。`labels` は `useTranslation` の `t()` から構築。
3. **`src/features/export/components/BatchConvertModal.tsx`**
   - `FilterTab` 型に `"pptx"` 追加。
   - フィルタボタン配列 `["all", "docx", "xlsx", "pptx", "pdf"]` に追加。
4. **`src/shared/i18n/locales/ja/common.json`** と **`.../en/common.json`**
   - `batchConvertFilterPptx`（フィルタタブラベル）
   - `pptxSlideLabel`（"スライド {{n}}" / "Slide {{n}}"）
   - `pptxNotesLabel`（"ノート:" / "Notes:"）
5. **Rust 側の既存 md 存在チェック** (`check_mdium_md_exists` 等) は拡張子非依存
   （`{stem}.md` を見る）ため変更不要。

## 6. エラーハンドリング

- PPTX として不正（必須 XML 欠落）の場合は例外を投げ、`useBatchConvert` の
  try/catch が `status: "failed"` として集計する（既存挙動踏襲）。
- 個別スライドの一部要素（壊れた表・解決できない画像 rId）はその要素のみスキップし、
  変換全体は継続する。スキップは握りつぶしてよい（部分的な成果物を優先）。
- 画像 MIME / 拡張子は media のファイル拡張子から決定。`jpeg`→`jpg` 正規化は docx 同様。

## 7. テスト（TDD）

バイナリ fixture を用意せず、テスト内で JSZip により最小 PPTX を組み立てて検証する。

テストケース:

1. タイトルが `##` 見出しになる。タイトル無しスライドは「スライド N」フォールバック。
2. 段落が箇条書きになり、`lvl` でネストする。
3. 表が Markdown テーブルになり、先頭行がヘッダになる。セル内 `|` がエスケープされる。
4. 画像参照が `![](baseName_images/imageN.png)` になり、`images` 配列に正しいバイト数で
   保存対象が積まれる（fs 書き込みはモック）。同一 rId の重複参照で二重保存しない。
5. スピーカーノートが引用ブロックで付加される。ノート無しスライドはノート行なし。
6. スライド順序が `presentation.xml` の提示順に従う（ファイル名数値順と異なるケース）。
7. i18n ラベル（slideFallback / notes）が出力に反映される。

fs 書き込み (`writeTextFile` / `writeFile` / `mkdir`) はモックし、生成 Markdown 文字列と
画像保存呼び出しを assert する。

## 8. 非対象 (YAGNI)

- スライドのレイアウト/テーマ/配色の再現。
- アニメーション・トランジション。
- 図形（矢印・吹き出し等）のベクター描画。テキストを持つ図形のテキストのみ抽出。
- SmartArt の構造再現（含まれるテキストが取れれば箇条書き化、取れなければスキップ）。
- 1 スライド内 shape の厳密な z-order / 座標ソート（出現順で十分とする）。
