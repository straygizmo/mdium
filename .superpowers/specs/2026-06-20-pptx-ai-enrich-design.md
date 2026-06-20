# PPTX プレビュー AI 意味解釈 設計仕様

- 日付: 2026-06-20
- 機能: PPTX プレビューで、各スライドの図（テキストボックスの配置・コネクタ）の意図を LLM に解釈させ、Markdown に併記する（オプトイン）
- アプローチ: スライドの構造化レイアウト（テキスト + 正規化位置 + コネクタ）を既存のワンショット LLM 経路に渡し、図の意図を Mermaid / 要約として取得して併記する。画像化（Vision）はしない。

## 1. 背景と目的

PPTX→Markdown 変換／プレビューは、テキストボックスの中身を文字列として落とし込むだけで、
図が伝えようとしている意味（箱と矢印で表すフロー、配置で示す関係など）は失われる。

本機能では、ユーザーが明示的に依頼したときだけ（オプトイン）、各スライドの図形配置と
コネクタを LLM に渡し、図の意図を解釈させて Markdown に反映する。決定論的に抽出した
原文は失わず、その下に「AI 解釈」セクション（Mermaid 図 または 要点説明）を**併記**する。

スコープは PPTX プレビュー上の表示まで（in-memory・ビュー専用）。`.md` ファイルへの
保存は v1 非対象（§8）。

## 2. 全体方針

- 既存の決定論的パース／レンダリング（`pptxParser.ts` / `pptxToMarkdown.ts` /
  `pptxToMarkdownPreview.ts`）は**変更しない**。AI ペイロード用のレイアウト抽出を
  別関数として新設する。
- LLM 呼び出しは既存のワンショット経路 `callAI(aiSettings, systemPrompt, userContent)`
  （`src/shared/lib/callAI.ts` → `invoke("ai_chat")` → Rust reqwest）を使う。これは
  WinINET プロキシをバイパスする経路で、非対話フローから安全に呼べる。
- スライド単位で並列に LLM を呼び、各スライドの決定論的 Markdown の末尾に
  「AI 解釈」セクションを挿入した「強化 Markdown」を組み立て、プレビューに描画する。
- Mermaid は既存のプレビュー Markdown 描画が対応済み。

## 3. レイアウト抽出（新規モジュール）

新規ファイル `src/features/export/lib/pptxLayout.ts`。JSZip + DOMParser のみ（fs 非依存、
happy-dom でテスト可能）。既存の `extractPptxMarkdown` と同じく prefix 付き
`getElementsByTagName` を使う（happy-dom 20.8.9 の NS バグ回避）。

```ts
export interface LayoutShape {
  id: string;          // p:cNvPr の id（コネクタ参照用）
  text: string;        // 図形内テキスト（段落を改行連結）
  x: number; y: number; w: number; h: number; // 0–100 に正規化
}
export interface LayoutConnector {
  from: string | null; // 始点図形 id（a:stCxn）。無ければ null
  to: string | null;   // 終点図形 id（a:endCxn）。無ければ null
}
export interface SlideLayout {
  shapes: LayoutShape[];
  connectors: LayoutConnector[];
}
export async function extractPptxLayout(data: Uint8Array): Promise<SlideLayout[]>;
```

抽出ルール:
- スライド順は既存の `resolveSlideOrder` と同じ（`presentation.xml` の `sldIdLst`）。
  DRY のため `pptxToMarkdown.ts` の `resolveSlideOrder` を named export し、
  `pptxLayout.ts` から import して再利用する（ロジック重複を作らない）。
- スライドサイズ: `presentation.xml` の `<p:sldSz cx cy/>`（EMU）。各図形の
  `<a:off x y/>` / `<a:ext cx cy/>`（EMU）を `x/cx*100` のように 0–100 へ正規化。
  `xfrm` が無い図形は位置不明として x=y=w=h=0（または省略）扱い。
- 図形テキスト: グループ `<p:grpSp>` も再帰的に辿り（既存パーサと同方針）、
  `<p:sp>` の `<p:txBody>` 内 `<a:p>` テキストを改行連結。
