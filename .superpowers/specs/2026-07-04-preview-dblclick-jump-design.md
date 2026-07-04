# プレビューのダブルクリックでエディタの該当行へジャンプ — 設計

- 日付: 2026-07-04
- 対象機能: MD エディタ / プレビュー（`src/features/editor`, `src/features/preview`, `src/app/App.tsx`）
- ステータス: 設計確定（承認済み）

## 背景 / 目的

MD プレビュー側の任意の場所をダブルクリックしたとき、エディタ側を対応するソース行へスクロールし、そこにカーソルを置きたい。プレビューを読みながら「ここを直したい」と思った箇所へ即座に編集を始められるようにする。

調査の結果、必要なインフラの大部分は既に存在する:

- プレビューの各トップレベルブロック要素には `data-source-line`（1 始まり、front matter オフセット考慮済み）が付与済み（`src/shared/lib/markdown/render-with-source-lines.ts`）。
- 行番号 → エディタ scrollTop の変換（`(line - 1) * lineHeight`、lineHeight は `getComputedStyle` で計測）は `src/shared/hooks/useScrollSync.ts` に実装済み。
- プレビュー上の dblclick ハンドラの前例あり（画像ダブルクリックでタブを開く、`PreviewPanel.tsx` 874 行付近）。

追加するのは「dblclick → 行番号解決 → エディタジャンプ」の配線のみ。

## ゴール / 非ゴール

ゴール:

- プレビュー内の要素をダブルクリックすると、エディタが該当ソース行へスクロールし、その行頭にカーソル（キャレット）が移動してフォーカスされる。
- 対象行はエディタの表示領域の中央付近に来るようにスクロールする。
- スクロール同期設定（`scrollSync`）の ON/OFF に関係なく常に動作する（明示的なユーザー操作のため）。

非ゴール:

- 複数行ブロック（コードブロック・長いリスト等）内部の行単位の精度。ダブルクリック位置を含むブロックの**先頭行**へのジャンプで十分とする（ユーザー確認済み）。レンダラの深い注釈付けは行わない。
- エディタ → プレビューの逆方向ジャンプ（既存のスクロール同期で足りる）。
- シングルクリックや修飾キー付きクリックでの発動。

## アーキテクチャ

案 A（採用）: `App.tsx` にジャンプコールバックを置く。`App.tsx` は `editorRef` と現在タブの `content` の両方を持っており、`PreviewPanel` はエディタの内部構造を知らずに済む（既存 props 設計と一貫）。

却下した案 B: `editorRef` を `PreviewPanel` へ直接渡す — プレビューがエディタ DOM を直接操作することになり境界が崩れる。行 → 文字オフセット変換に `content` も必要になり、渡すものが結局増える。

## コンポーネント / データフロー

### 1. `App.tsx` — `handleJumpToEditorLine(line: number)`（新規コールバック）

1. `editorRef.current` が null（エディタ非表示等）なら何もしない。
2. アクティブタブの `content` から `line` 行目の先頭文字オフセットを計算（`\n` を数えるだけの純関数）。
3. `textarea.focus()` → `setSelectionRange(offset, offset)`。
4. `textarea.scrollTop = max(0, (line - 1) * lineHeight - clientHeight / 2 + lineHeight / 2)` で行を中央付近に配置。lineHeight の計測は `useScrollSync.ts` と同じ方式（`getComputedStyle(editor).lineHeight`、`normal` 時はフォントサイズ × 1.5 等のフォールバック）。
5. `useMemo`/`useCallback` で安定化し、`PreviewPanel` に `onJumpToLine` prop として渡す。

補足: `focus()` はブラウザ既定のスクロールを引き起こしうるため、`focus({ preventScroll: true })` を使い、scrollTop は手動で設定する。

### 2. `PreviewPanel.tsx` — dblclick ハンドラ（新規）

既存の画像 dblclick ハンドラ（874 行付近）と同じパターンで `contentRef` に `dblclick` リスナーを追加:

1. `e.target.closest("img[data-filepath]")` に一致する場合は何もしない（既存の「画像をタブで開く」動作を優先。既存ハンドラと発火順に依存しないよう、新ハンドラ側で明示的に除外する）。
2. `e.target.closest("[data-source-line]")` で最近傍の注釈付きブロックを探す。見つからない場合（合成要素等）は何もしない。
3. `Number(el.dataset.sourceLine)` が正の整数なら `onJumpToLine(line)` を呼ぶ。
4. リスナーは既存パターンと同様、`html` 再注入のたびに張り直す effect 内で登録・解除する。

`onJumpToLine` は optional prop とし、未指定時はハンドラを登録しない。

### 3. 既存スクロール同期との相互作用

ジャンプで `editor.scrollTop` を設定するとエディタの `scroll` イベントが発火し、`useScrollSync` の `syncFromEditor` がプレビューを「同じ場所」へ再同期する。ジャンプ先はダブルクリックした要素の位置なので実害はない（プレビューがほぼ動かないか、ブロック先頭位置に微調整される程度）。特別なガードは入れない。実機確認で視覚的な揺れが目立つ場合のみ、`useScrollSync` の `isSyncingRef` 相当の抑制を検討する。

## エラーハンドリング

- `data-source-line` が欠落・不正（NaN、0 以下）→ 無視（no-op）。
- 行番号が `content` の総行数を超える（レンダリングと編集のタイミング差）→ 最終行にクランプ。
- エディタペイン非表示時 → no-op（`editorRef.current` が null）。

## UI 文字列 / i18n

新規の UI 文字列なし（ボタン・ツールチップを追加しないため i18n 対応は不要）。

## テスト

- 純関数（行番号 → 文字オフセット、クランプ）はユニットテストを追加（既存のテスト配置規約 `__tests__/` に従う）。
- dblclick → コールバック解決（`data-source-line` の closest 解決、画像除外、欠落時 no-op）は jsdom ベースのコンポーネント/ハンドラテストが既存構成で可能なら追加。難しければ純関数部分の切り出しでカバー。
- 実機スモーク: 見出し・段落・コードブロック途中・画像・front matter 付きファイルでダブルクリックし、ジャンプ位置とカーソル位置を確認。
