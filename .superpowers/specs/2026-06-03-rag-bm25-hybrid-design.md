# RAG ベクトル/BM25 ハイブリッド検索（RRF融合）設計

- 日付: 2026-06-03
- 対象: mdium アプリ内蔵 RAG（`src-tauri/src/commands/rag.rs`, `src/features/rag/*`）
- ステータス: 設計確定（実装前）

## 1. 背景と目的

現在の mdium の RAG は **ベクトル検索のみ**で構成されている。

- フロント (`useLocalEmbedding.ts`): `@huggingface/transformers` (onnxruntime-web) で完全ローカルに埋め込みを生成（e5系 / ruri系モデル）。
- Rust (`rag.rs`): Markdown を見出し単位でチャンク化し、埋め込みを f64 BLOB として各フォルダの `.mdium/rag_{model}.db`（SQLite）に保存。検索は全チャンクを読み込みコサイン類似度を総当たり計算し上位 K 件を返す。

参考記事（https://note.com/major_elk2890/n/n66664dc73a94）が指摘するとおり、ベクトル検索は「ふわっとした質問」に強い反面、**コマンド名・変数名のような完全一致をそのまま検索すると取りこぼす**弱点がある。

本設計の目的は、既存のベクトル検索に **BM25（キーワード検索）を追加し、RRF（Reciprocal Rank Fusion）で融合**することで、この弱点を補い検索精度を高めることである。

記事の3層ハイブリッド（①ベクトル ②BM25 ③SoftMatcha2）のうち、本設計では **①は既存・②を追加**する。③ SoftMatcha2 は完全ローカル構成（Python ランタイム非搭載）では移植コストが大きいため、**本スコープ外（将来の別フィーチャー）**とする。

## 2. スコープ

### 対象
- mdium アプリ内蔵の RAG パネル（このリポジトリ）。

### 含む
- BM25 検索（SQLite FTS5 + trigram トークナイザ、`bm25()` ランキング）。
- ベクトル検索と BM25 の RRF 融合（Rust 側で完結）。
- 既存インデックスの後方互換（再埋め込み不要）。
- 検索モード切替と BM25 重みの設定 UI（i18n 遵守）。

### 含まない
- SoftMatcha2 の実装（将来の別フィーチャー）。
- 形態素解析器（Lindera/vibrato 等）の導入。
- 埋め込みモデル・埋め込み生成フローの変更。

## 3. 採用方針（確定事項）

| 論点 | 決定 |
|------|------|
| スコープ | BM25 追加 → ベクトル/BM25 ハイブリッド。SoftMatcha は将来 |
| 対象 | mdium 内蔵 RAG パネル |
| BM25 実装 | SQLite FTS5 + trigram トークナイザ（新規依存ゼロ・辞書不要・バンドル増なし） |
| 融合方式 | RRF（Reciprocal Rank Fusion） |
| 後方互換 | 既存 DB から FTS 索引を再構築（再埋め込み不要） |
| デフォルト | hybrid（ハイブリッド検索を既定で有効） |

`rusqlite = { version = "0.31", features = ["bundled"] }` の bundled ビルドは SQLite を `SQLITE_ENABLE_FTS5` 付きでコンパイルするため、`bm25()` ランキング関数と `trigram` トークナイザが追加依存なしで利用できる。

## 4. アーキテクチャ

現状の「フロントで埋め込み生成 → Rust でコサイン総当たり」の流れは維持し、**Rust 側の検索にBM25を追加して融合する**。

融合を Rust 側で完結させる理由: 検索は複数 DB（カレントフォルダ + サブフォルダ）にまたがるため、候補を**グローバルに順位付けして RRF 融合**する必要がある。DB ごとに融合すると順位が壊れる。

```
フロント: 質問テキスト + クエリ埋め込み
   ↓ rag_search(folderPath, embedding, queryText, limit, modelName, searchMode, bm25Weight)
Rust:
   各DBから:
     ① 全チャンクの (id, file, heading, text, line, cosine類似度)
     ② FTS5 MATCH(queryText) にヒットしたチャンクの (id, bm25スコア)
   ↓ 全DBの候補を1つのリストにマージ（DBをまたいで一意化）
   ベクトル順位 rank_v を算出（cosine 降順）
   BM25順位   rank_b を算出（bm25 昇順 = スコア良い順）
   ↓ RRF:
     score = w_v / (k + rank_v) + w_b / (k + rank_b)
   ↓ score 降順にソートし上位 limit 件を返す
```

- `searchMode == "vector"` のときは従来どおりコサインのみで順位付けし返す（BM25/FTS をスキップ）。
- `w_v = 1 - bm25Weight`、`w_b = bm25Weight`。
- `k`（RRF 定数）は内部定数 `RRF_K = 60`（UI には出さない）。

### 候補の一意化
各チャンクは1つの DB にのみ存在する。マージ時は `(db_path, rowid)` を一意キーとして扱う。BM25 にヒットしないチャンクは `rank_b` を持たず、RRF の BM25 項は 0 とする（= ベクトル項のみで寄与）。逆にベクトルは全チャンクに存在するため `rank_v` は常に算出される。

## 5. データ層（FTS5・後方互換）

