//! Containment environment for the workflow runner process.
//!
//! The runner (and every agent CLI it launches) inherits these variables on
//! top of the user's environment. They block every git transport except
//! local `file://` access, disable credential prompts, and replace forge
//! tokens and CLI config dirs with inert values so an agent cannot push,
//! fetch, or talk to GitHub/GitLab on the user's behalf.

use std::io;
use std::path::{Path, PathBuf};

/// Placeholder value for forge tokens inside the containment env.
const BLOCKED_TOKEN: &str = "mdium-blocked";

/// Build the containment env for the workflow runner. Creates (or empties)
/// `<data_dir>/containment/gh` and `<data_dir>/containment/glab` and points
/// `GH_CONFIG_DIR` / `GLAB_CONFIG_DIR` at them, so the gh/glab CLIs see no
/// stored credentials.
pub fn containment_env(data_dir: &Path) -> io::Result<Vec<(String, String)>> {
    let root = data_dir.join("containment");
    let gh_dir = empty_dir(&root.join("gh"))?;
    let glab_dir = empty_dir(&root.join("glab"))?;

    let mut env: Vec<(String, String)> = [
        // Deny every git transport by default, then re-allow local file access
        // so worktree and local-repo operations keep working.
        ("GIT_CONFIG_COUNT", "2"),
        ("GIT_CONFIG_KEY_0", "protocol.allow"),
        ("GIT_CONFIG_VALUE_0", "never"),
        ("GIT_CONFIG_KEY_1", "protocol.file.allow"),
        ("GIT_CONFIG_VALUE_1", "always"),
        ("GIT_TERMINAL_PROMPT", "0"),
        ("GCM_INTERACTIVE", "never"),
        ("GH_TOKEN", BLOCKED_TOKEN),
        ("GITHUB_TOKEN", BLOCKED_TOKEN),
        ("GITLAB_TOKEN", BLOCKED_TOKEN),
    ]
    .iter()
    .map(|(k, v)| (k.to_string(), v.to_string()))
    .collect();
    env.push(("GH_CONFIG_DIR".into(), path_string(&gh_dir)));
    env.push(("GLAB_CONFIG_DIR".into(), path_string(&glab_dir)));
    Ok(env)
}

/// Recreate `dir` as an empty directory, discarding any previous content
/// (e.g. credentials a CLI wrote there during an earlier run).
fn empty_dir(dir: &Path) -> io::Result<PathBuf> {
    match std::fs::symlink_metadata(dir) {
        Ok(meta) if meta.is_dir() => std::fs::remove_dir_all(dir)?,
        // A file or link in the way is removed rather than followed.
        Ok(_) => remove_non_dir(dir)?,
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => return Err(e),
    }
    std::fs::create_dir_all(dir)?;
    Ok(dir.to_path_buf())
}

/// Remove a non-directory entry. On Windows a directory symlink/junction
/// reports `!is_dir()` via `symlink_metadata` but must be removed with
/// `remove_dir`, so fall back to it when `remove_file` fails.
fn remove_non_dir(path: &Path) -> io::Result<()> {
    std::fs::remove_file(path).or_else(|e| std::fs::remove_dir(path).map_err(|_| e))
}

fn path_string(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::fs;
    use std::process::Command;
    use tempfile::TempDir;

    #[cfg(target_os = "windows")]
    use std::os::windows::process::CommandExt;

    #[test]
    fn containment_env_has_exact_variables_and_empty_config_dirs() {
        let tmp = TempDir::new().unwrap();
        // Pre-existing content must be cleared.
        let stale = tmp.path().join("containment").join("gh");
        fs::create_dir_all(stale.join("nested")).unwrap();
        fs::write(stale.join("hosts.yml"), "token: secret").unwrap();

        let env = containment_env(tmp.path()).unwrap();
        let map: HashMap<String, String> = env.iter().cloned().collect();
        assert_eq!(map.len(), env.len(), "no duplicate keys");

        let gh_dir = tmp.path().join("containment").join("gh");
        let glab_dir = tmp.path().join("containment").join("glab");
        let mut expected: HashMap<String, String> = [
            ("GIT_CONFIG_COUNT", "2"),
            ("GIT_CONFIG_KEY_0", "protocol.allow"),
            ("GIT_CONFIG_VALUE_0", "never"),
            ("GIT_CONFIG_KEY_1", "protocol.file.allow"),
            ("GIT_CONFIG_VALUE_1", "always"),
            ("GIT_TERMINAL_PROMPT", "0"),
            ("GCM_INTERACTIVE", "never"),
            ("GH_TOKEN", "mdium-blocked"),
            ("GITHUB_TOKEN", "mdium-blocked"),
            ("GITLAB_TOKEN", "mdium-blocked"),
        ]
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
        expected.insert(
            "GH_CONFIG_DIR".into(),
            gh_dir.to_string_lossy().into_owned(),
        );
        expected.insert(
            "GLAB_CONFIG_DIR".into(),
            glab_dir.to_string_lossy().into_owned(),
        );
        assert_eq!(map, expected);

        for dir in [&gh_dir, &glab_dir] {
            assert!(dir.is_dir(), "{dir:?} must exist");
            assert_eq!(fs::read_dir(dir).unwrap().count(), 0, "{dir:?} must be empty");
        }
    }

    #[test]
    fn containment_env_blocks_remote_git_transports() {
        let tmp = TempDir::new().unwrap();
        let env = containment_env(tmp.path()).unwrap();
        let mut cmd = Command::new("git");
        cmd.args([
            "-c",
            "protocol.file.allow=always",
            "ls-remote",
            "https://example.invalid/mdium/blocked.git",
        ])
        .current_dir(tmp.path())
        .envs(env.iter().map(|(k, v)| (k.as_str(), v.as_str())));
        #[cfg(target_os = "windows")]
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        let output = cmd.output().expect("git must be runnable");
        assert!(!output.status.success());
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(
            stderr.contains("transport 'https' not allowed"),
            "unexpected stderr: {stderr}"
        );
    }
}
