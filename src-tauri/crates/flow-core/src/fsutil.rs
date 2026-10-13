//! File helpers shared by the engine: atomic writes, ids, timestamps and
//! the project identity key. Moved here from the workflow module so the
//! engine has no dependency on it (spec 2026-10-10, 10.1).

use rand::Rng;
use std::io;
use std::path::{Path, PathBuf};

/// Write `bytes` to `path` atomically: write to a uniquely named temp file
/// in the same directory, then rename over the target. Creates the parent
/// directory tree if it does not exist yet.
///
/// On Windows, `rename` over an existing file can occasionally fail with a
/// transient "access denied" or "already exists" error (e.g. a virus
/// scanner or another process briefly holding the target open). In that
/// case the existing target is moved aside to a uniquely named backup file
/// (never deleted outright) and the rename is retried once; see
/// [`place_via_rename`] for exactly how the retry and its failure modes are
/// handled. This function never ends up deleting both the temp file and
/// the target's content: at least one full copy of the data is always left
/// on disk.
pub fn atomic_write(path: &Path, bytes: &[u8]) -> io::Result<()> {
    atomic_write_impl(path, bytes, |from, to| std::fs::rename(from, to))
}

/// Implementation behind [`atomic_write`], parameterized over the rename
/// operation so tests can force specific rename attempts to fail (e.g. to
/// simulate the transient Windows failure this function retries around)
/// without depending on real OS-level file locking.
fn atomic_write_impl<F>(path: &Path, bytes: &[u8], rename: F) -> io::Result<()>
where
    F: FnMut(&Path, &Path) -> io::Result<()>,
{
    let parent = match path.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent.to_path_buf(),
        _ => PathBuf::from("."),
    };
    std::fs::create_dir_all(&parent)?;

    let file_name = path
        .file_name()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "path has no file name"))?
        .to_string_lossy()
        .into_owned();

    let temp_path = parent.join(format!(".{file_name}.{}.tmp", random_hex(8)));

    if let Err(err) = std::fs::write(&temp_path, bytes) {
        let _ = std::fs::remove_file(&temp_path);
        return Err(err);
    }

    match place_via_rename(&temp_path, path, &parent, rename) {
        PlaceOutcome::Placed => Ok(()),
        PlaceOutcome::FailedTargetIntact(err) => {
            // `path` holds valid content (either untouched, or restored
            // from the backup after a failed retry), so the abandoned
            // temp file -- holding a write that could not be placed -- is
            // safe to discard.
            let _ = std::fs::remove_file(&temp_path);
            Err(err)
        }
        PlaceOutcome::FailedTargetLost(err) => {
            // `path` itself is missing: the restore-from-backup rename
            // failed too. The temp file (new content) and the backup file
            // (original content, still on disk under its generated name)
            // are deliberately left in place for manual recovery. Never
            // delete both copies.
            Err(err)
        }
    }
}

/// Result of attempting to place `temp_path`'s content at `target_path` via
/// rename, retrying once through a backup swap on a retryable failure.
#[derive(Debug)]
enum PlaceOutcome {
    /// `temp_path` now lives at `target_path`; nothing is left to clean up.
    Placed,
    /// The rename failed, but `target_path` is confirmed to hold valid
    /// content (it was never moved, or a moved-aside backup was
    /// successfully restored). The caller may safely discard `temp_path`.
    FailedTargetIntact(io::Error),
    /// The rename failed and `target_path` could not be restored either
    /// (the backup rename-back also failed). `target_path` is missing;
    /// the caller must not delete `temp_path`, since it and the backup
    /// file left behind are the only remaining copies of real data.
    FailedTargetLost(io::Error),
}

/// Renames `temp_path` over `target_path`. On a retryable failure (see
/// [`is_retryable_rename_error`]), moves the existing target aside to a
/// uniquely named backup file in `dir` first, retries the rename, and on a
/// second failure moves the backup back into place before reporting the
/// error -- so the target is never left both incomplete and unrecoverable.
///
/// `rename` performs the actual filesystem rename and is injectable so
/// tests can force failures on specific steps deterministically.
fn place_via_rename<F>(
    temp_path: &Path,
    target_path: &Path,
    dir: &Path,
    mut rename: F,
) -> PlaceOutcome
where
    F: FnMut(&Path, &Path) -> io::Result<()>,
{
    match rename(temp_path, target_path) {
        Ok(()) => return PlaceOutcome::Placed,
        Err(err) if !is_retryable_rename_error(&err) => {
            return PlaceOutcome::FailedTargetIntact(err);
        }
        Err(_) => {}
    }

    let file_name = target_path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let backup_path = dir.join(format!(".{file_name}.{}.bak", random_hex(8)));

    if let Err(err) = rename(target_path, &backup_path) {
        // Could not move the existing target aside; it is untouched at
        // target_path, so it is confirmed intact.
        return PlaceOutcome::FailedTargetIntact(err);
    }

    match rename(temp_path, target_path) {
        Ok(()) => {
            // The new content is in place; the backup is redundant. Best
            // effort: a failure to remove it is not itself an error.
            let _ = std::fs::remove_file(&backup_path);
            PlaceOutcome::Placed
        }
        Err(retry_err) => {
            if rename(&backup_path, target_path).is_ok() {
                PlaceOutcome::FailedTargetIntact(retry_err)
            } else {
                PlaceOutcome::FailedTargetLost(retry_err)
            }
        }
    }
}

