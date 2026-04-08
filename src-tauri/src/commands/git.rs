use std::process::Command;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

fn run_git(path: &str, args: &[&str]) -> Result<String, String> {
    let mut full_args = vec!["-c", "core.quotePath=false"];
    full_args.extend_from_slice(args);
    let mut cmd = Command::new("git");
    cmd.args(&full_args).current_dir(path);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    let output = cmd
        .output()
        .map_err(|e| format!("Failed to run git: {}", e))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        let err = String::from_utf8_lossy(&output.stderr).to_string();
        Err(err)
    }
}

#[tauri::command]
pub fn git_init(path: String) -> Result<String, String> {
    run_git(&path, &["init", "-b", "main"])
}

#[tauri::command]
pub fn git_status(path: String) -> Result<String, String> {
    run_git(&path, &["status", "--short"])
}

#[tauri::command]
pub fn git_add_all(path: String) -> Result<String, String> {
    run_git(&path, &["add", "-A"])
}

#[tauri::command]
pub fn git_commit(path: String, message: String) -> Result<String, String> {
    run_git(&path, &["commit", "-m", &message])
}

#[tauri::command]
pub fn git_push(path: String) -> Result<String, String> {
    run_git(&path, &["push"])
}

#[tauri::command]
pub fn git_get_remote_url(path: String) -> Result<String, String> {
    run_git(&path, &["remote", "get-url", "origin"])
        .map(|s| s.trim().to_string())
}

#[tauri::command]
pub fn git_set_remote_url(path: String, url: String) -> Result<String, String> {
    // Try set-url first, fall back to add
    run_git(&path, &["remote", "set-url", "origin", &url])
        .or_else(|_| run_git(&path, &["remote", "add", "origin", &url]))
}

#[tauri::command]
pub fn git_status_porcelain(path: String) -> Result<String, String> {
    run_git(&path, &["status", "--porcelain=v1"])
}

#[tauri::command]
pub fn git_add(path: String, files: Vec<String>) -> Result<String, String> {
    let mut args = vec!["add", "--"];
    let file_refs: Vec<&str> = files.iter().map(|s| s.as_str()).collect();
    args.extend(file_refs);
    run_git(&path, &args)
}

#[tauri::command]
pub fn git_restore_staged(path: String, files: Vec<String>) -> Result<String, String> {
    let mut args = vec!["restore", "--staged", "--"];
    let file_refs: Vec<&str> = files.iter().map(|s| s.as_str()).collect();
    args.extend(file_refs.iter().copied());
    run_git(&path, &args).or_else(|_| {
        let mut fallback = vec!["rm", "--cached", "--"];
        fallback.extend(file_refs);
        run_git(&path, &fallback)
    })
}

#[tauri::command]
pub fn git_diff_staged(path: String) -> Result<String, String> {
    run_git(&path, &["diff", "--staged"])
}

#[tauri::command]
pub fn git_diff_unstaged(path: String) -> Result<String, String> {
    run_git(&path, &["diff"])
}

#[tauri::command]
pub fn git_log_oneline(path: String, count: u32) -> Result<String, String> {
    let n = format!("-{}", count);
    run_git(&path, &["log", "--oneline", &n])
}

#[tauri::command]
pub fn git_log_graph(path: String, count: u32, skip: u32) -> Result<String, String> {
    let n = format!("-{}", count);
    let s = format!("--skip={}", skip);
    run_git(
        &path,
        &[
            "log",
            "--format=<hash>%H<author>%an<date>%aI<message>%s<parents>%P<refs>%D",
            "--topo-order",
            &n,
            &s,
        ],
    )
}

#[tauri::command]
pub fn git_diff_commit(path: String, hash: String) -> Result<String, String> {
    run_git(&path, &["diff-tree", "--no-commit-id", "--name-status", "-r", &hash])
}

#[tauri::command]
pub fn git_branch_list(path: String) -> Result<String, String> {
    run_git(&path, &["branch", "-a", "--no-color"])
}

#[tauri::command]
pub fn git_current_branch(path: String) -> Result<String, String> {
    run_git(&path, &["branch", "--show-current"])
}

#[tauri::command]
pub fn git_switch(path: String, branch: String) -> Result<String, String> {
    run_git(&path, &["switch", &branch])
}

#[tauri::command]
pub fn git_discard(path: String, files: Vec<String>) -> Result<String, String> {
    let mut args = vec!["restore", "--"];
    let file_refs: Vec<&str> = files.iter().map(|s| s.as_str()).collect();
    args.extend(file_refs);
    run_git(&path, &args)
}

#[tauri::command]
pub fn git_remove_untracked(path: String, files: Vec<String>) -> Result<String, String> {
    let mut args = vec!["clean", "-f", "--"];
    let file_refs: Vec<&str> = files.iter().map(|s| s.as_str()).collect();
    args.extend(file_refs);
    run_git(&path, &args)
}

#[tauri::command]
pub fn git_commits_ahead(path: String) -> Result<u32, String> {
    // Get the upstream tracking ref for HEAD
    let upstream = run_git(&path, &["rev-parse", "--abbrev-ref", "@{upstream}"])
        .map(|s| s.trim().to_string());
    match upstream {
        Ok(up) if !up.is_empty() => {
            let range = format!("{}..HEAD", up);
            let out = run_git(&path, &["rev-list", "--count", &range])?;
            out.trim().parse::<u32>().map_err(|e| e.to_string())
        }
        // No upstream configured — treat all local commits as ahead
        _ => {
            let out = run_git(&path, &["rev-list", "--count", "HEAD"])
                .unwrap_or_else(|_| "0".to_string());
            Ok(out.trim().parse::<u32>().unwrap_or(0))
        }
    }
}

#[tauri::command]
pub fn git_push_upstream(path: String, branch: String) -> Result<String, String> {
    run_git(&path, &["push", "-u", "origin", &branch])
}

#[tauri::command]
pub fn git_show_file(path: String, revision: String, file: String) -> Result<String, String> {
    let spec = if revision.is_empty() {
        format!(":{}", file)
    } else {
        format!("{}:{}", revision, file)
    };
    run_git(&path, &["show", &spec])
}
