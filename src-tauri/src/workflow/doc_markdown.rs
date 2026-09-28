//! Markdown renditions of committed Office/PDF attachments, so agents can
//! read documents they would otherwise only see as binary files.
//!
//! Layout: next to a committed attachment's content,
//! `.mdium/task-attachments/<rootTaskId>/<attachmentId>/markdown/<stem>.md`
//! (plus any extracted images). The runner writes into `markdown.tmp/`,
//! which is renamed to `markdown/` once complete, so an existing
//! `markdown/` is never half-written. A conversion the converter itself
//! rejected (e.g. a scanned PDF without text) leaves
//! `markdown/conversion-failed.txt` instead and is not retried; a runner
//! that is missing, exited or timed out is retried on a later pass.
//!
//! A stored name always ends in a convertible extension here, so it can
//! never be `markdown` or `markdown.tmp` itself.
//!
//! Renditions are prepared without the project guard (see
//! [`prepare_root_renditions`]); committed attachments are immutable, and
//! per project one dispatch pass runs at a time.

use crate::workflow::attachments;
use crate::workflow::fsutil::MdiumPaths;
use crate::workflow::runner_client::RunnerError;
use crate::workflow::runner_host::RunnerApi;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Directory holding a finished rendition.
pub const MARKDOWN_DIR: &str = "markdown";
/// Directory a rendition is written into before it is moved into place.
const TMP_DIR: &str = "markdown.tmp";
/// Written instead of a rendition when the converter rejected the document.
pub const FAILED_MARKER: &str = "conversion-failed.txt";
/// How long one conversion may take; longer than the runner's own limit,
/// so the runner normally answers first.
pub const CONVERT_TIMEOUT: Duration = Duration::from_secs(180);
/// Prefix of the runner's error message for a document it could not convert.
const CONVERT_FAILED: &str = "CONVERT_FAILED";

const CONVERTIBLE_EXTENSIONS: [&str; 5] = ["docx", "xlsx", "xlsm", "pptx", "pdf"];

/// Whether `name` has an extension the converter handles.
pub fn is_convertible(name: &str) -> bool {
    Path::new(name)
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| {
            CONVERTIBLE_EXTENSIONS
                .iter()
                .any(|known| ext.eq_ignore_ascii_case(known))
        })
}

/// `<stem>.md` for a stored name (the extension replaced).
fn rendition_name(stored_name: &str) -> String {
    let stem = Path::new(stored_name)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("document");
    format!("{stem}.md")
}

/// A drive-absolute Windows path or a posix absolute path: what the runner
/// accepts. UNC and device paths are not converted.
fn is_local_absolute(path: &str) -> bool {
    let bytes = path.as_bytes();
    let drive = bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && matches!(bytes[2], b'\\' | b'/');
    let posix = bytes.first() == Some(&b'/') && !matches!(bytes.get(1), Some(b'/' | b'\\'));
    drive || posix
}

fn is_real_dir(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|meta| meta.file_type().is_dir())
}

fn is_regular_file(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|meta| meta.file_type().is_file())
}

/// The finished rendition of the attachment stored as `stored_name` in
/// `attachment_dir`, if there is one (a regular file in a real directory).
pub fn existing_rendition(attachment_dir: &Path, stored_name: &str) -> Option<PathBuf> {
    if !is_convertible(stored_name) {
        return None;
    }
    let dir = attachment_dir.join(MARKDOWN_DIR);
    let file = dir.join(rendition_name(stored_name));
    (is_real_dir(&dir) && is_regular_file(&file)).then_some(file)
}

/// What [`ensure_rendition`] ended with.
#[derive(Debug, PartialEq)]
pub enum Rendition {
    /// The rendition exists at this path.
    Ready(PathBuf),
    /// The converter rejected the document (recorded, not retried).
    Failed,
    /// The attachment is not a convertible document (or its path is not
    /// one the runner accepts).
    NotConvertible,
    /// The conversion could not run now; a later pass tries again.
    Retry(RunnerError),
}

/// Removes a leftover `path` (a link is removed itself, never followed).
fn remove_any(path: &Path) -> std::io::Result<()> {
    match std::fs::symlink_metadata(path) {
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err),
        Ok(meta) if meta.file_type().is_dir() => std::fs::remove_dir_all(path),
        Ok(_) => std::fs::remove_file(path).or_else(|_| std::fs::remove_dir(path)),
    }
}

