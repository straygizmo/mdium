//! Task attachments: files a user attaches to an intake session (drafts)
//! and the immutable copies committed under a root task.
//!
//! Layout (see `MdiumPaths`):
//! - drafts: `.mdium/task-attachments/_drafts/<intakeId>/<draftId>/{meta.json, <name>}`
//! - committed: `.mdium/task-attachments/<rootTaskId>/<attachmentId>/{meta.json, <name>}`
//!
//! Safety rules:
//! - every path is built from validated 16-hex ids;
//! - stored file names go through [`sanitize_file_name`] (basename only,
//!   no reserved Windows names, no control characters, bounded length), and
//!   a `meta.json` read back from disk is rejected unless its stored name is
//!   already in sanitized form;
//! - sources must be regular files of at most [`MAX_ATTACHMENT_BYTES`];
//!   symlinks and junctions are rejected, never followed (see
//!   [`open_regular_no_follow`] for how Windows reparse points are told
//!   apart);
//! - every directory from `.mdium/` down to an entry must be a real
//!   directory (not a symlink or junction); missing ones are created one
//!   component at a time and re-checked, and the result must also stay
//!   under the attachments root after canonicalization;
//! - `meta.json` is written last, so a directory without it is an
//!   incomplete entry that listings ignore;
//! - a committed attachment is never rewritten: committing a draft whose id
//!   is already committed with the same sha256 keeps the existing copy.
//!
//! Concurrency: these functions do no locking of their own. Callers must
//! serialize draft adds/removals and commits for a project under the
//! `ProjectGuard` (the per-draft/per-task count limits and commit
//! idempotence rely on it); reads need no lock.

use crate::workflow::fsutil::{self, InvalidId, MdiumPaths};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};

/// Maximum size of one attachment (20 MiB).
pub const MAX_ATTACHMENT_BYTES: u64 = 20 * 1024 * 1024;
/// Maximum number of attachments per root task (and of drafts per intake).
pub const MAX_ATTACHMENTS_PER_TASK: usize = 20;
/// Maximum length of a stored file name, in characters.
const MAX_NAME_CHARS: usize = 120;
/// Name of the metadata file inside every attachment and draft directory.
const META_FILE: &str = "meta.json";
/// Name used when sanitizing leaves nothing.
const FALLBACK_NAME: &str = "attachment";

/// Metadata stored as `meta.json` next to an attachment's content.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentMeta {
    pub schema_version: u32,
    pub id: String,
    pub original_name: String,
    pub stored_name: String,
    pub mime: String,
    pub size: u64,
    pub sha256: String,
    pub created_at: String,
}

/// Attachment failures; `code()` gives the stable `ATTACHMENT_*` code.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AttachmentError {
    /// An id used to build a path is not 16 lowercase hex characters.
    InvalidId,
    /// The source is not a regular file (directory, symlink, junction, ...).
    NotAFile,
    /// The content exceeds [`MAX_ATTACHMENT_BYTES`].
    TooLarge,
    /// The per-task (or per-intake) count limit would be exceeded.
    TooMany,
    /// A resolved path is not under the attachments root, or a directory
    /// on the way to it is a symlink or junction.
    OutsideRoot,
    /// The requested attachment does not exist.
    NotFound,
    Io(String),
    /// Stored metadata or content is malformed or inconsistent.
    Corrupt(String),
}

impl AttachmentError {
    pub fn code(&self) -> &'static str {
        match self {
            AttachmentError::InvalidId => "ATTACHMENT_INVALID_ID",
            AttachmentError::NotAFile => "ATTACHMENT_NOT_A_FILE",
            AttachmentError::TooLarge => "ATTACHMENT_TOO_LARGE",
            AttachmentError::TooMany => "ATTACHMENT_TOO_MANY",
            AttachmentError::OutsideRoot => "ATTACHMENT_OUTSIDE_ROOT",
            AttachmentError::NotFound => "ATTACHMENT_NOT_FOUND",
            AttachmentError::Io(_) => "ATTACHMENT_IO",
            AttachmentError::Corrupt(_) => "ATTACHMENT_CORRUPT",
        }
    }
}

impl std::fmt::Display for AttachmentError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AttachmentError::Io(detail) | AttachmentError::Corrupt(detail) => {
                write!(f, "{}: {detail}", self.code())
            }
            _ => f.write_str(self.code()),
        }
    }
}

crate::workflow::errors::impl_workflow_error!(AttachmentError);

impl From<InvalidId> for AttachmentError {
    fn from(_: InvalidId) -> Self {
        AttachmentError::InvalidId
    }
}

/// Turns a user- or agent-supplied file name into a safe stored name:
/// only the last path component (either separator) is kept, control
/// and bidirectional formatting characters are removed (they can disguise
/// an extension, e.g. `evil\u{202e}gnp.exe`), characters invalid on
/// Windows become `_`,
/// leading whitespace and trailing dots/whitespace are trimmed, the result
/// is at most [`MAX_NAME_CHARS`] characters (keeping a short extension),
/// and reserved Windows device names (`CON`, `LPT1.txt`, ...) as well as
/// the metadata file name get a `_` prefix. An empty result becomes
/// `attachment`.
pub fn sanitize_file_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("");
    let cleaned: String = base
        .chars()
        .filter(|c| !c.is_control() && !is_bidi_control(*c))
        .map(|c| {
            if matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*') {
                '_'
            } else {
                c
            }
        })
        .collect();
    let mut out = trim_name(&truncate_keeping_extension(
        trim_name(&cleaned),
        MAX_NAME_CHARS,
    ))
    .to_string();
    if out.is_empty() {
        out = FALLBACK_NAME.to_string();
    }
    if is_reserved_name(&out) {
        out.insert(0, '_');
        if out.chars().count() > MAX_NAME_CHARS {
            out = trim_name(&truncate_keeping_extension(&out, MAX_NAME_CHARS)).to_string();
        }
    }
    out
}

/// Trims leading whitespace and trailing whitespace and dots (Windows
/// silently drops trailing dots and spaces, so `a.txt.` would alias
/// `a.txt`).
fn trim_name(name: &str) -> &str {
    name.trim_start()
        .trim_end_matches(|c: char| c.is_whitespace() || c == '.')
}

/// Cuts `name` to at most `max` characters, keeping a short extension
/// (up to 16 characters including the dot) when there is one.
fn truncate_keeping_extension(name: &str, max: usize) -> String {
    if name.chars().count() <= max {
        return name.to_string();
    }
    if let Some(dot) = name.rfind('.') {
        let ext = &name[dot..];
        let ext_len = ext.chars().count();
        if dot > 0 && ext_len <= 16 {
            let stem: String = name[..dot].chars().take(max - ext_len).collect();
            let stem = trim_name(&stem);
            if !stem.is_empty() {
                return format!("{stem}{ext}");
            }
        }
    }
    name.chars().take(max).collect()
}

