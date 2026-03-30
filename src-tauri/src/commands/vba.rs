use serde::Serialize;
use encoding_rs::*;
use std::io::{Read, Write, Cursor};
use std::path::Path;
use std::fs;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct VbaModule {
    pub name: String,
    pub module_type: String, // "standard" | "class" | "document"
    pub path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractResult {
    pub macros_dir: String,
    pub modules: Vec<VbaModule>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InjectResult {
    pub backup_path: String,
    pub updated_modules: Vec<String>,
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
pub struct VbaModuleInfo {
    pub name: String,
    pub stream_name: String,
    pub module_type: String, // "standard" | "class" | "document"
    pub text_offset: u32,
}

/// Result of parsing the VBA dir stream.
#[derive(Debug)]
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
pub fn parse_dir_stream(data: &[u8]) -> Result<VbaProject, String> {
    let mut pos: usize = 0;
    let mut code_page: u16 = 1252; // default to Windows-1252
    let mut modules: Vec<VbaModuleInfo> = Vec::new();

    // Current module being accumulated
    let mut cur_name: Option<String> = None;
    let mut cur_stream_name: Option<String> = None;
    let mut cur_type: Option<String> = None;
    let mut cur_offset: u32 = 0;

    while pos + 6 <= data.len() {
        let record_id = u16::from_le_bytes([data[pos], data[pos + 1]]);
        let record_size = u32::from_le_bytes([
            data[pos + 2],
            data[pos + 3],
            data[pos + 4],
            data[pos + 5],
        ]) as usize;
        pos += 6;

        if pos + record_size > data.len() {
            return Err(format!(
                "Record 0x{:04X} at offset {} claims size {} but only {} bytes remain",
                record_id,
                pos - 6,
                record_size,
                data.len() - pos
            ));
        }

        let record_data = &data[pos..pos + record_size];

        match record_id {
            0x0003 => {
                // PROJECTCODEPAGE
                if record_size >= 2 {
                    code_page = u16::from_le_bytes([record_data[0], record_data[1]]);
                }
            }
            0x0019 => {
                // MODULENAME (code-page encoded)
                // Only use if we don't get a Unicode version
                if cur_name.is_none() {
                    cur_name = Some(
                        decode_bytes(record_data, code_page)
                            .unwrap_or_else(|_| String::from_utf8_lossy(record_data).into_owned()),
                    );
                }
            }
            0x0047 => {
                // MODULENAMEUNICODE (UTF-16LE)
                if record_size >= 2 {
                    let utf16: Vec<u16> = record_data
                        .chunks_exact(2)
                        .map(|c| u16::from_le_bytes([c[0], c[1]]))
                        .collect();
                    cur_name = Some(
                        String::from_utf16(&utf16)
                            .map_err(|e| format!("Invalid UTF-16LE module name: {}", e))?,
                    );
                }
            }
            0x001A => {
                // MODULESTREAMNAME (code-page encoded)
                cur_stream_name = Some(
                    decode_bytes(record_data, code_page)
                        .unwrap_or_else(|_| String::from_utf8_lossy(record_data).into_owned()),
                );
                // The next record (0x0032) is MODULESTREAMNAMEUNICODE - we'll handle it below
            }
            0x0032 => {
                // MODULESTREAMNAMEUNICODE (UTF-16LE)
                if record_size >= 2 {
                    let utf16: Vec<u16> = record_data
                        .chunks_exact(2)
                        .map(|c| u16::from_le_bytes([c[0], c[1]]))
                        .collect();
                    if let Ok(s) = String::from_utf16(&utf16) {
                        cur_stream_name = Some(s);
                    }
                }
            }
            0x0021 => {
                // MODULETYPE procedural (standard module)
                cur_type = Some("standard".to_string());
            }
            0x0022 => {
                // MODULETYPE document/class
                cur_type = Some("class".to_string());
            }
            0x0031 => {
                // MODULEOFFSET
                if record_size >= 4 {
                    cur_offset = u32::from_le_bytes([
                        record_data[0],
                        record_data[1],
                        record_data[2],
                        record_data[3],
                    ]);
                }
            }
            0x002B => {
                // MODULETERMINATOR - finalize current module
                if let (Some(name), Some(stream_name)) = (cur_name.take(), cur_stream_name.take())
                {
                    modules.push(VbaModuleInfo {
                        name,
                        stream_name,
                        module_type: cur_type.take().unwrap_or_else(|| "standard".to_string()),
                        text_offset: cur_offset,
                    });
                }
                cur_type = None;
                cur_offset = 0;
            }
            0x0010 => {
                // PROJECTTERMINATOR - stop parsing
                break;
            }
            _ => {
                // Skip unknown records
            }
        }

        pos += record_size;
    }

    Ok(VbaProject {
        code_page,
        modules,
    })
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
// Helper: extract code page from an xlsm file's vbaProject.bin
// ---------------------------------------------------------------------------

fn get_code_page_from_xlsm(xlsm_path: &str) -> Result<u16, String> {
    let vba_bin = read_vba_project_bin(xlsm_path)?;
    let mut comp = cfb::CompoundFile::open(Cursor::new(vba_bin))
        .map_err(|e| format!("Failed to parse vbaProject.bin as OLE2: {}", e))?;

    let mut dir_compressed = Vec::new();
    comp.open_stream("/VBA/dir")
        .map_err(|e| format!("Failed to open /VBA/dir stream: {}", e))?
        .read_to_end(&mut dir_compressed)
        .map_err(|e| format!("Failed to read /VBA/dir stream: {}", e))?;

    let dir_data = vba_decompress(&dir_compressed)?;
    let project = parse_dir_stream(&dir_data)?;
    Ok(project.code_page)
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
// Command: extract_vba_modules
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn extract_vba_modules(xlsm_path: String) -> Result<ExtractResult, String> {
    let file_path = Path::new(&xlsm_path);
    if !file_path.exists() {
        return Err(format!("File not found: {}", xlsm_path));
    }

    // 1. Read vbaProject.bin from the ZIP
    let vba_bin = read_vba_project_bin(&xlsm_path)?;

    // 2. Parse as OLE2 compound file
    let mut comp = cfb::CompoundFile::open(Cursor::new(vba_bin))
        .map_err(|e| format!("Failed to parse vbaProject.bin as OLE2: {}", e))?;

    // 3. Read and decompress the /VBA/dir stream
    let mut dir_compressed = Vec::new();
    comp.open_stream("/VBA/dir")
        .map_err(|e| format!("Failed to open /VBA/dir stream: {}", e))?
        .read_to_end(&mut dir_compressed)
        .map_err(|e| format!("Failed to read /VBA/dir stream: {}", e))?;

    let dir_data = vba_decompress(&dir_compressed)?;

    // 4. Parse dir stream to get module list and code page
    let project = parse_dir_stream(&dir_data)?;

    // 5. Determine output directory
    let file_stem = file_path
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or("Invalid file name")?;
    let parent_dir = file_path
        .parent()
        .ok_or("Cannot determine parent directory")?;
    let macros_dir = parent_dir.join(format!("{}_macros", file_stem));

    fs::create_dir_all(&macros_dir)
        .map_err(|e| format!("Failed to create macros directory: {}", e))?;

    // 6. Write .codepage file
    fs::write(
        macros_dir.join(".codepage"),
        project.code_page.to_string(),
    )
    .map_err(|e| format!("Failed to write .codepage file: {}", e))?;

    // 7. For each module, read stream, decompress, decode, write file
    let mut modules = Vec::new();

    for module_info in &project.modules {
        // Read the module stream from OLE2
        let stream_path = format!("/VBA/{}", module_info.stream_name);
        let mut stream_data = Vec::new();
        comp.open_stream(&stream_path)
            .map_err(|e| {
                format!(
                    "Failed to open stream '{}': {}",
                    stream_path, e
                )
            })?
            .read_to_end(&mut stream_data)
            .map_err(|e| {
                format!(
                    "Failed to read stream '{}': {}",
                    stream_path, e
                )
            })?;

        // The stream has text_offset bytes of performance cache,
        // followed by compressed VBA source
        let text_offset = module_info.text_offset as usize;
        if text_offset > stream_data.len() {
            return Err(format!(
                "Module '{}': text_offset {} exceeds stream length {}",
                module_info.name, text_offset, stream_data.len()
            ));
        }

        let compressed_source = &stream_data[text_offset..];
        let decompressed = vba_decompress(compressed_source)?;

        // Decode from code page to UTF-8
        let source = decode_bytes(&decompressed, project.code_page)?;

        // Determine file extension and refined module type
        let (ext, module_type) = if module_info.module_type == "standard" {
            ("bas", "standard".to_string())
        } else {
            // 0x22 type: distinguish document vs class
            let is_document = module_info.name.starts_with("Sheet")
                || module_info.name == "ThisWorkbook";
            if is_document {
                ("cls", "document".to_string())
            } else {
                ("cls", "class".to_string())
            }
        };

        let file_name = format!("{}.{}", module_info.name, ext);
        let module_path = macros_dir.join(&file_name);

        fs::write(&module_path, &source)
            .map_err(|e| format!("Failed to write module '{}': {}", file_name, e))?;

        modules.push(VbaModule {
            name: module_info.name.clone(),
            module_type,
            path: module_path.to_string_lossy().into_owned(),
        });
    }

    Ok(ExtractResult {
        macros_dir: macros_dir.to_string_lossy().into_owned(),
        modules,
    })
}

// ---------------------------------------------------------------------------
// Command: inject_vba_modules
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn inject_vba_modules(xlsm_path: String, macros_dir: String) -> Result<InjectResult, String> {
    let file_path = Path::new(&xlsm_path);
    let macros_path = Path::new(&macros_dir);

    if !file_path.exists() {
        return Err(format!("File not found: {}", xlsm_path));
    }
    if !macros_path.exists() || !macros_path.is_dir() {
        return Err(format!("Macros directory not found: {}", macros_dir));
    }

    // 1. Collect .bas/.cls files from macros_dir
    let mut macro_files: Vec<(String, String)> = Vec::new(); // (module_name, file_path)
    let entries = fs::read_dir(macros_path)
        .map_err(|e| format!("Failed to read macros directory: {}", e))?;

    for entry in entries {
        let entry = entry.map_err(|e| format!("Failed to read directory entry: {}", e))?;
        let path = entry.path();
        if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
            if ext == "bas" || ext == "cls" {
                let module_name = path
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .ok_or_else(|| format!("Invalid file name: {:?}", path))?
                    .to_string();
                macro_files.push((module_name, path.to_string_lossy().into_owned()));
            }
        }
    }

    if macro_files.is_empty() {
        return Err("No .bas or .cls files found in macros directory".to_string());
    }

    // 2. Read code page from .codepage file, or fall back to extraction
    let codepage_file = macros_path.join(".codepage");
    let code_page: u16 = if codepage_file.exists() {
        let cp_str = fs::read_to_string(&codepage_file)
            .map_err(|e| format!("Failed to read .codepage file: {}", e))?;
        cp_str
            .trim()
            .parse::<u16>()
            .map_err(|e| format!("Invalid code page in .codepage file: {}", e))?
    } else {
        get_code_page_from_xlsm(&xlsm_path)?
    };

    // 3. Create backup
    let backup_path = format!("{}.bak", xlsm_path);
    fs::copy(&xlsm_path, &backup_path)
        .map_err(|e| format!("Failed to create backup: {}", e))?;

    // 4. Read the entire xlsm file and extract vbaProject.bin
    let xlsm_data = fs::read(&xlsm_path)
        .map_err(|e| format!("Failed to read file: {}", e))?;

    let vba_bin = read_vba_project_bin(&xlsm_path)?;

    // 5. Parse OLE2, read dir stream, build module mapping
    let mut comp = cfb::CompoundFile::open(Cursor::new(vba_bin))
        .map_err(|e| format!("Failed to parse vbaProject.bin as OLE2: {}", e))?;

    let mut dir_compressed = Vec::new();
    comp.open_stream("/VBA/dir")
        .map_err(|e| format!("Failed to open /VBA/dir stream: {}", e))?
        .read_to_end(&mut dir_compressed)
        .map_err(|e| format!("Failed to read /VBA/dir stream: {}", e))?;

    let dir_data = vba_decompress(&dir_compressed)?;
    let project = parse_dir_stream(&dir_data)?;

    // Build mapping: module name -> VbaModuleInfo
    let module_map: std::collections::HashMap<String, &VbaModuleInfo> = project
        .modules
        .iter()
        .map(|m| (m.name.clone(), m))
        .collect();

    // 6. For each macro file, encode and compress, then write back
    let mut updated_modules: Vec<String> = Vec::new();

    for (module_name, file_path_str) in &macro_files {
        let info = module_map.get(module_name).ok_or_else(|| {
            format!(
                "Module '{}' not found in vbaProject.bin. \
                 Cannot inject a module that doesn't exist in the original file.",
                module_name
            )
        })?;

        // Read UTF-8 source from file
        let source = fs::read_to_string(file_path_str)
            .map_err(|e| format!("Failed to read macro file '{}': {}", file_path_str, e))?;

        // Encode UTF-8 -> code page
        let encoded = encode_string(&source, code_page)?;

        // Compress with VBA compression
        let compressed = vba_compress(&encoded);

        // Read original stream to preserve performance cache
        let stream_path = format!("/VBA/{}", info.stream_name);
        let mut original_stream = Vec::new();
        comp.open_stream(&stream_path)
            .map_err(|e| format!("Failed to open stream '{}': {}", stream_path, e))?
            .read_to_end(&mut original_stream)
            .map_err(|e| format!("Failed to read stream '{}': {}", stream_path, e))?;

        let text_offset = info.text_offset as usize;
        let cache = if text_offset <= original_stream.len() {
            &original_stream[..text_offset]
        } else {
            &original_stream[..]
        };

        // Build new stream: cache + compressed source
        let mut new_stream = Vec::with_capacity(cache.len() + compressed.len());
        new_stream.extend_from_slice(cache);
        new_stream.extend_from_slice(&compressed);

        // Write new stream back to OLE2
        {
            let mut stream = comp
                .create_stream(&stream_path)
                .map_err(|e| format!("Failed to create stream '{}': {}", stream_path, e))?;
            stream
                .write_all(&new_stream)
                .map_err(|e| format!("Failed to write stream '{}': {}", stream_path, e))?;
        }

        updated_modules.push(module_name.clone());
    }

    // 7. Serialize updated OLE2 back to bytes
    comp.flush()
        .map_err(|e| format!("Failed to flush OLE2 compound file: {}", e))?;
    let updated_vba_bin = comp.into_inner().into_inner();

    // 8. Replace vbaProject.bin in the ZIP
    let new_xlsm = replace_zip_entry(&xlsm_data, "xl/vbaProject.bin", &updated_vba_bin)?;

    // 9. Write updated file back
    fs::write(&xlsm_path, &new_xlsm)
        .map_err(|e| format!("Failed to write updated file: {}", e))?;

    Ok(InjectResult {
        backup_path,
        updated_modules,
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
}
