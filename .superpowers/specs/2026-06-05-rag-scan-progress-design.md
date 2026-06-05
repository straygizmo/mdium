# RAGスキャン進捗の詳細表示 — 設計ドキュメント

- 日付: 2026-06-05
- 対象: RAGインデックス作成時の進捗表示改善

## 背景・課題

RAGインデックス作成は3フェーズで構成される:

1. **モデル読み込み** (`loadEmbed`) — ダウンロード%・読み込み%の進捗を表示済み
2. **フォルダスキャン** (`rag_scan_folder`) — Rust側の単一ブロッキング呼び出し。全ファイルを再帰走査し、読み込み・SHA256ハッシュ計算・見出し単位のチャンク分割を行う。**この間は進捗が一切報告されず、バッジは「Building...」のまま固定**
3. **埋め込み生成ループ** (`embed`) — チャンク単位で `currentIndex/totalChunks` とプログレスバー・ファイル名を表示済み

ユーザー報告: 「対象ファイルや容量が大きいと固まっているように見える」。原因はフェーズ2（スキャン）に粒度のある進捗が無いこと。大量ファイル・巨大ファイルでこのフェーズが長く止まって見える。

## 目的

スキャンフェーズに「処理件数 / 総数 + 現在のファイル名」を表示し、さらにUIバッジに現在のフェーズ名ラベル（スキャン中 / ベクトル化中 / 保存中）を表示して、「何をどこまでやっているか」を可視化する。

## 採用アプローチ

既存の `model-download-progress` と同じ **Tauriイベント方式**。`rag_scan_folder` のスキャンループ内でファイルごとに `rag-scan-progress` イベントを `app.emit` し、フロント側が `listen` で受けて進捗状態を更新する。既存パターンと一貫性があり実装リスクが低い。

検討した他案:
- **Tauri Channel方式**: 型安全だが既存コードに前例がなく新パターン導入コスト → 不採用
- **フェーズラベルのみ（イベント無し）**: 実装最小だが「件数+ファイル名」を出せず要件未達 → 不採用

## 設計詳細

### 1. バックエンド (`src-tauri/src/commands/rag.rs`)

#### 進捗ペイロード構造体

```rust
#[derive(Serialize, Clone)]
struct RagScanProgress {
    current: usize,   // 走査済みファイル数
    total: usize,     // 総ファイル数
    file: String,     // 現在処理中のファイルパス
}
```

#### 事前カウントパス

再帰走査は途中までフォルダ構造が分からず総数を出せないため、まず軽量な総数算出を行う。`count_files_recursive`（仮称）はディレクトリ列挙＋拡張子マッチのみを行い、ファイル読込・ハッシュ計算は行わない。`.mdium` 内ファイルも親フォルダ扱いで数える（実スキャンと件数を一致させる）。スキップ規則は既存の `scan_folder_recursive` と揃える:
- `node_modules` / `target` をスキップ
- `.mdium` 以外の隠しフォルダ（`.` 始まり）をスキップ
- `.mdium` フォルダは中の対象ファイルを親に帰属させて数える

#### `rag_scan_folder` シグネチャ変更

```rust
pub fn rag_scan_folder(
    app: tauri::AppHandle,            // 追加
    folder_path: String,
    file_extensions: Option<String>,
    min_chunk_length: Option<usize>,
    model_name: Option<String>,
) -> Result<Vec<RagChunk>, String>
```

- まず `count_files_recursive` で `total` を算出。
- `scan_folder_recursive` に `&AppHandle`・`total`・`&mut usize`（走査済みカウンタ）を追加で渡す。
- `scan_folder_recursive` 内の `for path in md_paths` ループ先頭でカウンタを増やし、`app.emit("rag-scan-progress", RagScanProgress { current, total, file })` を発行。`tauri::Emitter` は既にインポート済み。
- カウンタはハッシュ未変更でスキップされるファイルも含めて増やす（「走査済み件数」として総数と整合）。

#### スロットリング

数千ファイル時のIPC氾濫を防ぐため、更新が最大200件程度になるよう `step = max(1, total / 200)` 件ごとに発行する。最後のファイルは必ず発行して `current == total` で終わるようにする。ファイル読込・ハッシュ計算が各ファイルで走るため、この粒度で十分。