/// Ensures the rendition of the attachment whose verified content file is
/// `content` exists, converting it with `convert(input, output)` when
/// needed. `convert` must write the Markdown to `output` (and its images
/// next to it).
pub fn ensure_rendition(
    content: &Path,
    convert: impl FnOnce(&str, &str) -> Result<String, RunnerError>,
) -> Rendition {
    let (Some(dir), Some(stored_name)) = (content.parent(), content.file_name()) else {
        return Rendition::NotConvertible;
    };
    let Some(stored_name) = stored_name.to_str() else {
        return Rendition::NotConvertible;
    };
    if !is_convertible(stored_name) {
        return Rendition::NotConvertible;
    }
    let final_dir = dir.join(MARKDOWN_DIR);
    let name = rendition_name(stored_name);
    if std::fs::symlink_metadata(&final_dir).is_ok() {
        // Something is there already: a finished rendition, a failure
        // record, or something MDium did not write (left alone).
        return match existing_rendition(dir, stored_name) {
            Some(file) => Rendition::Ready(file),
            None => Rendition::Failed,
        };
    }
    let (Some(input), Some(dir_text)) = (content.to_str(), dir.to_str()) else {
        return Rendition::NotConvertible;
    };
    if !is_local_absolute(input) || !is_local_absolute(dir_text) {
        return Rendition::NotConvertible;
    }

    let tmp = dir.join(TMP_DIR);
    if let Err(err) = remove_any(&tmp).and_then(|()| std::fs::create_dir(&tmp)) {
        return Rendition::Retry(RunnerError::Transport(format!("{}: {err}", tmp.display())));
    }
    let output = tmp.join(&name);
    let Some(output_text) = output.to_str() else {
        let _ = remove_any(&tmp);
        return Rendition::NotConvertible;
    };
    let result = convert(input, output_text);
    let finish = |tmp: &Path| -> std::io::Result<()> { std::fs::rename(tmp, &final_dir) };
    match result {
        Ok(_) if is_regular_file(&output) => match finish(&tmp) {
            Ok(()) => Rendition::Ready(final_dir.join(&name)),
            Err(err) => {
                let _ = remove_any(&tmp);
                Rendition::Retry(RunnerError::Transport(format!("{}: {err}", tmp.display())))
            }
        },
        Ok(_) => {
            let _ = remove_any(&tmp);
            Rendition::Retry(RunnerError::Protocol(
                "the runner reported a Markdown file it did not write".to_string(),
            ))
        }
        Err(RunnerError::Remote(message)) if message.starts_with(CONVERT_FAILED) => {
            let recorded = std::fs::write(tmp.join(FAILED_MARKER), message.as_bytes())
                .and_then(|()| finish(&tmp));
            if recorded.is_err() {
                let _ = remove_any(&tmp);
            }
            Rendition::Failed
        }
        Err(err) => {
            let _ = remove_any(&tmp);
            Rendition::Retry(err)
        }
    }
}

