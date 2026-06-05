use futures_util::StreamExt;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::Emitter;

#[derive(Serialize)]
pub struct RagStatus {
    pub total_chunks: usize,
    pub total_files: usize,
}

#[derive(Serialize)]
pub struct RagChunk {
    pub folder: String,
    pub file: String,
    pub heading: String,
    pub text: String,
    pub line: usize,
    pub hash: String,
}

#[derive(Serialize, Clone)]
struct RagScanProgress {
    current: usize,
    total: usize,
    file: String,
}

#[derive(Deserialize)]
pub struct RagChunkWithEmbedding {
    pub folder: String,
    pub file: String,
    pub heading: String,
    pub text: String,
    pub line: usize,
    pub hash: String,
    pub embedding: Vec<f64>,
}

#[derive(Serialize)]
pub struct RagSearchResult {
    pub file: String,
    pub heading: String,
    pub text: String,
    pub line: usize,
    pub score: f64,
}

struct ScoredCandidate {
    file: String,
    heading: String,
    text: String,
    line: usize,
    cosine: f64,
    bm25: Option<f64>,
}

fn model_db_name(model_name: &str) -> String {
    // "Xenova/multilingual-e5-large" → "rag_multilingual-e5-large.db"
    let short = model_name.rsplit('/').next().unwrap_or(model_name);
    format!("rag_{}.db", short)
}

fn db_path(folder: &str, model_name: &str) -> String {
    let dir = Path::new(folder).join(".mdium");
    dir.join(model_db_name(model_name)).to_string_lossy().to_string()
}

fn ensure_db_dir(folder: &str) -> Result<(), String> {
    let dir = Path::new(folder).join(".mdium");
    fs::create_dir_all(&dir).map_err(|e| {
        format!(
            "Failed to create directory '{}': {} ({})",
            dir.display(),
            e,
            match e.kind() {
                std::io::ErrorKind::PermissionDenied =>
                    "check folder permissions or if antivirus is blocking access",
                _ => "check that the path is valid and accessible",
            }
        )
    })
}

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
    // Runs exactly once per DB, tracked via PRAGMA user_version. We cannot use
    // `SELECT count(*) FROM chunks_fts` as an emptiness probe: on an
    // external-content FTS5 table that count is read straight from the content
    // table (`chunks`), so it is non-zero even when the index is empty, which
    // would skip the rebuild and leave legacy rows unsearchable.
    let schema_version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if schema_version < 1 {
        let chunk_count: i64 = conn.query_row("SELECT count(*) FROM chunks", [], |r| r.get(0))?;
        if chunk_count > 0 {
            conn.execute_batch("INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild');")?;
        }
        conn.execute_batch("PRAGMA user_version = 1;")?;
    }
    Ok(())
}

fn cosine_similarity(a: &[f64], b: &[f64]) -> f64 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }
    let mut dot = 0.0;
    let mut na = 0.0;
    let mut nb = 0.0;
    for i in 0..a.len() {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    let denom = na.sqrt() * nb.sqrt();
    if denom == 0.0 { 0.0 } else { dot / denom }
}

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

/// Reciprocal Rank Fusion of a vector score (cosine, larger = better) and an
/// optional BM25 score (smaller = better, per SQLite `bm25()`).
///
/// `items[i] = (cosine, Option<bm25>)`. Returns `(item_index, fused_score)`
/// pairs sorted by fused score descending, truncated to `limit`. `bm25_weight`
/// in [0,1] splits weight between the two ranks (vector weight = 1 -
/// bm25_weight); `k` is the RRF constant. Items without a BM25 match contribute
/// only the vector term.
fn fuse_rrf(items: &[(f64, Option<f64>)], bm25_weight: f64, k: f64, limit: usize) -> Vec<(usize, f64)> {
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
    // Relies on Rust's stable sort: items with equal scores keep their original
    // index order, giving deterministic tie-breaking.
    scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    scored.into_iter().take(limit).collect()
}