/// Unicode bidirectional formatting characters: LRM/RLM, the embeddings
/// and overrides (U+202A..U+202E) and the isolates (U+2066..U+2069).
fn is_bidi_control(c: char) -> bool {
    matches!(c, '\u{200e}' | '\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
}

/// True for names Windows treats as devices whatever the extension
/// (`CON`, `con.txt`, `COM1.log`, `CON .txt`), and for the metadata file
/// name, which is reserved inside an attachment directory.
fn is_reserved_name(name: &str) -> bool {
    if name.eq_ignore_ascii_case(META_FILE) {
        return true;
    }
    let stem = name
        .split('.')
        .next()
        .unwrap_or("")
        .trim_end()
        .to_uppercase();
    if matches!(
        stem.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
    ) {
        return true;
    }
    let mut chars = stem.chars();
    let prefix: String = chars.by_ref().take(3).collect();
    let rest: Vec<char> = chars.collect();
    (prefix == "COM" || prefix == "LPT")
        && rest.len() == 1
        && matches!(rest[0], '0'..='9' | '\u{b9}' | '\u{b2}' | '\u{b3}')
}

/// MIME type from the file extension (case-insensitive); unknown
/// extensions are `application/octet-stream`.
pub fn mime_for(name: &str) -> &'static str {
    let ext = name
        .rsplit_once('.')
        .map(|(_, ext)| ext.to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "pdf" => "application/pdf",
        "txt" | "log" => "text/plain",
        "md" => "text/markdown",
        "json" => "application/json",
        "csv" => "text/csv",
        "zip" => "application/zip",
        _ => "application/octet-stream",
    }
}

/// Adds a draft attachment to intake `intake_id` by copying `source`, which
/// must be a regular file (not a symlink, junction or directory) of at most
/// [`MAX_ATTACHMENT_BYTES`]. The source may live anywhere (e.g. a file the
/// user picked); only its content and file name are used.
pub fn add_draft_from_path(
    paths: &MdiumPaths,
    intake_id: &str,
    source: &Path,
) -> Result<AttachmentMeta, AttachmentError> {
    paths.drafts_dir(intake_id)?;
    let (name, bytes) = read_source(source)?;
    store_draft(paths, intake_id, &name, &bytes)
}

/// Reads a source file for [`add_draft_from_bytes`] under the same rules as
/// [`add_draft_from_path`] (a regular file, never a link, of at most
/// [`MAX_ATTACHMENT_BYTES`]); returns its file name and content. Needs no
/// lock, so a slow source can be read before the project is locked.
pub fn read_source(source: &Path) -> Result<(String, Vec<u8>), AttachmentError> {
    let mut file = open_regular_no_follow(source)?;
    let bytes = read_limited(&mut file, source)?;
    let name = source
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    Ok((name, bytes))
}

/// Adds a draft attachment to intake `intake_id` from in-memory content
/// (e.g. a pasted image) named `name`.
pub fn add_draft_from_bytes(
    paths: &MdiumPaths,
    intake_id: &str,
    name: &str,
    bytes: &[u8],
) -> Result<AttachmentMeta, AttachmentError> {
    store_draft(paths, intake_id, name, bytes)
}

/// The complete drafts of intake `intake_id`, oldest first.
pub fn list_drafts(
    paths: &MdiumPaths,
    intake_id: &str,
) -> Result<Vec<AttachmentMeta>, AttachmentError> {
    list_entries(paths, &paths.drafts_dir(intake_id)?)
}

/// Deletes one draft; removing a draft that does not exist is a no-op.
pub fn remove_draft(
    paths: &MdiumPaths,
    intake_id: &str,
    draft_id: &str,
) -> Result<(), AttachmentError> {
    let dir = paths.draft_dir(intake_id, draft_id)?;
    remove_tree(paths, &dir)
}

/// Commits every draft of intake `intake_id` to root task `root_task_id`
/// and then removes the intake's draft directory. Each draft keeps its id
/// as the attachment id. Content is copied and verified against the draft's
/// sha256. A draft whose id is already committed with the same sha256 is
/// kept as is (the committed copy is never rewritten), so re-running after
/// a crash is safe; the same id with different content is `Corrupt`. The
/// task may hold at most [`MAX_ATTACHMENTS_PER_TASK`] attachments.
///
/// Returns all attachments of the task, so a retry after the drafts were
/// already removed still reports what was committed.
pub fn commit_drafts(
    paths: &MdiumPaths,
    intake_id: &str,
    root_task_id: &str,
) -> Result<Vec<AttachmentMeta>, AttachmentError> {
    let prepared = prepare_commit(paths, intake_id, root_task_id)?;
    apply_commit(paths, prepared)
}

/// The first half of [`commit_drafts`], which only reads and so needs no
/// lock: the drafts to commit, with their content read and verified
/// against their sha256 (so the slow part of a commit runs outside the
/// project lock). Conflicts and the count limit are checked here and again
/// by [`apply_commit`].
#[derive(Debug)]
pub struct PreparedCommit {
    intake_id: String,
    root_task_id: String,
    /// Every draft of the intake when prepared.
    drafts: Vec<AttachmentMeta>,
    /// The drafts not yet committed, with their verified content.
    pending: Vec<(AttachmentMeta, Vec<u8>)>,
}

/// Reads and verifies what [`commit_drafts`] would commit; see
/// [`PreparedCommit`].
pub fn prepare_commit(
    paths: &MdiumPaths,
    intake_id: &str,
    root_task_id: &str,
) -> Result<PreparedCommit, AttachmentError> {
    paths.task_attachments_dir(root_task_id)?;
    paths.drafts_dir(intake_id)?;
    let drafts = list_drafts(paths, intake_id)?;
    let existing = list_attachments(paths, root_task_id)?;
    let mut pending = Vec::new();
    for draft in uncommitted(&drafts, &existing)? {
        let bytes = read_content(&paths.draft_dir(intake_id, &draft.id)?, draft)?;
        pending.push((draft.clone(), bytes));
    }
    Ok(PreparedCommit {
        intake_id: intake_id.to_string(),
        root_task_id: root_task_id.to_string(),
        drafts,
        pending,
    })
}

/// The second half of [`commit_drafts`], to be called under the project
/// lock: the drafts must still be exactly the prepared ones (else
/// `Corrupt`, nothing written); the conflict and count checks are
/// repeated, the prepared content is written, and the intake's draft
/// directory is removed. Returns all attachments of the task.
pub fn apply_commit(
    paths: &MdiumPaths,
    prepared: PreparedCommit,
) -> Result<Vec<AttachmentMeta>, AttachmentError> {
    let PreparedCommit {
        intake_id,
        root_task_id,
        drafts,
        pending,
    } = prepared;
    let drafts_dir = paths.drafts_dir(&intake_id)?;
    if list_drafts(paths, &intake_id)? != drafts {
        return Err(AttachmentError::Corrupt(format!(
            "the drafts of intake {intake_id} changed while they were committed"
        )));
    }
    let existing = list_attachments(paths, &root_task_id)?;
    let still: Vec<&str> = uncommitted(&drafts, &existing)?
        .into_iter()
        .map(|draft| draft.id.as_str())
        .collect();
    for (draft, bytes) in &pending {
        if !still.contains(&draft.id.as_str()) {
            continue;
        }
        let dest = paths.attachment_dir(&root_task_id, &draft.id)?;
        write_entry(paths, &dest, draft, bytes)?;
    }
    remove_tree(paths, &drafts_dir)?;
    list_attachments(paths, &root_task_id)
}

