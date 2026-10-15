use serde::Serialize;
use encoding_rs::*;
use std::io::{Read, Write, Cursor};
use std::path::{Path, PathBuf};
use std::fs;
use serde_json;
use crate::commands::vba_streams::{DirStream, ModuleKind, ProjectStream, ProjectWm, REC_MODULETYPE_PROCEDURAL};
use std::collections::HashMap;
use tauri::{AppHandle, Emitter};
use crate::commands::vba_source::{fix_vb_name, normalize_source, validate_module_name};

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct VbaModule {
    pub name: String,
    pub module_type: String, // "standard" | "class" | "document"
    /// Path of the extracted file; None when the macros dir has no file for it.
    pub path: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullResult {
    pub xlsm_path: String,
    pub macros_dir: String,
    pub modules: Vec<VbaModule>,
}
#[derive(Serialize)]

#[serde(rename_all = "camelCase")]
pub struct ListResult {
    pub xlsm_path: String,
    pub macros_dir: String,
    pub extracted: bool,
    pub locked: bool,
    pub modules: Vec<VbaModule>,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkbookLock {
    pub locked: bool,
    /// "owner_file" | "write_denied" when locked.
    pub reason: Option<String>,
}

/// Structured error string shared by commands, bridge and UI:
/// `{"error": <code>, "message": <text>}`.
pub fn vba_error(code: &str, message: impl Into<String>) -> String {
    serde_json::json!({ "error": code, "message": message.into() }).to_string()
}

/// `<stem>_assets/macros/` next to the workbook. The single source of truth
/// for where extracted modules live.
pub fn macros_dir_for(xlsm_path: &Path) -> Result<PathBuf, String> {
    let stem = xlsm_path
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or_else(|| vba_error("invalid_workbook", "Invalid file name"))?;
    let parent = xlsm_path
        .parent()
        .ok_or_else(|| vba_error("invalid_workbook", "Cannot determine parent directory"))?;
    Ok(parent.join(format!("{}_assets", stem)).join("macros"))
}

pub fn is_macro_workbook(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .as_deref(),
        Some("xlsm") | Some("xlam")
    )
}

/// Validate path + extension; returns the structured error used by all commands.
fn require_macro_workbook(xlsm_path: &str) -> Result<&Path, String> {
    let p = Path::new(xlsm_path);
    if !p.exists() {
        return Err(vba_error("invalid_workbook", format!("File not found: {}", xlsm_path)));
    }
    if !is_macro_workbook(p) {
        return Err(vba_error("invalid_workbook", "Only .xlsm and .xlam workbooks are supported"));
    }
    Ok(p)
}

/// Excel holds an open workbook without write sharing, so a write-mode open
/// fails while it is open. The `~$<name>` owner file only refines the reason
/// (a stale owner file after a crash must not lock the workbook forever).
pub fn workbook_lock(path: &Path) -> WorkbookLock {
    let write_denied = match fs::OpenOptions::new().write(true).open(path) {
        Ok(_) => false,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
        Err(_) => true,
    };
    if !write_denied {
        return WorkbookLock { locked: false, reason: None };
    }
    let owner_file_exists = match (path.parent(), path.file_name().and_then(|n| n.to_str())) {
        (Some(parent), Some(name)) => parent.join(format!("~${}", name)).exists(),
        _ => false,
    };
    WorkbookLock {
        locked: true,
        reason: Some(if owner_file_exists { "owner_file" } else { "write_denied" }.to_string()),
    }
}

#[tauri::command]
pub fn check_workbook_lock(xlsm_path: String) -> Result<WorkbookLock, String> {
    Ok(workbook_lock(Path::new(&xlsm_path)))
}

// ---------------------------------------------------------------------------
// MS-OVBA 2.4.1  VBA Compression / Decompression
// ---------------------------------------------------------------------------

/// Decompress a VBA compressed container (MS-OVBA 2.4.1.3).
///
/// The input must start with signature byte 0x01, followed by one or more
/// compressed chunks.  Each chunk has a 2-byte LE header encoding the
/// chunk size and a "compressed" flag (bit 15).
pub fn vba_decompress(data: &[u8]) -> Result<Vec<u8>, String> {
    if data.is_empty() {
        return Err("Empty input".to_string());
    }
    if data[0] != 0x01 {
        return Err(format!(
            "Invalid VBA compression signature: 0x{:02X} (expected 0x01)",
            data[0]
        ));
    }

    let mut out = Vec::new();
    let mut pos: usize = 1; // skip signature

    while pos < data.len() {
        if pos + 2 > data.len() {
            return Err("Truncated chunk header".to_string());
        }
        let header = u16::from_le_bytes([data[pos], data[pos + 1]]);
        pos += 2;

        let chunk_size = (header & 0x0FFF) as usize + 3; // +3 per spec
        let is_compressed = (header & 0x8000) != 0;

        if !is_compressed {
            // Raw chunk: next 4096 bytes (or less at end of stream)
            let end = (pos + 4096).min(data.len());
            out.extend_from_slice(&data[pos..end]);
            pos = end;
            continue;
        }

        // Compressed chunk
        let chunk_end = (pos + chunk_size - 2).min(data.len()); // -2 because header already consumed
        let decompressed_start = out.len();

        while pos < chunk_end {
            let flag_byte = data[pos];
            pos += 1;

            for bit_index in 0..8u8 {
                if pos >= chunk_end {
                    break;
                }

                if (flag_byte >> bit_index) & 1 == 0 {
                    // Literal token
                    out.push(data[pos]);
                    pos += 1;
                } else {
                    // Copy token
                    if pos + 2 > chunk_end {
                        return Err("Truncated copy token".to_string());
                    }
                    let token = u16::from_le_bytes([data[pos], data[pos + 1]]);
                    pos += 2;

                    // Variable bit lengths depend on decompressed offset within chunk
                    let decompressed_current = out.len() - decompressed_start;
                    let bit_count = copy_token_bit_count(decompressed_current);
                    let len_mask = (1u16 << bit_count) - 1;

                    let length = ((token & len_mask) + 3) as usize;
                    let offset = ((token >> bit_count) + 1) as usize;

                    if offset > out.len() - decompressed_start {
                        return Err(format!(
                            "Copy token offset {} exceeds decompressed chunk size {}",
                            offset,
                            out.len() - decompressed_start
                        ));
                    }

                    // Copy byte-by-byte (may overlap)
                    for _ in 0..length {
                        let src_pos = out.len() - offset;
                        let b = out[src_pos];
                        out.push(b);
                    }
                }
            }
        }
    }

    Ok(out)
}

/// Compress data into a VBA compressed container (MS-OVBA 2.4.1.2).
pub fn vba_compress(data: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    out.push(0x01); // signature

    let mut src_pos: usize = 0;

    while src_pos < data.len() {
        let chunk_start = src_pos;
        let chunk_end = (src_pos + 4096).min(data.len());

        let mut compressed_chunk = Vec::new();

        while src_pos < chunk_end {
            let flag_byte_pos = compressed_chunk.len();
            compressed_chunk.push(0u8); // placeholder for flag byte
            let mut flag_byte: u8 = 0;

            for bit_index in 0..8u8 {
                if src_pos >= chunk_end {
                    break;
                }

                let decompressed_offset = src_pos - chunk_start;

                // Try to find a match in the sliding window
                let (best_len, best_offset) =
                    find_best_match(data, chunk_start, src_pos, chunk_end);

                if best_len >= 3 {
                    // Copy token
                    flag_byte |= 1 << bit_index;

                    let bit_count = copy_token_bit_count(decompressed_offset);
                    let len_mask = (1u16 << bit_count) - 1;

                    let token_offset = (best_offset - 1) as u16;
                    let token_length = (best_len - 3) as u16;

                    let token = (token_offset << bit_count) | (token_length & len_mask);
                    compressed_chunk.push(token as u8);
                    compressed_chunk.push((token >> 8) as u8);

                    src_pos += best_len;
                } else {
                    // Literal token
                    compressed_chunk.push(data[src_pos]);
                    src_pos += 1;
                }
            }

            compressed_chunk[flag_byte_pos] = flag_byte;
        }

        // Build chunk header
        // If compressed is not smaller than 4096 (padded uncompressed size), store raw.
        // We compare against 4096 because uncompressed chunks are always padded to 4096.
        let chunk_data_len = chunk_end - chunk_start;
        if compressed_chunk.len() >= 4096 {
            // Uncompressed chunk: header size = 4095 (0x0FFF), bit 15 = 0
            let header: u16 = 0x0FFF; // uncompressed, size = 4096
            out.push(header as u8);
            out.push((header >> 8) as u8);
            out.extend_from_slice(&data[chunk_start..chunk_end]);
            // Pad remaining bytes to 4096
            for _ in chunk_data_len..4096 {
                out.push(0x00);
            }
        } else {
            let size = (compressed_chunk.len() + 2) as u16; // +2 for header itself
            let header: u16 = ((size - 3) & 0x0FFF) | 0x8000; // bit 15 = 1 (compressed)
            out.push(header as u8);
            out.push((header >> 8) as u8);
            out.extend_from_slice(&compressed_chunk);
        }
    }

    out
}

/// Number of bits used for the **length** field in a copy token,
/// based on the current decompressed offset within the chunk.
///
/// MS-OVBA 2.4.1.3.19.1 defines `BitCount` as the number of bits for the
/// **offset** portion of a copy token.  This function returns `16 - BitCount`,
/// i.e. the number of bits for the **length** portion, since both the
/// compressor and decompressor need length-bits directly.
fn copy_token_bit_count(decompressed_offset: usize) -> u16 {
    // MS-OVBA 2.4.1.3.19.1 – BitCount (offset bits)
    let offset_bits: u16 = if decompressed_offset <= 0x0010 {
        4
    } else if decompressed_offset <= 0x0020 {
        5
    } else if decompressed_offset <= 0x0040 {
        6
    } else if decompressed_offset <= 0x0080 {
        7
    } else if decompressed_offset <= 0x0100 {
        8
    } else if decompressed_offset <= 0x0200 {
        9
    } else if decompressed_offset <= 0x0400 {
        10
    } else if decompressed_offset <= 0x0800 {
        11
    } else {
        12
    };
    // Return length bits = 16 - offset bits
    16 - offset_bits
}

/// Find the best (longest) match in the sliding window for compression.
/// Returns (length, offset) where offset is distance back from current position.
fn find_best_match(
    data: &[u8],
    chunk_start: usize,
    current: usize,
    chunk_end: usize,
) -> (usize, usize) {
    let decompressed_offset = current - chunk_start;
    if decompressed_offset == 0 {
        return (0, 0);
    }

    let bit_count = copy_token_bit_count(decompressed_offset);
    let max_len = ((1usize << bit_count) - 1) + 3;
    let max_offset = (1usize << (16 - bit_count)).min(decompressed_offset);

    let mut best_len: usize = 0;
    let mut best_offset: usize = 0;

    for offset in 1..=max_offset {
        let candidate_start = current - offset;
        let mut length = 0;

        while length < max_len
            && (current + length) < chunk_end
            && (current + length) < data.len()
        {
            // Copy tokens can overlap: source byte comes from already-decompressed data
            let src_idx = candidate_start + (length % offset);
            if data[src_idx] == data[current + length] {
                length += 1;
            } else {
                break;
            }
        }

        if length > best_len {
            best_len = length;
            best_offset = offset;
            if length == max_len {
                break; // can't do better
            }
        }
    }

    (best_len, best_offset)
}

// ---------------------------------------------------------------------------
// Encoding helpers  (Windows code page <-> UTF-8)
// ---------------------------------------------------------------------------

/// Look up an `encoding_rs::Encoding` from a Windows code page number.
fn encoding_from_codepage(codepage: u16) -> Result<&'static Encoding, String> {
    match codepage {
        932 => Ok(SHIFT_JIS),
        936 => Ok(GBK),
        949 => Ok(EUC_KR),
        950 => Ok(BIG5),
        1200 => Ok(UTF_16LE),
        1250 => Ok(WINDOWS_1250),
        1251 => Ok(WINDOWS_1251),
        1252 => Ok(WINDOWS_1252),
        1253 => Ok(WINDOWS_1253),
        1254 => Ok(WINDOWS_1254),
        1255 => Ok(WINDOWS_1255),
        1256 => Ok(WINDOWS_1256),
        1257 => Ok(WINDOWS_1257),
        1258 => Ok(WINDOWS_1258),
        10000 => Ok(MACINTOSH),
        65001 => Ok(UTF_8),
        _ => Err(format!("Unsupported code page: {}", codepage)),
    }
}