fn count_db_status(db_path: &Path) -> (usize, usize) {
    if !db_path.exists() {
        return (0, 0);
    }
    let conn = match Connection::open(db_path) {
        Ok(c) => c,
        Err(_) => return (0, 0),
    };
    if ensure_tables(&conn).is_err() {
        return (0, 0);
    }
    let chunks: usize = conn
        .query_row("SELECT COUNT(*) FROM chunks", [], |r| r.get(0))
        .unwrap_or(0);
    let files: usize = conn
        .query_row("SELECT COUNT(DISTINCT file) FROM chunks", [], |r| r.get(0))
        .unwrap_or(0);
    (chunks, files)
}

#[tauri::command]
pub fn rag_get_status(folder_path: String, model_name: Option<String>) -> Result<RagStatus, String> {
    let name = model_name.as_deref().unwrap_or(DEFAULT_MODEL_NAME);
    // rag_{model}.db for the current folder
    let (mut total_chunks, mut total_files) = count_db_status(&PathBuf::from(db_path(&folder_path, name)));

    // Also aggregate rag_{model}.db from subfolders
    let mut sub_dbs = Vec::new();
    find_sub_rag_dbs(Path::new(&folder_path), name, &mut sub_dbs);
    for sub_db in &sub_dbs {
        let (c, f) = count_db_status(sub_db);
        total_chunks += c;
        total_files += f;
    }

    Ok(RagStatus { total_chunks, total_files })
}

fn collect_files_from_db(db_path: &Path, files: &mut Vec<String>) {
    if !db_path.exists() {
        return;
    }
    let conn = match Connection::open(db_path) {
        Ok(c) => c,
        Err(_) => return,
    };
    if ensure_tables(&conn).is_err() {
        return;
    }
    let result: Vec<String> = conn
        .prepare("SELECT DISTINCT file FROM chunks ORDER BY file")
        .ok()
        .and_then(|mut stmt| {
            stmt.query_map([], |row| row.get::<_, String>(0))
                .ok()
                .map(|rows| rows.flatten().collect())
        })
        .unwrap_or_default();
    files.extend(result);
}

#[tauri::command]
pub fn rag_list_files(folder_path: String, model_name: Option<String>) -> Result<Vec<String>, String> {
    let name = model_name.as_deref().unwrap_or(DEFAULT_MODEL_NAME);
    let mut files = Vec::new();

    // rag_{model}.db for the current folder
    collect_files_from_db(&PathBuf::from(db_path(&folder_path, name)), &mut files);

    // Also collect rag_{model}.db from subfolders
    let mut sub_dbs = Vec::new();
    find_sub_rag_dbs(Path::new(&folder_path), name, &mut sub_dbs);
    for sub_db in &sub_dbs {
        collect_files_from_db(sub_db, &mut files);
    }

    files.sort();
    Ok(files)
}

#[tauri::command]
pub fn rag_scan_folder(
    app: tauri::AppHandle,
    folder_path: String,
    file_extensions: Option<String>,
    min_chunk_length: Option<usize>,
    model_name: Option<String>,
) -> Result<Vec<RagChunk>, String> {
    let name = model_name.as_deref().unwrap_or(DEFAULT_MODEL_NAME);
    let extensions: Vec<String> = file_extensions
        .unwrap_or_else(|| ".md".to_string())
        .split(',')
        .map(|s| {
            let s = s.trim();
            if s.starts_with('.') { s.to_string() } else { format!(".{}", s) }
        })
        .filter(|s| s.len() > 1)
        .collect();
    let min_len = min_chunk_length.unwrap_or(0);
    let mut chunks = Vec::new();

    // Pre-count so the frontend can show "current/total". Cheap directory walk.
    // Best-effort: if files are added/removed on disk between this count and the
    // scan below, progress may drift (e.g. stop at 198/200). Acceptable — this is
    // cosmetic progress, not a correctness guarantee.
    let total = count_files_recursive(Path::new(&folder_path), &extensions);
    // Throttle large trees to ~200 events. For <=200 files emit_step is 1
    // (every file emits), which is well within acceptable IPC volume.
    let emit_step = (total / 200).max(1);
    let mut scanned = 0usize;

    scan_folder_recursive(
        Path::new(&folder_path),
        &mut chunks,
        &extensions,
        min_len,
        name,
        &app,
        total,
        &mut scanned,
        emit_step,
    )?;
    Ok(chunks)
}