/// Whether a `rename` failure is worth retrying once via a backup swap
/// (Windows-specific transient failures).
fn is_retryable_rename_error(err: &io::Error) -> bool {
    matches!(
        err.kind(),
        io::ErrorKind::PermissionDenied | io::ErrorKind::AlreadyExists
    )
}

/// A run of `len` lowercase hex characters from a cryptographically
/// irrelevant, but process-unique, RNG.
fn random_hex(len: usize) -> String {
    const HEX: &[u8] = b"0123456789abcdef";
    let mut rng = rand::thread_rng();
    (0..len)
        .map(|_| HEX[rng.gen_range(0..HEX.len())] as char)
        .collect()
}

/// A new random id: 16 lowercase hex characters, matching `^[0-9a-f]{16}$`.
pub fn new_id() -> String {
    random_hex(16)
}

/// The current UTC time as RFC 3339 with millisecond precision, e.g.
/// `2026-09-25T12:34:56.789Z`.
pub fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// A project root as MDium works with it: canonicalized when the path
/// exists (falling back to the path as given), without a trailing
/// separator, and without the Windows verbatim (`\\?\`) prefix that
/// `canonicalize` adds. Letter case is preserved.
///
/// The result is meant as a lock/identity key and a display root. Without
/// the verbatim prefix, Win32 APIs apply the `MAX_PATH` limit and path
/// normalization again, so do not use it to reach deep paths below the
/// root on Windows.
pub fn normalize_root(project_root: &Path) -> PathBuf {
    // `canonicalize` fails for paths that do not exist (yet). Fall back to
    // `absolute`, which needs no file system access, so a relative and an
    // absolute spelling of the same missing root still share one key; only
    // if that fails too is the path used exactly as given.
    let resolved = std::fs::canonicalize(project_root)
        .or_else(|_| std::path::absolute(project_root))
        .unwrap_or_else(|_| project_root.to_path_buf());
    // Rebuilding from the components drops a trailing separator.
    strip_verbatim(resolved.components().collect())
}

/// Removes the verbatim prefix from a verbatim disk (`\\?\C:\...`) or UNC
/// (`\\?\UNC\server\share`) path; any other path is returned unchanged.
#[cfg(windows)]
fn strip_verbatim(path: PathBuf) -> PathBuf {
    let Some(text) = path.to_str() else {
        return path;
    };
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    match text.strip_prefix(r"\\?\") {
        Some(rest) if rest.as_bytes().get(1) == Some(&b':') => PathBuf::from(rest),
        _ => path,
    }
}

#[cfg(not(windows))]
fn strip_verbatim(path: PathBuf) -> PathBuf {
    path
}