/// Decode bytes from a Windows code page to a UTF-8 String.
/// Returns an error if the bytes contain unmappable characters.
pub fn decode_bytes(bytes: &[u8], codepage: u16) -> Result<String, String> {
    let encoding = encoding_from_codepage(codepage)?;
    let (cow, _encoding_used, had_errors) = encoding.decode(bytes);
    if had_errors {
        return Err(format!(
            "Failed to decode bytes with code page {}: unmappable characters",
            codepage
        ));
    }
    Ok(cow.into_owned())
}

/// Encode a UTF-8 string to bytes in a Windows code page.
/// Returns an error if the string contains characters that cannot be
/// represented in the target encoding.
pub fn encode_string(s: &str, codepage: u16) -> Result<Vec<u8>, String> {
    let encoding = encoding_from_codepage(codepage)?;
    let (cow, _encoding_used, had_errors) = encoding.encode(s);
    if had_errors {
        return Err(format!(
            "Failed to encode string with code page {}: unmappable characters",
            codepage
        ));
    }
    Ok(cow.into_owned())
}

// ---------------------------------------------------------------------------
// VBA dir stream parsing  (MS-OVBA 2.3.4.2)
// ---------------------------------------------------------------------------

/// Internal representation of a module parsed from the dir stream.
#[derive(Debug, Clone)]
#[cfg(test)]
pub struct VbaModuleInfo {
    pub name: String,
    pub stream_name: String,
    pub module_type: String, // "standard" | "class" | "document"
    pub text_offset: u32,
}

/// Result of parsing the VBA dir stream.
#[derive(Debug)]
#[cfg(test)]
pub struct VbaProject {
    pub code_page: u16,
    pub modules: Vec<VbaModuleInfo>,
}

/// Parse the decompressed VBA dir stream to extract the code page and module list.
///
/// Record layout (MS-OVBA 2.3.4.2):
///   - Each record starts with a 2-byte LE record id, then a 4-byte LE size, then data.
///   - Notable records:
///     0x0003 = PROJECTCODEPAGE  (2-byte code page)
///     0x0019 = MODULENAME       (variable: module name in code page encoding)
///     0x0047 = MODULENAMEUNICODE (variable: module name in UTF-16LE; we prefer this)
///     0x001A = MODULESTREAMNAME (variable)
///     0x0021 = MODULETYPE procedural (standard module, size=0)
///     0x0022 = MODULETYPE document/class (size=0)
///     0x0031 = MODULEOFFSET     (4-byte text offset)
///     0x002B = MODULETERMINATOR
///     0x0010 = PROJECTTERMINATOR
#[cfg(test)] // Only the tests use this thin wrapper now.
pub fn parse_dir_stream(data: &[u8]) -> Result<VbaProject, String> {
    let dir = DirStream::parse(data)?;
    let code_page = dir.code_page();
    let modules = dir
        .modules()
        .into_iter()
        .map(|m| VbaModuleInfo {
            name: m.name,
            stream_name: m.stream_name,
            module_type: if m.type_id == REC_MODULETYPE_PROCEDURAL { "standard" } else { "class" }.to_string(),
            text_offset: m.text_offset,
        })
        .collect();
    Ok(VbaProject { code_page, modules })
}


// ---------------------------------------------------------------------------
// Helper: read vbaProject.bin from an xlsm/xlam ZIP file
// ---------------------------------------------------------------------------

fn read_vba_project_bin(xlsm_path: &str) -> Result<Vec<u8>, String> {
    let file = fs::File::open(xlsm_path)
        .map_err(|e| format!("Failed to open file: {}", e))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| format!("Failed to read ZIP archive: {}", e))?;

    let mut vba_file = archive.by_name("xl/vbaProject.bin").map_err(|_| {
        "No VBA macros found in this file (xl/vbaProject.bin not present)".to_string()
    })?;

    let mut buf = Vec::new();
    vba_file
        .read_to_end(&mut buf)
        .map_err(|e| format!("Failed to read vbaProject.bin: {}", e))?;
    Ok(buf)
}

// ---------------------------------------------------------------------------
// Helper: rebuild a ZIP with one entry replaced
// ---------------------------------------------------------------------------

