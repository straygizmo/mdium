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
        let skill_file = path.join("SKILL.md");
        if !skill_file.exists() {
            continue;
        }
        let content = match fs::read_to_string(&skill_file) {
            Ok(c) => c,
            Err(_) => continue,
        };
        let dir_name = path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        let skill = parse_skill_frontmatter(&dir_name, &content);
        entries.push(skill);
    }

    Ok(entries)
}

#[tauri::command]
pub fn write_skill(base_dir: String, dir_name: String, content: String) -> Result<(), String> {
    let skill_dir = Path::new(&base_dir).join("skills").join(&dir_name);
    fs::create_dir_all(&skill_dir).map_err(|e| e.to_string())?;
    let skill_file = skill_dir.join("SKILL.md");
    fs::write(skill_file, content).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_skill(base_dir: String, dir_name: String) -> Result<(), String> {
    let skill_dir = Path::new(&base_dir).join("skills").join(&dir_name);
    if skill_dir.exists() {
        fs::remove_dir_all(&skill_dir).map_err(|e| e.to_string())?;
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
    let tools_dir = Path::new(&base_dir).join("tools");
    if !tools_dir.exists() {
        return Ok(vec![]);
    }

    let mut entries = vec![];
    let read_dir = fs::read_dir(&tools_dir).map_err(|e| e.to_string())?;

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
    let tools_dir = Path::new(&base_dir).join("tools");
    fs::create_dir_all(&tools_dir).map_err(|e| e.to_string())?;
    let file_path = tools_dir.join(&file_name);
    fs::write(file_path, content).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_tool_file(base_dir: String, file_name: String) -> Result<(), String> {
    let file_path = Path::new(&base_dir).join("tools").join(&file_name);
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
    }
}