/// Prepares the renditions of every convertible committed attachment of
/// root task `root_id` through `runner`. Best effort: problems are logged.
/// Stops at the first failure that is not the document's own fault (the
/// runner is missing, exited or timed out), since the rest would fail the
/// same way.
pub fn prepare_root_renditions(project_root: &Path, root_id: &str, runner: &dyn RunnerApi) {
    let paths = MdiumPaths::new(project_root);
    let metas = match attachments::list_attachments(&paths, root_id) {
        Ok(metas) => metas,
        Err(err) => {
            eprintln!("[workflow] listing the attachments of task {root_id} failed: {err}");
            return;
        }
    };
    for meta in metas {
        if !is_convertible(&meta.stored_name) {
            continue;
        }
        let Ok(dir) = paths.attachment_dir(root_id, &meta.id) else {
            continue;
        };
        if std::fs::symlink_metadata(dir.join(MARKDOWN_DIR)).is_ok() {
            continue;
        }
        // Verifies the content (real directories, size and hash) first.
        let content = match attachments::attachment_file(&paths, root_id, &meta.id) {
            Ok(content) => content,
            Err(err) => {
                eprintln!(
                    "[workflow] attachment {} of task {root_id} not converted: {err}",
                    meta.id
                );
                continue;
            }
        };
        let outcome = ensure_rendition(&content, |input, output| {
            runner.convert_document(input, output, CONVERT_TIMEOUT)
        });
        match outcome {
            Rendition::Ready(_) | Rendition::NotConvertible => {}
            Rendition::Failed => eprintln!(
                "[workflow] attachment {} of task {root_id} could not be converted to Markdown",
                meta.id
            ),
            Rendition::Retry(err) => {
                eprintln!(
                    "[workflow] converting attachment {} of task {root_id} deferred: {err}",
                    meta.id
                );
                return;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workflow::attachments::{add_draft_from_bytes, apply_commit, prepare_commit};
    use crate::workflow::model::Provider;
    use crate::workflow::runner_client::{RunnerEvent, StartSessionParams};
    use std::sync::mpsc::Receiver;
    use std::sync::Mutex;
    use tempfile::TempDir;

    fn content_in(dir: &TempDir, name: &str) -> PathBuf {
        let entry = dir.path().join("entry");
        std::fs::create_dir_all(&entry).unwrap();
        let content = entry.join(name);
        std::fs::write(&content, b"doc").unwrap();
        content
    }

    fn write_markdown(output: &str, text: &str) -> Result<String, RunnerError> {
        std::fs::write(output, text).unwrap();
        Ok(output.to_string())
    }

    #[test]
    fn convertible_extensions_are_case_insensitive() {
        assert!(is_convertible("a.DOCX"));
        assert!(is_convertible("b.xlsm"));
        assert!(is_convertible("c.pdf"));
        assert!(!is_convertible("d.txt"));
        assert!(!is_convertible("markdown"));
        assert_eq!(rendition_name("q3.report.pptx"), "q3.report.md");
    }

    #[test]
    fn local_absolute_paths() {
        assert!(is_local_absolute("C:\\a\\b.pdf"));
        assert!(is_local_absolute("c:/a/b.pdf"));
        assert!(is_local_absolute("/home/a.pdf"));
        assert!(!is_local_absolute("\\\\server\\share\\a.pdf"));
        assert!(!is_local_absolute("//server/share/a.pdf"));
        assert!(!is_local_absolute("relative.pdf"));
    }

    #[test]
    fn a_conversion_is_moved_into_place_and_reused() {
        let tmp = TempDir::new().unwrap();
        let content = content_in(&tmp, "report.docx");
        let outcome = ensure_rendition(&content, |input, output| {
            assert_eq!(input, content.to_str().unwrap());
            assert!(output.ends_with("report.md"));
            assert!(output.contains(TMP_DIR));
            write_markdown(output, "# Report")
        });
        let expected = content
            .parent()
            .unwrap()
            .join(MARKDOWN_DIR)
            .join("report.md");
        assert_eq!(outcome, Rendition::Ready(expected.clone()));
        assert_eq!(std::fs::read_to_string(&expected).unwrap(), "# Report");
        assert!(!content.parent().unwrap().join(TMP_DIR).exists());
        assert_eq!(
            existing_rendition(content.parent().unwrap(), "report.docx"),
            Some(expected.clone())
        );
        // A second call does not convert again.
        let again = ensure_rendition(&content, |_, _| panic!("converted twice"));
        assert_eq!(again, Rendition::Ready(expected));
    }

    #[test]
    fn a_rejected_document_is_recorded_and_not_retried() {
        let tmp = TempDir::new().unwrap();
        let content = content_in(&tmp, "scan.pdf");
        let outcome = ensure_rendition(&content, |_, _| {
            Err(RunnerError::Remote("CONVERT_FAILED: no text".to_string()))
        });
        assert_eq!(outcome, Rendition::Failed);
        let dir = content.parent().unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.join(MARKDOWN_DIR).join(FAILED_MARKER)).unwrap(),
            "CONVERT_FAILED: no text"
        );
        assert_eq!(existing_rendition(dir, "scan.pdf"), None);
        let again = ensure_rendition(&content, |_, _| panic!("retried"));
        assert_eq!(again, Rendition::Failed);
    }

    #[test]
    fn an_unavailable_runner_is_retried_later_and_leaves_nothing_behind() {
        let tmp = TempDir::new().unwrap();
        let content = content_in(&tmp, "deck.pptx");
        let dir = content.parent().unwrap();
        // A leftover temp directory from an interrupted run is replaced.
        std::fs::create_dir(dir.join(TMP_DIR)).unwrap();
        std::fs::write(dir.join(TMP_DIR).join("stale.md"), "old").unwrap();
        let outcome = ensure_rendition(&content, |_, _| Err(RunnerError::Timeout));
        assert_eq!(outcome, Rendition::Retry(RunnerError::Timeout));
        assert!(!dir.join(TMP_DIR).exists());
        assert!(!dir.join(MARKDOWN_DIR).exists());
        let outcome = ensure_rendition(&content, |_, output| write_markdown(output, "# Deck"));
        assert!(matches!(outcome, Rendition::Ready(_)));
    }

    #[test]
    fn a_reply_without_the_file_is_retried() {
        let tmp = TempDir::new().unwrap();
        let content = content_in(&tmp, "book.xlsx");
        let outcome = ensure_rendition(&content, |_, output| Ok(output.to_string()));
        assert!(matches!(
            outcome,
            Rendition::Retry(RunnerError::Protocol(_))
        ));
        assert!(!content.parent().unwrap().join(MARKDOWN_DIR).exists());
    }

    #[test]
    fn other_files_are_not_converted() {
        let tmp = TempDir::new().unwrap();
        let content = content_in(&tmp, "notes.txt");
        let outcome = ensure_rendition(&content, |_, _| panic!("converted a text file"));
        assert_eq!(outcome, Rendition::NotConvertible);
    }

    /// Converts by writing a fixed Markdown file; counts calls.
    struct ConvertingRunner {
        calls: Mutex<Vec<String>>,
        fail: Option<RunnerError>,
    }

    impl RunnerApi for ConvertingRunner {
        fn start_session(
            &self,
            _params: StartSessionParams,
            _timeout: Duration,
        ) -> Result<(Receiver<RunnerEvent>, Option<String>), RunnerError> {
            unreachable!()
        }
        fn send(&self, _: &str, _: &str, _: &[String]) -> Result<(), RunnerError> {
            unreachable!()
        }
        fn cancel(&self, _: &str) -> Result<(), RunnerError> {
            unreachable!()
        }
        fn respond_permission(&self, _: &str, _: &str, _: bool) -> Result<(), RunnerError> {
            unreachable!()
        }
        fn close_session(&self, _: &str) -> Result<(), RunnerError> {
            unreachable!()
        }
        fn probe(&self, _: Provider, _: Duration) -> Result<serde_json::Value, RunnerError> {
            unreachable!()
        }
        fn convert_document(
            &self,
            input: &str,
            output: &str,
            _timeout: Duration,
        ) -> Result<String, RunnerError> {
            self.calls.lock().unwrap().push(input.to_string());
            if let Some(err) = &self.fail {
                return Err(err.clone());
            }
            write_markdown(output, "converted")
        }
        fn shutdown(&self) {}
    }

    #[test]
    fn root_renditions_cover_convertible_committed_attachments() {
        let tmp = TempDir::new().unwrap();
        let paths = MdiumPaths::new(tmp.path());
        let intake = "0123456789abcdef";
        let root = "fedcba9876543210";
        add_draft_from_bytes(&paths, intake, "spec.docx", b"docx bytes").unwrap();
        add_draft_from_bytes(&paths, intake, "screen.png", b"png").unwrap();
        add_draft_from_bytes(&paths, intake, "data.xlsx", b"xlsx bytes").unwrap();
        let prepared = prepare_commit(&paths, intake, root).unwrap();
        let committed = apply_commit(&paths, prepared).unwrap();

        let unavailable = ConvertingRunner {
            calls: Mutex::new(Vec::new()),
            fail: Some(RunnerError::Exited),
        };
        prepare_root_renditions(tmp.path(), root, &unavailable);
        // Stops after the first runner failure, leaving everything to retry.
        assert_eq!(unavailable.calls.lock().unwrap().len(), 1);

        let runner = ConvertingRunner {
            calls: Mutex::new(Vec::new()),
            fail: None,
        };
        prepare_root_renditions(tmp.path(), root, &runner);
        let calls = runner.calls.lock().unwrap().clone();
        assert_eq!(calls.len(), 2);
        assert!(calls.iter().any(|c| c.ends_with("spec.docx")));
        assert!(calls.iter().any(|c| c.ends_with("data.xlsx")));
        for meta in &committed {
            let dir = paths.attachment_dir(root, &meta.id).unwrap();
            let rendition = existing_rendition(&dir, &meta.stored_name);
            assert_eq!(rendition.is_some(), meta.stored_name != "screen.png");
        }

        // Nothing left to convert.
        prepare_root_renditions(tmp.path(), root, &runner);
        assert_eq!(runner.calls.lock().unwrap().len(), 2);
    }
}
