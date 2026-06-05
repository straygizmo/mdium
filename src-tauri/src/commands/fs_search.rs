use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use regex::RegexBuilder;
use serde::Serialize;

/// Live "active folder" the opencode folder_glob/folder_grep tools must be
/// confined to. The webview pushes the active tab's folder here via the
/// `set_active_folder` command; the HTTP bridge reads it per request.
pub type ActiveFolderState = Arc<Mutex<Option<String>>>;

pub fn new_active_folder_state() -> ActiveFolderState {
    Arc::new(Mutex::new(None))
}

#[tauri::command]
pub fn set_active_folder(
    state: tauri::State<ActiveFolderState>,
    path: Option<String>,
) -> Result<(), String> {
    let mut guard = state.lock().map_err(|e| e.to_string())?;
    *guard = path.filter(|p| !p.is_empty());
    Ok(())
}

/// Directory names never descended into during a scan.
const EXCLUDED_DIRS: &[&str] = &[
    ".git", "node_modules", ".mdium", "target", "dist", "build", ".next", ".svn", ".hg",
];

/// Convert a glob pattern to an anchored regex string.
/// `**` matches across path separators; `*` and `?` do not match `/`.
fn glob_to_regex(pattern: &str) -> String {
    let mut re = String::from("^");
    let bytes = pattern.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i] as char;
        match c {
            '*' => {
                if i + 1 < bytes.len() && bytes[i + 1] as char == '*' {
                    i += 1; // consume the second '*'
                    if i + 1 < bytes.len() && bytes[i + 1] as char == '/' {
                        i += 1; // consume the trailing '/'
                        re.push_str("(?:.*/)?");
                    } else {
                        re.push_str(".*");
                    }
                } else {
                    re.push_str("[^/]*");
                }
            }
            '?' => re.push_str("[^/]"),
            '.' | '+' | '(' | ')' | '|' | '^' | '$' | '{' | '}' | '[' | ']' | '\\' => {
                re.push('\\');
                re.push(c);
            }
            _ => re.push(c),
        }
        i += 1;
    }
    re.push('$');
    re
}

fn is_excluded_dir(name: &str) -> bool {
    EXCLUDED_DIRS.contains(&name)
}

/// Collect file paths (relative to `root`, '/'-separated) matching `pattern`.
/// A pattern containing no '/' matches against the file's basename at any depth;
/// otherwise it matches against the full relative path. Capped at `limit`.
/// (This basename-at-any-depth behavior is intentional and differs from standard shell glob, where `*.md` would match only the top level.)
pub fn fs_glob(root: &Path, pattern: &str, limit: usize) -> Result<Vec<String>, String> {
    if !root.is_dir() {
        return Err(format!("Not a folder: {}", root.display()));
    }
    let re = RegexBuilder::new(&glob_to_regex(pattern))
        .build()
        .map_err(|e| format!("Invalid pattern: {}", e))?;
    let match_basename = !pattern.contains('/');
    let mut out: Vec<String> = Vec::new();
    walk_glob(root, root, &re, match_basename, limit, &mut out);
    out.sort();
    Ok(out)
}

fn walk_glob(
    root: &Path,
    dir: &Path,
    re: &regex::Regex,
    match_basename: bool,
    limit: usize,
    out: &mut Vec<String>,
) {
    if out.len() >= limit {
        return;
    }
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        if out.len() >= limit {
            return;
        }
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        if is_dir {
            if is_excluded_dir(&name) {
                continue;
            }
            walk_glob(root, &path, re, match_basename, limit, out);
        } else {
            let rel = match path.strip_prefix(root) {
                Ok(r) => r.to_string_lossy().replace('\\', "/"),
                Err(_) => continue,
            };
            let hay = if match_basename { name.as_str() } else { rel.as_str() };
            if re.is_match(hay) {
                out.push(rel);
            }
        }
    }
}

#[derive(Serialize, Clone)]
pub struct GrepMatch {
    pub file: String,
    pub line_number: usize,
    pub line: String,
}

const MAX_GREP_FILE_BYTES: u64 = 5 * 1024 * 1024;

