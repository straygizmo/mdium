//! Artifact records: media type guessing, path rules and `artifacts.json`.

use std::path::{Component, Path, PathBuf};

use crate::fsutil;
use crate::run::model::Artifact;

/// Extensions the spec maps to a media type (5.1); anything else is a blob.
pub const MEDIA_TYPES: [(&str, &str); 11] = [
    ("png", "image/png"),
    ("jpg", "image/jpeg"),
    ("jpeg", "image/jpeg"),
    ("webp", "image/webp"),
    ("mp4", "video/mp4"),
    ("webm", "video/webm"),
    ("mp3", "audio/mpeg"),
    ("wav", "audio/wav"),
    ("json", "application/json"),
    ("md", "text/markdown"),
    ("txt", "text/plain"),
];

pub const DEFAULT_MEDIA_TYPE: &str = "application/octet-stream";

pub fn guess_media_type(path: &str) -> &'static str {
    let ext = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase());
    ext.and_then(|e| MEDIA_TYPES.iter().find(|(x, _)| *x == e).map(|(_, m)| *m))
        .unwrap_or(DEFAULT_MEDIA_TYPE)
}

/// Normalises `raw` (absolute, or relative to `node_dir`) and requires it to
/// lie inside the project root. The file need not exist yet. The result is
/// anchored on the canonical form of its longest existing ancestor.
pub fn resolve_artifact_path(
    project_root: &Path,
    node_dir: &Path,
    raw: &str,
) -> Result<PathBuf, &'static str> {
    if raw.trim().is_empty() {
        return Err("empty");
    }
    let candidate = Path::new(raw);
    let joined = if candidate.is_absolute() {
        candidate.to_path_buf()
    } else {
        node_dir.join(candidate)
    };
    let resolved = canonical_prefix(&normalise(&joined));
    let root = project_root.canonicalize().map_err(|_| "outside-root")?;
    // Compare without the Windows `\\?\` verbatim prefix on either side.
    if strip_verbatim(&resolved).starts_with(strip_verbatim(&root)) {
        Ok(strip_verbatim(&resolved))
    } else {
        Err("outside-root")
    }
}

/// Lexically resolves `.` and `..`; keeps the prefix and root components.
fn normalise(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Canonicalizes the longest existing ancestor and re-appends the rest.
fn canonical_prefix(path: &Path) -> PathBuf {
    let mut rest = Vec::new();
    let mut cur = path;
    loop {
        if let Ok(canon) = cur.canonicalize() {
            return rest.iter().rev().fold(canon, |acc, part| acc.join(part));
        }
        match (cur.parent(), cur.file_name()) {
            (Some(parent), Some(name)) => {
                rest.push(name.to_os_string());
                cur = parent;
            }
            _ => return path.to_path_buf(),
        }
    }
}

/// Drops a leading `\\?\` (Windows verbatim prefix) so paths compare equal.
fn strip_verbatim(path: &Path) -> PathBuf {
    let text = path.to_string_lossy();
    match text.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with("UNC\\") => PathBuf::from(rest),
        _ => path.to_path_buf(),
    }
}

pub fn write_artifacts_json(dir: &Path, artifacts: &[Artifact]) -> std::io::Result<()> {
    let text = serde_json::to_string_pretty(artifacts).map_err(std::io::Error::other)?;
    fsutil::atomic_write(&dir.join("artifacts.json"), text.as_bytes())
}

pub fn read_artifacts_json(dir: &Path) -> Vec<Artifact> {
    std::fs::read(dir.join("artifacts.json"))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn guesses_media_types_from_the_extension() {
        for (path, media) in [
            ("a.png", "image/png"),
            ("A.JPG", "image/jpeg"),
            ("x.jpeg", "image/jpeg"),
            ("w.webp", "image/webp"),
            ("v.mp4", "video/mp4"),
            ("v.webm", "video/webm"),
            ("s.mp3", "audio/mpeg"),
            ("s.wav", "audio/wav"),
            ("d.json", "application/json"),
            ("d.md", "text/markdown"),
            ("d.txt", "text/plain"),
            ("bin", "application/octet-stream"),
            ("x.exe", "application/octet-stream"),
        ] {
            assert_eq!(guess_media_type(path), media, "{path}");
        }
    }

    #[test]
    fn resolves_relative_paths_against_the_node_dir_and_rejects_escapes() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("proj");
        let node_dir = root.join(".mdium/flow-runs/r/nodes/a/1");
        std::fs::create_dir_all(&node_dir).unwrap();
        let ok = resolve_artifact_path(&root, &node_dir, "out/a.png").unwrap();
        assert!(ok.ends_with("out/a.png") || ok.ends_with("out\\a.png"));
        assert!(ok.starts_with(strip_verbatim(&root.canonicalize().unwrap())));
        #[cfg(windows)]
        assert!(!ok.to_string_lossy().starts_with(r"\\?\"));
        let abs = root.join("x.txt");
        assert_eq!(
            resolve_artifact_path(&root, &node_dir, abs.to_str().unwrap()).unwrap(),
            strip_verbatim(&root.canonicalize().unwrap()).join("x.txt")
        );
        assert_eq!(
            resolve_artifact_path(&root, &node_dir, "../../../../../../../etc/passwd")
                .unwrap_err(),
            "outside-root"
        );
        assert_eq!(
            resolve_artifact_path(&root, &node_dir, "  ").unwrap_err(),
            "empty"
        );
        assert_eq!(
            resolve_artifact_path(&root, &node_dir, "").unwrap_err(),
            "empty"
        );
        let outside = tmp.path().join("elsewhere.txt");
        assert_eq!(
            resolve_artifact_path(&root, &node_dir, outside.to_str().unwrap()).unwrap_err(),
            "outside-root"
        );
    }

    #[cfg(windows)]
    #[test]
    fn accepts_an_ordinary_drive_path_inside_the_root_on_windows() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("proj");
        let node_dir = root.join("node");
        std::fs::create_dir_all(&node_dir).unwrap();
        let plain = strip_verbatim(&root.canonicalize().unwrap())
            .join("out")
            .join("a.png");
        assert!(!plain.to_string_lossy().starts_with(r"\\?\"));
        let got = resolve_artifact_path(&root, &node_dir, plain.to_str().unwrap()).unwrap();
        assert_eq!(strip_verbatim(&got), plain);
        // Forward slashes and `..` segments still resolve inside the root.
        let base = strip_verbatim(&root.canonicalize().unwrap());
        let mixed = format!("{}/node/../out/a.png", base.display());
        let got = resolve_artifact_path(&root, &node_dir, &mixed).unwrap();
        assert_eq!(strip_verbatim(&got), plain);
    }

    #[test]
    fn artifacts_json_round_trips_and_tolerates_absence() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(read_artifacts_json(tmp.path()).is_empty());
        let a = Artifact {
            index: 0,
            path: "C:/p/a.png".into(),
            label: Some("img".into()),
            media_type: "image/png".into(),
            bytes: Some(3),
            recorded_at: "2026-10-11T00:00:00.000Z".into(),
        };
        write_artifacts_json(tmp.path(), &[a.clone()]).unwrap();
        assert_eq!(read_artifacts_json(tmp.path()), vec![a]);
        std::fs::write(tmp.path().join("artifacts.json"), "{not json").unwrap();
        assert!(read_artifacts_json(tmp.path()).is_empty());
    }
}