/// Recursively collect matching files from inside a `.mdium` folder.
/// These are attributed to the parent folder so their chunks land in the
/// parent's `<parent>/.mdium/rag_{model}.db` rather than a nested DB.
fn collect_md_in_mdium(dir: &Path, extensions: &[String], result: &mut Vec<PathBuf>) {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();

        if path.is_dir() {
            if name.starts_with('.') || name == "node_modules" || name == "target" {
                continue;
            }
            collect_md_in_mdium(&path, extensions, result);
        } else if extensions.iter().any(|ext| name.ends_with(ext.as_str())) {
            result.push(path);
        }
    }
}

/// Count files that `scan_folder_recursive` would process, using identical
/// directory-traversal rules. Cheap: lists directories and matches extensions
/// only — no file reads, no hashing. Best-effort: unreadable subfolders
/// contribute 0 (the real scan would surface the error itself).
fn count_files_recursive(dir: &Path, extensions: &[String]) -> usize {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return 0,
    };
    let mut count = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();

        if name == "node_modules" || name == "target" {
            continue;
        }

        if path.is_dir() {
            if name == ".mdium" {
                let mut md = Vec::new();
                collect_md_in_mdium(&path, extensions, &mut md);
                count += md.len();
                continue;
            }
            if name.starts_with('.') {
                continue;
            }
            count += count_files_recursive(&path, extensions);
        } else if extensions.iter().any(|ext| name.ends_with(ext.as_str())) {
            count += 1;
        }
    }
    count
}

