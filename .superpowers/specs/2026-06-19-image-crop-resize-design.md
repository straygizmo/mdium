# 画像編集：トリミング／リサイズ機能 設計書

- 日付: 2026-06-19
- 対象: `src/features/image/`（ImageCanvas / useImageCanvas / ImagePreviewToolbar）、`src/app/App.tsx`、`src/stores/tab-store.ts`、i18n（`image-editor` ロケール）

## 1. 目的

画像編集ビューに以下2機能を追加する。

- **トリミング（crop）**: 選択した矩形領域だけを残して画像をその大きさに切り抜く（実ピクセルサイズが変わる）。
- **リサイズ（拡大縮小 / resize）**: 出力画像の実ピクセル数を数値指定で変更する。注釈もまとめてスケールされる。

いずれも**元画像の実解像度を基準**に動作し、表示縮小に起因する劣化を起こさないことを必須要件とする。

## 2. 現状と課題

現在の画像編集は Fabric.js ベース。ツール: `select / text / rect / circle / arrow / line / pen / ocr`。ズームは `viewportTransform` による表示倍率のみで、画像本体のサイズ変更・切り抜きはない。

`useImageCanvas.loadBackgroundImage` がキャンバス内部寸法をコンテナに収まるサイズへ**物理的に縮小**し、背景画像も `scale = min(scaleX, scaleY, 1)` で縮小、注釈は縮小後座標で保持する。保存（`App.tsx`）は `getCanvasDataUrl()` をそのまま PNG 化してファイル上書きするため、**元が大きい画像は表示・保存の時点で実解像度が落ちる**。トリミング／リサイズをこの上に乗せると操作基準が縮小後サイズになり品質劣化が残るため、座標系の基盤から見直す。

## 3. アーキテクチャ方針：実ピクセル座標系への移行（基盤）

Fabric キャンバスの内部座標系を「**元画像の実ピクセル**」に一致させる。

- キャンバス内部寸法 = 元画像の実 W×H、背景画像 `scaleX/scaleY = 1`、`left/top = 0`。
- コンテナへ収める「フィット表示」は既存の `viewportTransform`（ズーム）で行う。
- 初期表示時に `initialZoom = min(コンテナW/画像W, コンテナH/画像H, 1)` を初期ズームとして `setViewportTransform` で適用し、`zoomLevel` に反映する（中央寄せのため必要に応じて平行移動も設定）。
- 既存のズームボタン／Ctrl+ホイール／`resetZoom` はこの初期ズームを基準に動くよう調整（`resetZoom` は等倍ではなく「フィット表示」に戻す挙動へ変更）。

### 帰結
- トリミング・リサイズ・保存がすべて実ピクセルで動き、劣化が発生しない。
- 注釈座標も実ピクセルで永続化され、再読み込み時のズレが軽減する。
- `getCanvasDataUrl` の region 計算は `scale=1` 前提で単純化される。
- 注釈描画は `getScenePoint` 経由のシーン座標を使っているため、座標系変更に追従済み。

### 影響範囲
`useImageCanvas.ts`: `initCanvas` / `loadBackgroundImage` / ズーム初期値・`resetZoom` / `getCanvasDataUrl` / `saveImage`。`App.tsx` の保存処理は `getCanvasDataUrl()` の戻り値がそのまま実解像度PNGになるため追加変更不要。

## 4. トリミング（crop）

新ツール `crop` を `ImageTool` 型と `TOOL_IDS` に追加。OCR と同様の「矩形を引く→確定」フロー。

### 操作フロー
1. ツールバー「トリミング」選択 → カーソル crosshair。
2. 画像上で矩形をドラッグ。OCR と同じく半透明オーバーレイ＋破線枠で選択範囲を表示。選択後は Fabric 標準ハンドルでサイズ・位置を微調整可能。
3. 確定UI（範囲近傍またはツールバーに「適用」「キャンセル」ボタン）を表示。範囲ピクセル値（例 `820 × 540`）も表示。
4. 「適用」で実行:
   - 操作前のフルスナップショットを undo にプッシュ（§6）。
   - 背景画像を選択範囲で切り出した新画像へ差し替え（オフスクリーン canvas で `drawImage`、実ピクセル基準）。
   - キャンバス内部寸法を範囲サイズへ変更。
   - 全注釈オブジェクトを `left -= region.left, top -= region.top` で平行移動。範囲外にはみ出た注釈は削除せずクリップ表示（見えなくなるだけ）。
   - フィット用ズームを再計算。
   - `imageBlobUrl` を新画像 dataURL へ差し替え（§7）。
5. 「キャンセル」で選択矩形を破棄しツールを `select` に戻す。

### SVG の扱い
トリミングはラスタ操作のため、既存 drawing ツール同様 `isSvg` のとき非表示。

## 5. リサイズ（resize）ダイアログ

ツールバーに「リサイズ」ボタンを追加。クリックで `AppDialog`（`src/shared/components/AppDialog`）ベースのモーダルを開く。

### ダイアログUI
- 現在サイズ表示: `現在: 1920 × 1080 px`
- 幅（px）入力 / 高さ（px）入力
- 「縦横比を固定」チェックボックス（デフォルトON）。ON時は片方変更でもう片方を自動追従。
- プリセット倍率ボタン: 25% / 50% / 75% / 200%。クリックで両入力欄へ反映。
- 「OK」「キャンセル」。