### 2. フロントエンド

#### `BuildProgress` 型の汎用化 (`useRagFeatures.ts`)

現状の `{ currentFile, currentIndex, totalChunks }`（埋め込み専用の命名）をフェーズ対応に一般化:

```typescript
interface BuildProgress {
  phase: "scanning" | "embedding" | "saving";
  current: number;
  total: number;
  currentFile: string;
}
```

#### `buildIndex` の改修 (`useRagFeatures.ts`)

- `rag_scan_folder` 呼び出しの直前に `rag-scan-progress` イベントを `listen` 登録。受信のたびに
  `setBuildProgress({ phase: "scanning", current: payload.current, total: payload.total, currentFile: payload.file })`。
- スキャン完了後、`try/finally` で確実に `unlisten()` してリスナーリークを防止（リビルド時の多重リスナー防止）。
- 埋め込みループでは各チャンクで `phase: "embedding"`, `current: i + 1`, `total: chunks.length`, `currentFile` をセット（既存の per-chunk 更新を踏襲）。
- `rag_save_chunks` 呼び出し直前に `phase: "saving"` をセット。

#### バッジ＆プログレスバー表示 (`RagPanel.tsx`)

- バッジ: フェーズに応じたラベル＋件数。
  - scanning: `${t("ragPhaseScanning")} ${current}/${total}`
  - embedding: `${t("ragPhaseEmbedding")} ${current}/${total}`
  - saving: `${t("ragPhaseSaving")}`
  - モデルDL/ロード中の既存表示（`ragDownloadingModel` / `embedProgress%`）は維持。
- プログレスバー: `current / total` で塗りつぶし（既存の `rag-panel__build-progress` 要素を再利用、新フィールド名に合わせて更新）。`saving` 時は total 不定なら不確定表示またはバー非表示。
- ファイル名: 既存の `rag-panel__build-progress-file` をそのまま流用。

### 3. i18n (`src/shared/i18n/locales/{en,ja}/common.json`)

新規キーを追加（CLAUDE.md準拠でハードコード禁止）:

| キー | en | ja |
|------|----|----|
| `ragPhaseScanning` | "Scanning" | "スキャン中" |
| `ragPhaseEmbedding` | "Embedding" | "ベクトル化中" |
| `ragPhaseSaving` | "Saving" | "保存中" |

## エラー処理・エッジケース

- リスナーは `try/finally` で必ず解除（リビルド時の多重リスナー防止）。
- 総数0件（対象ファイルなし）: emit無し → 既存の「変更ファイルなし」パスがそのまま機能。
- 事前カウントの追加走査はディレクトリ列挙のみで安価。
- スロットリングで大量ファイル時のIPC負荷を抑制。
- イベント名 `rag-scan-progress` は他で未使用（衝突なし）。

## テスト方針

- Rust: `count_files_recursive` が `scan_folder_recursive` と同じスキップ規則で同じ件数を返すことを単体テストで確認（`node_modules`/`target`/隠しフォルダ除外、`.mdium` 内ファイル算入）。
- 手動: 大量ファイル（数百〜数千）を含むフォルダでスキャン中にバッジが「スキャン中 N/総数 + ファイル名」と更新され、固まって見えないことを確認。フェーズが scanning → embedding → saving と遷移することを確認。en/ja 両ロケールでラベル表示を確認。

## 影響範囲

- `src-tauri/src/commands/rag.rs`（`rag_scan_folder` シグネチャ変更、進捗構造体・カウント関数追加、emit追加）
- `src/features/rag/hooks/useRagFeatures.ts`（`BuildProgress` 型、`buildIndex` のリスナー登録・フェーズ設定）
- `src/features/rag/components/RagPanel.tsx`（バッジ・プログレスバー表示）
- `src/shared/i18n/locales/{en,ja}/common.json`（フェーズラベル3キー）

注: `rag_scan_folder` の呼び出し元はフロントの `invoke("rag_scan_folder", ...)`（`useRagFeatures.ts`）と `lib.rs` のコマンド登録のみで、他に直接呼ぶRustコードは無いことを確認済み。`app: AppHandle` はTauriが自動注入するためフロント側の引数追加は不要。イベント名 `rag-scan-progress` も既存コードで未使用。