/// Search file contents under `root` for `pattern` (regex). `include` is an
/// optional glob filter on the relative path/basename. Capped at `limit` matches.
pub fn fs_grep(
    root: &Path,
    pattern: &str,
    include: Option<&str>,
    case_insensitive: bool,
    limit: usize,
) -> Result<Vec<GrepMatch>, String> {
    if !root.is_dir() {
        return Err(format!("Not a folder: {}", root.display()));
    }
    let re = RegexBuilder::new(pattern)
        .case_insensitive(case_insensitive)
        .build()
        .map_err(|e| format!("Invalid regex: {}", e))?;
    let include_re = match include {
        Some(g) if !g.is_empty() => Some((
            RegexBuilder::new(&glob_to_regex(g))
                .build()
                .map_err(|e| format!("Invalid include: {}", e))?,
            !g.contains('/'),
        )),
        _ => None,
    };
    let mut out: Vec<GrepMatch> = Vec::new();
    walk_grep(root, root, &re, &include_re, limit, &mut out);
    Ok(out)
}

fn walk_grep(
    root: &Path,
    dir: &Path,
    re: &regex::Regex,
    include_re: &Option<(regex::Regex, bool)>,
    limit: usize,
    out: &mut Vec<GrepMatch>,
) {
    if out.len() >= limit {
        return;
    }
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        if out.len() >= limit {
            return;
        }
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        if is_dir {
            if is_excluded_dir(&name) {
                continue;
            }
            walk_grep(root, &path, re, include_re, limit, out);
            continue;
        }
        let rel = match path.strip_prefix(root) {
            Ok(r) => r.to_string_lossy().replace('\\', "/"),
            Err(_) => continue,
        };
        if let Some((inc, basename_only)) = include_re {
            let hay = if *basename_only { name.as_str() } else { rel.as_str() };
            if !inc.is_match(hay) {
                continue;
            }
        }
        let bytes = match fs::read(&path) {
            Ok(b) => b,
            Err(_) => continue,
        };
        if bytes.len() as u64 > MAX_GREP_FILE_BYTES {
            continue;
        }
        let content = match String::from_utf8(bytes) {
            Ok(s) => s,
            Err(_) => continue,
        };
        for (idx, line) in content.lines().enumerate() {
            if out.len() >= limit {
                return;
            }
            if re.is_match(line) {
                out.push(GrepMatch {
                    file: rel.clone(),
                    line_number: idx + 1,
                    line: line.to_string(),
                });
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn glob_translation() {
        assert_eq!(glob_to_regex("*.md"), "^[^/]*\\.md$");
        assert_eq!(glob_to_regex("**/*.md"), "^(?:.*/)?[^/]*\\.md$");
        assert_eq!(glob_to_regex("a?b"), "^a[^/]b$");
        assert_eq!(glob_to_regex("docs/**"), "^docs/.*$");
    }

    fn make_temp_dir(tag: &str) -> PathBuf {
        let mut dir = std::env::temp_dir();
        dir.push(format!("mdium_fs_search_{}_{}", std::process::id(), tag));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("sub")).unwrap();
        fs::write(dir.join("a.md"), "hello world\nsecond line\n").unwrap();
        fs::write(dir.join("b.txt"), "nothing here\n").unwrap();
        fs::write(dir.join("sub/c.md"), "deep hello\n").unwrap();
        fs::create_dir_all(dir.join("node_modules")).unwrap();
        fs::write(dir.join("node_modules/ignored.md"), "should be skipped\n").unwrap();
        dir
    }

    #[test]
    fn glob_recurses_and_excludes() {
        let dir = make_temp_dir("glob");
        let mut files = fs_glob(&dir, "**/*.md", 1000).unwrap();
        files.sort();
        assert_eq!(files, vec!["a.md".to_string(), "sub/c.md".to_string()]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn glob_basename_matches_any_depth() {
        let dir = make_temp_dir("glob_base");
        let mut files = fs_glob(&dir, "*.md", 1000).unwrap();
        files.sort();
        assert_eq!(files, vec!["a.md".to_string(), "sub/c.md".to_string()]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn grep_finds_matches_with_line_numbers() {
        let dir = make_temp_dir("grep");
        let matches = fs_grep(&dir, "hello", None, false, 100).unwrap();
        let mut hits: Vec<(String, usize, String)> = matches
            .into_iter()
            .map(|m| (m.file, m.line_number, m.line))
            .collect();
        hits.sort();
        assert_eq!(
            hits,
            vec![
                ("a.md".to_string(), 1, "hello world".to_string()),
                ("sub/c.md".to_string(), 1, "deep hello".to_string()),
            ]
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn grep_respects_include_filter() {
        let dir = make_temp_dir("grep_inc");
        let matches = fs_grep(&dir, "hello", Some("a.md"), false, 100).unwrap();
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].file, "a.md");
        let _ = fs::remove_dir_all(&dir);
    }
}
