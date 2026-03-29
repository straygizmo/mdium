use crate::markdown_parser::{parse_markdown, rebuild_document, MarkdownTable, ParsedDocument};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use std::process::Command;

#[derive(Serialize, Clone)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    #[serde(rename = "is_dir")]
    pub is_directory: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<FileEntry>>,
}

#[tauri::command]
pub fn read_text_file(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| format!("Failed to read file: {}", e))
}

#[tauri::command]
pub fn read_binary_file(path: String) -> Result<Vec<u8>, String> {
    fs::read(&path).map_err(|e| format!("Failed to read binary file: {}", e))
}

#[tauri::command]
pub fn write_text_file(path: String, content: String) -> Result<(), String> {
    fs::write(&path, &content).map_err(|e| format!("Failed to write file: {}", e))
}

#[tauri::command]
pub fn write_text_file_with_dirs(path: String, content: String) -> Result<(), String> {
    let p = Path::new(&path);
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create directories: {}", e))?;
    }
    fs::write(&path, &content).map_err(|e| format!("Failed to write file: {}", e))
}

/// Check if a file is a target file
fn is_target_file(
    name: &str,
    include_docx: bool,
    include_xls: bool,
    include_km: bool,
    include_images: bool,
    include_pdf: bool,
) -> bool {
    if name.ends_with(".md") {
        return true;
    }
    let lower = name.to_lowercase();
    if include_docx && lower.ends_with(".docx") {
        return true;
    }
    if include_xls && (lower.ends_with(".xlsx") || lower.ends_with(".xlsm")) {
        return true;
    }
    if include_km && (lower.ends_with(".km") || lower.ends_with(".xmind")) {
        return true;
    }
    if include_images
        && (lower.ends_with(".png")
            || lower.ends_with(".jpg")
            || lower.ends_with(".jpeg")
            || lower.ends_with(".gif")
            || lower.ends_with(".bmp")
            || lower.ends_with(".svg")
            || lower.ends_with(".webp"))
    {
        return true;
    }
    if include_pdf && lower.ends_with(".pdf") {
        return true;
    }
    false
}

/// Recursively read directory and return only target files and folders
fn build_tree_filtered(
    dir: &Path,
    depth: u32,
    include_docx: bool,
    include_xls: bool,
    include_km: bool,
    include_images: bool,
    include_pdf: bool,
    include_empty_dirs: bool,
) -> Vec<FileEntry> {
    if depth > 10 {
        return Vec::new();
    }
    let mut entries = Vec::new();
    let Ok(read_dir) = fs::read_dir(dir) else {
        return entries;
    };

    let mut items: Vec<_> = read_dir.filter_map(|e| e.ok()).collect();
    items.sort_by_key(|e| e.file_name());

    for entry in items {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();

        // Skip hidden files and common non-essential directories
        if name.starts_with('.')
            || name == "node_modules"
            || name == "target"
            || name == "dist"
        {
            continue;
        }

        if path.is_dir() {
            let children = build_tree_filtered(
                &path,
                depth + 1,
                include_docx,
                include_xls,
                include_km,
                include_images,
                include_pdf,
                include_empty_dirs,
            );
            // Only show folders containing target files (show empty folders if include_empty_dirs)
            if !children.is_empty() || include_empty_dirs {
                entries.push(FileEntry {
                    name,
                    path: path.to_string_lossy().to_string(),
                    is_directory: true,
                    children: Some(children),
                });
            }
        } else if is_target_file(&name, include_docx, include_xls, include_km, include_images, include_pdf) {
            entries.push(FileEntry {
                name,
                path: path.to_string_lossy().to_string(),
                is_directory: false,
                children: None,
            });
        }
    }

    // Sort: directories first, then alphabetical
    entries.sort_by(|a, b| match (a.is_directory, b.is_directory) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });

    entries
}

/// Recursively read directory and return all files and folders (excluding hidden files etc.)
fn build_tree_all(dir: &Path, depth: u32) -> Vec<FileEntry> {
    if depth > 10 {
        return Vec::new();
    }
    let mut entries = Vec::new();
    let Ok(read_dir) = fs::read_dir(dir) else {
        return entries;
    };

    let mut items: Vec<_> = read_dir.filter_map(|e| e.ok()).collect();
    items.sort_by_key(|e| e.file_name());

    for entry in items {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();

        if name.starts_with('.')
            || name == "node_modules"
            || name == "target"
            || name == "dist"
        {
            continue;
        }

        if path.is_dir() {
            let children = build_tree_all(&path, depth + 1);
            entries.push(FileEntry {
                name,
                path: path.to_string_lossy().to_string(),
                is_directory: true,
                children: Some(children),
            });
        } else {
            entries.push(FileEntry {
                name,
                path: path.to_string_lossy().to_string(),
                is_directory: false,
                children: None,
            });
        }
    }

    entries.sort_by(|a, b| match (a.is_directory, b.is_directory) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });

    entries
}