/// Scan files in each folder level and recurse into subfolders
fn scan_folder_recursive(
    dir: &Path,
    chunks: &mut Vec<RagChunk>,
    extensions: &[String],
    min_chunk_length: usize,
    model_name: &str,
    app: &tauri::AppHandle,
    total: usize,
    scanned: &mut usize,
    emit_step: usize,
) -> Result<(), String> {
    let folder_str = dir.to_string_lossy().to_string();

    // Surface the offending path on read_dir failure. A bare e.to_string()
    // produces "アクセスが拒否されました。 (os error 5)" with no location,
    // making per-subfolder ACL/antivirus issues impossible to diagnose from
    // the UI.
    let entries: Vec<_> = fs::read_dir(dir)
        .map_err(|e| {
            let hint = match e.kind() {
                std::io::ErrorKind::PermissionDenied =>
                    " (check folder permissions, antivirus exclusions, or whether another process is locking this folder)",
                std::io::ErrorKind::NotFound =>
                    " (folder no longer exists)",
                _ => "",
            };
            format!("Failed to read folder '{}': {}{}", dir.display(), e, hint)
        })?
        .filter_map(|e| e.ok())
        .collect();

    // Recurse into subfolders
    let mut md_paths: Vec<PathBuf> = Vec::new();
    for entry in &entries {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();

        if name == "node_modules" || name == "target" {
            continue;
        }

        if path.is_dir() {
            if name == ".mdium" {
                // Treat `.md` files inside `.mdium/` as belonging to this folder so
                // their chunks are written to `<this folder>/.mdium/rag_{model}.db`
                // instead of a nested `.mdium/.mdium/` DB.
                collect_md_in_mdium(&path, extensions, &mut md_paths);
                continue;
            }
            if name.starts_with('.') {
                continue;
            }
            scan_folder_recursive(&path, chunks, extensions, min_chunk_length, model_name, app, total, scanned, emit_step)?;
        } else if extensions.iter().any(|ext| name.ends_with(ext.as_str())) {
            md_paths.push(path);
        }
    }

    // No .md files at this folder level: prune only rows for files that no
    // longer exist on disk. Keep the DB file itself — a legacy layout may
    // store chunks for subfolder files in this folder's DB, and dropping the
    // file would silently destroy a still-valid index.
    let mdium_dir = Path::new(&folder_str).join(".mdium");
    let db_filename = model_db_name(model_name);
    let db_file = mdium_dir.join(&db_filename);
    if md_paths.is_empty() {
        if db_file.exists() {
            if let Ok(conn) = Connection::open(&db_file) {
                if ensure_tables(&conn).is_ok() {
                    let stored_files: Vec<String> = conn
                        .prepare("SELECT DISTINCT file FROM chunks")
                        .ok()
                        .and_then(|mut stmt| {
                            stmt.query_map([], |row| row.get::<_, String>(0))
                                .ok()
                                .map(|rows| rows.flatten().collect())
                        })
                        .unwrap_or_default();
                    for file in stored_files {
                        if !Path::new(&file).exists() {
                            let _ = conn.execute("DELETE FROM chunks WHERE file = ?1", [&file]);
                            let _ = conn.execute("DELETE FROM file_hashes WHERE file = ?1", [&file]);
                        }
                    }
                }
            }
        }
        return Ok(());
    }

    ensure_db_dir(&folder_str)?;
    let db = db_path(&folder_str, model_name);
    let conn = Connection::open(&db).map_err(|e| {
        format!("Failed to open database '{}': {} (if another process is using this file, close it and retry)", db, e)
    })?;
    ensure_tables(&conn).map_err(|e| e.to_string())?;

    // Get existing hashes from this folder's rag_{model}.db
    let existing_hashes: HashMap<String, String> = {
        let mut stmt = conn
            .prepare("SELECT file, hash FROM file_hashes")
            .map_err(|e| e.to_string())?;
        let rows: Vec<(String, String)> = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        rows.into_iter().collect()
    };

    let mut current_files: HashSet<String> = HashSet::new();

    for path in md_paths {
        *scanned += 1;
        if *scanned % emit_step == 0 || *scanned == total {
            app.emit(
                "rag-scan-progress",
                RagScanProgress {
                    current: *scanned,
                    total,
                    file: path.to_string_lossy().to_string(),
                },
            )
            .ok();
        }
        let content = fs::read_to_string(&path).unwrap_or_default();
        let file_path = path.to_string_lossy().to_string();
        let hash = format!("{:x}", Sha256::digest(content.as_bytes()));

        current_files.insert(file_path.clone());

        // Skip if hash hasn't changed
        if let Some(existing_hash) = existing_hashes.get(&file_path) {
            if *existing_hash == hash {
                continue;
            }
        }

        // Changed or new file → chunk it
        let mut current_heading = String::new();
        let mut current_text = String::new();
        let mut chunk_start = 0;

        for (i, line) in content.lines().enumerate() {
            if line.starts_with('#') {
                let trimmed = current_text.trim();
                if !trimmed.is_empty() && trimmed.len() >= min_chunk_length {
                    chunks.push(RagChunk {
                        folder: folder_str.clone(),
                        file: file_path.clone(),
                        heading: current_heading.clone(),
                        text: trimmed.to_string(),
                        line: chunk_start,
                        hash: hash.clone(),
                    });
                }
                current_heading = line.trim_start_matches('#').trim().to_string();
                current_text = String::new();
                chunk_start = i;
            } else {
                current_text.push_str(line);
                current_text.push('\n');
            }
        }

        let trimmed = current_text.trim();
        if !trimmed.is_empty() && trimmed.len() >= min_chunk_length {
            chunks.push(RagChunk {
                folder: folder_str.clone(),
                file: file_path,
                heading: current_heading,
                text: trimmed.to_string(),
                line: chunk_start,
                hash,
            });
        }
    }

    // Delete chunks and hashes of removed files from DB
    for (file, _) in &existing_hashes {
        if !current_files.contains(file) {
            conn.execute("DELETE FROM chunks WHERE file = ?1", [file])
                .ok();
            conn.execute("DELETE FROM file_hashes WHERE file = ?1", [file])
                .ok();
        }
    }

    Ok(())
}