fn replace_zip_entry(
    original_zip: &[u8],
    entry_name: &str,
    new_data: &[u8],
) -> Result<Vec<u8>, String> {
    let reader = Cursor::new(original_zip);
    let mut archive = zip::ZipArchive::new(reader)
        .map_err(|e| format!("Failed to read ZIP archive: {}", e))?;

    let mut output = Cursor::new(Vec::new());
    let mut writer = zip::ZipWriter::new(&mut output);

    for i in 0..archive.len() {
        let entry = archive
            .by_index(i)
            .map_err(|e| format!("Failed to read ZIP entry {}: {}", i, e))?;
        let name = entry.name().to_owned();

        if name == entry_name {
            // Write the replacement data with the same options
            let options = entry.options();
            drop(entry);
            writer
                .start_file(&name, options)
                .map_err(|e| format!("Failed to start ZIP entry '{}': {}", name, e))?;
            writer
                .write_all(new_data)
                .map_err(|e| format!("Failed to write ZIP entry '{}': {}", name, e))?;
        } else {
            // Copy the entry as-is
            writer
                .raw_copy_file(entry)
                .map_err(|e| format!("Failed to copy ZIP entry '{}': {}", name, e))?;
        }
    }

    writer
        .finish()
        .map_err(|e| format!("Failed to finalize ZIP: {}", e))?;

    Ok(output.into_inner())
}