#[tauri::command]
pub fn get_file_tree(
    path: String,
    show_all: Option<bool>,
    include_docx: Option<bool>,
    include_xls: Option<bool>,
    include_km: Option<bool>,
    include_images: Option<bool>,
    include_pdf: Option<bool>,
    include_empty_dirs: Option<bool>,
) -> Result<Vec<FileEntry>, String> {
    let root = Path::new(&path);
    if !root.is_dir() {
        return Err("Not a directory".to_string());
    }
    if show_all.unwrap_or(false) {
        Ok(build_tree_all(root, 0))
    } else {
        Ok(build_tree_filtered(
            root,
            0,
            include_docx.unwrap_or(false),
            include_xls.unwrap_or(false),
            include_km.unwrap_or(false),
            include_images.unwrap_or(false),
            include_pdf.unwrap_or(false),
            include_empty_dirs.unwrap_or(false),
        ))
    }
}

/// Zenn project detection result
#[derive(Debug, Serialize, Deserialize)]
pub struct ZennProjectInfo {
    pub is_zenn_project: bool,
    pub project_root: String,
    pub has_articles: bool,
    pub has_books: bool,
}

/// Zenn article front matter metadata
#[derive(Debug, Serialize, Deserialize)]
pub struct ZennArticleMeta {
    pub path: String,
    pub emoji: String,
    pub title: String,
    pub published: bool,
}

/// Tauri command to detect if a directory is a Zenn project
#[tauri::command]
pub fn detect_zenn_project(dir_path: String) -> Result<ZennProjectInfo, String> {
    let path = Path::new(&dir_path);
    if !path.exists() || !path.is_dir() {
        return Err("Directory does not exist".to_string());
    }

    let articles_path = path.join("articles");
    let books_path = path.join("books");
    let has_articles = articles_path.exists() && articles_path.is_dir();
    let has_books = books_path.exists() && books_path.is_dir();

    // Also check if zenn-cli is in package.json
    let mut is_zenn = has_articles || has_books;
    if !is_zenn {
        let pkg_path = path.join("package.json");
        if pkg_path.exists() {
            if let Ok(content) = fs::read_to_string(&pkg_path) {
                is_zenn = content.contains("zenn-cli");
            }
        }
    }

    Ok(ZennProjectInfo {
        is_zenn_project: is_zenn,
        project_root: dir_path,
        has_articles,
        has_books,
    })
}

/// Tauri command to batch-retrieve front matter metadata from .md files in articles/
#[tauri::command]
pub fn get_zenn_articles_meta(dir_path: String) -> Result<Vec<ZennArticleMeta>, String> {
    let articles_dir = Path::new(&dir_path).join("articles");
    if !articles_dir.exists() || !articles_dir.is_dir() {
        return Ok(Vec::new());
    }

    let mut metas = Vec::new();
    let Ok(read_dir) = fs::read_dir(&articles_dir) else {
        return Ok(metas);
    };

    for entry in read_dir.filter_map(|e| e.ok()) {
        let path = entry.path();
        if !path.is_file() || !path.extension().map_or(false, |e| e == "md") {
            continue;
        }
        if let Ok(content) = fs::read_to_string(&path) {
            if let Some(meta) = extract_zenn_frontmatter(&content) {
                metas.push(ZennArticleMeta {
                    path: path.to_string_lossy().to_string(),
                    emoji: meta.0,
                    title: meta.1,
                    published: meta.2,
                });
            }
        }
    }
    Ok(metas)
}

/// Extract emoji, title, published from front matter
fn extract_zenn_frontmatter(content: &str) -> Option<(String, String, bool)> {
    if !content.starts_with("---\n") && !content.starts_with("---\r\n") {
        return None;
    }
    let end = content.find("\n---")?;
    if end <= 4 {
        return None;
    }
    let yaml = &content[4..end];
    let mut emoji = String::new();
    let mut title = String::new();
    let mut published = false;

    for line in yaml.lines() {
        let line = line.trim();
        if let Some(val) = line.strip_prefix("emoji:") {
            emoji = val.trim().trim_matches('"').trim_matches('\'').to_string();
        } else if let Some(val) = line.strip_prefix("title:") {
            title = val.trim().trim_matches('"').trim_matches('\'').to_string();
        } else if let Some(val) = line.strip_prefix("published:") {
            published = val.trim() == "true";
        }
    }

    if emoji.is_empty() && title.is_empty() {
        return None;
    }
    Some((emoji, title, published))
}

/// Tauri command to read and parse a Markdown file
#[tauri::command]
pub fn read_markdown_file(file_path: String) -> Result<ParsedDocument, String> {
    let content = fs::read_to_string(&file_path).map_err(|e| e.to_string())?;
    Ok(parse_markdown(&content))
}