### 適用処理
- 倍率 `rx = newW / curW`, `ry = newH / curH` を算出。
- 操作前フルスナップショットを undo にプッシュ（§6）。
- 背景画像: オフスクリーンで新サイズへ `drawImage`（`imageSmoothingQuality = 'high'`）し差し替え。
- キャンバス内部寸法を `newW × newH` へ変更。
- 全注釈オブジェクトを `rx, ry` でスケール: `scaleX *= rx`, `scaleY *= ry`, `left *= rx`, `top *= ry`。線幅・フォントサイズは `scaleX/scaleY` に追従するため個別変更は不要（Fabric の仕様に合わせ、必要なら明示スケール）。
- フィット用ズーム再計算、`imageBlobUrl` を新画像 dataURL へ差し替え（§7）。

### バリデーション
1〜10000px の整数。範囲外・非数値は OK を無効化。全文言は i18n（`imageEditor` 名前空間に追加）。

### SVG の扱い
リサイズもラスタ操作のため `isSvg` のとき非表示。

## 6. Undo / Redo の拡張

トリミング・リサイズはキャンバス寸法と背景画像そのものを変えるため、現在の undo（注釈JSONのみ・背景除外）では戻せない。スナップショットを拡張する。

- 現状: `undoStack: string[]`（注釈JSON）。
- 変更: スナップショットを `{ json: string; width: number; height: number; bgDataUrl?: string }` に拡張。
  - 通常の描画操作では `bgDataUrl` を省略（`undefined` のとき背景は維持）。寸法は現状値を記録。
  - crop/resize の操作前にだけ `bgDataUrl` 付きフルスナップショットをプッシュ。
- `undo`/`redo` 復元時: `width/height` と `bgDataUrl` があれば寸法・背景を先に復元してから注釈JSONを `loadFromJSON`、その後フィットズーム再計算。
- メモリ方針: まず `MAX_UNDO = 50` 据え置きで実装。大画像でメモリ問題が出たらフルスナップショットのみ別枠で世代数を絞る（後追い対応）。

## 7. 永続化（imageCanvasJson / imageBlobUrl）

crop/resize 後は寸法・背景が変わるため、`serializeCanvas`（背景除外の注釈JSON）だけでは復元時に元画像へ戻ってしまう。

- **方針: crop/resize 適用時に `imageBlobUrl` を新画像 dataURL へ差し替える。**
  - これにより、タブ切り替え・再読み込みでも新画像が背景の基準になり、注釈JSONとの整合が取れる。
  - `tab-store` に差し替え用アクション（例 `updateImageBlobUrl(tabId, url)`）を追加。`ImageCanvas` から `onCanvasModified` と同様のコールバック、または専用コールバックで App 側へ通知し、`activeTab.imageBlobUrl` を更新する。
  - 既存の `imageBlobUrl` が Blob URL（`URL.createObjectURL`）の場合は、差し替え時に古い URL を `URL.revokeObjectURL` で解放してリークを防ぐ。dataURL を用いる場合は解放不要。実装時にどちらを採用するか確認し統一する。
- ファイルへの確定保存は従来どおりユーザーの Ctrl+S 時に `getCanvasDataUrl()`（実解像度）でファイル上書き。crop/resize 自体は即時ファイル保存しない（ダーティ状態として保持）。

## 8. i18n

i18n 名前空間は `imageEditor`（`useTranslation("imageEditor")`）、ファイルは `src/shared/i18n/locales/{ja,en}/image-editor.json`。以下を追加（キー名は実装時に調整可）。

- `tools.crop`（例 ja: `✂ トリミング`）
- `crop.apply` / `crop.cancel` / `crop.sizeLabel`
- `resize.button`（例 `⤢ リサイズ`） / `resize.title` / `resize.current` / `resize.width` / `resize.height` / `resize.keepAspect` / `resize.preset` / `resize.ok` / `resize.cancel` / `resize.invalid`

UI文言のハードコード禁止（プロジェクト規約）。

## 9. テスト方針

- ユニット（ロジック抽出可能な部分）: crop 範囲計算（実ピクセル変換）、resize 倍率計算、アスペクト比固定の追従計算、バリデーション境界（0 / 1 / 10000 / 10001 / 非整数）。
- 統合（Fabric 依存のため手動確認中心）:
  - 大きい画像を開き、フィット表示・初期ズームが正しいこと。
  - 注釈を描いた状態で crop → 注釈が正しく平行移動・クリップされること。
  - resize（縮小・拡大・アスペクト固定／非固定・プリセット）後に注釈が比例スケールすること。
  - crop/resize 後に undo/redo で寸法・背景・注釈が完全復元すること。
  - crop/resize 後に Ctrl+S → ファイルが実解像度で上書きされること。
  - タブ切り替え後に crop/resize 結果が保持されること。
  - SVG タブでトリミング／リサイズボタンが非表示であること。

## 10. スコープ外（YAGNI）

- 回転・反転・フィルタ等の追加画像処理。
- 自由形状（非矩形）トリミング。
- リサイズの補間アルゴリズム選択UI（`imageSmoothingQuality='high'` 固定）。
- フルスナップショット undo の世代別上限制御（問題が出たら後追い）。
