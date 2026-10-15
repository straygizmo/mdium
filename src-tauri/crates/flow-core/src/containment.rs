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
        // so worktree and local-repo operations keep working. Env-provided
        // config has command-line scope, so denying each remote transport
        // explicitly keeps a repo-local `protocol.<name>.allow=always` (which
        // would override the `protocol.allow` default) from re-enabling it.
        ("GIT_CONFIG_COUNT", "7"),
        ("GIT_CONFIG_KEY_0", "protocol.allow"),
        ("GIT_CONFIG_VALUE_0", "never"),
        ("GIT_CONFIG_KEY_1", "protocol.file.allow"),
        ("GIT_CONFIG_VALUE_1", "always"),
        ("GIT_CONFIG_KEY_2", "protocol.https.allow"),
        ("GIT_CONFIG_VALUE_2", "never"),
        ("GIT_CONFIG_KEY_3", "protocol.http.allow"),
        ("GIT_CONFIG_VALUE_3", "never"),
        ("GIT_CONFIG_KEY_4", "protocol.ssh.allow"),
        ("GIT_CONFIG_VALUE_4", "never"),
        ("GIT_CONFIG_KEY_5", "protocol.git.allow"),
        ("GIT_CONFIG_VALUE_5", "never"),
        ("GIT_CONFIG_KEY_6", "protocol.ext.allow"),
        ("GIT_CONFIG_VALUE_6", "never"),
        ("GIT_TERMINAL_PROMPT", "0"),
        ("GCM_INTERACTIVE", "never"),
        ("GH_TOKEN", BLOCKED_TOKEN),
        ("GITHUB_TOKEN", BLOCKED_TOKEN),
        ("GITLAB_TOKEN", BLOCKED_TOKEN),
        ("GH_ENTERPRISE_TOKEN", BLOCKED_TOKEN),
        ("GITHUB_ENTERPRISE_TOKEN", BLOCKED_TOKEN),
        ("GITLAB_ACCESS_TOKEN", BLOCKED_TOKEN),
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
///
/// If removing an existing directory fails (on Windows, e.g. because another
/// process holds a handle to the directory itself) but it is already empty,
/// the directory is reused as-is. Any other failure is returned so callers
/// never run the workflow with stale CLI credentials in place.
fn empty_dir(dir: &Path) -> io::Result<PathBuf> {
    match std::fs::symlink_metadata(dir) {
        Ok(meta) if meta.is_dir() => {
            if let Err(e) = std::fs::remove_dir_all(dir) {
                if !is_empty_dir(dir) {
                    return Err(e);
                }
            }
        }
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

/// True if `dir` exists, is a directory, and has no entries.
fn is_empty_dir(dir: &Path) -> bool {
    std::fs::read_dir(dir).is_ok_and(|mut entries| entries.next().is_none())
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
            ("GIT_CONFIG_COUNT", "7"),
            ("GIT_CONFIG_KEY_0", "protocol.allow"),
            ("GIT_CONFIG_VALUE_0", "never"),
            ("GIT_CONFIG_KEY_1", "protocol.file.allow"),
            ("GIT_CONFIG_VALUE_1", "always"),
            ("GIT_CONFIG_KEY_2", "protocol.https.allow"),
            ("GIT_CONFIG_VALUE_2", "never"),
            ("GIT_CONFIG_KEY_3", "protocol.http.allow"),
            ("GIT_CONFIG_VALUE_3", "never"),
            ("GIT_CONFIG_KEY_4", "protocol.ssh.allow"),
            ("GIT_CONFIG_VALUE_4", "never"),
            ("GIT_CONFIG_KEY_5", "protocol.git.allow"),
            ("GIT_CONFIG_VALUE_5", "never"),
            ("GIT_CONFIG_KEY_6", "protocol.ext.allow"),
            ("GIT_CONFIG_VALUE_6", "never"),
            ("GIT_TERMINAL_PROMPT", "0"),
            ("GCM_INTERACTIVE", "never"),
            ("GH_TOKEN", "mdium-blocked"),
            ("GITHUB_TOKEN", "mdium-blocked"),
            ("GITLAB_TOKEN", "mdium-blocked"),
            ("GH_ENTERPRISE_TOKEN", "mdium-blocked"),
            ("GITHUB_ENTERPRISE_TOKEN", "mdium-blocked"),
            ("GITLAB_ACCESS_TOKEN", "mdium-blocked"),
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
            assert_eq!(
                fs::read_dir(dir).unwrap().count(),
                0,
                "{dir:?} must be empty"
            );
        }
    }

    #[test]
    fn is_empty_dir_distinguishes_empty_nonempty_and_missing() {
        let tmp = TempDir::new().unwrap();
        assert!(is_empty_dir(tmp.path()));
        fs::write(tmp.path().join("f"), "x").unwrap();
        assert!(!is_empty_dir(tmp.path()));
        assert!(!is_empty_dir(&tmp.path().join("missing")));
    }

    /// Runs git in `dir` with `env` and without a console window.
    fn git_with_env(dir: &Path, env: &[(String, String)], args: &[&str]) -> std::process::Output {
        let mut cmd = Command::new("git");
        cmd.args(args)
            .current_dir(dir)
            .envs(env.iter().map(|(k, v)| (k.as_str(), v.as_str())));
        #[cfg(target_os = "windows")]
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        cmd.output().expect("git must be runnable")
    }

    #[test]
    fn repo_local_protocol_config_cannot_reenable_remotes() {
        let tmp = TempDir::new().unwrap();
        let repo = tmp.path().join("repo");
        fs::create_dir_all(&repo).unwrap();
        let env = containment_env(&tmp.path().join("data")).unwrap();
        for args in [
            &["init", "-b", "main"][..],
            &["config", "protocol.https.allow", "always"][..],
            &["config", "protocol.allow", "always"][..],
        ] {
            assert!(git_with_env(&repo, &[], args).status.success(), "{args:?}");
        }
        let output = git_with_env(
            &repo,
            &env,
            &["ls-remote", "https://example.invalid/mdium/blocked.git"],
        );
        assert!(!output.status.success());
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(
            stderr.contains("transport 'https' not allowed"),
            "unexpected stderr: {stderr}"
        );
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
