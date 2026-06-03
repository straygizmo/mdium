# RAG ベクトル/BM25 ハイブリッド検索 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 既存のベクトルのみの RAG に BM25（SQLite FTS5 trigram）を追加し、RRF で融合して検索精度を高める。

**Architecture:** フロントは質問テキストとクエリ埋め込みを Rust の `rag_search` に渡す。Rust は各 SQLite DB から全チャンクのコサイン類似度と FTS5 `bm25()` スコアを取得し、複数 DB をまたいだ候補をグローバルに順位付けして RRF で融合、上位 K 件を返す。FTS5 索引は external-content + トリガーで自動同期し、既存 DB は初回オープン時に `rebuild` で再構築（再埋め込み不要）。

**Tech Stack:** Rust（rusqlite bundled = SQLite FTS5 + trigram + bm25）、React + TypeScript、zustand persist、i18next、vitest、cargo test。

---

## File Structure

**Rust（バックエンド）**
- Modify: `src-tauri/src/commands/rag.rs`
  - `ensure_tables`: FTS5 仮想テーブル + 同期トリガー + 後方互換 rebuild を追加。
  - 新規 private 関数: `build_fts_query`（テキスト→MATCH クエリ）、`fuse_rrf`（RRF 融合）。
  - `search_single_db`: コサイン＋bm25 を持つ候補構造体を返すよう変更。
  - `rag_search`: シグネチャ拡張（`query_text`, `search_mode`, `bm25_weight`）＋融合。
  - 末尾に `#[cfg(test)] mod tests`。

**フロント（TypeScript）**
- Modify: `src/shared/types/index.ts` — `RagSettings` に `searchMode`, `bm25Weight`。
- Create: `src/features/rag/lib/rag-settings.ts` — `DEFAULT_RAG_SETTINGS` と純粋関数 `normalizeRagSettings`（副作用なし・テスト容易）。
- Create: `src/features/rag/lib/rag-settings.test.ts` — 上記のテスト。
- Modify: `src/stores/settings-store.ts` — 上記からデフォルトを取り込み、persist の `merge` で旧設定にデフォルトを補完。
- Modify: `src/features/rag/hooks/useRagFeatures.ts` — `rag_search` に `queryText`/`searchMode`/`bm25Weight` を渡し、hybrid 時は cosine 用 minScore フィルタを無効化。
- Modify: `src/features/rag/components/RagPanel.tsx` — 検索モード切替と BM25 重みスライダー。
- Modify: `src/shared/i18n/locales/ja/common.json`, `src/shared/i18n/locales/en/common.json` — 新規 UI 文字列。

---

## Task 1: FTS5 スキーマ・トリガー・後方互換 rebuild

**Files:**
- Modify: `src-tauri/src/commands/rag.rs:73-89`（`ensure_tables`）
- Test: `src-tauri/src/commands/rag.rs`（末尾 `#[cfg(test)] mod tests`）

- [ ] **Step 1: Write the failing test**

