use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

#[derive(Serialize, Deserialize, Clone)]
pub struct SkillEntry {
    pub dir_name: String,
    pub name: String,
    pub description: String,
    pub user_invocable: bool,
    pub allowed_tools: Vec<String>,
    pub content: String,
    /// Whether opencode discovers this skill (i.e. SKILL.md exists). A disabled
    /// skill keeps its content in SKILL.md.disabled so opencode ignores it.
    pub enabled: bool,
}

#[tauri::command]
pub fn get_home_dir() -> Result<String, String> {
    dirs::home_dir()
        .map(|p| p.to_string_lossy().to_string())
        .ok_or_else(|| "Could not determine home directory".to_string())
}

#[tauri::command]
pub fn read_json_file(path: String) -> Result<String, String> {
    let p = Path::new(&path);
    if !p.exists() {
        return Ok("{}".to_string());
    }
    fs::read_to_string(p).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn write_json_file(path: String, content: String) -> Result<(), String> {
    let p = Path::new(&path);
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(p, content).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_skills(base_dir: String) -> Result<Vec<SkillEntry>, String> {
    let skills_dir = Path::new(&base_dir).join("skills");
    if !skills_dir.exists() {
        return Ok(vec![]);
    }

    let mut entries = vec![];
    let read_dir = fs::read_dir(&skills_dir).map_err(|e| e.to_string())?;

    for entry in read_dir {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        // A skill is enabled when opencode can discover it (SKILL.md present).
        // When disabled, mdium parks its content in SKILL.md.disabled so opencode
        // ignores it while we still list it (with its toggle off).
        let active_file = path.join("SKILL.md");
        let disabled_file = path.join("SKILL.md.disabled");
        let (skill_file, enabled) = if active_file.exists() {
            (active_file, true)
        } else if disabled_file.exists() {
            (disabled_file, false)
        } else {
            continue;
        };
        let content = match fs::read_to_string(&skill_file) {
            Ok(c) => c,
            Err(_) => continue,
        };
        let dir_name = path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        let mut skill = parse_skill_frontmatter(&dir_name, &content);
        skill.enabled = enabled;
        entries.push(skill);
    }

    Ok(entries)
}

#[tauri::command]
pub fn write_skill(base_dir: String, dir_name: String, content: String) -> Result<(), String> {
    let skill_dir = Path::new(&base_dir).join("skills").join(&dir_name);
    fs::create_dir_all(&skill_dir).map_err(|e| e.to_string())?;
    let skill_file = skill_dir.join("SKILL.md");
    fs::write(skill_file, content).map_err(|e| e.to_string())?;
    // Saving produces an authoritative SKILL.md, so drop any stale disabled copy
    // to avoid both files coexisting (which would re-disable on next toggle).
    let disabled_file = skill_dir.join("SKILL.md.disabled");
    if disabled_file.exists() {
        let _ = fs::remove_file(&disabled_file);
    }
    Ok(())
}

/// Toggle whether opencode discovers a skill by renaming SKILL.md <-> SKILL.md.disabled.
/// opencode only loads `skills/<name>/SKILL.md`, so the `.disabled` suffix hides
/// the skill without deleting its content.
#[tauri::command]
pub fn set_skill_enabled(base_dir: String, dir_name: String, enabled: bool) -> Result<(), String> {
    let skill_dir = Path::new(&base_dir).join("skills").join(&dir_name);
    let active = skill_dir.join("SKILL.md");
    let disabled = skill_dir.join("SKILL.md.disabled");
    if enabled {
        if disabled.exists() && !active.exists() {
            fs::rename(&disabled, &active).map_err(|e| e.to_string())?;
        }
    } else if active.exists() {
        // On Windows fs::rename errors if the destination exists, so clear any
        // stale disabled copy first (the active file is authoritative).
        if disabled.exists() {
            let _ = fs::remove_file(&disabled);
        }
        fs::rename(&active, &disabled).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn delete_skill(base_dir: String, dir_name: String) -> Result<(), String> {
    let skill_dir = Path::new(&base_dir).join("skills").join(&dir_name);
    if skill_dir.exists() {
        fs::remove_dir_all(&skill_dir).map_err(|e| e.to_string())?;
    }
    Ok(())
}

// --- Claude session history ---

#[derive(Serialize, Clone)]
pub struct ClaudeSessionEntry {
    pub id: String,
    pub title: String,
    /// Last-modified time of the session transcript, in milliseconds since the
    /// Unix epoch. Used by the UI to sort newest-first and render a timestamp.
    pub updated_at: i64,
}

/// Claude Code stores per-project transcripts under
/// `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`, where the directory
/// name is the working directory with every non-alphanumeric character replaced
/// by a dash (e.g. `C:\Users\me\repo` -> `C--Users-me-repo`).
fn encode_project_dir(folder: &str) -> String {
    folder
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

fn claude_projects_dir(folder: &str) -> Option<std::path::PathBuf> {
    let home = dirs::home_dir()?;
    Some(
        home.join(".claude")
            .join("projects")
            .join(encode_project_dir(folder)),
    )
}

/// Guards `read`/`delete` against path traversal: session ids are UUID-shaped,
/// so only alphanumerics and dashes are ever legitimate.
fn is_safe_session_id(id: &str) -> bool {
    !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// Strip the mdium context wrapper and skip harness/command noise so the derived
/// title reflects what the user actually typed. Returns an empty string when the
/// message is not a meaningful user prompt.
fn clean_user_text(text: &str) -> String {
    let mut s = text.trim();
    if let Some(rest) = s.strip_prefix("<mdium_context>") {
        if let Some(idx) = rest.find("</mdium_context>") {
            s = rest[idx + "</mdium_context>".len()..].trim_start();
        }
    }
    let s = s.trim();
    if s.is_empty()
        || s.starts_with("<local-command")
        || s.starts_with("<command-")
        || s.starts_with("<system-reminder")
        || s.starts_with('[')
    {
        return String::new();
    }
    s.chars().take(80).collect::<String>().trim().to_string()
}

/// Extract a plain-text prompt from a `user` jsonl entry, whether the message
/// content is a bare string or an array of content blocks.
fn user_entry_text(v: &serde_json::Value) -> Option<String> {
    let content = v.get("message")?.get("content")?;
    if let Some(s) = content.as_str() {
        return Some(s.to_string());
    }
    if let Some(arr) = content.as_array() {
        for block in arr {
            if block.get("type").and_then(|x| x.as_str()) == Some("text") {
                if let Some(s) = block.get("text").and_then(|x| x.as_str()) {
                    return Some(s.to_string());
                }
            }
        }
    }
    None
}

/// Read a transcript once to derive a display title and whether it holds any
/// real conversation. Prefers Claude's own `aiTitle`, falling back to the first
/// meaningful user prompt.
fn extract_session_meta(path: &Path) -> (String, bool) {
    let content = match fs::read_to_string(path) {
        Ok(c) => c,
        Err(_) => return (String::new(), false),
    };
    let mut ai_title = String::new();
    let mut first_user = String::new();
    let mut has_message = false;
    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let v: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        match v.get("type").and_then(|x| x.as_str()).unwrap_or("") {
            "ai-title" => {
                if let Some(s) = v.get("aiTitle").and_then(|x| x.as_str()) {
                    if !s.is_empty() {
                        ai_title = s.to_string();
                    }
                }
            }
            "user" => {
                has_message = true;
                let is_meta = v.get("isMeta").and_then(|x| x.as_bool()).unwrap_or(false);
                if first_user.is_empty() && !is_meta {
                    if let Some(txt) = user_entry_text(&v) {
                        let cleaned = clean_user_text(&txt);
                        if !cleaned.is_empty() {
                            first_user = cleaned;
                        }
                    }
                }
            }
            "assistant" => has_message = true,
            _ => {}
        }
    }
    let title = if !ai_title.is_empty() {
        ai_title
    } else {
        first_user
    };
    (title, has_message)
}

#[tauri::command]
pub fn list_claude_sessions(folder: String) -> Result<Vec<ClaudeSessionEntry>, String> {
    let dir = match claude_projects_dir(&folder) {
        Some(d) => d,
        None => return Ok(vec![]),
    };
    if !dir.exists() {
        return Ok(vec![]);
    }
    let mut sessions = vec![];
    for entry in fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let id = path
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        let updated_at = fs::metadata(&path)
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        let (title, has_message) = extract_session_meta(&path);
        // Skip transcripts with no actual conversation (e.g. aborted boots).
        if !has_message {
            continue;
        }
        sessions.push(ClaudeSessionEntry {
            id,
            title,
            updated_at,
        });
    }
    sessions.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(sessions)
}

#[tauri::command]
pub fn read_claude_session(folder: String, session_id: String) -> Result<String, String> {
    if !is_safe_session_id(&session_id) {
        return Err("invalid session id".to_string());
    }
    let dir = claude_projects_dir(&folder).ok_or("Could not determine home directory")?;
    let path = dir.join(format!("{session_id}.jsonl"));
    if !path.exists() {
        return Ok(String::new());
    }
    fs::read_to_string(path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_claude_session(folder: String, session_id: String) -> Result<(), String> {
    if !is_safe_session_id(&session_id) {
        return Err("invalid session id".to_string());
    }
    let dir = claude_projects_dir(&folder).ok_or("Could not determine home directory")?;
    let path = dir.join(format!("{session_id}.jsonl"));
    if path.exists() {
        fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

// --- Custom tool file operations ---

#[derive(Serialize, Deserialize, Clone)]
pub struct ToolFileEntry {
    pub file_name: String,
    pub tool_name: String,
    pub content: String,
}

#[tauri::command]
pub fn list_tool_files(base_dir: String) -> Result<Vec<ToolFileEntry>, String> {
    // `base_dir` is the tools directory itself (e.g. ~/.config/opencode/tools),
    // mirroring how list_agent_files treats `agents_dir`.
    let tools_dir = Path::new(&base_dir);
    if !tools_dir.exists() {
        return Ok(vec![]);
    }

    let mut entries = vec![];
    let read_dir = fs::read_dir(tools_dir).map_err(|e| e.to_string())?;

    for entry in read_dir {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let file_name = path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        let tool_name = path
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        let content = match fs::read_to_string(&path) {
            Ok(c) => c,
            Err(_) => continue,
        };
        entries.push(ToolFileEntry {
            file_name,
            tool_name,
            content,
        });
    }

    entries.sort_by(|a, b| a.tool_name.cmp(&b.tool_name));
    Ok(entries)
}

#[tauri::command]
pub fn write_tool_file(base_dir: String, file_name: String, content: String) -> Result<(), String> {
    // `base_dir` is the tools directory itself (mirrors write_agent_file).
    let tools_dir = Path::new(&base_dir);
    fs::create_dir_all(tools_dir).map_err(|e| e.to_string())?;
    let file_path = tools_dir.join(&file_name);
    fs::write(file_path, content).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_tool_file(base_dir: String, file_name: String) -> Result<(), String> {
    // `base_dir` is the tools directory itself (mirrors delete_agent_file).
    let file_path = Path::new(&base_dir).join(&file_name);
    if file_path.exists() {
        fs::remove_file(&file_path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

// --- Agent .md file operations ---

#[derive(Serialize, Deserialize, Clone)]
pub struct AgentFileEntry {
    pub file_name: String,     // e.g. "review.md"
    pub agent_name: String,    // e.g. "review" (without .md)
    pub description: String,
    pub content: String,
}

#[tauri::command]
pub fn list_agent_files(agents_dir: String) -> Result<Vec<AgentFileEntry>, String> {
    let dir = Path::new(&agents_dir);
    if !dir.exists() {
        return Ok(vec![]);
    }

    let mut entries = vec![];
    let read_dir = fs::read_dir(dir).map_err(|e| e.to_string())?;

    for entry in read_dir {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
        if ext != "md" {
            continue;
        }
        let file_name = path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        let agent_name = path
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        let content = match fs::read_to_string(&path) {
            Ok(c) => c,
            Err(_) => continue,
        };
        let description = parse_agent_description(&content);
        entries.push(AgentFileEntry {
            file_name,
            agent_name,
            description,
            content,
        });
    }

    entries.sort_by(|a, b| a.agent_name.cmp(&b.agent_name));
    Ok(entries)
}

#[tauri::command]
pub fn write_agent_file(agents_dir: String, file_name: String, content: String) -> Result<(), String> {
    let dir = Path::new(&agents_dir);
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let file_path = dir.join(&file_name);
    fs::write(file_path, content).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_agent_file(agents_dir: String, file_name: String) -> Result<(), String> {
    let file_path = Path::new(&agents_dir).join(&file_name);
    if file_path.exists() {
        fs::remove_file(&file_path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn parse_agent_description(content: &str) -> String {
    if content.starts_with("---\n") || content.starts_with("---\r\n") {
        if let Some(end) = content.find("\n---") {
            let yaml = &content[4..end];
            for line in yaml.lines() {
                let line = line.trim();
                if let Some(val) = line.strip_prefix("description:") {
                    return val.trim().trim_matches('"').trim_matches('\'').to_string();
                }
            }
        }
    }
    String::new()
}

fn parse_skill_frontmatter(dir_name: &str, content: &str) -> SkillEntry {
    let mut name = String::new();
    let mut description = String::new();
    let mut user_invocable = false;
    let mut allowed_tools: Vec<String> = vec![];

    if content.starts_with("---\n") || content.starts_with("---\r\n") {
        if let Some(end) = content.find("\n---") {
            let yaml = &content[4..end];
            for line in yaml.lines() {
                let line = line.trim();
                if let Some(val) = line.strip_prefix("name:") {
                    name = val.trim().trim_matches('"').trim_matches('\'').to_string();
                } else if let Some(val) = line.strip_prefix("description:") {
                    description = val.trim().trim_matches('"').trim_matches('\'').to_string();
                } else if let Some(val) = line.strip_prefix("user_invocable:") {
                    user_invocable = val.trim() == "true";
                } else if let Some(val) = line.strip_prefix("allowed_tools:") {
                    let val = val.trim();
                    if val.starts_with('[') && val.ends_with(']') {
                        let inner = &val[1..val.len() - 1];
                        allowed_tools = inner
                            .split(',')
                            .map(|s| s.trim().trim_matches('"').trim_matches('\'').to_string())
                            .filter(|s| !s.is_empty())
                            .collect();
                    }
                }
            }
        }
    }

    SkillEntry {
        dir_name: dir_name.to_string(),
        name,
        description,
        user_invocable,
        allowed_tools,
        content: content.to_string(),
        enabled: true,
    }
}