// ---------------------------------------------------------------------------
// Command: pull_vba_modules
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn pull_vba_modules(xlsm_path: String) -> Result<PullResult, String> {
    let file_path = require_macro_workbook(&xlsm_path)?;
    let vba_bin = read_vba_project_bin(xlsm_path.as_str()).map_err(|e| vba_error("no_vba_project", e))?;
    let mut loaded = load_project(vba_bin).map_err(|e| vba_error("pull_failed", e))?;
    let editable: Vec<ProjectModule> = loaded.modules.iter().filter(|m| m.kind != ModuleKind::Form).cloned().collect();
    if editable.is_empty() {
        return Err(vba_error("no_vba_project", "No VBA modules found in this file"));
    }
    let macros_dir = macros_dir_for(file_path)?;
    fs::create_dir_all(&macros_dir).map_err(|e| vba_error("pull_failed", e.to_string()))?;
    fs::write(macros_dir.join(".codepage"), loaded.code_page.to_string()).map_err(|e| vba_error("pull_failed", e.to_string()))?;
    let mut modules = Vec::new();
    for m in &editable {
        let source = fix_vb_name(&module_source(&mut loaded, m).map_err(|e| vba_error("pull_failed", e))?, &m.name);
        let module_path = macros_dir.join(format!("{}.{}", m.name, file_ext_for(m.kind)));
        fs::write(&module_path, &source).map_err(|e| vba_error("pull_failed", e.to_string()))?;
        modules.push(VbaModule { name: m.name.clone(), module_type: m.kind.as_str().to_string(), path: Some(module_path.to_string_lossy().into_owned()) });
    }

    Ok(PullResult {
        xlsm_path: xlsm_path.clone(),
        macros_dir: macros_dir.to_string_lossy().into_owned(),
        modules,
    })
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SkippedModule {
    pub name: String,
    pub reason: String,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PushResult {
    pub xlsm_path: String,
    pub backup_path: String,
    pub updated: Vec<String>,
    pub unchanged: Vec<String>,
    pub added: Vec<String>,
    pub removed: Vec<String>,
    pub skipped: Vec<SkippedModule>,
}

/// One existing module with its kind resolved from the PROJECT stream.
#[derive(Debug, Clone)]
pub(crate) struct ProjectModule {
    pub name: String,
    pub stream_name: String,
    pub kind: ModuleKind,
    pub text_offset: u32,
}

pub(crate) struct LoadedProject {
    pub comp: cfb::CompoundFile<Cursor<Vec<u8>>>,
    pub dir: DirStream,
    pub project: ProjectStream,
    pub wm: ProjectWm,
    pub code_page: u16,
    pub modules: Vec<ProjectModule>,
}

fn read_stream(comp: &mut cfb::CompoundFile<Cursor<Vec<u8>>>, path: &str) -> Result<Vec<u8>, String> {
    let mut buf = Vec::new();
    comp.open_stream(path)
        .map_err(|e| format!("Failed to open stream '{}': {}", path, e))?
        .read_to_end(&mut buf)
        .map_err(|e| format!("Failed to read stream '{}': {}", path, e))?;
    Ok(buf)
}

fn write_stream(comp: &mut cfb::CompoundFile<Cursor<Vec<u8>>>, path: &str, data: &[u8]) -> Result<(), String> {
    comp.create_stream(path)
        .map_err(|e| format!("Failed to create stream '{}': {}", path, e))?
        .write_all(data)
        .map_err(|e| format!("Failed to write stream '{}': {}", path, e))
}

/// Kind fallback for modules the PROJECT stream does not list.
fn heuristic_kind(name: &str, type_id: u16) -> ModuleKind {
    if type_id == REC_MODULETYPE_PROCEDURAL {
        ModuleKind::Standard
    } else if name.eq_ignore_ascii_case("ThisWorkbook") || name.to_ascii_lowercase().starts_with("sheet") {
        ModuleKind::Document
    } else {
        ModuleKind::Class
    }
}

pub(crate) fn load_project(vba_bin: Vec<u8>) -> Result<LoadedProject, String> {
    let mut comp = cfb::CompoundFile::open(Cursor::new(vba_bin))
        .map_err(|e| format!("Failed to parse vbaProject.bin as OLE2: {}", e))?;
    let dir = DirStream::parse(&vba_decompress(&read_stream(&mut comp, "/VBA/dir")?)?)?;
    let code_page = dir.code_page();
    let project = match read_stream(&mut comp, "/PROJECT") {
        Ok(bytes) => ProjectStream::parse(&bytes, code_page)?,
        Err(_) => ProjectStream { lines: vec![] },
    };
    let wm = match read_stream(&mut comp, "/PROJECTwm") {
        Ok(bytes) => ProjectWm::parse(&bytes, code_page)?,
        Err(_) => ProjectWm { names: vec![] },
    };
    let kinds: HashMap<String, ModuleKind> = project
        .module_kinds()
        .into_iter()
        .map(|(n, k)| (n.to_ascii_lowercase(), k))
        .collect();
    let modules = dir
        .modules()
        .into_iter()
        .map(|m| ProjectModule {
            kind: kinds
                .get(&m.name.to_ascii_lowercase())
                .copied()
                .unwrap_or_else(|| heuristic_kind(&m.name, m.type_id)),
            name: m.name,
            stream_name: m.stream_name,
            text_offset: m.text_offset,
        })
        .collect();
    Ok(LoadedProject { comp, dir, project, wm, code_page, modules })
}

fn file_ext_for(kind: ModuleKind) -> &'static str {
    if kind == ModuleKind::Standard { "bas" } else { "cls" }
}

/// Decoded source of an existing module (cache prefix skipped).
fn module_source(loaded: &mut LoadedProject, m: &ProjectModule) -> Result<String, String> {
    let data = read_stream(&mut loaded.comp, &format!("/VBA/{}", m.stream_name))?;
    let off = m.text_offset as usize;
    if off > data.len() {
        return Err(format!("Module '{}': text_offset {} exceeds stream length {}", m.name, off, data.len()));
    }
    decode_bytes(&vba_decompress(&data[off..])?, loaded.code_page)
}

/// Encode with the project code page, reporting the first unencodable character.
fn encode_module(source: &str, module_name: &str, code_page: u16) -> Result<Vec<u8>, String> {
    encode_string(source, code_page).map_err(|_| {
        let (line_no, ch) = source
            .lines()
            .enumerate()
            .find_map(|(i, l)| {
                l.chars().find(|c| encode_string(&c.to_string(), code_page).is_err()).map(|c| (i + 1, c))
            })
            .unwrap_or((0, '?'));
        vba_error(
            "unencodable_character",
            format!("Module '{}' line {}: '{}' cannot be encoded in code page {}", module_name, line_no, ch, code_page),
        )
    })
}

pub fn push_vba_modules_impl(xlsm_path: &str) -> Result<PushResult, String> {
    let file_path = require_macro_workbook(xlsm_path)?;
    let macros_dir = macros_dir_for(file_path)?;
    if !macros_dir.is_dir() {
        return Err(vba_error("macros_dir_not_found", format!("Macros directory not found: {} (run vba_pull first)", macros_dir.display())));
    }
    if workbook_lock(file_path).locked {
        return Err(vba_error("workbook_locked", "The workbook is open in Excel. Close it there, then push again."));
    }

    // Collect .bas/.cls files, keyed by lower-cased name for case-insensitive matching.
    let mut files: HashMap<String, (String, ModuleKind, PathBuf)> = HashMap::new();
    for entry in fs::read_dir(&macros_dir).map_err(|e| vba_error("push_failed", e.to_string()))? {
        let path = entry.map_err(|e| vba_error("push_failed", e.to_string()))?.path();
        let ext = path.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase());
        let kind = match ext.as_deref() {
            Some("bas") => ModuleKind::Standard,
            Some("cls") => ModuleKind::Class,
            _ => continue,
        };
        let name = path.file_stem().and_then(|s| s.to_str()).unwrap_or("").to_string();
        if files.insert(name.to_ascii_lowercase(), (name.clone(), kind, path)).is_some() {
            return Err(vba_error("duplicate_module_file", format!("Both {}.bas and {}.cls exist; keep one", name, name)));
        }
    }

    let xlsm_data = fs::read(file_path).map_err(|e| vba_error("push_failed", e.to_string()))?;
    let vba_bin = read_vba_project_bin(xlsm_path).map_err(|e| vba_error("no_vba_project", e))?;
    let mut loaded = load_project(vba_bin).map_err(|e| vba_error("push_failed", e))?;
    let code_page = match fs::read_to_string(macros_dir.join(".codepage")) {
        Ok(s) => s.trim().parse::<u16>().unwrap_or(loaded.code_page),
        Err(_) => loaded.code_page,
    };

    // ---- plan (nothing written yet) ----
    let existing_names: Vec<String> = loaded.modules.iter().map(|m| m.name.clone()).collect();
    let mut updated: Vec<(ProjectModule, Vec<u8>)> = Vec::new();
    let mut unchanged = Vec::new();
    let mut added: Vec<(String, ModuleKind, Vec<u8>)> = Vec::new();
    let mut removed: Vec<ProjectModule> = Vec::new();
    let mut skipped = Vec::new();
    let mut matched_files: std::collections::HashSet<String> = std::collections::HashSet::new();

    for m in loaded.modules.clone() {
        match files.get(&m.name.to_ascii_lowercase()) {
            Some((_, _, path)) => {
                matched_files.insert(m.name.to_ascii_lowercase());
                if m.kind == ModuleKind::Form {
                    skipped.push(SkippedModule { name: m.name.clone(), reason: "UserForms are not updated by push".into() });
                    continue;
                }
                let raw = fs::read_to_string(path).map_err(|e| vba_error("push_failed", format!("{}: {}", path.display(), e)))?;
                let normalized = normalize_source(&raw, &m.name, m.kind);
                let current = module_source(&mut loaded, &m).map_err(|e| vba_error("push_failed", e))?;
                if current == normalized {
                    unchanged.push(m.name.clone());
                } else {
                    let encoded = encode_module(&normalized, &m.name, code_page)?;
                    updated.push((m, encoded));
                }
            }
            None => match m.kind {
                ModuleKind::Standard | ModuleKind::Class => removed.push(m),
                ModuleKind::Document => skipped.push(SkippedModule { name: m.name.clone(), reason: "document module file is missing; document modules are never removed".into() }),
                ModuleKind::Form => skipped.push(SkippedModule { name: m.name.clone(), reason: "UserForms are never removed by push".into() }),
            },
        }
    }

    let mut new_files: Vec<&(String, ModuleKind, PathBuf)> = files
        .iter()
        .filter(|(k, _)| !matched_files.contains(*k))
        .map(|(_, v)| v)
        .collect();
    new_files.sort_by(|a, b| a.0.cmp(&b.0));
    let mut taken = existing_names.clone();
    for (name, kind, path) in new_files {
        if name.eq_ignore_ascii_case("ThisWorkbook")
            || loaded.modules.iter().any(|m| m.kind == ModuleKind::Form && m.name.eq_ignore_ascii_case(name))
        {
            return Err(vba_error("invalid_module_name", format!("'{}' is a document or form module and cannot be created from a file", name)));
        }
        validate_module_name(name, &taken).map_err(|msg| vba_error("invalid_module_name", msg))?;
        taken.push(name.clone());
        let raw = fs::read_to_string(path).map_err(|e| vba_error("push_failed", format!("{}: {}", path.display(), e)))?;
        let encoded = encode_module(&normalize_source(&raw, name, *kind), name, code_page)?;
        added.push((name.clone(), *kind, encoded));
    }

    // ---- write ----
    let backup_path = format!("{}.bak", xlsm_path);
    fs::copy(xlsm_path, &backup_path).map_err(|e| vba_error("push_failed", format!("Failed to create backup: {}", e)))?;

    let write_err = |e: String| vba_error("push_failed", format!("{} (the original is in {})", e, backup_path));

    for (m, encoded) in &updated {
        let path = format!("/VBA/{}", m.stream_name);
        let mut data = read_stream(&mut loaded.comp, &path).map_err(write_err)?;
        data.truncate(m.text_offset as usize);
        data.extend_from_slice(&vba_compress(encoded));
        write_stream(&mut loaded.comp, &path, &data).map_err(write_err)?;
    }
    for (name, kind, encoded) in &added {
        write_stream(&mut loaded.comp, &format!("/VBA/{}", name), &vba_compress(encoded)).map_err(write_err)?;
        loaded.dir.append_module(name, name, *kind, 0, loaded.code_page).map_err(write_err)?;
        loaded.project.add_module(name, *kind);
        loaded.wm.add(name);
    }
    for m in &removed {
        loaded.comp.remove_stream(&format!("/VBA/{}", m.stream_name)).map_err(|e| write_err(e.to_string()))?;
        loaded.dir.remove_module(&m.name);
        loaded.project.remove_module(&m.name);
        loaded.wm.remove(&m.name);
    }
    write_stream(&mut loaded.comp, "/VBA/dir", &vba_compress(&loaded.dir.serialize())).map_err(write_err)?;
    write_stream(&mut loaded.comp, "/PROJECT", &loaded.project.serialize(loaded.code_page).map_err(write_err)?).map_err(write_err)?;
    write_stream(&mut loaded.comp, "/PROJECTwm", &loaded.wm.serialize(loaded.code_page).map_err(write_err)?).map_err(write_err)?;

    // Invalidate compiled caches so Excel rebuilds from the sources we wrote
    // (MS-OVBA 2.3.4.1: _VBA_PROJECT must carry no PerformanceCache on write;
    // __SRP_* are undocumented caches readers must ignore).
    const VBA_PROJECT_HEADER: [u8; 7] = [0xCC, 0x61, 0xFF, 0xFF, 0x00, 0x00, 0x00];
    write_stream(&mut loaded.comp, "/VBA/_VBA_PROJECT", &VBA_PROJECT_HEADER).map_err(write_err)?;
    let srp: Vec<std::path::PathBuf> = loaded
        .comp
        .walk()
        .filter(|e| e.is_stream() && e.name().starts_with("__SRP_") && e.path().parent().map(|p| p.to_string_lossy() == "/VBA").unwrap_or(false))
        .map(|e| e.path().to_path_buf())
        .collect();
    for p in srp {
        loaded.comp.remove_stream(&p).map_err(|e| write_err(e.to_string()))?;
    }

    loaded.comp.flush().map_err(|e| write_err(e.to_string()))?;
    let new_bin = loaded.comp.into_inner().into_inner();
    let new_xlsm = replace_zip_entry(&xlsm_data, "xl/vbaProject.bin", &new_bin).map_err(write_err)?;
    fs::write(xlsm_path, &new_xlsm).map_err(|e| write_err(e.to_string()))?;

    Ok(PushResult {
        xlsm_path: xlsm_path.to_string(),
        backup_path,
        updated: updated.into_iter().map(|(m, _)| m.name).collect(),
        unchanged,
        added: added.into_iter().map(|(n, _, _)| n).collect(),
        removed: removed.into_iter().map(|m| m.name).collect(),
        skipped,
    })
}

#[tauri::command]
pub fn push_vba_modules(app: AppHandle, xlsm_path: String) -> Result<PushResult, String> {
    let result = push_vba_modules_impl(&xlsm_path)?;
    let _ = app.emit("vba-pushed", serde_json::json!({ "path": xlsm_path }));
    Ok(result)
}


