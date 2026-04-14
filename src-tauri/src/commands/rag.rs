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
        );",
    )
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
pub fn rag_scan_folder(folder_path: String, file_extensions: Option<String>, min_chunk_length: Option<usize>, model_name: Option<String>) -> Result<Vec<RagChunk>, String> {
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
    scan_folder_recursive(Path::new(&folder_path), &mut chunks, &extensions, min_len, name)?;
    Ok(chunks)
}

/// Scan files in each folder level and recurse into subfolders
fn scan_folder_recursive(dir: &Path, chunks: &mut Vec<RagChunk>, extensions: &[String], min_chunk_length: usize, model_name: &str) -> Result<(), String> {
    let folder_str = dir.to_string_lossy().to_string();

    let entries: Vec<_> = fs::read_dir(dir)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .collect();

    // Recurse into subfolders
    let mut md_entries = Vec::new();
    for entry in &entries {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();

        if name.starts_with('.') || name == "node_modules" || name == "target" {
            continue;
        }

        if path.is_dir() {
            scan_folder_recursive(&path, chunks, extensions, min_chunk_length, model_name)?;
        } else if extensions.iter().any(|ext| name.ends_with(ext.as_str())) {
            md_entries.push(entry);
        }
    }

    // Don't create rag_{model}.db if no .md files exist
    let mdium_dir = Path::new(&folder_str).join(".mdium");
    let db_filename = model_db_name(model_name);
    let db_file = mdium_dir.join(&db_filename);
    if md_entries.is_empty() {
        // If existing rag_{model}.db is the only file in .mdium folder, delete the entire folder
        if db_file.exists() {
            let mdium_entries: Vec<_> = fs::read_dir(&mdium_dir)
                .ok()
                .map(|rd| rd.filter_map(|e| e.ok()).collect())
                .unwrap_or_default();
            if mdium_entries.len() == 1 {
                fs::remove_dir_all(&mdium_dir).ok();
            } else {
                fs::remove_file(&db_file).ok();
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

    for entry in md_entries {
        let path = entry.path();
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

fn search_single_db(db_file: &Path, embedding: &[f64], results: &mut Vec<RagSearchResult>) -> Result<(), String> {
    if !db_file.exists() {
        return Ok(());
    }

    let conn = Connection::open(db_file).map_err(|e| e.to_string())?;
    ensure_tables(&conn).map_err(|e| e.to_string())?;

    let mut stmt = conn
        .prepare("SELECT file, heading, text, line, embedding FROM chunks")
        .map_err(|e| e.to_string())?;

    let rows: Vec<RagSearchResult> = stmt
        .query_map([], |row| {
            let file: String = row.get(0)?;
            let heading: String = row.get(1)?;
            let text: String = row.get(2)?;
            let line: usize = row.get(3)?;
            let emb_bytes: Vec<u8> = row.get(4)?;

            let stored_emb: Vec<f64> = emb_bytes
                .chunks(8)
                .map(|c| {
                    let mut buf = [0u8; 8];
                    buf.copy_from_slice(c);
                    f64::from_le_bytes(buf)
                })
                .collect();

            let score = cosine_similarity(embedding, &stored_emb);

            Ok(RagSearchResult { file, heading, text, line, score })
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    results.extend(rows);
    Ok(())
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

#[tauri::command]
pub fn rag_search(folder_path: String, embedding: Vec<f64>, limit: usize, model_name: Option<String>) -> Result<Vec<RagSearchResult>, String> {
    let name = model_name.as_deref().unwrap_or(DEFAULT_MODEL_NAME);
    let mut results = Vec::new();

    // Search rag_{model}.db in the current folder
    let current_db = PathBuf::from(db_path(&folder_path, name));
    search_single_db(&current_db, &embedding, &mut results)?;

    // Also search rag_{model}.db in subfolders
    let mut sub_dbs = Vec::new();
    find_sub_rag_dbs(Path::new(&folder_path), name, &mut sub_dbs);
    for sub_db in &sub_dbs {
        search_single_db(sub_db, &embedding, &mut results)?;
    }

    // Sort by score and return top limit results
    results.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    results.truncate(limit);

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

fn model_files_for(model_name: &str) -> &'static [&'static str] {
    if model_name.contains("harrier") {
        // Harrier's quantized variant ships the weights as an external .onnx_data file.
        &[
            "config.json",
            "tokenizer.json",
            "tokenizer_config.json",
            "onnx/model_quantized.onnx",
            "onnx/model_quantized.onnx_data",
        ]
    } else {
        &[
            "config.json",
            "tokenizer.json",
            "tokenizer_config.json",
            "onnx/model_quantized.onnx",
        ]
    }
}

fn embedding_model_dir_for(model_name: &str) -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let exe_dir = exe.parent().ok_or("Cannot determine app directory")?;
    // model_name is like "Xenova/multilingual-e5-large"
    let parts: Vec<&str> = model_name.splitn(2, '/').collect();
    if parts.len() != 2 {
        return Err(format!("Invalid model name: {}", model_name));
    }
    Ok(exe_dir
        .join(".embedding-models")
        .join(parts[0])
        .join(parts[1]))
}

#[tauri::command]
pub fn rag_get_model_dir(model_name: Option<String>) -> Result<String, String> {
    let name = model_name.as_deref().unwrap_or(DEFAULT_MODEL_NAME);
    let dir = embedding_model_dir_for(name)?;
    Ok(dir.to_string_lossy().to_string())
}

#[tauri::command]
pub fn rag_check_model(model_name: Option<String>) -> Result<bool, String> {
    let name = model_name.as_deref().unwrap_or(DEFAULT_MODEL_NAME);
    let dir = embedding_model_dir_for(name)?;
    for file in model_files_for(name) {
        if !dir.join(file).exists() {
            return Ok(false);
        }
    }
    Ok(true)
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
    let dir = embedding_model_dir_for(name)?;
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(600))
        .build()
        .map_err(|e| format!("NETWORK_ERROR:{}", e))?;
    let files = model_files_for(name);
    let file_count = files.len();

    for (idx, &file) in files.iter().enumerate() {
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