- 図形 id: `<p:nvSpPr><p:cNvPr id="...">`。
- コネクタ: `<p:cxnSp>` の `<p:nvCxnSpPr><p:cNvCxnSpPr>` 配下
  `<a:stCxn id="..."/>` / `<a:endCxn id="..."/>` から from/to を取得。

## 4. AI 意味解釈モジュール（新規）

新規ファイル `src/features/export/lib/pptxAiEnrich.ts`。

```ts
import type { PptxLabels } from "./pptxParser";

export interface EnrichLabels {
  /** "AI 解釈" セクション見出し（例: "AI 解釈"） */
  aiSection: string;
  /** 出力言語ヒント（"日本語" / "English"） */
  lang: string;
}

// Build the AI-enriched preview markdown: deterministic markdown per slide with
// an "AI interpretation" section appended. Slides whose AI call fails keep only
// their deterministic markdown. Throws only if deterministic extraction fails.
export async function pptxToMarkdownPreviewEnriched(
  data: Uint8Array,
  labels: PptxLabels,
  enrich: EnrichLabels,
): Promise<string>;
```

処理:
1. `md = await pptxToMarkdownPreview(data, labels)` で決定論的プレビュー MD を取得
   （画像 data URL、スライドは `\n\n---\n\n` 区切り）。
2. `layouts = await extractPptxLayout(data)` を取得（同じスライド順）。
3. `md` をスライド境界（`\n\n---\n\n`）で分割し `chunks` を得る。`chunks.length` と
   `layouts.length` が一致しない場合は、安全側として AI 解釈の挿入を行わず `md` を
   そのまま返す（破損 PPTX 等の保険）。
4. 各 (chunk, layout) を**並列**に処理（同時実行上限 4 程度。`callAI` を Promise で
   束ね、簡易セマフォで制御）:
   - payload = レイアウトをテキスト化（各 shape を `[id] (x,y w×h): text`、各 connector を
     `from -> to` の行で列挙）
   - `interpretation = await callAI(aiSettings, SYSTEM_PROMPT(enrich.lang), payload)`
   - 成功時、chunk 末尾に `\n\n### ${enrich.aiSection}\n\n${interpretation}` を付加
   - 失敗時、chunk はそのまま（決定論 MD のみ）
5. 強化済み chunks を `\n\n---\n\n` で再結合して返す。

`aiSettings` は `useSettingsStore.getState().aiSettings`。空（API キー未設定）の場合は
呼び出し側（UI）で事前にエラー表示し、本関数は呼ばない。

SYSTEM_PROMPT（言語引数で ja/en 切替、`constants.ts` に定数で定義しハードコードを集約）:
> あなたはプレゼン資料の図解析アシスタントです。与えられるのは 1 枚のスライド上の
> 図形（正規化座標 0–100 とテキスト）とコネクタ（矢印の from→to）の一覧です。
> 空間配置と矢印から、その図が伝えようとしている意味を推論してください。
> フロー・関係・階層・対比を表す図なら **Mermaid**（flowchart 等）で表現し、
> そうでなければ要点を 2–4 行で簡潔に説明してください。出力は解釈本文のみ。
> 言語は {lang}。前置き・後置き・コードフェンス外の注釈は不要。