/// The drafts not committed yet. A draft whose id is committed with the
/// same sha256 counts as committed; with another sha256 it is `Corrupt`.
/// More than [`MAX_ATTACHMENTS_PER_TASK`] in total is `TooMany`.
fn uncommitted<'a>(
    drafts: &'a [AttachmentMeta],
    existing: &[AttachmentMeta],
) -> Result<Vec<&'a AttachmentMeta>, AttachmentError> {
    let mut pending = Vec::new();
    for draft in drafts {
        match existing.iter().find(|committed| committed.id == draft.id) {
            Some(committed) if committed.sha256 == draft.sha256 => {}
            Some(_) => {
                return Err(AttachmentError::Corrupt(format!(
                    "attachment {} is already committed with different content",
                    draft.id
                )))
            }
            None => pending.push(draft),
        }
    }
    if existing.len() + pending.len() > MAX_ATTACHMENTS_PER_TASK {
        return Err(AttachmentError::TooMany);
    }
    Ok(pending)
}

/// Deletes every committed attachment of root task `root_task_id` (its
/// whole directory; a missing one is a no-op, a link is removed itself,
/// never followed). Callers hold the project lock.
pub fn remove_task_attachments(
    paths: &MdiumPaths,
    root_task_id: &str,
) -> Result<(), AttachmentError> {
    let dir = paths.task_attachments_dir(root_task_id)?;
    remove_tree(paths, &dir)
}

/// The committed attachments of root task `root_task_id`, oldest first.
pub fn list_attachments(
    paths: &MdiumPaths,
    root_task_id: &str,
) -> Result<Vec<AttachmentMeta>, AttachmentError> {
    list_entries(paths, &paths.task_attachments_dir(root_task_id)?)
}

/// The absolute, canonical path of a committed attachment's content,
/// verified to be a regular file under the attachments root whose size and
/// sha256 match its metadata. A missing attachment is `NotFound`.
pub fn attachment_file(
    paths: &MdiumPaths,
    root_task_id: &str,
    attachment_id: &str,
) -> Result<PathBuf, AttachmentError> {
    let dir = paths.attachment_dir(root_task_id, attachment_id)?;
    verified_entry_file(paths, &dir, attachment_id)
}

/// The absolute, canonical path of a draft's content of intake
/// `intake_id`, verified like [`attachment_file`]. A missing draft is
/// `NotFound`.
pub fn draft_file(
    paths: &MdiumPaths,
    intake_id: &str,
    draft_id: &str,
) -> Result<PathBuf, AttachmentError> {
    let dir = paths.draft_dir(intake_id, draft_id)?;
    verified_entry_file(paths, &dir, draft_id)
}

/// The content file of the entry `id` in `dir`: every directory on the way
/// is real, the metadata is valid, the content matches it, and the file
/// resolves under the attachments root.
fn verified_entry_file(
    paths: &MdiumPaths,
    dir: &Path,
    id: &str,
) -> Result<PathBuf, AttachmentError> {
    if !walk_real_dirs(paths, dir, false)? {
        return Err(AttachmentError::NotFound);
    }
    let meta = read_meta(dir, id)?.ok_or(AttachmentError::NotFound)?;
    read_content(dir, &meta)?;
    let canonical = ensure_under_root(paths, &dir.join(&meta.stored_name))?;
    Ok(simplify_verbatim(canonical))
}

/// Validates and stores one draft: size and count limits, sanitized name,
/// content hash.
fn store_draft(
    paths: &MdiumPaths,
    intake_id: &str,
    name: &str,
    bytes: &[u8],
) -> Result<AttachmentMeta, AttachmentError> {
    paths.drafts_dir(intake_id)?;
    if bytes.len() as u64 > MAX_ATTACHMENT_BYTES {
        return Err(AttachmentError::TooLarge);
    }
    if list_drafts(paths, intake_id)?.len() >= MAX_ATTACHMENTS_PER_TASK {
        return Err(AttachmentError::TooMany);
    }
    let id = fsutil::new_id();
    let stored_name = sanitize_file_name(name);
    let meta = AttachmentMeta {
        schema_version: 1,
        mime: mime_for(&stored_name).to_string(),
        id: id.clone(),
        original_name: name.to_string(),
        stored_name,
        size: bytes.len() as u64,
        sha256: sha256_hex(bytes),
        created_at: fsutil::now(),
    };
    write_entry(paths, &paths.draft_dir(intake_id, &id)?, &meta, bytes)?;
    Ok(meta)
}

/// Writes an entry directory: the content first, then `meta.json`, so an
/// interrupted write leaves an entry that listings ignore.
fn write_entry(
    paths: &MdiumPaths,
    dir: &Path,
    meta: &AttachmentMeta,
    bytes: &[u8],
) -> Result<(), AttachmentError> {
    walk_real_dirs(paths, dir, true)?;
    ensure_under_root(paths, dir)?;
    let content = dir.join(&meta.stored_name);
    fsutil::atomic_write(&content, bytes).map_err(io_error(&content))?;
    let json =
        serde_json::to_vec_pretty(meta).map_err(|err| AttachmentError::Corrupt(err.to_string()))?;
    let meta_path = dir.join(META_FILE);
    fsutil::atomic_write(&meta_path, &json).map_err(io_error(&meta_path))
}

/// Complete entries (valid id directory with a valid `meta.json`) directly
/// under `dir`, sorted by creation time then id. A missing `dir` is empty.
fn list_entries(paths: &MdiumPaths, dir: &Path) -> Result<Vec<AttachmentMeta>, AttachmentError> {
    if !walk_real_dirs(paths, dir, false)? {
        return Ok(Vec::new());
    }
    ensure_under_root(paths, dir)?;
    let mut metas = Vec::new();
    for entry in std::fs::read_dir(dir).map_err(io_error(dir))? {
        let entry = entry.map_err(io_error(dir))?;
        let name = entry.file_name();
        let Some(id) = name.to_str().filter(|id| fsutil::is_valid_id(id)) else {
            continue;
        };
        // `DirEntry::file_type` does not follow links, so linked
        // directories are skipped.
        if !entry.file_type().map_err(io_error(&entry.path()))?.is_dir() {
            continue;
        }
        if let Some(meta) = read_meta(&entry.path(), id)? {
            metas.push(meta);
        }
    }
    metas.sort_by(|a, b| (&a.created_at, &a.id).cmp(&(&b.created_at, &b.id)));
    Ok(metas)
}

/// Reads and validates `<dir>/meta.json`; `None` if it does not exist.
/// A stored name that is not already in sanitized form (e.g. `../x`,
/// `CON`, `meta.json`) is `Corrupt`, so a tampered file can never make a
/// path escape its entry directory.
fn read_meta(dir: &Path, expected_id: &str) -> Result<Option<AttachmentMeta>, AttachmentError> {
    let path = dir.join(META_FILE);
    match std::fs::symlink_metadata(&path) {
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(io_error(&path)(err)),
        Ok(_) => {}
    }
    let corrupt = |detail: &str| AttachmentError::Corrupt(format!("{}: {detail}", path.display()));
    let mut file = open_regular_no_follow(&path).map_err(|err| match err {
        AttachmentError::NotAFile => corrupt("not a regular file"),
        other => other,
    })?;
    let bytes = read_limited(&mut file, &path).map_err(|err| match err {
        AttachmentError::TooLarge => corrupt("too large"),
        other => other,
    })?;
    let meta: AttachmentMeta =
        serde_json::from_slice(&bytes).map_err(|err| corrupt(&err.to_string()))?;
    let valid = meta.schema_version == 1
        && meta.id == expected_id
        && meta.stored_name == sanitize_file_name(&meta.stored_name)
        && meta.size <= MAX_ATTACHMENT_BYTES
        && meta.sha256.len() == 64
        && meta
            .sha256
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'));
    if !valid {
        return Err(corrupt("invalid metadata"));
    }
    Ok(Some(meta))
}