/// Normalized key for a project root ([`normalize_root`]), lowercased on
/// Windows, whose file system is case-insensitive. Different spellings of
/// the same directory share one key; the per-project lock and the
/// orchestrator's project table are both keyed by it.
pub fn project_key(project_root: &Path) -> PathBuf {
    let root = normalize_root(project_root);
    if cfg!(windows) {
        PathBuf::from(root.to_string_lossy().to_lowercase())
    } else {
        root
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;
    use std::path::PathBuf;

    #[test]
    fn atomic_write_replaces_content_and_creates_parents() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a/b/file.json");
        atomic_write(&path, b"one").unwrap();
        atomic_write(&path, b"two").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"two");
        let leftovers: Vec<_> = std::fs::read_dir(path.parent().unwrap())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "{leftovers:?}");
    }

    #[test]
    fn new_id_is_sixteen_lowercase_hex_chars() {
        let id = new_id();
        assert_eq!(id.len(), 16);
        assert!(id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')));
        assert_ne!(new_id(), id);
    }

    #[test]
    fn now_is_rfc3339_with_millis_and_zulu_suffix() {
        let ts = now();
        assert!(ts.ends_with('Z'), "{ts}");
        assert_eq!(ts.len(), "2026-09-25T12:34:56.789Z".len(), "{ts}");
    }

    #[test]
    fn normalize_root_drops_trailing_separator() {
        let dir = tempfile::tempdir().unwrap();
        let root = normalize_root(dir.path());
        assert_eq!(normalize_root(&dir.path().join("")), root);
        assert!(!root.to_string_lossy().ends_with(std::path::MAIN_SEPARATOR));
    }

    #[test]
    fn project_key_is_case_insensitive_on_windows_only() {
        let dir = tempfile::tempdir().unwrap();
        let key = project_key(dir.path());
        let upper = PathBuf::from(dir.path().to_string_lossy().to_uppercase());
        if cfg!(windows) {
            assert_eq!(project_key(&upper), key);
        } else {
            assert_ne!(project_key(&upper), key);
        }
    }

    #[test]
    fn concurrent_writers_never_produce_a_partial_file() {
        // This test cannot make the OS scheduler's thread interleaving
        // itself deterministic -- that is inherent to testing real
        // concurrency portably. What *is* deterministic, and what this
        // test actually asserts, is the outcome for every interleaving:
        // the file on disk is always exactly one complete write's content,
        // never a mix of two writes' bytes. That holds on every run given
        // a correct `atomic_write` (rename is atomic within a directory on
        // both Windows and POSIX filesystems), and a naive non-atomic
        // implementation would be very likely to violate it given two
        // threads racing 200 writes each of a few hundred bytes. A
        // `Barrier` lines up both threads' start so the writes actually
        // race instead of one thread finishing before the other begins.
        let dir = tempfile::tempdir().unwrap();
        let path = std::sync::Arc::new(dir.path().join("shared.json"));
        let per_thread = 200usize;
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));

        let content_for = |label: &str, seq: usize| -> String {
            format!(
                "{{\"writer\":\"{label}\",\"seq\":{seq},\"padding\":\"{}\"}}",
                "x".repeat(500)
            )
        };

        let mut possible_contents: HashSet<String> = HashSet::new();
        for label in ["a", "b"] {
            for seq in 0..per_thread {
                possible_contents.insert(content_for(label, seq));
            }
        }

        let handles: Vec<_> = ["a", "b"]
            .into_iter()
            .map(|label| {
                let path = std::sync::Arc::clone(&path);
                let barrier = std::sync::Arc::clone(&barrier);
                std::thread::spawn(move || {
                    barrier.wait();
                    for seq in 0..per_thread {
                        let content = content_for(label, seq);
                        atomic_write(&path, content.as_bytes()).unwrap();
                    }
                })
            })
            .collect();

        for handle in handles {
            handle.join().unwrap();
        }

        let final_content = std::fs::read_to_string(&*path).unwrap();
        assert!(
            possible_contents.contains(&final_content),
            "final content did not match any single write"
        );

        // The content must parse cleanly (no truncation or interleaving of
        // two writers' bytes).
        let _: serde_json::Value = serde_json::from_str(&final_content).unwrap();

        let leftover: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.file_name() != "shared.json")
            .collect();
        assert!(leftover.is_empty(), "leftover files: {leftover:?}");
    }

    #[test]
    fn place_via_rename_restores_original_when_retry_also_fails() {
        let dir = tempfile::tempdir().unwrap();
        let target_path = dir.path().join("target.txt");
        let temp_path = dir.path().join(".target.txt.deadbeef.tmp");

        std::fs::write(&target_path, b"original").unwrap();
        std::fs::write(&temp_path, b"new content").unwrap();

        let forced_target = target_path.clone();
        let outcome = place_via_rename(&temp_path, &target_path, dir.path(), move |from, to| {
            if to == forced_target && from.extension().and_then(|e| e.to_str()) == Some("tmp") {
                // Simulate the transient Windows failure on every attempt
                // to place the new content directly over the target.
                Err(io::Error::from(io::ErrorKind::PermissionDenied))
            } else {
                std::fs::rename(from, to)
            }
        });

        assert!(
            matches!(outcome, PlaceOutcome::FailedTargetIntact(_)),
            "expected FailedTargetIntact, got {outcome:?}"
        );

        // The original content must have survived: the target was moved
        // aside as a backup, the retry failed, and the backup was
        // restored.
        assert_eq!(std::fs::read_to_string(&target_path).unwrap(), "original");

        // `place_via_rename` never touches the temp file itself; only the
        // caller (`atomic_write_impl`) decides whether it is now safe to
        // discard it.
        assert_eq!(std::fs::read_to_string(&temp_path).unwrap(), "new content");

        // The backup was successfully restored, so no stray backup file
        // is left behind.
        let leftover: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|entry| entry.ok())
            .filter(|entry| {
                let name = entry.file_name();
                name != "target.txt" && name != temp_path.file_name().unwrap()
            })
            .collect();
        assert!(leftover.is_empty(), "leftover files: {leftover:?}");
    }

    #[test]
    fn place_via_rename_preserves_both_copies_when_restore_also_fails() {
        let dir = tempfile::tempdir().unwrap();
        let target_path = dir.path().join("target.txt");
        let temp_path = dir.path().join(".target.txt.deadbeef.tmp");

        std::fs::write(&target_path, b"original").unwrap();
        std::fs::write(&temp_path, b"new content").unwrap();

        let forced_target = target_path.clone();
        let outcome = place_via_rename(&temp_path, &target_path, dir.path(), move |from, to| {
            if to == forced_target {
                // Every attempt to write anything into target_path fails,
                // as if the target were persistently locked -- including
                // the restore-from-backup attempt.
                Err(io::Error::from(io::ErrorKind::PermissionDenied))
            } else {
                std::fs::rename(from, to)
            }
        });

        assert!(
            matches!(outcome, PlaceOutcome::FailedTargetLost(_)),
            "expected FailedTargetLost, got {outcome:?}"
        );

        // Neither copy was deleted: the temp file still holds the new
        // content...
        assert_eq!(std::fs::read_to_string(&temp_path).unwrap(), "new content");
        // ...and the original content survives under the generated backup
        // name.
        let backup_content = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|entry| entry.ok())
            .find(|entry| entry.file_name().to_string_lossy().ends_with(".bak"))
            .map(|entry| std::fs::read_to_string(entry.path()).unwrap());
        assert_eq!(backup_content, Some("original".to_string()));

        // `target_path` itself is indeed missing in this worst case.
        assert!(!target_path.exists());
    }

    #[test]
    fn atomic_write_impl_restores_original_and_cleans_up_temp_when_retry_fails() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("target.txt");
        std::fs::write(&path, b"original").unwrap();

        let forced_target = path.clone();
        let result = atomic_write_impl(&path, b"new content", move |from, to| {
            if to == forced_target && from.extension().and_then(|e| e.to_str()) == Some("tmp") {
                Err(io::Error::from(io::ErrorKind::PermissionDenied))
            } else {
                std::fs::rename(from, to)
            }
        });

        assert!(result.is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "original");

        // Once the target is confirmed to hold valid (restored) content,
        // no temp or backup files are left behind.
        let leftover: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.file_name() != "target.txt")
            .collect();
        assert!(leftover.is_empty(), "leftover files: {leftover:?}");
    }

    #[test]
    fn atomic_write_impl_never_deletes_both_copies_when_target_cannot_be_restored() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("target.txt");
        std::fs::write(&path, b"original").unwrap();

        let forced_target = path.clone();
        let result = atomic_write_impl(&path, b"new content", move |from, to| {
            if to == forced_target {
                Err(io::Error::from(io::ErrorKind::PermissionDenied))
            } else {
                std::fs::rename(from, to)
            }
        });

        assert!(result.is_err());

        // The temp file (new content) must still be on disk.
        let temp_entry = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|entry| entry.ok())
            .find(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"));
        assert!(temp_entry.is_some(), "temp file must be preserved");
        assert_eq!(
            std::fs::read_to_string(temp_entry.unwrap().path()).unwrap(),
            "new content"
        );

        // The backup file (original content) must also still be on disk.
        let backup_entry = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|entry| entry.ok())
            .find(|entry| entry.file_name().to_string_lossy().ends_with(".bak"));
        assert!(backup_entry.is_some(), "backup file must be preserved");
        assert_eq!(
            std::fs::read_to_string(backup_entry.unwrap().path()).unwrap(),
            "original"
        );
    }

    #[test]
    fn normalize_root_drops_trailing_separator_and_keeps_case() {
        let dir = tempfile::tempdir().unwrap();
        let root = normalize_root(dir.path());
        assert_eq!(normalize_root(&dir.path().join("")), root);
        assert!(!root.to_string_lossy().ends_with(std::path::MAIN_SEPARATOR));
        let missing = dir.path().join("Missing-Dir");
        let normalized = normalize_root(&missing.join(""));
        assert!(normalized.to_string_lossy().ends_with("Missing-Dir"));
    }

    #[cfg(windows)]
    #[test]
    fn normalize_root_strips_the_verbatim_prefix() {
        let dir = tempfile::tempdir().unwrap();
        let root = normalize_root(dir.path());
        assert!(!root.to_string_lossy().starts_with(r"\\?\"), "{root:?}");
        let verbatim = PathBuf::from(format!(r"\\?\{}", root.display()));
        assert_eq!(normalize_root(&verbatim), root);
        assert_eq!(
            strip_verbatim(PathBuf::from(r"\\?\UNC\server\share\x")),
            PathBuf::from(r"\\server\share\x")
        );
        let volume = PathBuf::from(r"\\?\Volume{0}\x");
        assert_eq!(strip_verbatim(volume.clone()), volume);
    }
}

/// True if `id` is exactly 16 lowercase hex characters.
pub fn is_valid_id(id: &str) -> bool {
    id.len() == 16 && id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}