### スキーマ
各 `rag_{model}.db` に external-content の FTS5 仮想テーブルを追加する。本文を二重保存しない。

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
    text,
    content='chunks',
    content_rowid='id',
    tokenize='trigram'
);
```

### 同期トリガー
`chunks` への INSERT / DELETE に対しトリガーを張り FTS 索引を自動同期する。既存の削除経路が複数（scan のプルーニング、`rag_save_chunks` の更新前削除、削除ファイルのクリーンアップ）あるため、手動同期よりトリガーが安全。

```sql
CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES('delete', old.id, old.text);
END;
```
（UPDATE は本コードベースでは「DELETE → INSERT」でのみ発生するため、UPDATE トリガーは不要。必要になれば追加する。）

### 後方互換（再埋め込み不要）
`ensure_tables` を拡張し、`chunks_fts` が存在しなければ作成したうえで、既存チャンクから索引を再構築する。

```sql
INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild');
```

これにより既存ユーザーは**再埋め込み不要**で、アプリ更新後の初回オープン時に BM25 索引が自動生成される。`rebuild` は冪等なので、初回のみ実行されるよう「FTS テーブルが新規作成されたとき」または「FTS の行数が 0 かつ chunks の行数が >0 のとき」に限定して実行する。

## 6. クエリ処理（FTS5 trigram）

質問文を FTS5 の MATCH クエリへ変換する。

- trigram トークナイザは3文字以上の部分一致を行う。
- FTS5 の特殊文字（`"`, `*`, `(`, `)`, `:` 等）をエスケープする。最も安全なのは各語をダブルクォートで括る方法（`"..."` 内のダブルクォートは `""` にエスケープ）。
- 質問文を空白で語に分割し、**3文字以上の語のみ**を抽出してダブルクォートで括り、`OR` で結合する。3文字未満の語は trigram では索引できないため BM25 側ではスキップ（ベクトル側が拾う）。
- 抽出語が1つも無い場合は BM25 をスキップし、ベクトルのみで順位付け（フォールバック）。

例: `git の rebase コマンド` → `"rebase" OR "コマンド"`（"git", "の" は3文字未満で除外）。

これにより「コマンド名・変数名をそのまま投げる」ケースで部分一致が効く。

## 7. 設定と UI（i18n 遵守）

### 型 (`src/shared/types/index.ts`)
`RagSettings` に追加:

```ts
export interface RagSettings {
  embeddingModel: /* 既存のまま */;
  minChunkLength: number;
  fileExtensions: string;
  retrieveTopK: number;
  retrieveMinScore: number;
  searchMode: "vector" | "hybrid";   // 追加（デフォルト "hybrid"）
  bm25Weight: number;                // 追加（0..1、デフォルト 0.5）
}
```

### デフォルト (`src/stores/settings-store.ts`)
`DEFAULT_RAG_SETTINGS` に `searchMode: "hybrid"`, `bm25Weight: 0.5` を追加。既存ユーザーの永続化済み設定にこれらが無い場合に備え、ストア読み込み時にデフォルトでフォールバックする（マイグレーション）。

### UI (`RagPanel.tsx`)
- 検索モード切替（vector / hybrid）。
- BM25 重みスライダー（hybrid 時のみ表示、0..1）。
- **すべての UI 文字列は i18n**（`locales/ja/*.json`, `locales/en/*.json`）に追加。ハードコード禁止（プロジェクト規約）。

### 呼び出し (`useRagFeatures.ts`)
`askQuestion` 内の `rag_search` 呼び出しに `queryText: question`, `searchMode`, `bm25Weight` を追加。`retrieveMinScore` フィルタは RRF スコアに対しては意味が変わるため、hybrid 時はフィルタを無効化（または別の閾値解釈）する。詳細は実装計画で決定。

### Rust コマンド (`rag.rs`)
`rag_search` のシグネチャを拡張:

```rust
pub fn rag_search(
    folder_path: String,
    embedding: Vec<f64>,
    query_text: String,      // 追加
    limit: usize,
    model_name: Option<String>,
    search_mode: Option<String>,  // 追加 "vector" | "hybrid"
    bm25_weight: Option<f64>,     // 追加
) -> Result<Vec<RagSearchResult>, String>
```

`RagSearchResult.score` は hybrid 時は RRF スコア、vector 時は従来どおりコサイン類似度を入れる。

## 8. テスト

### Rust（`cargo test`）
- RRF 融合ロジックの単体テスト: 既知の2つのランクリストを与え、期待される融合順位を検証。
- FTS5 同期トリガーのテスト: チャンク INSERT/DELETE 後に `MATCH` の結果が一致することを検証。
- 後方互換テスト: FTS テーブルなしの DB（chunks のみ）を開いた後、`rebuild` で MATCH が機能することを検証。
- trigram クエリ変換/エスケープのテスト: 特殊文字・3文字未満語・空クエリのフォールバック。

### フロント（vitest）
- hybrid 時に `rag_search` へ `queryText` / `searchMode` / `bm25Weight` が渡ることを検証（invoke モック）。
- 設定の往復（store の保存/読み込みで新フィールドが保持される、旧設定からのマイグレーション）。

## 9. リスクと留意点

- **trigram の特性**: trigram は語境界を見ない部分一致のため、形態素ベース BM25 より精度は劣るが、辞書不要・バンドル増なしの利点が大きい。完全一致弱点の補完という本来の目的には十分。
- **パフォーマンス**: ベクトル検索は既に全チャンク総当たり O(N)。FTS5 MATCH はインデックス済みで高速、候補を絞るため全体性能を悪化させない。個人規模では問題なし。
- **RRF と minScore フィルタの整合**: RRF スコアはコサインと尺度が異なるため、既存の `retrieveMinScore` を hybrid にそのまま適用しない。実装計画で扱いを確定する。
- **将来拡張**: SoftMatcha2 を追加する場合も同じ RRF 融合点に第3ランクを足す形で拡張できる（融合を Rust に集約した設計の利点）。