/// Reads an entry's content and verifies it against its metadata.
fn read_content(dir: &Path, meta: &AttachmentMeta) -> Result<Vec<u8>, AttachmentError> {
    let path = dir.join(&meta.stored_name);
    let corrupt = |detail: &str| AttachmentError::Corrupt(format!("{}: {detail}", path.display()));
    let mut file = open_regular_no_follow(&path).map_err(|err| match err {
        AttachmentError::NotAFile => corrupt("not a regular file"),
        other => other,
    })?;
    let bytes = read_limited(&mut file, &path).map_err(|err| match err {
        AttachmentError::TooLarge => corrupt("too large"),
        other => other,
    })?;
    if bytes.len() as u64 != meta.size || sha256_hex(&bytes) != meta.sha256 {
        return Err(corrupt("content does not match its metadata"));
    }
    Ok(bytes)
}

/// Opens `path` for reading if it is a regular file, never following a
/// final symlink or junction; a path swapped after the `symlink_metadata`
/// pre-check fails closed.
///
/// Unix: `O_NOFOLLOW` (plus `O_NONBLOCK` so a FIFO cannot block), then the
/// opened handle must be a regular file.
///
/// Windows: only *name-surrogate* reparse points (symlinks, junctions:
/// reparse tag bit `0x2000_0000`) are links. Other reparse points such as
/// OneDrive/cloud placeholders or deduplicated files are ordinary files and
/// must be read through a normal open so their filter driver supplies the
/// content. std's `FileType` reports `is_symlink()` exactly for
/// name-surrogate tags, reading the tag from the handle
/// (`GetFileInformationByHandleEx(FileAttributeTagInfo)`), so:
/// 1. the entry itself is opened with `FILE_FLAG_OPEN_REPARSE_POINT` and a
///    share mode without `FILE_SHARE_DELETE` (it cannot be renamed, deleted
///    or replaced while held), and must be a regular file (no
///    name-surrogate tag);
/// 2. the path is opened again normally for reading (hydrating cloud
///    files); that handle must be a regular file too;
/// 3. both handles must agree on creation time, last write time and size,
///    which catches a parent directory re-pointed between the two opens.
fn open_regular_no_follow(path: &Path) -> Result<File, AttachmentError> {
    let pre = std::fs::symlink_metadata(path).map_err(io_error(path))?;
    if !pre.file_type().is_file() {
        return Err(AttachmentError::NotAFile);
    }
    open_regular_platform(path)
}

#[cfg(unix)]
fn open_regular_platform(path: &Path) -> Result<File, AttachmentError> {
    use std::os::unix::fs::OpenOptionsExt;
    let file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(crate::workflow::checks::open_flags::FLAGS)
        .open(path)
        .map_err(io_error(path))?;
    if !file.metadata().map_err(io_error(path))?.is_file() {
        return Err(AttachmentError::NotAFile);
    }
    Ok(file)
}

#[cfg(windows)]
fn open_regular_platform(path: &Path) -> Result<File, AttachmentError> {
    use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
    /// Open a reparse point itself instead of its target.
    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    /// `FILE_SHARE_READ | FILE_SHARE_WRITE`: no `FILE_SHARE_DELETE`.
    const SHARE_READ_WRITE: u32 = 0x1 | 0x2;

    let pin = std::fs::OpenOptions::new()
        .read(true)
        .share_mode(SHARE_READ_WRITE)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
        .map_err(io_error(path))?;
    let pinned = pin.metadata().map_err(io_error(path))?;
    if !pinned.file_type().is_file() {
        return Err(AttachmentError::NotAFile);
    }
    let file = std::fs::OpenOptions::new()
        .read(true)
        .open(path)
        .map_err(io_error(path))?;
    let opened = file.metadata().map_err(io_error(path))?;
    if !opened.file_type().is_file() {
        return Err(AttachmentError::NotAFile);
    }
    let same = pinned.creation_time() == opened.creation_time()
        && pinned.last_write_time() == opened.last_write_time()
        && pinned.file_size() == opened.file_size();
    if !same {
        return Err(AttachmentError::NotAFile);
    }
    Ok(file)
}

/// Reads at most [`MAX_ATTACHMENT_BYTES`] from `file`; more is `TooLarge`
/// (also when the file grows while it is read).
fn read_limited(file: &mut File, path: &Path) -> Result<Vec<u8>, AttachmentError> {
    let len = file.metadata().map_err(io_error(path))?.len();
    if len > MAX_ATTACHMENT_BYTES {
        return Err(AttachmentError::TooLarge);
    }
    let mut bytes = Vec::with_capacity(len as usize);
    file.take(MAX_ATTACHMENT_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(io_error(path))?;
    if bytes.len() as u64 > MAX_ATTACHMENT_BYTES {
        return Err(AttachmentError::TooLarge);
    }
    Ok(bytes)
}

/// Removes `dir` (an entry or an intake's draft directory) if it exists,
/// after checking its parent resolves under the attachments root. A link at
/// `dir` is removed itself, never followed.
fn remove_tree(paths: &MdiumPaths, dir: &Path) -> Result<(), AttachmentError> {
    match std::fs::symlink_metadata(dir) {
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(err) => return Err(io_error(dir)(err)),
        Ok(_) => {}
    }
    let parent = dir.parent().ok_or(AttachmentError::OutsideRoot)?;
    if !walk_real_dirs(paths, parent, false)? {
        return Ok(());
    }
    ensure_under_root(paths, parent)?;
    std::fs::remove_dir_all(dir).map_err(io_error(dir))
}

/// Walks from `.mdium/` down to `dir` one component at a time; every
/// existing component must be a real directory (a symlink or junction is
/// `OutsideRoot`). With `create`, a missing component is created with
/// `create_dir` and re-checked; without it, a missing component returns
/// `Ok(false)`. `dir` must lie under `.mdium/` lexically.
fn walk_real_dirs(paths: &MdiumPaths, dir: &Path, create: bool) -> Result<bool, AttachmentError> {
    let rel = dir
        .strip_prefix(paths.root())
        .map_err(|_| AttachmentError::OutsideRoot)?;
    let mut current = paths.root().to_path_buf();
    let mut components = rel.components();
    loop {
        match std::fs::symlink_metadata(&current) {
            Ok(meta) => {
                if !meta.file_type().is_dir() {
                    return Err(AttachmentError::OutsideRoot);
                }
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                if !create {
                    return Ok(false);
                }
                match std::fs::create_dir(&current) {
                    Ok(()) => {}
                    Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => {}
                    Err(err) => return Err(io_error(&current)(err)),
                }
                let meta = std::fs::symlink_metadata(&current).map_err(io_error(&current))?;
                if !meta.file_type().is_dir() {
                    return Err(AttachmentError::OutsideRoot);
                }
            }
            Err(err) => return Err(io_error(&current)(err)),
        }
        match components.next() {
            None => return Ok(true),
            Some(std::path::Component::Normal(name)) => current.push(name),
            Some(_) => return Err(AttachmentError::OutsideRoot),
        }
    }
}

/// Canonicalizes `path` and verifies it lies under the canonical
/// attachments root; returns the canonical path.
fn ensure_under_root(paths: &MdiumPaths, path: &Path) -> Result<PathBuf, AttachmentError> {
    let root = paths.attachments_root();
    let root = std::fs::canonicalize(&root).map_err(io_error(&root))?;
    let canonical = std::fs::canonicalize(path).map_err(io_error(path))?;
    if canonical.starts_with(&root) {
        Ok(canonical)
    } else {
        Err(AttachmentError::OutsideRoot)
    }
}

/// On Windows, `canonicalize` returns verbatim paths (`\\?\C:\...`); turn
/// them back into ordinary absolute paths for callers that show them to
/// agents or users. Other platforms are unchanged.
fn simplify_verbatim(path: PathBuf) -> PathBuf {
    #[cfg(windows)]
    {
        if let Some(text) = path.to_str() {
            if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
                return PathBuf::from(format!(r"\\{rest}"));
            }
            if let Some(rest) = text.strip_prefix(r"\\?\") {
                if rest.as_bytes().get(1) == Some(&b':') {
                    return PathBuf::from(rest);
                }
            }
        }
    }
    path
}

pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn io_error(path: &Path) -> impl Fn(std::io::Error) -> AttachmentError + '_ {
    move |err| AttachmentError::Io(format!("{}: {err}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    const INTAKE: &str = "1111111111111111";
    const ROOT: &str = "2222222222222222";

    fn setup() -> (tempfile::TempDir, MdiumPaths) {
        let dir = tempfile::tempdir().unwrap();
        // The project root always exists; `.mdium/` below it may not.
        std::fs::create_dir(dir.path().join("project")).unwrap();
        let paths = MdiumPaths::new(dir.path().join("project"));
        (dir, paths)
    }

    /// Makes `link` a directory symlink (on Windows, a junction) to
    /// `target`.
    fn link_dir(target: &Path, link: &Path) {
        #[cfg(unix)]
        std::os::unix::fs::symlink(target, link).unwrap();
        #[cfg(windows)]
        junction::create(target, link).unwrap();
    }

    /// Recursively collects (relative path, content) of every file under
    /// `dir`, sorted, to prove a tree did not change.
    fn snapshot(dir: &Path) -> Vec<(PathBuf, Vec<u8>)> {
        fn walk(base: &Path, dir: &Path, out: &mut Vec<(PathBuf, Vec<u8>)>) {
            for entry in std::fs::read_dir(dir).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    walk(base, &path, out);
                } else {
                    let rel = path.strip_prefix(base).unwrap().to_path_buf();
                    out.push((rel, std::fs::read(&path).unwrap()));
                }
            }
        }
        let mut out = Vec::new();
        walk(dir, dir, &mut out);
        out.sort();
        out
    }

    fn copy_tree(from: &Path, to: &Path) {
        std::fs::create_dir_all(to).unwrap();
        for entry in std::fs::read_dir(from).unwrap() {
            let path = entry.unwrap().path();
            let dest = to.join(path.file_name().unwrap());
            if path.is_dir() {
                copy_tree(&path, &dest);
            } else {
                std::fs::copy(&path, &dest).unwrap();
            }
        }
    }

    #[test]
    fn sanitize_strips_directories_and_traversal() {
        assert_eq!(sanitize_file_name("..\\..\\evil.exe"), "evil.exe");
        assert_eq!(sanitize_file_name("../../evil.exe"), "evil.exe");
        assert_eq!(sanitize_file_name("C:\\Windows\\system32\\x.dll"), "x.dll");
        assert_eq!(sanitize_file_name("/etc/passwd"), "passwd");
        assert_eq!(sanitize_file_name(".."), "attachment");
        assert_eq!(sanitize_file_name("dir/.."), "attachment");
        assert_eq!(sanitize_file_name("a:b.txt"), "a_b.txt");
        assert_eq!(sanitize_file_name("x<>\"|?*.txt"), "x______.txt");
    }

    #[test]
    fn sanitize_prefixes_reserved_windows_names() {
        assert_eq!(sanitize_file_name("CON"), "_CON");
        assert_eq!(sanitize_file_name("con.txt"), "_con.txt");
        assert_eq!(sanitize_file_name("Lpt1.log"), "_Lpt1.log");
        assert_eq!(sanitize_file_name("COM9"), "_COM9");
        assert_eq!(sanitize_file_name("nul.tar.gz"), "_nul.tar.gz");
        assert_eq!(sanitize_file_name("CON .txt"), "_CON .txt");
        assert_eq!(sanitize_file_name("console.txt"), "console.txt");
        assert_eq!(sanitize_file_name("COM10"), "COM10");
        assert_eq!(sanitize_file_name("COM0"), "_COM0");
        assert_eq!(sanitize_file_name("lpt0.txt"), "_lpt0.txt");
        assert_eq!(sanitize_file_name("COM\u{b9}"), "_COM\u{b9}");
        assert_eq!(sanitize_file_name("LPT\u{b3}.log"), "_LPT\u{b3}.log");
        // The metadata file name is reserved inside an attachment directory.
        assert_eq!(sanitize_file_name("meta.json"), "_meta.json");
        assert_eq!(sanitize_file_name("META.JSON"), "_META.JSON");
    }

    #[test]
    fn sanitize_removes_control_chars_and_trailing_dots_and_spaces() {
        assert_eq!(sanitize_file_name("a\u{0}b\nc\u{7f}.txt"), "abc.txt");
        assert_eq!(sanitize_file_name("  report.pdf. . "), "report.pdf");
        assert_eq!(sanitize_file_name("\u{1}\u{2}"), "attachment");
    }

    #[test]
    fn sanitize_removes_bidi_controls() {
        assert_eq!(sanitize_file_name("evil\u{202e}gnp.exe"), "evilgnp.exe");
        assert_eq!(
            sanitize_file_name("\u{200e}a\u{2066}b\u{2069}\u{200f}\u{202a}.txt"),
            "ab.txt"
        );
    }

    #[test]
    fn sanitize_limits_length_and_keeps_extension() {
        let long = format!("{}.png", "x".repeat(300));
        let out = sanitize_file_name(&long);
        assert_eq!(out.chars().count(), MAX_NAME_CHARS);
        assert!(out.ends_with(".png"), "{out}");

        let unicode = "\u{3042}".repeat(200);
        assert_eq!(sanitize_file_name(&unicode).chars().count(), MAX_NAME_CHARS);

        // Truncation that exposes a reserved name still gets the prefix and
        // stays within the limit.
        let tricky = format!("CON{}x", " ".repeat(200));
        let out = sanitize_file_name(&tricky);
        assert_eq!(out, "_CON");
    }

    #[test]
    fn sanitize_empty_becomes_fallback() {
        assert_eq!(sanitize_file_name(""), "attachment");
        assert_eq!(sanitize_file_name("   "), "attachment");
        assert_eq!(sanitize_file_name("dir/"), "attachment");
    }

    #[test]
    fn mime_is_derived_from_extension() {
        assert_eq!(mime_for("a.PNG"), "image/png");
        assert_eq!(mime_for("a.jpg"), "image/jpeg");
        assert_eq!(mime_for("a.jpeg"), "image/jpeg");
        assert_eq!(mime_for("a.gif"), "image/gif");
        assert_eq!(mime_for("a.webp"), "image/webp");
        assert_eq!(mime_for("a.pdf"), "application/pdf");
        assert_eq!(mime_for("a.txt"), "text/plain");
        assert_eq!(mime_for("a.md"), "text/markdown");
        assert_eq!(mime_for("a.json"), "application/json");
        assert_eq!(mime_for("a.csv"), "text/csv");
        assert_eq!(mime_for("a.log"), "text/plain");
        assert_eq!(mime_for("a.zip"), "application/zip");
        assert_eq!(mime_for("a.exe"), "application/octet-stream");
        assert_eq!(mime_for("noext"), "application/octet-stream");
    }

    #[test]
    fn draft_from_bytes_records_sha256_mime_and_sanitized_name() {
        let (_dir, paths) = setup();
        let bytes = b"\x89PNG fake image";
        let meta = add_draft_from_bytes(&paths, INTAKE, "..\\..\\shot.png", bytes).unwrap();

        assert_eq!(meta.schema_version, 1);
        assert!(fsutil::is_valid_id(&meta.id));
        assert_eq!(meta.original_name, "..\\..\\shot.png");
        assert_eq!(meta.stored_name, "shot.png");
        assert_eq!(meta.mime, "image/png");
        assert_eq!(meta.size, bytes.len() as u64);
        assert_eq!(meta.sha256, sha256_hex(bytes));

        let dir = paths.draft_dir(INTAKE, &meta.id).unwrap();
        assert_eq!(std::fs::read(dir.join("shot.png")).unwrap(), bytes);
        let on_disk: AttachmentMeta =
            serde_json::from_slice(&std::fs::read(dir.join("meta.json")).unwrap()).unwrap();
        assert_eq!(on_disk, meta);
        let json: serde_json::Value =
            serde_json::from_slice(&std::fs::read(dir.join("meta.json")).unwrap()).unwrap();
        assert_eq!(json["schemaVersion"], 1);
        assert_eq!(json["storedName"], "shot.png");

        assert_eq!(list_drafts(&paths, INTAKE).unwrap(), vec![meta]);
    }

    #[test]
    fn draft_from_path_copies_a_regular_file() {
        let (dir, paths) = setup();
        let source = dir.path().join("notes.md");
        std::fs::write(&source, "# hello").unwrap();

        let meta = add_draft_from_path(&paths, INTAKE, &source).unwrap();

        assert_eq!(meta.original_name, "notes.md");
        assert_eq!(meta.stored_name, "notes.md");
        assert_eq!(meta.mime, "text/markdown");
        assert_eq!(meta.sha256, sha256_hex(b"# hello"));
        let stored = paths.draft_dir(INTAKE, &meta.id).unwrap().join("notes.md");
        assert_eq!(std::fs::read_to_string(stored).unwrap(), "# hello");
        // The source is copied, not moved.
        assert!(source.exists());
    }

    #[test]
    fn draft_from_path_rejects_directories_and_missing_files() {
        let (dir, paths) = setup();
        assert_eq!(
            add_draft_from_path(&paths, INTAKE, dir.path()),
            Err(AttachmentError::NotAFile)
        );
        assert!(matches!(
            add_draft_from_path(&paths, INTAKE, &dir.path().join("missing.txt")),
            Err(AttachmentError::Io(_))
        ));
    }

    #[cfg(unix)]
    #[test]
    fn draft_from_path_rejects_a_symlink_source() {
        let (dir, paths) = setup();
        let real = dir.path().join("real.txt");
        std::fs::write(&real, "secret").unwrap();
        let link = dir.path().join("link.txt");
        std::os::unix::fs::symlink(&real, &link).unwrap();

        assert_eq!(
            add_draft_from_path(&paths, INTAKE, &link),
            Err(AttachmentError::NotAFile)
        );
        assert!(list_drafts(&paths, INTAKE).unwrap().is_empty());
    }

    #[cfg(windows)]
    #[test]
    fn draft_from_path_rejects_a_symlink_or_junction_source() {
        let (dir, paths) = setup();
        let real = dir.path().join("real.txt");
        std::fs::write(&real, "secret").unwrap();

        // A file symlink needs developer mode or elevation; test it when
        // the platform permits it.
        let link = dir.path().join("link.txt");
        if std::os::windows::fs::symlink_file(&real, &link).is_ok() {
            assert_eq!(
                add_draft_from_path(&paths, INTAKE, &link),
                Err(AttachmentError::NotAFile)
            );
        }

        // A junction can always be created by an unprivileged user.
        let target_dir = dir.path().join("target");
        std::fs::create_dir(&target_dir).unwrap();
        let junction_path = dir.path().join("junction");
        junction::create(&target_dir, &junction_path).unwrap();
        assert_eq!(
            add_draft_from_path(&paths, INTAKE, &junction_path),
            Err(AttachmentError::NotAFile)
        );
        assert!(list_drafts(&paths, INTAKE).unwrap().is_empty());
    }

    #[test]
    fn size_limit_is_enforced() {
        let (dir, paths) = setup();
        let at_limit = vec![7u8; MAX_ATTACHMENT_BYTES as usize];
        assert!(add_draft_from_bytes(&paths, INTAKE, "big.bin", &at_limit).is_ok());

        let over = vec![7u8; MAX_ATTACHMENT_BYTES as usize + 1];
        assert_eq!(
            add_draft_from_bytes(&paths, INTAKE, "big.bin", &over),
            Err(AttachmentError::TooLarge)
        );

        let source = dir.path().join("huge.bin");
        let file = File::create(&source).unwrap();
        file.set_len(MAX_ATTACHMENT_BYTES + 1).unwrap();
        drop(file);
        assert_eq!(
            add_draft_from_path(&paths, INTAKE, &source),
            Err(AttachmentError::TooLarge)
        );
        assert_eq!(list_drafts(&paths, INTAKE).unwrap().len(), 1);
    }

    #[test]
    fn draft_count_limit_is_enforced() {
        let (_dir, paths) = setup();
        for i in 0..MAX_ATTACHMENTS_PER_TASK {
            add_draft_from_bytes(&paths, INTAKE, &format!("{i}.txt"), b"x").unwrap();
        }
        assert_eq!(
            add_draft_from_bytes(&paths, INTAKE, "one-more.txt", b"x"),
            Err(AttachmentError::TooMany)
        );
    }

    #[test]
    fn remove_draft_deletes_only_that_draft() {
        let (_dir, paths) = setup();
        let keep = add_draft_from_bytes(&paths, INTAKE, "keep.txt", b"keep").unwrap();
        let drop_me = add_draft_from_bytes(&paths, INTAKE, "drop.txt", b"drop").unwrap();

        remove_draft(&paths, INTAKE, &drop_me.id).unwrap();

        assert_eq!(list_drafts(&paths, INTAKE).unwrap(), vec![keep]);
        assert!(!paths.draft_dir(INTAKE, &drop_me.id).unwrap().exists());
        // Removing again is a no-op; a malformed id is rejected.
        remove_draft(&paths, INTAKE, &drop_me.id).unwrap();
        assert_eq!(
            remove_draft(&paths, INTAKE, "../../tasks"),
            Err(AttachmentError::InvalidId)
        );
    }

    #[test]
    fn commit_copies_drafts_and_removes_the_draft_dir() {
        let (_dir, paths) = setup();
        let a = add_draft_from_bytes(&paths, INTAKE, "a.txt", b"alpha").unwrap();
        let b = add_draft_from_bytes(&paths, INTAKE, "b.png", b"beta").unwrap();

        let committed = commit_drafts(&paths, INTAKE, ROOT).unwrap();

        let mut expected = vec![a.clone(), b.clone()];
        expected.sort_by(|x, y| (&x.created_at, &x.id).cmp(&(&y.created_at, &y.id)));
        assert_eq!(committed, expected);
        assert_eq!(list_attachments(&paths, ROOT).unwrap(), expected);
        assert!(!paths.drafts_dir(INTAKE).unwrap().exists());
        assert!(list_drafts(&paths, INTAKE).unwrap().is_empty());

        let file = attachment_file(&paths, ROOT, &a.id).unwrap();
        assert_eq!(std::fs::read(&file).unwrap(), b"alpha");
        assert_eq!(file.file_name().unwrap(), "a.txt");
        assert!(file.is_absolute());
    }

    #[test]
    fn commit_is_idempotent_and_never_changes_committed_files() {
        let (dir, paths) = setup();
        add_draft_from_bytes(&paths, INTAKE, "a.txt", b"alpha").unwrap();
        let drafts = paths.drafts_dir(INTAKE).unwrap();
        let backup = dir.path().join("drafts-backup");
        copy_tree(&drafts, &backup);

        let first = commit_drafts(&paths, INTAKE, ROOT).unwrap();
        let task_dir = paths.task_attachments_dir(ROOT).unwrap();
        let before = snapshot(&task_dir);

        // Simulate a crash before the draft dir was removed: the same
        // drafts are committed again.
        copy_tree(&backup, &drafts);
        let second = commit_drafts(&paths, INTAKE, ROOT).unwrap();

        assert_eq!(first, second);
        assert_eq!(second.len(), 1);
        assert_eq!(snapshot(&task_dir), before);
        assert!(!drafts.exists());

        // Committing with no drafts left returns the task's attachments.
        assert_eq!(commit_drafts(&paths, INTAKE, ROOT).unwrap(), first);
    }

    #[test]
    fn commit_rejects_a_draft_that_conflicts_with_a_committed_attachment() {
        let (dir, paths) = setup();
        let meta = add_draft_from_bytes(&paths, INTAKE, "a.txt", b"alpha").unwrap();
        let drafts = paths.drafts_dir(INTAKE).unwrap();
        let backup = dir.path().join("drafts-backup");
        copy_tree(&drafts, &backup);
        commit_drafts(&paths, INTAKE, ROOT).unwrap();
        let task_dir = paths.task_attachments_dir(ROOT).unwrap();
        let before = snapshot(&task_dir);

        // Same draft id, different content: must not overwrite.
        copy_tree(&backup, &drafts);
        let draft_dir = paths.draft_dir(INTAKE, &meta.id).unwrap();
        std::fs::write(draft_dir.join("a.txt"), b"tampered").unwrap();
        let mut tampered = meta.clone();
        tampered.sha256 = sha256_hex(b"tampered");
        tampered.size = 8;
        std::fs::write(
            draft_dir.join("meta.json"),
            serde_json::to_vec(&tampered).unwrap(),
        )
        .unwrap();

        assert!(matches!(
            commit_drafts(&paths, INTAKE, ROOT),
            Err(AttachmentError::Corrupt(_))
        ));
        assert_eq!(snapshot(&task_dir), before);
    }

    #[test]
    fn commit_rejects_draft_content_that_does_not_match_its_meta() {
        let (_dir, paths) = setup();
        let meta = add_draft_from_bytes(&paths, INTAKE, "a.txt", b"alpha").unwrap();
        let draft_dir = paths.draft_dir(INTAKE, &meta.id).unwrap();
        std::fs::write(draft_dir.join("a.txt"), b"swapped").unwrap();

        assert!(matches!(
            commit_drafts(&paths, INTAKE, ROOT),
            Err(AttachmentError::Corrupt(_))
        ));
        assert!(list_attachments(&paths, ROOT).unwrap().is_empty());
    }

    #[test]
    fn commit_enforces_the_per_task_limit() {
        let (_dir, paths) = setup();
        for i in 0..MAX_ATTACHMENTS_PER_TASK {
            add_draft_from_bytes(&paths, INTAKE, &format!("{i}.txt"), b"x").unwrap();
        }
        commit_drafts(&paths, INTAKE, ROOT).unwrap();

        let other_intake = "3333333333333333";
        add_draft_from_bytes(&paths, other_intake, "extra.txt", b"x").unwrap();
        assert_eq!(
            commit_drafts(&paths, other_intake, ROOT),
            Err(AttachmentError::TooMany)
        );
        assert_eq!(
            list_attachments(&paths, ROOT).unwrap().len(),
            MAX_ATTACHMENTS_PER_TASK
        );
        // The rejected draft is kept for the user to deal with.
        assert_eq!(list_drafts(&paths, other_intake).unwrap().len(), 1);
    }

    #[test]
    fn attachment_file_rejects_ids_that_escape() {
        let (_dir, paths) = setup();
        let meta = add_draft_from_bytes(&paths, INTAKE, "a.txt", b"alpha").unwrap();
        commit_drafts(&paths, INTAKE, ROOT).unwrap();

        for bad in ["..", "../../tasks", "_drafts", "", "2222222222222222/.."] {
            assert_eq!(
                attachment_file(&paths, bad, &meta.id),
                Err(AttachmentError::InvalidId),
                "root {bad:?}"
            );
            assert_eq!(
                attachment_file(&paths, ROOT, bad),
                Err(AttachmentError::InvalidId),
                "attachment {bad:?}"
            );
        }
    }

    #[test]
    fn attachment_file_rejects_a_tampered_stored_name() {
        let (_dir, paths) = setup();
        let meta = add_draft_from_bytes(&paths, INTAKE, "a.txt", b"alpha").unwrap();
        commit_drafts(&paths, INTAKE, ROOT).unwrap();
        let meta_path = paths
            .attachment_dir(ROOT, &meta.id)
            .unwrap()
            .join("meta.json");

        for evil in ["../../../tasks/x.md", "..\\..\\x", "meta.json", "CON"] {
            let mut tampered = meta.clone();
            tampered.stored_name = evil.to_string();
            std::fs::write(&meta_path, serde_json::to_vec(&tampered).unwrap()).unwrap();
            assert!(
                matches!(
                    attachment_file(&paths, ROOT, &meta.id),
                    Err(AttachmentError::Corrupt(_))
                ),
                "{evil}"
            );
        }
    }

    #[test]
    fn attachment_file_for_a_missing_attachment_is_an_error() {
        let (_dir, paths) = setup();
        assert!(matches!(
            attachment_file(&paths, ROOT, "4444444444444444"),
            Err(AttachmentError::NotFound)
        ));
        assert!(list_attachments(&paths, ROOT).unwrap().is_empty());
    }

    #[test]
    fn attachment_file_verifies_content_against_meta() {
        let (_dir, paths) = setup();
        let meta = add_draft_from_bytes(&paths, INTAKE, "a.txt", b"alpha").unwrap();
        commit_drafts(&paths, INTAKE, ROOT).unwrap();
        let content = paths.attachment_dir(ROOT, &meta.id).unwrap().join("a.txt");

        // Same size, different bytes.
        std::fs::write(&content, b"alphA").unwrap();
        assert!(matches!(
            attachment_file(&paths, ROOT, &meta.id),
            Err(AttachmentError::Corrupt(_))
        ));
        // Different size.
        std::fs::write(&content, b"alpha!").unwrap();
        assert!(matches!(
            attachment_file(&paths, ROOT, &meta.id),
            Err(AttachmentError::Corrupt(_))
        ));
    }

    #[test]
    fn linked_attachments_root_is_rejected() {
        let (dir, paths) = setup();
        let outside = dir.path().join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::create_dir_all(paths.root()).unwrap();
        link_dir(&outside, &paths.attachments_root());

        assert_eq!(
            add_draft_from_bytes(&paths, INTAKE, "a.txt", b"alpha"),
            Err(AttachmentError::OutsideRoot)
        );
        assert_eq!(
            list_drafts(&paths, INTAKE),
            Err(AttachmentError::OutsideRoot)
        );
        assert!(std::fs::read_dir(&outside).unwrap().next().is_none());
    }

    #[test]
    fn linked_mdium_dir_is_rejected() {
        let (dir, paths) = setup();
        let outside = dir.path().join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::create_dir_all(paths.root().parent().unwrap()).unwrap();
        link_dir(&outside, paths.root());

        assert_eq!(
            add_draft_from_bytes(&paths, INTAKE, "a.txt", b"alpha"),
            Err(AttachmentError::OutsideRoot)
        );
        assert!(std::fs::read_dir(&outside).unwrap().next().is_none());
    }

    #[test]
    fn linked_task_dir_is_rejected() {
        let (dir, paths) = setup();
        let meta = add_draft_from_bytes(&paths, INTAKE, "a.txt", b"alpha").unwrap();
        commit_drafts(&paths, INTAKE, ROOT).unwrap();

        // Replace the task dir with a link to a copy of itself elsewhere.
        let task_dir = paths.task_attachments_dir(ROOT).unwrap();
        let outside = dir.path().join("outside");
        copy_tree(&task_dir, &outside);
        std::fs::remove_dir_all(&task_dir).unwrap();
        link_dir(&outside, &task_dir);

        assert_eq!(
            list_attachments(&paths, ROOT),
            Err(AttachmentError::OutsideRoot)
        );
        assert_eq!(
            attachment_file(&paths, ROOT, &meta.id),
            Err(AttachmentError::OutsideRoot)
        );
    }

    #[test]
    fn listings_ignore_entries_without_meta() {
        let (_dir, paths) = setup();
        let meta = add_draft_from_bytes(&paths, INTAKE, "a.txt", b"alpha").unwrap();
        let incomplete = paths.draft_dir(INTAKE, "5555555555555555").unwrap();
        std::fs::create_dir_all(&incomplete).unwrap();
        std::fs::write(incomplete.join("a.txt"), b"partial").unwrap();
        std::fs::create_dir_all(paths.drafts_dir(INTAKE).unwrap().join("not-an-id")).unwrap();

        assert_eq!(list_drafts(&paths, INTAKE).unwrap(), vec![meta]);
    }

    #[test]
    fn a_prepared_commit_is_written_by_apply() {
        let (_dir, paths) = setup();
        let a = add_draft_from_bytes(&paths, INTAKE, "a.txt", b"alpha").unwrap();

        let prepared = prepare_commit(&paths, INTAKE, ROOT).unwrap();
        // Preparing only reads.
        assert!(list_attachments(&paths, ROOT).unwrap().is_empty());
        assert_eq!(list_drafts(&paths, INTAKE).unwrap(), vec![a.clone()]);

        assert_eq!(apply_commit(&paths, prepared).unwrap(), vec![a.clone()]);
        assert_eq!(
            std::fs::read(attachment_file(&paths, ROOT, &a.id).unwrap()).unwrap(),
            b"alpha"
        );
        assert!(!paths.drafts_dir(INTAKE).unwrap().exists());
    }

    #[test]
    fn apply_refuses_drafts_that_changed_after_prepare() {
        let (_dir, paths) = setup();
        add_draft_from_bytes(&paths, INTAKE, "a.txt", b"alpha").unwrap();
        let prepared = prepare_commit(&paths, INTAKE, ROOT).unwrap();
        add_draft_from_bytes(&paths, INTAKE, "b.txt", b"beta").unwrap();

        assert!(matches!(
            apply_commit(&paths, prepared),
            Err(AttachmentError::Corrupt(_))
        ));
        assert!(list_attachments(&paths, ROOT).unwrap().is_empty());
        assert_eq!(list_drafts(&paths, INTAKE).unwrap().len(), 2);
    }

    #[test]
    fn draft_file_is_verified_like_attachment_file() {
        let (_dir, paths) = setup();
        let meta = add_draft_from_bytes(&paths, INTAKE, "shot.png", b"png").unwrap();
        let file = draft_file(&paths, INTAKE, &meta.id).unwrap();
        assert!(file.is_absolute());
        assert_eq!(file.file_name().unwrap(), "shot.png");
        assert_eq!(std::fs::read(&file).unwrap(), b"png");

        assert_eq!(
            draft_file(&paths, INTAKE, "4444444444444444"),
            Err(AttachmentError::NotFound)
        );
        assert_eq!(
            draft_file(&paths, "..", &meta.id),
            Err(AttachmentError::InvalidId)
        );
        std::fs::write(&file, b"PNG").unwrap();
        assert!(matches!(
            draft_file(&paths, INTAKE, &meta.id),
            Err(AttachmentError::Corrupt(_))
        ));
    }

    #[test]
    fn removing_a_tasks_attachments_deletes_its_directory_only() {
        let (dir, paths) = setup();
        add_draft_from_bytes(&paths, INTAKE, "a.txt", b"alpha").unwrap();
        commit_drafts(&paths, INTAKE, ROOT).unwrap();
        let other = "3333333333333333";
        add_draft_from_bytes(&paths, "4444444444444444", "b.txt", b"beta").unwrap();
        commit_drafts(&paths, "4444444444444444", other).unwrap();

        remove_task_attachments(&paths, ROOT).unwrap();
        assert!(!paths.task_attachments_dir(ROOT).unwrap().exists());
        assert_eq!(list_attachments(&paths, other).unwrap().len(), 1);
        // Removing again is a no-op; bad ids are refused.
        remove_task_attachments(&paths, ROOT).unwrap();
        assert_eq!(
            remove_task_attachments(&paths, ".."),
            Err(AttachmentError::InvalidId)
        );

        // A linked task directory is removed itself, never followed.
        let outside = dir.path().join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("keep.txt"), b"keep").unwrap();
        link_dir(&outside, &paths.task_attachments_dir(ROOT).unwrap());
        remove_task_attachments(&paths, ROOT).unwrap();
        assert_eq!(std::fs::read(outside.join("keep.txt")).unwrap(), b"keep");
    }

    #[test]
    fn error_codes_are_stable() {
        assert_eq!(AttachmentError::InvalidId.code(), "ATTACHMENT_INVALID_ID");
        assert_eq!(AttachmentError::NotAFile.code(), "ATTACHMENT_NOT_A_FILE");
        assert_eq!(AttachmentError::NotFound.code(), "ATTACHMENT_NOT_FOUND");
        assert_eq!(AttachmentError::TooLarge.code(), "ATTACHMENT_TOO_LARGE");
        assert_eq!(AttachmentError::TooMany.code(), "ATTACHMENT_TOO_MANY");
        assert_eq!(
            AttachmentError::OutsideRoot.code(),
            "ATTACHMENT_OUTSIDE_ROOT"
        );
        assert_eq!(AttachmentError::Io("x".into()).code(), "ATTACHMENT_IO");
        assert_eq!(
            AttachmentError::Corrupt("x".into()).code(),
            "ATTACHMENT_CORRUPT"
        );
        let json = serde_json::to_value(AttachmentError::TooMany).unwrap();
        assert_eq!(json["code"], "ATTACHMENT_TOO_MANY");
    }
}