注: Mermaid をコードフェンス ```mermaid で囲って返すよう促す（プレビューの
mermaid 描画がフェンスを前提とするため）。プロンプトでフェンス付き出力を明示する。

## 5. UI 統合（PreviewPanel）

PPTX プレビュー（`isPptx`）のツールバーに「AI で図を解釈」ボタンを追加。

状態:
- `aiEnrichedMarkdown: string | null` / `aiEnriching: boolean` / `aiEnrichError: string | null`
- `showAiEnriched: boolean`（原文 ↔ AI 解釈の表示トグル）

挙動:
- ボタン押下時、`aiSettings` の API キーが未設定なら `aiEnrichError`（「AI 未設定」）を表示。
- 設定済みなら `aiEnriching=true`、`pptxToMarkdownPreviewEnriched(binaryData, labels, enrich)`
  を呼ぶ。`labels` は既存の `common:pptxSlideLabel`/`common:pptxNotesLabel`、`enrich` は
  `aiSection = t("pptxAiSection")`、`lang` は現在の i18n 言語に対応する語。
- 成功時 `aiEnrichedMarkdown` にセットし `showAiEnriched=true`。描画ソースを
  `showAiEnriched && aiEnrichedMarkdown ? aiEnrichedMarkdown : pptxMarkdown` とする
  （既存の `markdownSource` 派生に統合）。
- トグルで原文（決定論 MD）へ戻せる。タブ切替時は AI 状態をリセット（既存の生成
  エフェクトと同様に `activeTab.filePath` をキーにクリア）。
- ビュー専用は不変（保存しない・`.pptx` を上書きしない）。

i18n（`editor` 名前空間に追加）: `pptxAiButton`（"AI で図を解釈" / "Interpret diagram with AI"）、
`pptxAiLoading`、`pptxAiError`、`pptxAiNotConfigured`、`pptxAiShowOriginal` /
`pptxAiShowEnriched`（トグル）。`pptxAiSection`（"AI 解釈" / "AI interpretation"）。
すべて `t()` 経由、ハードコード禁止。

## 6. データフロー

```
[AI で図を解釈] 押下
  → aiSettings 確認（未設定ならエラー表示で終了）
  → pptxToMarkdownPreviewEnriched(binaryData, labels, enrich)
       ├─ pptxToMarkdownPreview(data, labels)  // 決定論 MD（data URL 画像, --- 区切り）
       ├─ extractPptxLayout(data)              // 各スライドの図形+コネクタ（正規化）
       └─ slides 並列: callAI(...) → 「### AI 解釈」挿入
  → aiEnrichedMarkdown にセット → 既存 Markdown 描画パイプラインで表示（Mermaid 含む）
```

## 7. エラーハンドリング

- AI 未設定（API キー空）: UI で事前にエラー表示し LLM を呼ばない。
- 個別スライドの `callAI` 失敗（ネットワーク/タイムアウト/レート制限）: そのスライドは
  決定論 MD のみとし、全体は継続。1 枚も成功しなくても決定論 MD は表示される。
- 決定論抽出自体の失敗（不正 PPTX）: 既存どおり例外伝播 → 既存のプレビューエラー表示。
- スライド境界分割数の不一致: AI 挿入をスキップして決定論 MD を返す（保険）。

## 8. 非対象 (YAGNI)

- 強化 Markdown の `.md` 保存／エクスポート（v1 はプレビュー表示のみ。保存は
  画像のファイル化と data URL の扱いが絡むため後続で別途設計）。
- スライドの画像化 + Vision LLM（レンダラ新規構築が必要・閉域/プロキシ制約のため不採用）。
- 一括変換ダイアログへの AI トグル統合（オプトインはプレビューのボタンに限定）。
- レイアウトの厳密な座標復元・テーマ/配色再現。
- ストリーミング表示やトークン使用量メータ。

## 9. テスト

- `src/features/export/lib/__tests__/pptxLayout.test.ts`（happy-dom, メモリ内 JSZip）:
  - 図形の EMU 座標がスライドサイズ基準で 0–100 に正規化される。
  - コネクタ `a:stCxn`/`a:endCxn` から from/to が解決される。
  - グループ内図形のテキスト/位置も抽出される。
- `src/features/export/lib/__tests__/pptxAiEnrich.test.ts`（happy-dom）:
  - `@/shared/lib/callAI` を `vi.mock` し、各スライド末尾に `### <aiSection>` と
    モック解釈が挿入されること、スライド順・区切りが保たれること。
  - あるスライドの `callAI` が reject したとき、そのスライドは決定論 MD のみで
    全体は継続すること。
  - 分割数不一致時に決定論 MD をそのまま返すこと。
- UI（PreviewPanel）は新規ユニットテストを設けず、`npx tsc --noEmit` と全テスト緑、
  手動検証で確認。

## 10. 手動検証

1. AI 設定（プロバイダ/モデル/API キー）を構成。
2. 図（箱＋矢印）を含む `.pptx` をプレビューし「AI で図を解釈」を押す。
3. 各スライドに原文＋「AI 解釈」（フロー図は Mermaid 描画）が併記されること。
4. トグルで原文表示に戻れること。
5. AI 未設定時に分かりやすいエラーが出ること。一部スライドの失敗で全体が壊れないこと。
6. 保存操作で `.pptx` が上書きされないこと（ビュー専用）。日本語/英語でラベル切替。