#[tauri::command]
pub fn rag_save_chunks(_folder_path: String, chunks: Vec<RagChunkWithEmbedding>, model_name: Option<String>) -> Result<usize, String> {
    let name = model_name.as_deref().unwrap_or(DEFAULT_MODEL_NAME);
    // Group chunks by folder
    let mut by_folder: HashMap<String, Vec<&RagChunkWithEmbedding>> = HashMap::new();
    for chunk in &chunks {
        by_folder.entry(chunk.folder.clone()).or_default().push(chunk);
    }

    let count = chunks.len();

    for (folder, folder_chunks) in &by_folder {
        ensure_db_dir(folder)?;
        let db = db_path(folder, name);
        let conn = Connection::open(&db).map_err(|e| {
            format!("Failed to open database '{}': {} (if another process is using this file, close it and retry)", db, e)
        })?;
        ensure_tables(&conn).map_err(|e| e.to_string())?;

        // Delete only old chunks of files being updated
        let mut files: HashSet<&str> = HashSet::new();
        for chunk in folder_chunks {
            files.insert(&chunk.file);
        }
        for file in &files {
            conn.execute("DELETE FROM chunks WHERE file = ?1", [file])
                .map_err(|e| e.to_string())?;
        }

        for chunk in folder_chunks {
            let embedding_bytes: Vec<u8> = chunk
                .embedding
                .iter()
                .flat_map(|f| f.to_le_bytes())
                .collect();

            conn.execute(
                "INSERT INTO chunks (file, heading, text, line, hash, embedding) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                rusqlite::params![chunk.file, chunk.heading, chunk.text, chunk.line, chunk.hash, embedding_bytes],
            ).map_err(|e| e.to_string())?;

            // Update file_hashes table
            conn.execute(
                "INSERT OR REPLACE INTO file_hashes (file, hash) VALUES (?1, ?2)",
                rusqlite::params![chunk.file, chunk.hash],
            ).map_err(|e| e.to_string())?;
        }
    }

    Ok(count)
}

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

/// Recursively find rag_{model}.db in subfolders
fn find_sub_rag_dbs(dir: &Path, model_name: &str, dbs: &mut Vec<PathBuf>) {
    let db_filename = model_db_name(model_name);
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();

            if name.starts_with('.') || name == "node_modules" || name == "target" {
                continue;
            }

            if path.is_dir() {
                let sub_db = path.join(".mdium").join(&db_filename);
                if sub_db.exists() {
                    dbs.push(sub_db);
                }
                find_sub_rag_dbs(&path, model_name, dbs);
            }
        }
    }
}

const RRF_K: f64 = 60.0;