`rag.rs` の末尾に追加（既存に test モジュールが無ければ新規作成）:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn insert_chunk(conn: &Connection, file: &str, text: &str) {
        conn.execute(
            "INSERT INTO chunks (file, heading, text, line, hash, embedding) VALUES (?1,?2,?3,?4,?5,?6)",
            rusqlite::params![file, "", text, 0i64, "h", Vec::<u8>::new()],
        ).unwrap();
    }

    #[test]
    fn fts_trigger_keeps_index_in_sync() {
        let conn = Connection::open_in_memory().unwrap();
        ensure_tables(&conn).unwrap();

        insert_chunk(&conn, "a.md", "rebase コマンドの使い方");
        let hits: i64 = conn
            .query_row(
                "SELECT count(*) FROM chunks_fts WHERE chunks_fts MATCH '\"rebase\"'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(hits, 1, "inserted chunk should be searchable via FTS");

        conn.execute("DELETE FROM chunks WHERE file = 'a.md'", []).unwrap();
        let hits_after: i64 = conn
            .query_row(
                "SELECT count(*) FROM chunks_fts WHERE chunks_fts MATCH '\"rebase\"'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(hits_after, 0, "deleted chunk should be removed from FTS");
    }

    #[test]
    fn ensure_tables_backfills_legacy_db() {
        let conn = Connection::open_in_memory().unwrap();
        // Simulate a pre-FTS DB: only the base tables exist, with one row.
        conn.execute_batch(
            "CREATE TABLE chunks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                file TEXT NOT NULL, heading TEXT NOT NULL, text TEXT NOT NULL,
                line INTEGER NOT NULL, hash TEXT NOT NULL, embedding BLOB);
             CREATE TABLE file_hashes (file TEXT PRIMARY KEY, hash TEXT NOT NULL);",
        ).unwrap();
        insert_chunk(&conn, "old.md", "legacy rebase content");

        // First call must create the FTS table AND backfill the existing row.
        ensure_tables(&conn).unwrap();
        let hits: i64 = conn
            .query_row(
                "SELECT count(*) FROM chunks_fts WHERE chunks_fts MATCH '\"rebase\"'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(hits, 1, "legacy rows must be backfilled into FTS");
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml fts_trigger_keeps_index_in_sync ensure_tables_backfills_legacy_db`
Expected: FAIL（`no such table: chunks_fts` などでコンパイル/実行エラー）

- [ ] **Step 3: Write minimal implementation**

`ensure_tables` を以下に置き換える（`src-tauri/src/commands/rag.rs:73-89`）:

```rust
fn ensure_tables(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS chunks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            file TEXT NOT NULL,
            heading TEXT NOT NULL,
            text TEXT NOT NULL,
            line INTEGER NOT NULL,
            hash TEXT NOT NULL,
            embedding BLOB
        );
        CREATE TABLE IF NOT EXISTS file_hashes (
            file TEXT PRIMARY KEY,
            hash TEXT NOT NULL
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
            text,
            content='chunks',
            content_rowid='id',
            tokenize='trigram'
        );
        CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
            INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
        END;
        CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
            INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES('delete', old.id, old.text);
        END;",
    )?;

    // Backfill the FTS index for databases created before FTS existed.
    // Runs once: only when the index is empty but chunks are present.
    let fts_count: i64 = conn.query_row("SELECT count(*) FROM chunks_fts", [], |r| r.get(0))?;
    let chunk_count: i64 = conn.query_row("SELECT count(*) FROM chunks", [], |r| r.get(0))?;
    if fts_count == 0 && chunk_count > 0 {
        conn.execute_batch("INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild');")?;
    }
    Ok(())
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test --manifest-path src-tauri/Cargo.toml fts_trigger_keeps_index_in_sync ensure_tables_backfills_legacy_db`
Expected: PASS（2 tests）

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands/rag.rs
git commit -m "feat(rag): add FTS5 index, sync triggers, and legacy backfill"
```

---

## Task 2: `build_fts_query`（テキスト→FTS5 MATCH クエリ）

**Files:**
- Modify: `src-tauri/src/commands/rag.rs`（`cosine_similarity` の近くに private 関数を追加）
- Test: `src-tauri/src/commands/rag.rs`（`mod tests`）

- [ ] **Step 1: Write the failing test**

`mod tests` 内に追加:

```rust
    #[test]
    fn build_fts_query_extracts_terms() {
        // "の" is 1 char (<3) and is dropped; the rest are kept and quoted.
        let q = build_fts_query("git の rebase コマンド").unwrap();
        assert_eq!(q, "\"git\" OR \"rebase\" OR \"コマンド\"");
    }

    #[test]
    fn build_fts_query_escapes_double_quotes() {
        // Internal double quotes are doubled, then the term is wrapped in quotes.
        let q = build_fts_query("a\"b cde").unwrap();
        assert_eq!(q, "\"a\"\"b\" OR \"cde\"");
    }

    #[test]
    fn build_fts_query_returns_none_when_no_term_qualifies() {
        assert!(build_fts_query("a b の").is_none());
        assert!(build_fts_query("   ").is_none());
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml build_fts_query`
Expected: FAIL（`cannot find function build_fts_query`）

- [ ] **Step 3: Write minimal implementation**

`cosine_similarity` 関数の直後（`src-tauri/src/commands/rag.rs:105` 付近）に追加:

```rust
/// Build an FTS5 MATCH query from free text for the trigram tokenizer.
///
/// Splits on whitespace, keeps terms of >= 3 Unicode chars (the trigram
/// tokenizer needs at least 3 characters to index), wraps each term in double
/// quotes (doubling any embedded quote to escape it), and joins with `OR`.
/// Returns `None` when no term qualifies, so the caller can skip BM25 entirely.
fn build_fts_query(query_text: &str) -> Option<String> {
    let terms: Vec<String> = query_text
        .split_whitespace()
        .filter(|t| t.chars().count() >= 3)
        .map(|t| format!("\"{}\"", t.replace('"', "\"\"")))
        .collect();
    if terms.is_empty() {
        None
    } else {
        Some(terms.join(" OR "))
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test --manifest-path src-tauri/Cargo.toml build_fts_query`
Expected: PASS（3 tests）

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands/rag.rs
git commit -m "feat(rag): add build_fts_query trigram query builder"
```

---

## Task 3: `fuse_rrf`（RRF 融合）

**Files:**
- Modify: `src-tauri/src/commands/rag.rs`（`build_fts_query` の後に追加）
- Test: `src-tauri/src/commands/rag.rs`（`mod tests`）

- [ ] **Step 1: Write the failing test**

`mod tests` 内に追加:

```rust
    #[test]
    fn fuse_rrf_pure_vector_when_weight_zero() {
        // (cosine, bm25 where smaller = better). bm25_weight = 0 => cosine order.
        let items = vec![(0.9, None), (0.2, Some(-5.0)), (0.8, Some(-1.0))];
        let order = fuse_rrf(&items, 0.0, 60.0, 3);
        assert_eq!(order, vec![0, 2, 1]); // 0.9 > 0.8 > 0.2
    }

    #[test]
    fn fuse_rrf_pure_bm25_when_weight_one() {
        // bm25_weight = 1 => only matched items score; unmatched falls last.
        let items = vec![(0.9, None), (0.2, Some(-5.0)), (0.8, Some(-1.0))];
        let order = fuse_rrf(&items, 1.0, 60.0, 3);
        assert_eq!(order, vec![1, 2, 0]); // -5.0 best, -1.0 next, None last
    }

    #[test]
    fn fuse_rrf_respects_limit() {
        let items = vec![(0.9, None), (0.2, Some(-5.0)), (0.8, Some(-1.0))];
        assert_eq!(fuse_rrf(&items, 0.5, 60.0, 2).len(), 2);
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml fuse_rrf`
Expected: FAIL（`cannot find function fuse_rrf`）

- [ ] **Step 3: Write minimal implementation**

`build_fts_query` の後に追加:

```rust
/// Reciprocal Rank Fusion of a vector score (cosine, larger = better) and an
/// optional BM25 score (smaller = better, per SQLite `bm25()`).
///
/// `items[i] = (cosine, Option<bm25>)`. Returns item indices sorted by fused
/// score descending, truncated to `limit`. `bm25_weight` in [0,1] splits weight
/// between the two ranks (vector weight = 1 - bm25_weight); `k` is the RRF
/// constant. Items without a BM25 match contribute only the vector term.
fn fuse_rrf(items: &[(f64, Option<f64>)], bm25_weight: f64, k: f64, limit: usize) -> Vec<usize> {
    let n = items.len();

    // Vector ranks: sort indices by cosine descending (1-based).
    let mut by_cos: Vec<usize> = (0..n).collect();
    by_cos.sort_by(|&a, &b| {
        items[b].0.partial_cmp(&items[a].0).unwrap_or(std::cmp::Ordering::Equal)
    });
    let mut vec_rank = vec![0usize; n];
    for (rank, &idx) in by_cos.iter().enumerate() {
        vec_rank[idx] = rank + 1;
    }

    // BM25 ranks: only matched items, sorted ascending (smaller = better).
    let mut by_bm: Vec<usize> = (0..n).filter(|&i| items[i].1.is_some()).collect();
    by_bm.sort_by(|&a, &b| {
        items[a].1.unwrap().partial_cmp(&items[b].1.unwrap()).unwrap_or(std::cmp::Ordering::Equal)
    });
    let mut bm_rank = vec![0usize; n]; // 0 = no BM25 match
    for (rank, &idx) in by_bm.iter().enumerate() {
        bm_rank[idx] = rank + 1;
    }

    let w_v = 1.0 - bm25_weight;
    let w_b = bm25_weight;
    let mut scored: Vec<(usize, f64)> = (0..n)
        .map(|i| {
            let mut s = w_v / (k + vec_rank[i] as f64);
            if bm_rank[i] > 0 {
                s += w_b / (k + bm_rank[i] as f64);
            }
            (i, s)
        })
        .collect();
    scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    scored.into_iter().take(limit).map(|(i, _)| i).collect()
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test --manifest-path src-tauri/Cargo.toml fuse_rrf`
Expected: PASS（3 tests）

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands/rag.rs
git commit -m "feat(rag): add fuse_rrf reciprocal rank fusion"
```

---

## Task 4: `rag_search` にハイブリッド検索を結線

**Files:**
- Modify: `src-tauri/src/commands/rag.rs:452-491`（`search_single_db`）
- Modify: `src-tauri/src/commands/rag.rs:516-537`（`rag_search`）
- Test: `src-tauri/src/commands/rag.rs`（`mod tests`、in-memory 結合テスト）

- [ ] **Step 1: Write the failing test**

`mod tests` 内に追加（`search_collect_db` という新しい収集関数を直接叩いて、コサインと bm25 の両方が候補に乗ることを検証する）:

```rust
    #[test]
    fn search_collect_db_populates_cosine_and_bm25() {
        let conn = Connection::open_in_memory().unwrap();
        ensure_tables(&conn).unwrap();

        // Two chunks; query embedding favors the first by cosine, but only the
        // second contains the keyword "rebase".
        let emb_a: Vec<f64> = vec![1.0, 0.0];
        let emb_b: Vec<f64> = vec![0.0, 1.0];
        let to_blob = |e: &[f64]| -> Vec<u8> { e.iter().flat_map(|f| f.to_le_bytes()).collect() };
        conn.execute(
            "INSERT INTO chunks (file, heading, text, line, hash, embedding) VALUES (?1,?2,?3,?4,?5,?6)",
            rusqlite::params!["a.md", "", "general notes about git", 0i64, "h", to_blob(&emb_a)],
        ).unwrap();
        conn.execute(
            "INSERT INTO chunks (file, heading, text, line, hash, embedding) VALUES (?1,?2,?3,?4,?5,?6)",
            rusqlite::params!["b.md", "", "how to rebase a branch", 0i64, "h", to_blob(&emb_b)],
        ).unwrap();

        let query_emb: Vec<f64> = vec![1.0, 0.0];
        let fts = build_fts_query("rebase branch");
        let mut out: Vec<ScoredCandidate> = Vec::new();
        search_collect_db(&conn, &query_emb, fts.as_deref(), &mut out).unwrap();

        assert_eq!(out.len(), 2);
        let a = out.iter().find(|c| c.file == "a.md").unwrap();
        let b = out.iter().find(|c| c.file == "b.md").unwrap();
        assert!(a.cosine > b.cosine, "a.md should win on cosine");
        assert!(a.bm25.is_none(), "a.md has no keyword match");
        assert!(b.bm25.is_some(), "b.md matches the FTS query");
    }
```

注: 既存の `search_single_db` は `Connection` ではなく `&Path` を受け取る。テスト容易化のため、DB 接続を受け取る内部関数 `search_collect_db(conn, embedding, fts_query, out)` を新設し、`search_single_db` はパスを開いて `ensure_tables` 後に `search_collect_db` を呼ぶ薄いラッパにする。

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml search_collect_db_populates_cosine_and_bm25`
Expected: FAIL（`cannot find type ScoredCandidate` / `function search_collect_db`）

- [ ] **Step 3: Write minimal implementation**

(a) `RagSearchResult` 構造体の直後（`src-tauri/src/commands/rag.rs:44` 付近）に内部候補型を追加:

```rust
struct ScoredCandidate {
    file: String,
    heading: String,
    text: String,
    line: usize,
    cosine: f64,
    bm25: Option<f64>,
}
```

(b) `search_single_db`（`src-tauri/src/commands/rag.rs:452-491`）を、接続を受け取る `search_collect_db` と薄いラッパに置き換える:

```rust
/// Collect every chunk in `conn` as a candidate with its cosine score, and fill
/// in BM25 scores for the rows matching `fts_query` (if any). rowid is unique
/// only within a single DB, so BM25 is resolved here before results are merged
/// across databases.
fn search_collect_db(
    conn: &Connection,
    embedding: &[f64],
    fts_query: Option<&str>,
    out: &mut Vec<ScoredCandidate>,
) -> Result<(), String> {
    // rowid -> index into `out` for this DB, so we can attach BM25 scores below.
    let mut rowid_to_idx: HashMap<i64, usize> = HashMap::new();

    let mut stmt = conn
        .prepare("SELECT id, file, heading, text, line, embedding FROM chunks")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            let id: i64 = row.get(0)?;
            let file: String = row.get(1)?;
            let heading: String = row.get(2)?;
            let text: String = row.get(3)?;
            let line: usize = row.get(4)?;
            let emb_bytes: Vec<u8> = row.get(5)?;
            Ok((id, file, heading, text, line, emb_bytes))
        })
        .map_err(|e| e.to_string())?;

    for row in rows {
        let (id, file, heading, text, line, emb_bytes) = row.map_err(|e| e.to_string())?;
        let stored_emb: Vec<f64> = emb_bytes
            .chunks(8)
            .map(|c| {
                let mut buf = [0u8; 8];
                buf.copy_from_slice(c);
                f64::from_le_bytes(buf)
            })
            .collect();
        let cosine = cosine_similarity(embedding, &stored_emb);
        rowid_to_idx.insert(id, out.len());
        out.push(ScoredCandidate { file, heading, text, line, cosine, bm25: None });
    }

    if let Some(q) = fts_query {
        let mut stmt = conn
            .prepare("SELECT rowid, bm25(chunks_fts) FROM chunks_fts WHERE chunks_fts MATCH ?1")
            .map_err(|e| e.to_string())?;
        let matches = stmt
            .query_map([q], |row| {
                let rowid: i64 = row.get(0)?;
                let score: f64 = row.get(1)?;
                Ok((rowid, score))
            })
            .map_err(|e| e.to_string())?;
        for m in matches {
            let (rowid, score) = m.map_err(|e| e.to_string())?;
            if let Some(&idx) = rowid_to_idx.get(&rowid) {
                out[idx].bm25 = Some(score);
            }
        }
    }

    Ok(())
}

fn search_single_db(
    db_file: &Path,
    embedding: &[f64],
    fts_query: Option<&str>,
    out: &mut Vec<ScoredCandidate>,
) -> Result<(), String> {
    if !db_file.exists() {
        return Ok(());
    }
    let conn = Connection::open(db_file).map_err(|e| e.to_string())?;
    ensure_tables(&conn).map_err(|e| e.to_string())?;
    search_collect_db(&conn, embedding, fts_query, out)
}
```

(c) `rag_search`（`src-tauri/src/commands/rag.rs:516-537`）を置き換える:

```rust
const RRF_K: f64 = 60.0;

#[tauri::command]
pub fn rag_search(
    folder_path: String,
    embedding: Vec<f64>,
    query_text: String,
    limit: usize,
    model_name: Option<String>,
    search_mode: Option<String>,
    bm25_weight: Option<f64>,
) -> Result<Vec<RagSearchResult>, String> {
    let name = model_name.as_deref().unwrap_or(DEFAULT_MODEL_NAME);
    let mode = search_mode.as_deref().unwrap_or("hybrid");
    let weight = bm25_weight.unwrap_or(0.5).clamp(0.0, 1.0);

    // Only build an FTS query in hybrid mode; None disables BM25 collection.
    let fts_query = if mode == "hybrid" {
        build_fts_query(&query_text)
    } else {
        None
    };

    // Collect candidates from the current folder DB and every subfolder DB.
    let mut candidates: Vec<ScoredCandidate> = Vec::new();
    let current_db = PathBuf::from(db_path(&folder_path, name));
    search_single_db(&current_db, &embedding, fts_query.as_deref(), &mut candidates)?;
    let mut sub_dbs = Vec::new();
    find_sub_rag_dbs(Path::new(&folder_path), name, &mut sub_dbs);
    for sub_db in &sub_dbs {
        search_single_db(sub_db, &embedding, fts_query.as_deref(), &mut candidates)?;
    }

    // Vector-only mode (or no qualifying FTS terms): rank by cosine alone.
    if mode != "hybrid" || fts_query.is_none() {
        let mut results: Vec<RagSearchResult> = candidates
            .into_iter()
            .map(|c| RagSearchResult {
                file: c.file,
                heading: c.heading,
                text: c.text,
                line: c.line,
                score: c.cosine,
            })
            .collect();
        results.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
        results.truncate(limit);
        return Ok(results);
    }

    // Hybrid: fuse cosine + BM25 ranks with RRF.
    let items: Vec<(f64, Option<f64>)> =
        candidates.iter().map(|c| (c.cosine, c.bm25)).collect();
    let order = fuse_rrf(&items, weight, RRF_K, limit);

    // Recompute the fused score so the UI can display it.
    let n = items.len();
    let mut by_cos: Vec<usize> = (0..n).collect();
    by_cos.sort_by(|&a, &b| items[b].0.partial_cmp(&items[a].0).unwrap_or(std::cmp::Ordering::Equal));
    let mut vec_rank = vec![0usize; n];
    for (rank, &idx) in by_cos.iter().enumerate() { vec_rank[idx] = rank + 1; }
    let mut by_bm: Vec<usize> = (0..n).filter(|&i| items[i].1.is_some()).collect();
    by_bm.sort_by(|&a, &b| items[a].1.unwrap().partial_cmp(&items[b].1.unwrap()).unwrap_or(std::cmp::Ordering::Equal));
    let mut bm_rank = vec![0usize; n];
    for (rank, &idx) in by_bm.iter().enumerate() { bm_rank[idx] = rank + 1; }

    let results: Vec<RagSearchResult> = order
        .into_iter()
        .map(|i| {
            let mut score = (1.0 - weight) / (RRF_K + vec_rank[i] as f64);
            if bm_rank[i] > 0 {
                score += weight / (RRF_K + bm_rank[i] as f64);
            }
            RagSearchResult {
                file: candidates[i].file.clone(),
                heading: candidates[i].heading.clone(),
                text: candidates[i].text.clone(),
                line: candidates[i].line,
                score,
            }
        })
        .collect();

    Ok(results)
}
```

注: `lib.rs` の `invoke_handler!` は関数名のみを列挙しているため（`commands::rag::rag_search`）、シグネチャ変更によるレジストリ修正は不要。

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib`
Expected: PASS（rag の全テスト。`search_collect_db_populates_cosine_and_bm25` を含む）

- [ ] **Step 5: Build check（型エラーの早期検出）**

Run: `cargo build --manifest-path src-tauri/Cargo.toml`
Expected: 成功（警告は可、エラー不可）

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/commands/rag.rs
git commit -m "feat(rag): hybrid vector+BM25 search with RRF in rag_search"
```

---

## Task 5: フロント型・設定デフォルト・マイグレーション

**Files:**
- Modify: `src/shared/types/index.ts:91-102`
- Create: `src/features/rag/lib/rag-settings.ts`
- Create: `src/features/rag/lib/rag-settings.test.ts`
- Modify: `src/stores/settings-store.ts:7`, `:20-26`, `:135-154`

- [ ] **Step 1: Write the failing test**

Create `src/features/rag/lib/rag-settings.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { DEFAULT_RAG_SETTINGS, normalizeRagSettings } from "./rag-settings";

describe("normalizeRagSettings", () => {
  it("fills hybrid defaults for legacy settings without the new fields", () => {
    const legacy = {
      embeddingModel: "Xenova/multilingual-e5-base",
      minChunkLength: 0,
      fileExtensions: ".md",
      retrieveTopK: 5,
      retrieveMinScore: 0.1,
    };
    const r = normalizeRagSettings(legacy as any);
    expect(r.searchMode).toBe("hybrid");
    expect(r.bm25Weight).toBe(0.5);
    expect(r.embeddingModel).toBe("Xenova/multilingual-e5-base");
  });

  it("preserves explicit values", () => {
    const r = normalizeRagSettings({ searchMode: "vector", bm25Weight: 0.8 } as any);
    expect(r.searchMode).toBe("vector");
    expect(r.bm25Weight).toBe(0.8);
  });

  it("returns the full default object for undefined input", () => {
    expect(normalizeRagSettings(undefined)).toEqual(DEFAULT_RAG_SETTINGS);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/features/rag/lib/rag-settings.test.ts`
Expected: FAIL（`Cannot find module './rag-settings'`）

- [ ] **Step 3: Write minimal implementation**

(a) `src/shared/types/index.ts:91-102` の `RagSettings` を更新:

```ts
export interface RagSettings {
  embeddingModel:
    | "Xenova/multilingual-e5-large"
    | "Xenova/multilingual-e5-base"
    | "Xenova/multilingual-e5-small"
    | "sirasagi62/ruri-v3-30m-ONNX"
    | "sirasagi62/ruri-v3-130m-ONNX";
  minChunkLength: number;
  fileExtensions: string;
  retrieveTopK: number;
  retrieveMinScore: number;
  /** "vector" = embedding only, "hybrid" = embedding + BM25 fused via RRF. */
  searchMode: "vector" | "hybrid";
  /** RRF weight for the BM25 rank, 0..1 (vector weight = 1 - bm25Weight). */
  bm25Weight: number;
}
```

(b) Create `src/features/rag/lib/rag-settings.ts`:

```ts
import type { RagSettings } from "@/shared/types";

/** Default RAG settings. Hybrid (vector + BM25) is on by default. */
export const DEFAULT_RAG_SETTINGS: RagSettings = {
  embeddingModel: "Xenova/multilingual-e5-base",
  minChunkLength: 0,
  fileExtensions: ".md",
  retrieveTopK: 5,
  retrieveMinScore: 0.1,
  searchMode: "hybrid",
  bm25Weight: 0.5,
};

/**
 * Merge persisted (possibly legacy) RAG settings over the defaults so that
 * fields added in later versions (searchMode, bm25Weight) always have a value.
 */
export function normalizeRagSettings(s?: Partial<RagSettings>): RagSettings {
  return { ...DEFAULT_RAG_SETTINGS, ...(s ?? {}) };
}
```

(c) `src/stores/settings-store.ts` を更新:

- `:7` のすぐ後（import 群）に追加:

```ts
import { DEFAULT_RAG_SETTINGS, normalizeRagSettings } from "@/features/rag/lib/rag-settings";
```

- `:20-26` のローカル `DEFAULT_RAG_SETTINGS` 定義を削除（上の import に置き換わるため）。

- persist のオプション（`:135-154`、`name` と `partialize` のオブジェクト）に `merge` を追加:

```ts
    {
      name: "mdium-settings",
      partialize: (state) => ({
        themeId: state.themeId,
        language: state.language,
        autoSave: state.autoSave,
        restoreLastFolders: state.restoreLastFolders,
        scrollSync: state.scrollSync,
        fontFamily: state.fontFamily,
        fontSize: state.fontSize,
        lineHeight: state.lineHeight,
        aiSettings: state.aiSettings,
        ragSettings: state.ragSettings,
        speechEnabled: state.speechEnabled,
        speechModel: state.speechModel,
        mediumSettings: state.mediumSettings,
        allowLlmVbaImport: state.allowLlmVbaImport,
      }),
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<SettingsState>;
        return {
          ...current,
          ...p,
          // Ensure RAG fields added in later versions get defaults.
          ragSettings: normalizeRagSettings(p.ragSettings),
        };
      },
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/features/rag/lib/rag-settings.test.ts`
Expected: PASS（3 tests）

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: エラーなし

- [ ] **Step 6: Commit**

```bash
git add src/shared/types/index.ts src/features/rag/lib/rag-settings.ts src/features/rag/lib/rag-settings.test.ts src/stores/settings-store.ts
git commit -m "feat(rag): add searchMode/bm25Weight settings with legacy migration"
```

---

## Task 6: `useRagFeatures` から新パラメータを送信

**Files:**
- Modify: `src/features/rag/hooks/useRagFeatures.ts:201-207`（`rag_search` 呼び出し）

- [ ] **Step 1: 実装（このタスクはフックの結線のため、検証は型チェック＋手動）**

`src/features/rag/hooks/useRagFeatures.ts:201-207` の検索呼び出しとフィルタを置き換える:

```ts
        await loadEmbed(ragSettings.embeddingModel);
        const queryEmbed = await embed(question, "query");
        const allResults = await invoke<any[]>("rag_search", {
          folderPath,
          embedding: queryEmbed,
          queryText: question,
          limit: ragSettings.retrieveTopK,
          modelName: ragSettings.embeddingModel,
          searchMode: ragSettings.searchMode,
          bm25Weight: ragSettings.bm25Weight,
        });
        // In hybrid mode `score` is an RRF score (different scale from cosine),
        // so the cosine-based minScore threshold only applies to vector mode.
        const results =
          ragSettings.searchMode === "hybrid"
            ? allResults
            : allResults.filter((r: any) => (r.score ?? 0) >= ragSettings.retrieveMinScore);
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: エラーなし

- [ ] **Step 3: Commit**

```bash
git add src/features/rag/hooks/useRagFeatures.ts
git commit -m "feat(rag): pass query text and hybrid params to rag_search"
```

---

## Task 7: RagPanel に検索モード切替・BM25 重みスライダーを追加

**Files:**
- Modify: `src/features/rag/components/RagPanel.tsx:476-487`（設定ダイアログ内、`ragRetrieveMinScore` ラベルの後）

- [ ] **Step 1: 実装**

`src/features/rag/components/RagPanel.tsx` の `ragRetrieveMinScore` スライダーの `</label>`（`:487`）の直後に、検索モードと BM25 重みの UI を追加:

```tsx
              <label className="rag-panel__settings-label">
                {t("ragSearchMode")}
                <select
                  className="rag-panel__settings-select"
                  value={localRagSettings.searchMode}
                  onChange={(e) => setLocalRagSettings({ ...localRagSettings, searchMode: e.target.value as RagSettings["searchMode"] })}
                >
                  <option value="hybrid">{t("ragSearchModeHybrid")}</option>
                  <option value="vector">{t("ragSearchModeVector")}</option>
                </select>
              </label>

              {localRagSettings.searchMode === "hybrid" && (
                <label className="rag-panel__settings-label">
                  {t("ragBm25Weight")}: {localRagSettings.bm25Weight.toFixed(2)}
                  <input
                    className="rag-panel__settings-slider"
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={localRagSettings.bm25Weight}
                    onChange={(e) => setLocalRagSettings({ ...localRagSettings, bm25Weight: parseFloat(e.target.value) })}
                  />
                </label>
              )}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: エラーなし（`ragSearchMode` 等の i18n キーは Task 8 で追加するが、`t()` は文字列キーを取るため型エラーにはならない）

- [ ] **Step 3: Commit**

```bash
git add src/features/rag/components/RagPanel.tsx
git commit -m "feat(rag): add search mode and BM25 weight controls to RagPanel"
```

---

## Task 8: i18n 文字列（ja / en）

**Files:**
- Modify: `src/shared/i18n/locales/ja/common.json:62`（`ragRetrieveMinScore` の行の後）
- Modify: `src/shared/i18n/locales/en/common.json:62`（同上）

- [ ] **Step 1: 実装（ja）**

`src/shared/i18n/locales/ja/common.json` の `"ragRetrieveMinScore": "最低類似度スコア",`（`:62`）の直後に追加:

```json
  "ragSearchMode": "検索方式",
  "ragSearchModeHybrid": "ハイブリッド (ベクトル + BM25)",
  "ragSearchModeVector": "ベクトルのみ",
  "ragBm25Weight": "BM25の重み",
```

- [ ] **Step 2: 実装（en）**

`src/shared/i18n/locales/en/common.json` の `"ragRetrieveMinScore": "Min Similarity Score",`（`:62`）の直後に追加:

```json
  "ragSearchMode": "Search Mode",
  "ragSearchModeHybrid": "Hybrid (Vector + BM25)",
  "ragSearchModeVector": "Vector only",
  "ragBm25Weight": "BM25 Weight",
```

- [ ] **Step 3: JSON 妥当性チェック**

Run: `node -e "require('./src/shared/i18n/locales/ja/common.json'); require('./src/shared/i18n/locales/en/common.json'); console.log('ok')"`
Expected: `ok`（パースエラーなし。末尾カンマや括弧の崩れを早期検出）

- [ ] **Step 4: Commit**

```bash
git add src/shared/i18n/locales/ja/common.json src/shared/i18n/locales/en/common.json
git commit -m "i18n(rag): add search mode and BM25 weight labels (ja/en)"
```

---

## Task 9: 最終検証

- [ ] **Step 1: Rust 全テスト**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib`
Expected: 全 PASS（Task 1–4 で追加した rag テストを含む）

- [ ] **Step 2: フロント全テスト**

Run: `npm test`
Expected: 全 PASS（既存 + `rag-settings.test.ts`）

- [ ] **Step 3: 型チェック**

Run: `npx tsc --noEmit`
Expected: エラーなし

- [ ] **Step 4: Rust ビルド**

Run: `cargo build --manifest-path src-tauri/Cargo.toml`
Expected: 成功

- [ ] **Step 5: 手動受け入れ確認（任意・推奨）**

`npm run tauri dev` でアプリを起動し:
1. 既存インデックスのあるフォルダを開く → 再埋め込みなしに検索できる（初回オープン時に FTS が backfill される）。
2. RAG 設定で「検索方式 = ハイブリッド」「BM25の重み」が表示・保存される。
3. コマンド名/変数名のような完全一致クエリで、ベクトルのみより的確にヒットすることを確認。
4. 「ベクトルのみ」に切替えても従来どおり動作する。

- [ ] **Step 6: 完了**

`superpowers:finishing-a-development-branch` スキルでブランチの統合方法（merge / PR）を選ぶ。

---

## Notes / リスク

- **trigram の特性**: 語境界を見ない部分一致のため形態素 BM25 より精度は劣るが、辞書不要・バンドル増なしの利点が大きく、完全一致弱点の補完という目的には十分。
- **RRF と minScore**: RRF スコアは尺度が異なるため hybrid では cosine 用 minScore を適用しない（Task 6）。
- **後方互換**: 既存 DB は初回 `ensure_tables` で `rebuild` され、再埋め込み不要（Task 1）。
- **将来の SoftMatcha2**: 同じ `fuse_rrf` の融合点に第3ランクを足す形で拡張可能。