/// Tauri command to update tables and write back to a Markdown file
#[tauri::command]
pub fn save_markdown_file(
    file_path: String,
    original_lines: Vec<String>,
    tables: Vec<MarkdownTable>,
) -> Result<(), String> {
    let content = rebuild_document(&original_lines, &tables);
    fs::write(&file_path, content).map_err(|e| e.to_string())
}

/// Rename a file or folder
#[tauri::command]
pub fn rename_file(old_path: String, new_path: String) -> Result<(), String> {
    let src = Path::new(&old_path);
    let dst = Path::new(&new_path);
    if !src.exists() {
        return Err("Source path does not exist".to_string());
    }
    if dst.exists() {
        return Err("Destination path already exists".to_string());
    }
    fs::rename(src, dst).map_err(|e| format!("Failed to rename: {}", e))
}

/// Delete a file or folder (folders are deleted recursively)
#[tauri::command]
pub fn delete_file(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if !p.exists() {
        return Err("Path does not exist".to_string());
    }
    if p.is_dir() {
        fs::remove_dir_all(p).map_err(|e| format!("Failed to delete directory: {}", e))
    } else {
        fs::remove_file(p).map_err(|e| format!("Failed to delete file: {}", e))
    }
}

#[tauri::command]
pub fn create_folder(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if p.exists() {
        return Err("Path already exists".to_string());
    }
    fs::create_dir_all(p).map_err(|e| format!("Failed to create folder: {}", e))
}

/// Copy a file or folder (folders are copied recursively)
#[tauri::command]
pub fn copy_file(src: String, dest: String) -> Result<(), String> {
    let s = Path::new(&src);
    let d = Path::new(&dest);
    if !s.exists() {
        return Err("Source path does not exist".to_string());
    }
    if d.exists() {
        return Err("Destination path already exists".to_string());
    }
    if s.is_dir() {
        copy_dir_recursive(s, d)
    } else {
        fs::copy(s, d)
            .map(|_| ())
            .map_err(|e| format!("Failed to copy file: {}", e))
    }
}

fn copy_dir_recursive(src: &Path, dest: &Path) -> Result<(), String> {
    fs::create_dir_all(dest).map_err(|e| format!("Failed to create directory: {}", e))?;
    let entries = fs::read_dir(src).map_err(|e| format!("Failed to read directory: {}", e))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("Failed to read entry: {}", e))?;
        let src_path = entry.path();
        let dest_path = dest.join(entry.file_name());
        if src_path.is_symlink() {
            continue;
        }
        if src_path.is_dir() {
            copy_dir_recursive(&src_path, &dest_path)?;
        } else {
            fs::copy(&src_path, &dest_path)
                .map_err(|e| format!("Failed to copy file: {}", e))?;
        }
    }
    Ok(())
}

/// Move a file or folder
#[tauri::command]
pub fn move_file(src: String, dest: String) -> Result<(), String> {
    let s = Path::new(&src);
    let d = Path::new(&dest);
    if !s.exists() {
        return Err("Source path does not exist".to_string());
    }
    if d.exists() {
        return Err("Destination path already exists".to_string());
    }
    fs::rename(s, d).or_else(|_| {
        if s.is_dir() {
            copy_dir_recursive(s, d)?;
            fs::remove_dir_all(s).map_err(|e| format!("Failed to remove source: {}", e))
        } else {
            fs::copy(s, d).map(|_| ()).map_err(|e| format!("Failed to copy: {}", e))?;
            fs::remove_file(s).map_err(|e| format!("Failed to remove source: {}", e))
        }
    })
}

/// Open a file with the OS default application
#[tauri::command]
pub fn open_in_default_app(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if !p.exists() {
        return Err("Path does not exist".to_string());
    }
    #[cfg(target_os = "windows")]
    {
        Command::new("cmd")
            .args(["/C", "start", "", &path])
            .spawn()
            .map_err(|e| format!("Failed to open file: {}", e))?;
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Failed to open file: {}", e))?;
    }
    #[cfg(target_os = "linux")]
    {
        Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Failed to open file: {}", e))?;
    }
    Ok(())
}

/// Open URL in default browser
#[tauri::command]
pub fn open_external_url(url: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        Command::new("cmd")
            .args(["/C", "start", "", &url])
            .spawn()
            .map_err(|e| format!("Failed to open URL: {}", e))?;
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(&url)
            .spawn()
            .map_err(|e| format!("Failed to open URL: {}", e))?;
    }
    #[cfg(target_os = "linux")]
    {
        Command::new("xdg-open")
            .arg(&url)
            .spawn()
            .map_err(|e| format!("Failed to open URL: {}", e))?;
    }
    Ok(())
}

/// Check if a folder exists
#[tauri::command]
pub fn folder_exists(path: String) -> bool {
    Path::new(&path).is_dir()
}

/// Open folder in VSCode
#[tauri::command]
pub fn open_in_vscode(path: String) -> Result<(), String> {
    Command::new("code")
        .arg(&path)
        .spawn()
        .map_err(|e| format!("Failed to open VSCode: {}", e))?;
    Ok(())
}