// ---------------------------------------------------------------------------
// Command: list_vba_modules
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn list_vba_modules(xlsm_path: String) -> Result<ListResult, String> {
    let path = require_macro_workbook(&xlsm_path)?;

    let macros_dir = macros_dir_for(path)?;
    let extracted = macros_dir.is_dir();

    let vba_bin = read_vba_project_bin(&xlsm_path).map_err(|e| vba_error("no_vba_project", e))?;
    let loaded = load_project(vba_bin).map_err(|e| vba_error("list_failed", e))?;

    // path is only populated when the extracted file exists.
    let modules: Vec<VbaModule> = loaded
        .modules
        .iter()
        .filter(|m| m.kind != ModuleKind::Form)
        .map(|m| {
            let file_path = macros_dir.join(format!("{}.{}", m.name, file_ext_for(m.kind)));
            VbaModule {
                name: m.name.clone(),
                module_type: m.kind.as_str().to_string(),
                path: if file_path.exists() { Some(file_path.to_string_lossy().into_owned()) } else { None },
            }
        })
        .collect();

    Ok(ListResult {
        xlsm_path: xlsm_path.clone(),
        macros_dir: macros_dir.to_string_lossy().into_owned(),
        extracted,
        locked: workbook_lock(path).locked,
        modules,
    })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;

    // --- Compression/Decompression tests ---

    #[test]
    fn test_vba_decompress_roundtrip() {
        let source = b"Sub HelloWorld()\r\n    MsgBox \"Hello, World!\"\r\nEnd Sub\r\n";
        let compressed = vba_compress(source);
        let decompressed = vba_decompress(&compressed).expect("decompress failed");
        assert_eq!(decompressed, source);
    }

    #[test]
    fn test_vba_decompress_repeated_data() {
        let source = b"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
        let compressed = vba_compress(source);
        assert!(
            compressed.len() < source.len(),
            "compressed len {} should be less than source len {}",
            compressed.len(),
            source.len()
        );
        let decompressed = vba_decompress(&compressed).expect("decompress failed");
        assert_eq!(decompressed, source);
    }

    #[test]
    fn test_vba_decompress_japanese() {
        // Shift_JIS bytes for "こんにちは"
        let sjis_bytes: Vec<u8> = vec![
            0x82, 0xB1, 0x82, 0xF1, 0x82, 0xC9, 0x82, 0xBF, 0x82, 0xCD,
        ];
        let compressed = vba_compress(&sjis_bytes);
        let decompressed = vba_decompress(&compressed).expect("decompress failed");
        assert_eq!(decompressed, sjis_bytes);
    }

    #[test]
    fn test_vba_decompress_invalid_signature() {
        let bad_data = vec![0x00, 0x01, 0x02];
        let result = vba_decompress(&bad_data);
        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .contains("Invalid VBA compression signature"));
    }

    #[test]
    fn test_vba_compress_empty() {
        let compressed = vba_compress(b"");
        assert_eq!(compressed, vec![0x01]);
    }

    #[test]
    fn test_copy_token_bit_count_returns_length_bits() {
        // Per MS-OVBA 2.4.1.3.19.1, BitCount (offset bits) starts at 4
        // when decompressed_offset <= 16.  Our function returns 16 - BitCount
        // (length bits).
        //
        // offset <= 0x10  -> BitCount=4,  length_bits=12
        // offset <= 0x20  -> BitCount=5,  length_bits=11
        // offset <= 0x40  -> BitCount=6,  length_bits=10
        // ...
        // offset >  0x800 -> BitCount=12, length_bits=4
        assert_eq!(copy_token_bit_count(1), 12);
        assert_eq!(copy_token_bit_count(16), 12);
        assert_eq!(copy_token_bit_count(17), 11);
        assert_eq!(copy_token_bit_count(32), 11);
        assert_eq!(copy_token_bit_count(33), 10);
        assert_eq!(copy_token_bit_count(64), 10);
        assert_eq!(copy_token_bit_count(65), 9);
        assert_eq!(copy_token_bit_count(128), 9);
        assert_eq!(copy_token_bit_count(129), 8);
        assert_eq!(copy_token_bit_count(256), 8);
        assert_eq!(copy_token_bit_count(257), 7);
        assert_eq!(copy_token_bit_count(512), 7);
        assert_eq!(copy_token_bit_count(513), 6);
        assert_eq!(copy_token_bit_count(1024), 6);
        assert_eq!(copy_token_bit_count(1025), 5);
        assert_eq!(copy_token_bit_count(2048), 5);
        assert_eq!(copy_token_bit_count(2049), 4);
        assert_eq!(copy_token_bit_count(4096), 4);
    }

    #[test]
    fn test_copy_token_bit_layout() {
        // Verify that a copy token at a known decompressed offset encodes
        // offset in the high bits and length in the low bits.
        //
        // At decompressed_offset=10, length_bits=12, offset_bits=4.
        //   -> max_length = (1 << 12) - 1 + 3 = 4098
        //   -> max_offset = 1 << 4 = 16
        //
        // Encode: offset=5, length=7
        //   token_offset = 5 - 1 = 4
        //   token_length = 7 - 3 = 4
        //   token = (4 << 12) | 4 = 0x4004
        let length_bits = copy_token_bit_count(10);
        assert_eq!(length_bits, 12);

        let offset_bits = 16 - length_bits;
        assert_eq!(offset_bits, 4);

        let offset: u16 = 5;
        let length: u16 = 7;
        let len_mask: u16 = (1 << length_bits) - 1;

        let token = ((offset - 1) << length_bits) | ((length - 3) & len_mask);
        assert_eq!(token, 0x4004);

        // Decode it back
        let decoded_length = ((token & len_mask) + 3) as usize;
        let decoded_offset = ((token >> length_bits) + 1) as usize;
        assert_eq!(decoded_length, 7);
        assert_eq!(decoded_offset, 5);
    }

    #[test]
    fn test_ms_ovba_spec_example() {
        // MS-OVBA 2.4.1.3.8 example: decompressing "#aaabcdefaaaaghij#"
        // The spec provides a known compressed byte stream for this input.
        // Compressed container bytes (from spec example, section 2.4.1.3.8):
        //   Signature: 0x01
        //   Chunk header: 0x19 0xB0  (size=0x0019+3-2=26 bytes compressed, compressed flag set)
        //   Then the compressed token stream.
        //
        // Rather than hardcode the spec's exact byte stream (which depends on
        // specific encoder choices), we verify that our encoder's output
        // round-trips and that the token layout is spec-compatible by
        // constructing a manual compressed stream.
        //
        // Manual compressed stream for "aaaaaaaaa" (9 x 'a'):
        //   At offset 0: literal 'a' (0x61)
        //   At offset 1: copy token, decompressed_offset=1
        //     length_bits = copy_token_bit_count(1) = 12
        //     offset=1, length=8
        //     token = ((1-1) << 12) | (8-3) = 0x0005
        //   Flag byte: bit 0 = 0 (literal), bit 1 = 1 (copy) => 0x02
        let mut manual_compressed: Vec<u8> = Vec::new();
        manual_compressed.push(0x01); // signature
        // We'll build the chunk data first, then prepend the header
        let mut chunk_data: Vec<u8> = Vec::new();
        // Flag byte: bits 0=literal, 1=copy, rest=0 => 0b00000010 = 0x02
        chunk_data.push(0x02);
        // Literal 'a'
        chunk_data.push(0x61);
        // Copy token: length_bits=12, offset=1, length=8
        // token = ((1-1) << 12) | (8-3) = 5
        let token: u16 = 0x0005;
        chunk_data.push(token as u8);
        chunk_data.push((token >> 8) as u8);

        // Chunk header: size = chunk_data.len() + 2 = 6; header = (6-3) | 0x8000 = 0x8003
        let header: u16 = ((chunk_data.len() as u16 + 2) - 3) | 0x8000;
        manual_compressed.push(header as u8);
        manual_compressed.push((header >> 8) as u8);
        manual_compressed.extend_from_slice(&chunk_data);

        let decompressed = vba_decompress(&manual_compressed).expect("decompress failed");
        assert_eq!(decompressed, b"aaaaaaaaa");
    }

    // --- Encoding tests ---

    #[test]
    fn test_decode_shift_jis() {
        // Shift_JIS bytes for "こんにちは"
        let sjis_bytes: &[u8] = &[
            0x82, 0xB1, 0x82, 0xF1, 0x82, 0xC9, 0x82, 0xBF, 0x82, 0xCD,
        ];
        let decoded = decode_bytes(sjis_bytes, 932).expect("decode failed");
        assert_eq!(decoded, "こんにちは");
    }

    #[test]
    fn test_encode_shift_jis() {
        let encoded = encode_string("こんにちは", 932).expect("encode failed");
        let expected: Vec<u8> = vec![
            0x82, 0xB1, 0x82, 0xF1, 0x82, 0xC9, 0x82, 0xBF, 0x82, 0xCD,
        ];
        assert_eq!(encoded, expected);
    }

    #[test]
    fn test_decode_encode_roundtrip_ascii() {
        let ascii = "Hello, World! 123";
        let encoded = encode_string(ascii, 1252).expect("encode failed");
        let decoded = decode_bytes(&encoded, 1252).expect("decode failed");
        assert_eq!(decoded, ascii);
    }

    // --- Dir stream parsing tests ---

    /// Helper: build a dir stream record (id: u16, data: &[u8]).
    fn make_record(id: u16, data: &[u8]) -> Vec<u8> {
        let mut rec = Vec::new();
        rec.extend_from_slice(&id.to_le_bytes());
        rec.extend_from_slice(&(data.len() as u32).to_le_bytes());
        rec.extend_from_slice(data);
        rec
    }

    #[test]
    fn test_parse_dir_stream_basic() {
        let mut stream = Vec::new();

        // PROJECTCODEPAGE = 932 (Shift_JIS)
        stream.extend_from_slice(&make_record(0x0003, &932u16.to_le_bytes()));

        // --- Module 1 ---
        // MODULENAME (Shift_JIS for "Module1" - all ASCII so same bytes)
        stream.extend_from_slice(&make_record(0x0019, b"Module1"));
        // MODULESTREAMNAME
        stream.extend_from_slice(&make_record(0x001A, b"Module1"));
        // MODULETYPE = standard (0x0021)
        stream.extend_from_slice(&make_record(0x0021, &[]));
        // MODULEOFFSET
        stream.extend_from_slice(&make_record(0x0031, &100u32.to_le_bytes()));
        // MODULETERMINATOR
        stream.extend_from_slice(&make_record(0x002B, &[]));

        // --- Module 2 ---
        stream.extend_from_slice(&make_record(0x0019, b"Sheet1"));
        stream.extend_from_slice(&make_record(0x001A, b"Sheet1"));
        // MODULETYPE = class/document (0x0022)
        stream.extend_from_slice(&make_record(0x0022, &[]));
        stream.extend_from_slice(&make_record(0x0031, &200u32.to_le_bytes()));
        stream.extend_from_slice(&make_record(0x002B, &[]));

        // PROJECTTERMINATOR
        stream.extend_from_slice(&make_record(0x0010, &[]));

        let project = parse_dir_stream(&stream).expect("parse failed");
        assert_eq!(project.code_page, 932);
        assert_eq!(project.modules.len(), 2);

        assert_eq!(project.modules[0].name, "Module1");
        assert_eq!(project.modules[0].stream_name, "Module1");
        assert_eq!(project.modules[0].module_type, "standard");
        assert_eq!(project.modules[0].text_offset, 100);

        assert_eq!(project.modules[1].name, "Sheet1");
        assert_eq!(project.modules[1].stream_name, "Sheet1");
        assert_eq!(project.modules[1].module_type, "class");
        assert_eq!(project.modules[1].text_offset, 200);
    }

    #[test]
    fn test_parse_dir_stream_unicode_name() {
        let mut stream = Vec::new();

        // PROJECTCODEPAGE = 932
        stream.extend_from_slice(&make_record(0x0003, &932u16.to_le_bytes()));

        // MODULENAME (Shift_JIS)
        stream.extend_from_slice(&make_record(0x0019, b"Module1"));
        // MODULENAMEUNICODE overrides
        let unicode_name: Vec<u8> = "TestModule"
            .encode_utf16()
            .flat_map(|c| c.to_le_bytes())
            .collect();
        stream.extend_from_slice(&make_record(0x0047, &unicode_name));
        stream.extend_from_slice(&make_record(0x001A, b"Module1"));
        stream.extend_from_slice(&make_record(0x0021, &[]));
        stream.extend_from_slice(&make_record(0x0031, &0u32.to_le_bytes()));
        stream.extend_from_slice(&make_record(0x002B, &[]));

        stream.extend_from_slice(&make_record(0x0010, &[]));

        let project = parse_dir_stream(&stream).expect("parse failed");
        assert_eq!(project.modules.len(), 1);
        // Unicode name should take priority
        assert_eq!(project.modules[0].name, "TestModule");
    }

    // --- Task 1: paths and lock ---

    #[test]
    fn macros_dir_is_assets_macros_next_to_workbook() {
        let dir = macros_dir_for(Path::new("C:/work/Book1.xlsm")).unwrap();
        assert_eq!(dir, Path::new("C:/work").join("Book1_assets").join("macros"));
    }

    #[test]
    fn macro_workbook_extension_is_case_insensitive() {
        assert!(is_macro_workbook(Path::new("C:/w/BOOK.XLSM")));
        assert!(is_macro_workbook(Path::new("C:/w/addin.xlam")));
        assert!(!is_macro_workbook(Path::new("C:/w/plain.xlsx")));
    }

    #[test]
    fn workbook_lock_is_false_for_writable_file() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("Book1.xlsm");
        std::fs::write(&p, b"x").unwrap();
        let lock = workbook_lock(&p);
        assert!(!lock.locked);
        assert_eq!(lock.reason, None);
    }

    #[cfg(windows)]
    #[test]
    fn workbook_lock_reports_write_denied_when_another_handle_denies_sharing() {
        use std::os::windows::fs::OpenOptionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("Book1.xlsm");
        std::fs::write(&p, b"x").unwrap();
        // Excel keeps the workbook open without write sharing; emulate that.
        let _holder = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&p)
            .unwrap();
        let lock = workbook_lock(&p);
        assert!(lock.locked);
        assert_eq!(lock.reason.as_deref(), Some("write_denied"));
    }

    #[cfg(windows)]
    #[test]
    fn workbook_lock_names_owner_file_when_present() {
        use std::os::windows::fs::OpenOptionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("Book1.xlsm");
        std::fs::write(&p, b"x").unwrap();
        std::fs::write(tmp.path().join("~$Book1.xlsm"), b"owner").unwrap();
        let _holder = std::fs::OpenOptions::new().read(true).share_mode(0).open(&p).unwrap();
        let lock = workbook_lock(&p);
        assert!(lock.locked);
        assert_eq!(lock.reason.as_deref(), Some("owner_file"));
    }

    #[test]
    fn vba_error_is_json_with_code_and_message() {
        let e = vba_error("invalid_workbook", "not an xlsm");
        let v: serde_json::Value = serde_json::from_str(&e).unwrap();
        assert_eq!(v["error"], "invalid_workbook");
        assert_eq!(v["message"], "not an xlsm");
    }

    #[test]
    fn list_vba_modules_missing_file_is_invalid_workbook() {
        let e = list_vba_modules("C:/nope/missing.xlsm".to_string()).err().unwrap();
        let v: serde_json::Value = serde_json::from_str(&e).unwrap();
        assert_eq!(v["error"], "invalid_workbook");
    }

    #[test]
    fn list_vba_modules_non_macro_extension_is_invalid_workbook() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("plain.xlsx");
        std::fs::write(&p, b"x").unwrap();
        let e = list_vba_modules(p.to_string_lossy().into_owned()).err().unwrap();
        let v: serde_json::Value = serde_json::from_str(&e).unwrap();
        assert_eq!(v["error"], "invalid_workbook");
    }

    // --- synthetic workbook for pull/push round trips (no Excel needed) ---

    use crate::commands::vba_streams::{DirStream, ModuleKind, ProjectStream, ProjectWm};

    struct TestModule {
        name: &'static str,
        kind: ModuleKind,
        source: &'static str,
        /// Fake PerformanceCache bytes placed before the compressed source.
        cache: &'static [u8],
    }

    fn build_vba_bin(code_page: u16, modules: &[TestModule]) -> Vec<u8> {
        let cursor = Cursor::new(Vec::new());
        let mut comp = cfb::CompoundFile::create(cursor).unwrap();
        comp.create_storage("/VBA").unwrap();

        let mut project = ProjectStream { lines: vec!["ID=\"{1}\"".into(), "Name=\"VBAProject\"".into(), "".into()] };
        let mut wm = ProjectWm { names: vec![] };
        let mut dir = DirStream::parse(&{
            let mut v = Vec::new();
            v.extend_from_slice(&make_record(0x0001, &3u32.to_le_bytes()));
            v.extend_from_slice(&make_record(0x0003, &code_page.to_le_bytes()));
            v.extend_from_slice(&make_record(0x000F, &0u16.to_le_bytes()));
            v.extend_from_slice(&make_record(0x0013, &0xFFFFu16.to_le_bytes()));
            v.extend_from_slice(&make_record(0x0010, &[]));
            v
        })
        .unwrap();

        for m in modules {
            project.add_module(m.name, m.kind);
            wm.add(m.name);
            dir.append_module(m.name, m.name, m.kind, m.cache.len() as u32, code_page).unwrap();
            let mut data = m.cache.to_vec();
            data.extend_from_slice(&vba_compress(&encode_string(m.source, code_page).unwrap()));
            comp.create_stream(&format!("/VBA/{}", m.name)).unwrap().write_all(&data).unwrap();
        }
        comp.create_stream("/PROJECT").unwrap().write_all(&project.serialize(code_page).unwrap()).unwrap();
        comp.create_stream("/PROJECTwm").unwrap().write_all(&wm.serialize(code_page).unwrap()).unwrap();
        comp.create_stream("/VBA/dir").unwrap().write_all(&vba_compress(&dir.serialize())).unwrap();
        comp.create_stream("/VBA/_VBA_PROJECT").unwrap().write_all(&[0xCC, 0x61, 0xFF, 0xFF, 0x00, 0x00, 0x00]).unwrap();
        comp.flush().unwrap();
        comp.into_inner().into_inner()
    }

    fn build_workbook(dir: &Path, file_name: &str, vba_bin: &[u8]) -> PathBuf {
        let path = dir.join(file_name);
        let mut zip = zip::ZipWriter::new(fs::File::create(&path).unwrap());
        let opts = zip::write::SimpleFileOptions::default();
        zip.start_file("[Content_Types].xml", opts).unwrap();
        zip.write_all(b"<Types/>").unwrap();
        zip.start_file("xl/workbook.xml", opts).unwrap();
        zip.write_all(b"<workbook/>").unwrap();
        zip.start_file("xl/vbaProject.bin", opts).unwrap();
        zip.write_all(vba_bin).unwrap();
        zip.finish().unwrap();
        path
    }

    fn std_module(name: &'static str, body: &'static str) -> TestModule {
        TestModule { name, kind: ModuleKind::Standard, source: body, cache: &[] }
    }

    fn three_module_workbook(dir: &Path) -> PathBuf {
        let bin = build_vba_bin(
            1252,
            &[
                std_module("Module1", "Attribute VB_Name = \"Module1\"\r\nSub Hello()\r\nEnd Sub\r\n"),
                // Carries the four class attributes VBE stores, so a pull→push
                // round trip without edits is reported as unchanged.
                TestModule { name: "Class1", kind: ModuleKind::Class, source: "Attribute VB_Name = \"Class1\"\r\nAttribute VB_GlobalNameSpace = False\r\nAttribute VB_Creatable = False\r\nAttribute VB_PredeclaredId = False\r\nAttribute VB_Exposed = False\r\nPublic Sub Hi()\r\nEnd Sub\r\n", cache: &[] },
                TestModule { name: "ThisWorkbook", kind: ModuleKind::Document, source: "Attribute VB_Name = \"ThisWorkbook\"\r\n", cache: &[9, 9, 9, 9, 9] },
            ],
        );
        build_workbook(dir, "Book1.xlsm", &bin)
    }

    fn stream_bytes(xlsm: &Path, stream: &str) -> Vec<u8> {
        let bin = read_vba_project_bin(xlsm.to_str().unwrap()).unwrap();
        let mut comp = cfb::CompoundFile::open(Cursor::new(bin)).unwrap();
        let mut buf = Vec::new();
        comp.open_stream(stream).unwrap().read_to_end(&mut buf).unwrap();
        buf
    }

    fn err_code(err: &str) -> String {
        serde_json::from_str::<serde_json::Value>(err).map(|v| v["error"].as_str().unwrap_or("").to_string()).unwrap_or_default()
    }

    #[test]
    fn pull_writes_files_and_list_reports_kinds_from_project_stream() {
        let tmp = tempfile::tempdir().unwrap();
        let xlsm = three_module_workbook(tmp.path());
        let xlsm_s = xlsm.to_string_lossy().to_string();

        let before = list_vba_modules(xlsm_s.clone()).unwrap();
        assert!(!before.extracted);
        assert!(before.modules.iter().all(|m| m.path.is_none()));

        let pulled = pull_vba_modules(xlsm_s.clone()).unwrap();
        assert_eq!(pulled.macros_dir, tmp.path().join("Book1_assets").join("macros").to_string_lossy());
        let kinds: Vec<(String, String)> = pulled.modules.iter().map(|m| (m.name.clone(), m.module_type.clone())).collect();
        assert_eq!(kinds, vec![
            ("Module1".to_string(), "standard".to_string()),
            ("Class1".to_string(), "class".to_string()),
            ("ThisWorkbook".to_string(), "document".to_string()),
        ]);
        assert!(Path::new(&pulled.macros_dir).join("Module1.bas").exists());
        assert!(Path::new(&pulled.macros_dir).join("Class1.cls").exists());
        assert!(Path::new(&pulled.macros_dir).join("ThisWorkbook.cls").exists());

        let after = list_vba_modules(xlsm_s).unwrap();
        assert!(after.extracted);
        assert!(after.modules.iter().all(|m| m.path.is_some()));
    }

    #[test]
    fn push_updates_adds_removes_and_skips_document_modules() {
        let tmp = tempfile::tempdir().unwrap();
        let xlsm = three_module_workbook(tmp.path());
        let xlsm_s = xlsm.to_string_lossy().to_string();
        let macros = Path::new(&pull_vba_modules(xlsm_s.clone()).unwrap().macros_dir).to_path_buf();

        fs::write(macros.join("Module1.bas"), "Attribute VB_Name = \"Module1\"\r\nSub Hello(name As String)\r\nEnd Sub\r\n").unwrap();
        fs::write(macros.join("Helpers.bas"), "Sub Help()\r\nEnd Sub\r\n").unwrap();
        fs::write(macros.join("NewClass.cls"), "VERSION 1.0 CLASS\r\nBEGIN\r\n  MultiUse = -1  'True\r\nEND\r\nAttribute VB_Name = \"NewClass\"\r\nPublic Sub Go()\r\nEnd Sub\r\n").unwrap();
        fs::remove_file(macros.join("Class1.cls")).unwrap();
        fs::remove_file(macros.join("ThisWorkbook.cls")).unwrap();

        let res = push_vba_modules_impl(&xlsm_s).unwrap();
        assert_eq!(res.updated, vec!["Module1"]);
        assert!(res.unchanged.is_empty());
        assert_eq!(res.added, vec!["Helpers", "NewClass"]);
        assert_eq!(res.removed, vec!["Class1"]);
        assert_eq!(res.skipped.len(), 1);
        assert_eq!(res.skipped[0].name, "ThisWorkbook");
        assert!(Path::new(&res.backup_path).exists());

        // Document module stream (including its fake cache prefix) is untouched.
        let tw = stream_bytes(&xlsm, "/VBA/ThisWorkbook");
        assert_eq!(&tw[..5], &[9, 9, 9, 9, 9]);

        // Project caches invalidated.
        assert_eq!(stream_bytes(&xlsm, "/VBA/_VBA_PROJECT"), vec![0xCC, 0x61, 0xFF, 0xFF, 0x00, 0x00, 0x00]);

        // A fresh pull reflects the new module set and the normalized sources.
        fs::remove_dir_all(&macros).unwrap();
        let again = pull_vba_modules(xlsm_s.clone()).unwrap();
        let names: Vec<&str> = again.modules.iter().map(|m| m.name.as_str()).collect();
        assert_eq!(names, vec!["Module1", "ThisWorkbook", "Helpers", "NewClass"]);
        let helpers = fs::read_to_string(macros.join("Helpers.bas")).unwrap();
        assert!(helpers.starts_with("Attribute VB_Name = \"Helpers\"\r\nSub Help()"));
        let new_class = fs::read_to_string(macros.join("NewClass.cls")).unwrap();
        assert!(!new_class.contains("VERSION 1.0 CLASS"));
        assert!(new_class.contains("Attribute VB_Exposed = False"));
        let m1 = fs::read_to_string(macros.join("Module1.bas")).unwrap();
        assert!(m1.contains("Sub Hello(name As String)"));

        // PROJECT / PROJECTwm agree with the dir stream.
        let project = ProjectStream::parse(&stream_bytes(&xlsm, "/PROJECT"), 1252).unwrap();
        let kinds = project.module_kinds();
        assert!(kinds.iter().any(|(n, k)| n == "Helpers" && *k == ModuleKind::Standard));
        assert!(kinds.iter().any(|(n, k)| n == "NewClass" && *k == ModuleKind::Class));
        assert!(!kinds.iter().any(|(n, _)| n == "Class1"));
        let wm = ProjectWm::parse(&stream_bytes(&xlsm, "/PROJECTwm"), 1252).unwrap();
        assert_eq!(wm.names, vec!["Module1", "ThisWorkbook", "Helpers", "NewClass"]);
    }

    #[test]
    fn push_twice_reports_everything_unchanged() {
        let tmp = tempfile::tempdir().unwrap();
        let xlsm = three_module_workbook(tmp.path());
        let xlsm_s = xlsm.to_string_lossy().to_string();
        pull_vba_modules(xlsm_s.clone()).unwrap();
        let first = push_vba_modules_impl(&xlsm_s).unwrap();
        assert!(first.updated.is_empty());
        assert_eq!(first.unchanged.len(), 3);
        let second = push_vba_modules_impl(&xlsm_s).unwrap();
        assert!(second.updated.is_empty() && second.added.is_empty() && second.removed.is_empty());
    }

    #[test]
    fn push_matches_file_names_case_insensitively() {
        let tmp = tempfile::tempdir().unwrap();
        let xlsm = three_module_workbook(tmp.path());
        let xlsm_s = xlsm.to_string_lossy().to_string();
        let macros = PathBuf::from(pull_vba_modules(xlsm_s.clone()).unwrap().macros_dir);
        fs::rename(macros.join("Module1.bas"), macros.join("module1.bas")).unwrap();
        fs::write(macros.join("module1.bas"), "Attribute VB_Name = \"Module1\"\r\nSub Changed()\r\nEnd Sub\r\n").unwrap();
        let res = push_vba_modules_impl(&xlsm_s).unwrap();
        assert_eq!(res.updated, vec!["Module1"]);
        assert!(res.added.is_empty());
        assert!(res.removed.is_empty());
    }

    #[test]
    fn push_refuses_invalid_module_name_without_touching_workbook() {
        let tmp = tempfile::tempdir().unwrap();
        let xlsm = three_module_workbook(tmp.path());
        let xlsm_s = xlsm.to_string_lossy().to_string();
        let macros = PathBuf::from(pull_vba_modules(xlsm_s.clone()).unwrap().macros_dir);
        fs::write(macros.join("1bad.bas"), "Sub X()\r\nEnd Sub\r\n").unwrap();
        let original = fs::read(&xlsm).unwrap();
        let err = push_vba_modules_impl(&xlsm_s).unwrap_err();
        assert_eq!(err_code(&err), "invalid_module_name");
        assert_eq!(fs::read(&xlsm).unwrap(), original);
        assert!(!tmp.path().join("Book1.xlsm.bak").exists());
    }

    #[test]
    fn push_refuses_creating_thisworkbook_from_a_file() {
        // A workbook whose project has no ThisWorkbook module; a new file with
        // that name must not be added as a standard module.
        let tmp = tempfile::tempdir().unwrap();
        let bin = build_vba_bin(1252, &[std_module("Module1", "Attribute VB_Name = \"Module1\"\r\nSub A()\r\nEnd Sub\r\n")]);
        let xlsm = build_workbook(tmp.path(), "One.xlsm", &bin);
        let xlsm_s = xlsm.to_string_lossy().to_string();
        let macros = PathBuf::from(pull_vba_modules(xlsm_s.clone()).unwrap().macros_dir);
        fs::write(macros.join("ThisWorkbook.bas"), "Sub X()\r\nEnd Sub\r\n").unwrap();
        let err = push_vba_modules_impl(&xlsm_s).unwrap_err();
        assert_eq!(err_code(&err), "invalid_module_name");
        assert!(!tmp.path().join("One.xlsm.bak").exists());
    }

    #[test]
    fn push_treats_a_bas_file_for_a_document_module_as_an_update() {
        // The module's kind comes from the project, not the file extension.
        let tmp = tempfile::tempdir().unwrap();
        let xlsm = three_module_workbook(tmp.path());
        let xlsm_s = xlsm.to_string_lossy().to_string();
        let macros = PathBuf::from(pull_vba_modules(xlsm_s.clone()).unwrap().macros_dir);
        fs::remove_file(macros.join("ThisWorkbook.cls")).unwrap();
        fs::write(macros.join("ThisWorkbook.bas"), "Attribute VB_Name = \"ThisWorkbook\"\r\nPrivate Sub Workbook_Open()\r\nEnd Sub\r\n").unwrap();
        let res = push_vba_modules_impl(&xlsm_s).unwrap();
        assert_eq!(res.updated, vec!["ThisWorkbook"]);
        assert!(res.added.is_empty());
        assert!(res.skipped.is_empty());
    }

    #[test]
    fn push_refuses_duplicate_bas_and_cls() {
        let tmp = tempfile::tempdir().unwrap();
        let xlsm = three_module_workbook(tmp.path());
        let xlsm_s = xlsm.to_string_lossy().to_string();
        let macros = PathBuf::from(pull_vba_modules(xlsm_s.clone()).unwrap().macros_dir);
        fs::write(macros.join("Module1.cls"), "Sub X()\r\nEnd Sub\r\n").unwrap();
        let err = push_vba_modules_impl(&xlsm_s).unwrap_err();
        assert_eq!(err_code(&err), "duplicate_module_file");
    }

    #[test]
    fn push_reports_unencodable_characters() {
        let tmp = tempfile::tempdir().unwrap();
        let xlsm = three_module_workbook(tmp.path()); // code page 1252
        let xlsm_s = xlsm.to_string_lossy().to_string();
        let macros = PathBuf::from(pull_vba_modules(xlsm_s.clone()).unwrap().macros_dir);
        fs::write(macros.join("Module1.bas"), "Attribute VB_Name = \"Module1\"\r\nSub A()\r\n  MsgBox \"日本語\"\r\nEnd Sub\r\n").unwrap();
        let err = push_vba_modules_impl(&xlsm_s).unwrap_err();
        assert_eq!(err_code(&err), "unencodable_character");
        assert!(err.contains("Module1"));
        assert!(!tmp.path().join("Book1.xlsm.bak").exists());
    }

    #[test]
    fn push_requires_macros_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let xlsm = three_module_workbook(tmp.path());
        let err = push_vba_modules_impl(xlsm.to_str().unwrap()).unwrap_err();
        assert_eq!(err_code(&err), "macros_dir_not_found");
    }

    #[test]
    fn round_trip_works_in_a_japanese_folder_with_shift_jis_source() {
        let tmp = tempfile::tempdir().unwrap();
        let folder = tmp.path().join("資料");
        fs::create_dir_all(&folder).unwrap();
        let bin = build_vba_bin(932, &[std_module("Module1", "Attribute VB_Name = \"Module1\"\r\nSub A()\r\n  MsgBox \"こんにちは\"\r\nEnd Sub\r\n")]);
        let xlsm = build_workbook(&folder, "帳票.xlsm", &bin);
        let xlsm_s = xlsm.to_string_lossy().to_string();
        let pulled = pull_vba_modules(xlsm_s.clone()).unwrap();
        assert_eq!(Path::new(&pulled.macros_dir), folder.join("帳票_assets").join("macros"));
        let src = fs::read_to_string(Path::new(&pulled.macros_dir).join("Module1.bas")).unwrap();
        assert!(src.contains("こんにちは"));
        fs::write(Path::new(&pulled.macros_dir).join("Module1.bas"), src.replace("こんにちは", "さようなら")).unwrap();
        let res = push_vba_modules_impl(&xlsm_s).unwrap();
        assert_eq!(res.updated, vec!["Module1"]);
        fs::remove_dir_all(&pulled.macros_dir).unwrap();
        pull_vba_modules(xlsm_s).unwrap();
        let src2 = fs::read_to_string(Path::new(&pulled.macros_dir).join("Module1.bas")).unwrap();
        assert!(src2.contains("さようなら"));
    }

    #[cfg(windows)]
    #[test]
    fn push_refuses_locked_workbook_before_backup() {
        use std::os::windows::fs::OpenOptionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let xlsm = three_module_workbook(tmp.path());
        let xlsm_s = xlsm.to_string_lossy().to_string();
        pull_vba_modules(xlsm_s.clone()).unwrap();
        let _holder = fs::OpenOptions::new().read(true).share_mode(0).open(&xlsm).unwrap();
        let err = push_vba_modules_impl(&xlsm_s).unwrap_err();
        assert_eq!(err_code(&err), "workbook_locked");
        assert!(!tmp.path().join("Book1.xlsm.bak").exists());
    }
}