#[tauri::command]
pub fn rag_search(
    folder_path: String,
    embedding: Vec<f64>,
    query_text: Option<String>,
    limit: usize,
    model_name: Option<String>,
    search_mode: Option<String>,
    bm25_weight: Option<f64>,
) -> Result<Vec<RagSearchResult>, String> {
    // Tolerate callers that omit query_text (backward compatibility): an empty
    // string makes build_fts_query return None, falling back to vector-only.
    let query_text = query_text.as_deref().unwrap_or("");
    let name = model_name.as_deref().unwrap_or(DEFAULT_MODEL_NAME);
    let mode = search_mode.as_deref().unwrap_or("hybrid");
    let weight = bm25_weight.unwrap_or(0.5).clamp(0.0, 1.0);

    // Only build an FTS query in hybrid mode; None disables BM25 collection.
    let fts_query = if mode == "hybrid" {
        build_fts_query(query_text)
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
    let ranked = fuse_rrf(&items, weight, RRF_K, limit);

    // fuse_rrf already computed the fused score for each item; reuse it directly.
    let results: Vec<RagSearchResult> = ranked
        .into_iter()
        .map(|(i, score)| RagSearchResult {
            file: candidates[i].file.clone(),
            heading: candidates[i].heading.clone(),
            text: candidates[i].text.clone(),
            line: candidates[i].line,
            score,
        })
        .collect();

    Ok(results)
}

#[tauri::command]
pub fn rag_delete_index(folder_path: String, model_name: Option<String>) -> Result<(), String> {
    let name = model_name.as_deref().unwrap_or(DEFAULT_MODEL_NAME);

    // Delete rag_{model}.db in the current folder
    let path = db_path(&folder_path, name);
    if Path::new(&path).exists() {
        fs::remove_file(&path).map_err(|e| e.to_string())?;
    }

    // Also delete all rag_{model}.db in subfolders
    let mut sub_dbs = Vec::new();
    find_sub_rag_dbs(Path::new(&folder_path), name, &mut sub_dbs);
    for sub_db in &sub_dbs {
        fs::remove_file(sub_db).map_err(|e| e.to_string())?;
    }

    Ok(())
}

// ===== Embedding Model Management =====

const DEFAULT_MODEL_NAME: &str = "Xenova/multilingual-e5-large";

const MODEL_FILES: &[&str] = &[
    "config.json",
    "tokenizer.json",
    "tokenizer_config.json",
    "onnx/model_quantized.onnx",
];

fn embedding_model_dir_for(
    app: &tauri::AppHandle,
    model_name: &str,
) -> Result<PathBuf, String> {
    let base = crate::embedding_models_base_dir(app)?;
    Ok(base.join(crate::model_subpath(model_name)?))
}

#[tauri::command]
pub fn rag_get_model_dir(
    app: tauri::AppHandle,
    model_name: Option<String>,
) -> Result<String, String> {
    let name = model_name.as_deref().unwrap_or(DEFAULT_MODEL_NAME);
    let dir = embedding_model_dir_for(&app, name)?;
    Ok(dir.to_string_lossy().to_string())
}

#[tauri::command]
pub fn rag_check_model(
    app: tauri::AppHandle,
    model_name: Option<String>,
) -> Result<bool, String> {
    let name = model_name.as_deref().unwrap_or(DEFAULT_MODEL_NAME);
    let dir = embedding_model_dir_for(&app, name)?;
    for file in MODEL_FILES {
        if !dir.join(file).exists() {
            return Ok(false);
        }
    }
    Ok(true)
}

/// The relative paths the frontend must show the user for manual model
/// placement when automatic download is unavailable (e.g. blocked network).
/// The list is identical for every selectable RAG model, so `model_name` is
/// accepted (the frontend passes it) but intentionally unused.
#[tauri::command]
pub fn rag_model_required_files(_model_name: Option<String>) -> Vec<String> {
    MODEL_FILES.iter().map(|s| s.to_string()).collect()
}

#[derive(Clone, Serialize)]
struct ModelDownloadProgress {
    file: String,
    downloaded: u64,
    total: u64,
    file_index: usize,
    file_count: usize,
}

#[tauri::command]
pub async fn rag_download_model(app: tauri::AppHandle, model_name: Option<String>) -> Result<(), String> {
    let name = model_name.as_deref().unwrap_or(DEFAULT_MODEL_NAME);
    let dir = embedding_model_dir_for(&app, name)?;
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(600))
        .build()
        .map_err(|e| format!("NETWORK_ERROR:{}", e))?;
    let file_count = MODEL_FILES.len();

    for (idx, &file) in MODEL_FILES.iter().enumerate() {
        let target = dir.join(file);

        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }

        let url = format!(
            "https://huggingface.co/{}/resolve/main/{}",
            name, file
        );

        // HEAD request to get expected file size
        let head_resp = client
            .head(&url)
            .send()
            .await
            .map_err(|e| {
                if e.is_connect() || e.is_timeout() {
                    format!("NETWORK_ERROR:{}", e)
                } else {
                    format!("DOWNLOAD_ERROR:{}", e)
                }
            })?;
        let expected_size = head_resp.content_length().unwrap_or(0);

        // Skip if file already exists with correct size
        if target.exists() {
            if let Ok(meta) = fs::metadata(&target) {
                if expected_size > 0 && meta.len() == expected_size {
                    continue;
                }
            }
        }

        let response = client
            .get(&url)
            .send()
            .await
            .map_err(|e| {
                if e.is_connect() || e.is_timeout() {
                    format!("NETWORK_ERROR:{}", e)
                } else {
                    format!("DOWNLOAD_ERROR:{}", e)
                }
            })?;

        if !response.status().is_success() {
            return Err(format!("HTTP {} for {}", response.status(), file));
        }

        let total = response.content_length().unwrap_or(0);
        let mut downloaded: u64 = 0;

        // Stream to a temp file, then rename for atomicity
        let tmp_target = target.with_extension("tmp");
        let mut out =
            tokio::fs::File::create(&tmp_target)
                .await
                .map_err(|e| format!("Failed to create {}: {}", file, e))?;

        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| {
                if e.is_connect() || e.is_timeout() {
                    format!("NETWORK_ERROR:{}", e)
                } else {
                    format!("DOWNLOAD_ERROR:{}", e)
                }
            })?;
            tokio::io::AsyncWriteExt::write_all(&mut out, &chunk)
                .await
                .map_err(|e| format!("Write error for {}: {}", file, e))?;
            downloaded += chunk.len() as u64;

            app.emit(
                "model-download-progress",
                ModelDownloadProgress {
                    file: file.to_string(),
                    downloaded,
                    total,
                    file_index: idx,
                    file_count,
                },
            )
            .ok();
        }

        drop(out);
        tokio::fs::rename(&tmp_target, &target)
            .await
            .map_err(|e| format!("Failed to finalize {}: {}", file, e))?;
    }

    Ok(())
}

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

    #[test]
    fn fuse_rrf_pure_vector_when_weight_zero() {
        // (cosine, bm25 where smaller = better). bm25_weight = 0 => cosine order.
        let items = vec![(0.9, None), (0.2, Some(-5.0)), (0.8, Some(-1.0))];
        let order: Vec<usize> = fuse_rrf(&items, 0.0, 60.0, 3).into_iter().map(|(i, _)| i).collect();
        assert_eq!(order, vec![0, 2, 1]); // 0.9 > 0.8 > 0.2
    }

    #[test]
    fn fuse_rrf_pure_bm25_when_weight_one() {
        // bm25_weight = 1 => only matched items score; unmatched falls last.
        let items = vec![(0.9, None), (0.2, Some(-5.0)), (0.8, Some(-1.0))];
        let order: Vec<usize> = fuse_rrf(&items, 1.0, 60.0, 3).into_iter().map(|(i, _)| i).collect();
        assert_eq!(order, vec![1, 2, 0]); // -5.0 best, -1.0 next, None last
    }

    #[test]
    fn fuse_rrf_respects_limit() {
        let items = vec![(0.9, None), (0.2, Some(-5.0)), (0.8, Some(-1.0))];
        assert_eq!(fuse_rrf(&items, 0.5, 60.0, 2).len(), 2);
    }

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

    #[test]
    fn count_files_recursive_mirrors_scan_traversal() {
        use std::fs;
        // Unique, std-only temp fixture (no tempfile crate dependency).
        let root = std::env::temp_dir().join(format!("mdium_rag_count_test_{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();

        // Counted: top-level .md files
        fs::write(root.join("a.md"), "# A\nbody").unwrap();
        fs::write(root.join("b.md"), "# B\nbody").unwrap();
        // Not counted: wrong extension
        fs::write(root.join("c.txt"), "nope").unwrap();

        // Counted: .md inside a normal subfolder (recursed)
        fs::create_dir_all(root.join("sub")).unwrap();
        fs::write(root.join("sub").join("d.md"), "# D\nbody").unwrap();

        // Not counted: node_modules and target are skipped
        fs::create_dir_all(root.join("node_modules")).unwrap();
        fs::write(root.join("node_modules").join("x.md"), "# X").unwrap();
        fs::create_dir_all(root.join("target")).unwrap();
        fs::write(root.join("target").join("y.md"), "# Y").unwrap();

        // Not counted: hidden dir (other than .mdium) is skipped
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::write(root.join(".git").join("z.md"), "# Z").unwrap();

        // Counted: files inside .mdium are attributed to the parent
        fs::create_dir_all(root.join(".mdium")).unwrap();
        fs::write(root.join(".mdium").join("e.md"), "# E\nbody").unwrap();

        let extensions = vec![".md".to_string()];
        let count = count_files_recursive(&root, &extensions);

        let _ = fs::remove_dir_all(&root);
        assert_eq!(count, 4, "should count a.md, b.md, sub/d.md, .mdium/e.md");
    }
}
