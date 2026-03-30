# Excel マクロ エクスポート/インポート Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `.xlsm` / `.xlam` ファイルのプレビューパネルから VBA マクロモジュールをファイルとしてエクスポート・インポートできるようにする。

**Architecture:** Rust バックエンドに `extract_vba_modules` / `inject_vba_modules` Tauri コマンドを追加。ZIP 展開 → OLE2 (cfb) パース → VBA 圧縮解凍 → Shift_JIS⇔UTF-8 変換を Rust 内で完結。フロントエンドは `invoke()` で呼び出し、既存の `convert-bar` にボタンを追加。

**Tech Stack:** Rust (`zip`, `cfb`, `encoding_rs` クレート), TypeScript/React, Tauri IPC, i18next

**Spec:** `docs/superpowers/specs/2026-03-30-excel-macro-export-import-design.md`

---

## File Structure

### New Files (Rust)
- `src-tauri/src/commands/vba.rs` — `extract_vba_modules` / `inject_vba_modules` Tauri コマンド、VBA 圧縮/解凍、OLE2 パース、エンコーディング変換

### Modified Files
- `src-tauri/Cargo.toml` — `zip`, `cfb`, `encoding_rs` 依存追加
- `src-tauri/src/commands/mod.rs` — `pub mod vba;` 追加
- `src-tauri/src/lib.rs` — コマンド登録に `vba::extract_vba_modules`, `vba::inject_vba_modules` 追加
- `src/shared/lib/constants.ts` — `OFFICE_EXTENSIONS` に `.xlam` 追加
- `src/features/preview/components/PreviewPanel.tsx` — マクロエクスポート/インポートボタンとハンドラ追加
- `src/features/preview/components/OfficePreview.tsx` — `.xlam` 対応
- `src/shared/i18n/locales/ja/editor.json` — マクロ関連 i18n キー追加
- `src/shared/i18n/locales/en/editor.json` — マクロ関連 i18n キー追加

---

### Task 1: Rust 依存クレート追加とモジュール骨格

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Create: `src-tauri/src/commands/vba.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Cargo.toml に依存追加**

`src-tauri/Cargo.toml` の `[dependencies]` セクションに以下を追加:

```toml
zip = "2"
cfb = "0.10"
encoding_rs = "0.8"
```

- [ ] **Step 2: vba.rs モジュール骨格を作成**

`src-tauri/src/commands/vba.rs` を作成:

```rust
use std::io::{Read, Cursor};
use std::path::{Path, PathBuf};
use std::fs;
use std::collections::HashMap;
use serde::Serialize;
use encoding_rs::*;

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

#[tauri::command]
pub fn extract_vba_modules(xlsm_path: String) -> Result<ExtractResult, String> {
    Err("Not implemented yet".to_string())
}

#[tauri::command]
pub fn inject_vba_modules(xlsm_path: String, macros_dir: String) -> Result<InjectResult, String> {
    Err("Not implemented yet".to_string())
}
```

- [ ] **Step 3: mod.rs にモジュール追加**

`src-tauri/src/commands/mod.rs` — 末尾に追加:

```rust
pub mod vba;
```

- [ ] **Step 4: lib.rs にコマンド登録**

`src-tauri/src/lib.rs` の `tauri::generate_handler!` マクロ内、`// Environment variable operations` セクションの後に追加:

```rust
    // VBA macro operations
    commands::vba::extract_vba_modules,
    commands::vba::inject_vba_modules,
```

- [ ] **Step 5: ビルド確認**

Run: `cd src-tauri && cargo check`
Expected: コンパイル成功（警告のみ許容）

- [ ] **Step 6: コミット**

```bash
git add src-tauri/Cargo.toml src-tauri/src/commands/vba.rs src-tauri/src/commands/mod.rs src-tauri/src/lib.rs
git commit -m "feat(vba): add vba module skeleton and dependencies (zip, cfb, encoding_rs)"
```

---

### Task 2: VBA 圧縮解凍の実装

**Files:**
- Modify: `src-tauri/src/commands/vba.rs`

VBA ソースコードは `vbaProject.bin` 内で MS-OVBA 2.4.1 仕様の独自圧縮形式で格納されている。このタスクではその解凍 (decompress) と圧縮 (compress) を実装する。

- [ ] **Step 1: VBA 解凍関数を実装**

`src-tauri/src/commands/vba.rs` の先頭に以下を追加:

```rust
/// Decompress VBA compressed stream (MS-OVBA 2.4.1.3.6).
/// Input: the raw bytes of a compressed container (starting with signature byte 0x01).
/// Output: decompressed byte vector.
fn vba_decompress(data: &[u8]) -> Result<Vec<u8>, String> {
    if data.is_empty() || data[0] != 0x01 {
        return Err("Invalid VBA compressed container: missing signature byte 0x01".to_string());
    }

    let mut result = Vec::new();
    let mut pos = 1; // skip signature byte

    while pos < data.len() {
        if pos + 1 >= data.len() {
            break;
        }
        // Read CompressedChunkHeader (2 bytes, little-endian)
        let header = u16::from_le_bytes([data[pos], data[pos + 1]]);
        pos += 2;

        let chunk_size = (header & 0x0FFF) as usize + 3; // CompressedChunkSize + 3
        let is_compressed = (header >> 15) & 1 == 1;

        if !is_compressed {
            // Raw chunk: copy 4096 bytes directly
            let end = (pos + 4096).min(data.len());
            result.extend_from_slice(&data[pos..end]);
            pos = end;
            continue;
        }

        let chunk_end = (pos + chunk_size - 2).min(data.len());
        let decompressed_start = result.len();

        while pos < chunk_end {
            if pos >= data.len() {
                break;
            }
            let flag_byte = data[pos];
            pos += 1;

            for bit_index in 0..8u8 {
                if pos >= chunk_end {
                    break;
                }

                if (flag_byte >> bit_index) & 1 == 0 {
                    // Literal token
                    result.push(data[pos]);
                    pos += 1;
                } else {
                    // Copy token
                    if pos + 1 >= data.len() {
                        return Err("Unexpected end of compressed data in copy token".to_string());
                    }
                    let token = u16::from_le_bytes([data[pos], data[pos + 1]]);
                    pos += 2;

                    // Calculate bit sizes based on decompressed chunk offset
                    let decompressed_current = result.len() - decompressed_start;
                    let bit_count = (16 - (decompressed_current.max(1) as f64).log2().ceil() as u16).max(4);
                    let length_mask = 0xFFFFu16 >> bit_count;
                    let offset_mask = !length_mask;

                    let length = ((token & length_mask) + 3) as usize;
                    let offset = ((token & offset_mask) >> (16 - bit_count)) as usize + 1;

                    for _ in 0..length {
                        let src_pos = result.len() - offset;
                        let byte = result[src_pos];
                        result.push(byte);
                    }
                }
            }
        }
    }

    Ok(result)
}

/// Compress data into VBA compressed stream format (MS-OVBA 2.4.1.3.7).
fn vba_compress(data: &[u8]) -> Vec<u8> {
    let mut result = vec![0x01u8]; // signature byte

    let mut pos = 0;
    while pos < data.len() {
        let chunk_start = pos;
        let chunk_end = (pos + 4096).min(data.len());

        let mut compressed_chunk = Vec::new();
        let mut current = pos;

        while current < chunk_end {
            let mut flag_byte: u8 = 0;
            let flag_pos = compressed_chunk.len();
            compressed_chunk.push(0); // placeholder for flag byte

            for bit_index in 0..8u8 {
                if current >= chunk_end {
                    break;
                }

                let decompressed_offset = current - chunk_start;

                // Try to find a match in the decompressed buffer
                let bit_count = if decompressed_offset > 0 {
                    (16 - (decompressed_offset as f64).log2().ceil() as u16).max(4)
                } else {
                    12
                };
                let max_length = (0xFFFFu16 >> bit_count) as usize + 3;
                let max_offset = (1u16 << (16 - bit_count)) as usize;

                let mut best_length = 0usize;
                let mut best_offset = 0usize;

                if decompressed_offset > 0 {
                    let search_start = if decompressed_offset > max_offset {
                        current - max_offset
                    } else {
                        chunk_start
                    };

                    let mut candidate = search_start;
                    while candidate < current {
                        let mut length = 0;
                        while length < max_length
                            && current + length < chunk_end
                            && data[candidate + length] == data[current + length]
                        {
                            length += 1;
                        }
                        if length >= 3 && length > best_length {
                            best_length = length;
                            best_offset = current - candidate;
                        }
                        candidate += 1;
                    }
                }

                if best_length >= 3 {
                    // Copy token
                    flag_byte |= 1 << bit_index;
                    let length_mask = 0xFFFFu16 >> bit_count;
                    let token = (((best_offset - 1) as u16) << (16 - bit_count))
                        | ((best_length as u16 - 3) & length_mask);
                    compressed_chunk.push(token as u8);
                    compressed_chunk.push((token >> 8) as u8);
                    current += best_length;
                } else {
                    // Literal token
                    compressed_chunk.push(data[current]);
                    current += 1;
                }
            }

            compressed_chunk[flag_pos] = flag_byte;
        }

        // Check if compressed is actually smaller
        let raw_size = chunk_end - chunk_start;
        if compressed_chunk.len() < raw_size {
            // Write compressed chunk header
            let chunk_size = (compressed_chunk.len() + 2 - 3) as u16;
            let header = 0x8000u16 | (chunk_size & 0x0FFF);
            result.push(header as u8);
            result.push((header >> 8) as u8);
            result.extend_from_slice(&compressed_chunk);
        } else {
            // Write raw chunk
            let header = ((raw_size - 3) as u16) & 0x0FFF;
            result.push(header as u8);
            result.push((header >> 8) as u8);
            result.extend_from_slice(&data[chunk_start..chunk_end]);
            // Pad to 4096 if needed
            for _ in raw_size..4096 {
                result.push(0);
            }
        }

        pos = chunk_end;
    }

    result
}
```

- [ ] **Step 2: ユニットテスト追加**

`src-tauri/src/commands/vba.rs` の末尾に追加:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_vba_decompress_roundtrip() {
        let original = b"Sub Hello()\r\n    MsgBox \"Hello, World!\"\r\nEnd Sub\r\n";
        let compressed = vba_compress(original);
        let decompressed = vba_decompress(&compressed).unwrap();
        assert_eq!(decompressed, original);
    }

    #[test]
    fn test_vba_decompress_repeated_data() {
        // Repeated data should compress well with copy tokens
        let original = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA".as_bytes();
        let compressed = vba_compress(original);
        let decompressed = vba_decompress(&compressed).unwrap();
        assert_eq!(decompressed, original);
    }

    #[test]
    fn test_vba_decompress_japanese() {
        // Shift_JIS encoded Japanese text (こんにちは = 0x82B1 0x82F1 0x82C9 0x82BF 0x82CD)
        let original: Vec<u8> = vec![
            0x82, 0xB1, 0x82, 0xF1, 0x82, 0xC9, 0x82, 0xBF, 0x82, 0xCD,
        ];
        let compressed = vba_compress(&original);
        let decompressed = vba_decompress(&compressed).unwrap();
        assert_eq!(decompressed, original);
    }

    #[test]
    fn test_vba_decompress_invalid_signature() {
        let result = vba_decompress(&[0x00, 0x01, 0x02]);
        assert!(result.is_err());
    }

    #[test]
    fn test_vba_compress_empty() {
        let compressed = vba_compress(&[]);
        assert_eq!(compressed, vec![0x01]); // Just signature byte
    }
}
```

- [ ] **Step 3: テスト実行**

Run: `cd src-tauri && cargo test --lib commands::vba::tests`
Expected: 全テスト PASS

- [ ] **Step 4: コミット**

```bash
git add src-tauri/src/commands/vba.rs
git commit -m "feat(vba): implement VBA compress/decompress (MS-OVBA 2.4.1)"
```

---

### Task 3: VBA プロジェクト パース (dir ストリーム解析 + モジュール抽出)

**Files:**
- Modify: `src-tauri/src/commands/vba.rs`

`vbaProject.bin` は OLE2 Compound File で、内部に `VBA/dir` (圧縮されたディレクトリストリーム) と各モジュールのストリームを持つ。このタスクでは `dir` ストリームをパースしてモジュール一覧を取得し、各モジュールのソースを抽出する。

- [ ] **Step 1: dir ストリーム パーサーを実装**

`src-tauri/src/commands/vba.rs` に以下を追加 (`vba_compress` 関数の後):

```rust
/// Parsed VBA module info from the dir stream.
#[derive(Debug, Clone)]
struct VbaModuleInfo {
    name: String,
    stream_name: String,
    module_type: u16, // 0x21 = procedural (standard), 0x22 = class/document
    text_offset: u32, // offset within compressed stream where source starts
}

/// Parsed VBA project info.
struct VbaProject {
    code_page: u16,
    modules: Vec<VbaModuleInfo>,
}

/// Parse the decompressed 'dir' stream to extract project info and module list.
/// Reference: MS-OVBA 2.3.4.2
fn parse_dir_stream(data: &[u8]) -> Result<VbaProject, String> {
    let mut pos = 0;
    let mut code_page: u16 = 1252; // default to Windows-1252
    let mut modules: Vec<VbaModuleInfo> = Vec::new();

    // Helper to read u16 LE
    let read_u16 = |p: usize| -> u16 {
        if p + 1 < data.len() {
            u16::from_le_bytes([data[p], data[p + 1]])
        } else {
            0
        }
    };
    let read_u32 = |p: usize| -> u32 {
        if p + 3 < data.len() {
            u32::from_le_bytes([data[p], data[p + 1], data[p + 2], data[p + 3]])
        } else {
            0
        }
    };

    // Scan through records
    while pos + 6 <= data.len() {
        let record_id = read_u16(pos);
        let record_size = read_u32(pos + 2) as usize;
        let record_data_start = pos + 6;

        match record_id {
            0x0003 => {
                // PROJECTCODEPAGE
                if record_size >= 2 {
                    code_page = read_u16(record_data_start);
                }
            }
            0x000F => {
                // MODULENAME - start of a module record block
                let name_bytes = &data[record_data_start..record_data_start + record_size];
                let name = decode_bytes(name_bytes, code_page)?;

                let mut mod_pos = record_data_start + record_size;
                let mut stream_name = name.clone();
                let mut module_type: u16 = 0x21;
                let mut text_offset: u32 = 0;

                // Parse sub-records until MODULEEND (0x002B)
                while mod_pos + 6 <= data.len() {
                    let sub_id = read_u16(mod_pos);
                    let sub_size = read_u32(mod_pos + 2) as usize;
                    let sub_data_start = mod_pos + 6;

                    match sub_id {
                        0x0047 => {
                            // MODULENAMEUNICODE
                            // UTF-16LE encoded name
                            if sub_size >= 2 {
                                let utf16_bytes = &data[sub_data_start..sub_data_start + sub_size];
                                let utf16: Vec<u16> = utf16_bytes
                                    .chunks_exact(2)
                                    .map(|c| u16::from_le_bytes([c[0], c[1]]))
                                    .collect();
                                if let Ok(s) = String::from_utf16(&utf16) {
                                    stream_name = s;
                                }
                            }
                        }
                        0x001A => {
                            // MODULESTREAMNAME (code page encoded)
                            // followed by 0x0032 MODULENAMEUNICODE for stream
                        }
                        0x0032 => {
                            // MODULESTREAMNAME unicode
                            if sub_size >= 2 {
                                let utf16_bytes = &data[sub_data_start..sub_data_start + sub_size];
                                let utf16: Vec<u16> = utf16_bytes
                                    .chunks_exact(2)
                                    .map(|c| u16::from_le_bytes([c[0], c[1]]))
                                    .collect();
                                if let Ok(s) = String::from_utf16(&utf16) {
                                    stream_name = s;
                                }
                            }
                        }
                        0x0021 => {
                            // MODULETYPE procedural (standard module)
                            module_type = 0x21;
                        }
                        0x0022 => {
                            // MODULETYPE class/document
                            module_type = 0x22;
                        }
                        0x0031 => {
                            // MODULEOFFSET - text offset within compressed stream
                            if sub_size >= 4 {
                                text_offset = read_u32(sub_data_start);
                            }
                        }
                        0x002B => {
                            // MODULEEND
                            break;
                        }
                        _ => {}
                    }

                    mod_pos = sub_data_start + sub_size;
                }

                modules.push(VbaModuleInfo {
                    name,
                    stream_name,
                    module_type,
                    text_offset,
                });

                pos = mod_pos + 6; // skip past MODULEEND record
                continue;
            }
            _ => {}
        }

        pos = record_data_start + record_size;
    }

    Ok(VbaProject { code_page, modules })
}
```

- [ ] **Step 2: エンコーディング変換ヘルパーを実装**

`src-tauri/src/commands/vba.rs` に追加 (parse_dir_stream の前):

```rust
/// Decode bytes from a given Windows code page to a Rust String (UTF-8).
fn decode_bytes(bytes: &[u8], code_page: u16) -> Result<String, String> {
    let encoding = match code_page {
        932 => SHIFT_JIS,
        936 => GBK,
        949 => EUC_KR,
        950 => BIG5,
        1250 => WINDOWS_1250,
        1251 => WINDOWS_1251,
        1252 => WINDOWS_1252,
        1253 => WINDOWS_1253,
        1254 => WINDOWS_1254,
        1255 => WINDOWS_1255,
        1256 => WINDOWS_1256,
        1257 => WINDOWS_1257,
        1258 => WINDOWS_1258,
        10000 => MACINTOSH,
        65001 => UTF_8,
        _ => WINDOWS_1252, // fallback
    };

    let (result, _, had_errors) = encoding.decode(bytes);
    if had_errors {
        Err(format!(
            "Failed to decode bytes with code page {}: contains unmappable characters",
            code_page
        ))
    } else {
        Ok(result.into_owned())
    }
}

/// Encode a UTF-8 string to bytes in a given Windows code page.
fn encode_string(text: &str, code_page: u16) -> Result<Vec<u8>, String> {
    let encoding = match code_page {
        932 => SHIFT_JIS,
        936 => GBK,
        949 => EUC_KR,
        950 => BIG5,
        1250 => WINDOWS_1250,
        1251 => WINDOWS_1251,
        1252 => WINDOWS_1252,
        1253 => WINDOWS_1253,
        1254 => WINDOWS_1254,
        1255 => WINDOWS_1255,
        1256 => WINDOWS_1256,
        1257 => WINDOWS_1257,
        1258 => WINDOWS_1258,
        10000 => MACINTOSH,
        65001 => UTF_8,
        _ => WINDOWS_1252,
    };

    let (result, _, had_errors) = encoding.encode(text);
    if had_errors {
        Err(format!(
            "Failed to encode text to code page {}: contains characters not representable in this encoding",
            code_page
        ))
    } else {
        Ok(result.into_owned())
    }
}
```

- [ ] **Step 3: テスト追加**

`tests` モジュール内に追加:

```rust
    #[test]
    fn test_decode_shift_jis() {
        // "こんにちは" in Shift_JIS
        let bytes: Vec<u8> = vec![0x82, 0xB1, 0x82, 0xF1, 0x82, 0xC9, 0x82, 0xBF, 0x82, 0xCD];
        let result = decode_bytes(&bytes, 932).unwrap();
        assert_eq!(result, "こんにちは");
    }

    #[test]
    fn test_encode_shift_jis() {
        let bytes = encode_string("こんにちは", 932).unwrap();
        let expected: Vec<u8> = vec![0x82, 0xB1, 0x82, 0xF1, 0x82, 0xC9, 0x82, 0xBF, 0x82, 0xCD];
        assert_eq!(bytes, expected);
    }

    #[test]
    fn test_decode_encode_roundtrip_ascii() {
        let text = "Sub Hello()\r\nEnd Sub\r\n";
        let encoded = encode_string(text, 1252).unwrap();
        let decoded = decode_bytes(&encoded, 1252).unwrap();
        assert_eq!(decoded, text);
    }
```

- [ ] **Step 4: テスト実行**

Run: `cd src-tauri && cargo test --lib commands::vba::tests`
Expected: 全テスト PASS

- [ ] **Step 5: コミット**

```bash
git add src-tauri/src/commands/vba.rs
git commit -m "feat(vba): implement dir stream parser and encoding helpers"
```

---

### Task 4: extract_vba_modules コマンド実装

**Files:**
- Modify: `src-tauri/src/commands/vba.rs`

- [ ] **Step 1: extract_vba_modules を実装**

`src-tauri/src/commands/vba.rs` の `extract_vba_modules` 関数を以下で置換:

```rust
#[tauri::command]
pub fn extract_vba_modules(xlsm_path: String) -> Result<ExtractResult, String> {
    let path = Path::new(&xlsm_path);
    if !path.exists() {
        return Err(format!("File not found: {}", xlsm_path));
    }

    // Determine output directory: {filename}_macros/
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or("Invalid file name")?;
    let parent = path
        .parent()
        .ok_or("Cannot determine parent directory")?;
    let macros_dir = parent.join(format!("{}_macros", stem));

    // Read the ZIP archive
    let file = fs::File::open(&xlsm_path)
        .map_err(|e| format!("Failed to open file: {}", e))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| format!("Failed to read ZIP archive: {}", e))?;

    // Find and read vbaProject.bin
    let vba_bin = {
        let mut entry = archive
            .by_name("xl/vbaProject.bin")
            .map_err(|_| "No VBA macros found in this file (xl/vbaProject.bin not present)".to_string())?;
        let mut buf = Vec::new();
        entry.read_to_end(&mut buf)
            .map_err(|e| format!("Failed to read vbaProject.bin: {}", e))?;
        buf
    };

    // Parse as OLE2 Compound File
    let cursor = Cursor::new(&vba_bin);
    let mut comp = cfb::CompoundFile::open(cursor)
        .map_err(|e| format!("Failed to parse vbaProject.bin as OLE2: {}", e))?;

    // Read and decompress the dir stream
    let dir_compressed = {
        let mut stream = comp
            .open_stream("/VBA/dir")
            .map_err(|e| format!("Failed to open VBA/dir stream: {}", e))?;
        let mut buf = Vec::new();
        stream.read_to_end(&mut buf)
            .map_err(|e| format!("Failed to read dir stream: {}", e))?;
        buf
    };
    let dir_data = vba_decompress(&dir_compressed)?;

    // Parse dir stream to get project info and module list
    let project = parse_dir_stream(&dir_data)?;

    if project.modules.is_empty() {
        return Err("No VBA macros found in this file".to_string());
    }

    // Create output directory
    fs::create_dir_all(&macros_dir)
        .map_err(|e| format!("Failed to create macros directory: {}", e))?;

    // Save code page file
    fs::write(macros_dir.join(".codepage"), project.code_page.to_string())
        .map_err(|e| format!("Failed to write .codepage file: {}", e))?;

    // Extract each module
    let mut modules = Vec::new();
    for module in &project.modules {
        let stream_path = format!("/VBA/{}", module.stream_name);
        let compressed = {
            let mut stream = comp
                .open_stream(&stream_path)
                .map_err(|e| format!("Failed to open stream '{}': {}", stream_path, e))?;
            let mut buf = Vec::new();
            stream.read_to_end(&mut buf)
                .map_err(|e| format!("Failed to read stream '{}': {}", stream_path, e))?;
            buf
        };

        // The module stream has text_offset bytes of performance cache before the compressed source
        let source_data = if (module.text_offset as usize) < compressed.len() {
            &compressed[module.text_offset as usize..]
        } else {
            &compressed
        };

        let decompressed = vba_decompress(source_data)?;

        // Decode from code page to UTF-8
        let source = decode_bytes(&decompressed, project.code_page)?;

        // Determine file extension and module type string
        let (ext, type_str) = if module.module_type == 0x21 {
            (".bas", "standard")
        } else {
            // Check if it's a document module (ThisWorkbook, Sheet*)
            let name_lower = module.name.to_lowercase();
            if name_lower.starts_with("sheet") || name_lower == "thisworkbook" {
                (".cls", "document")
            } else {
                (".cls", "class")
            }
        };

        let file_name = format!("{}{}", module.name, ext);
        let file_path = macros_dir.join(&file_name);

        fs::write(&file_path, &source)
            .map_err(|e| format!("Failed to write module '{}': {}", file_name, e))?;

        modules.push(VbaModule {
            name: module.name.clone(),
            module_type: type_str.to_string(),
            path: file_path.to_string_lossy().to_string(),
        });
    }

    Ok(ExtractResult {
        macros_dir: macros_dir.to_string_lossy().to_string(),
        modules,
    })
}
```

- [ ] **Step 2: ビルド確認**

Run: `cd src-tauri && cargo check`
Expected: コンパイル成功

- [ ] **Step 3: コミット**

```bash
git add src-tauri/src/commands/vba.rs
git commit -m "feat(vba): implement extract_vba_modules command"
```

---

### Task 5: inject_vba_modules コマンド実装

**Files:**
- Modify: `src-tauri/src/commands/vba.rs`

- [ ] **Step 1: inject_vba_modules を実装**

`src-tauri/src/commands/vba.rs` の `inject_vba_modules` 関数を以下で置換:

```rust
#[tauri::command]
pub fn inject_vba_modules(xlsm_path: String, macros_dir: String) -> Result<InjectResult, String> {
    let path = Path::new(&xlsm_path);
    let macros_path = Path::new(&macros_dir);

    if !path.exists() {
        return Err(format!("File not found: {}", xlsm_path));
    }
    if !macros_path.exists() || !macros_path.is_dir() {
        return Err("Macro folder not found".to_string());
    }

    // Collect .bas and .cls files from macros_dir
    let macro_files: Vec<(String, String)> = fs::read_dir(&macros_path)
        .map_err(|e| format!("Failed to read macros directory: {}", e))?
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let file_name = entry.file_name().to_string_lossy().to_string();
            let lower = file_name.to_lowercase();
            if lower.ends_with(".bas") || lower.ends_with(".cls") {
                let module_name = file_name.rsplit_once('.').map(|(n, _)| n.to_string())?;
                let content = fs::read_to_string(entry.path()).ok()?;
                Some((module_name, content))
            } else {
                None
            }
        })
        .collect();

    if macro_files.is_empty() {
        return Err("No .bas or .cls files found to import".to_string());
    }

    // Read code page
    let code_page: u16 = {
        let cp_path = macros_path.join(".codepage");
        if cp_path.exists() {
            fs::read_to_string(&cp_path)
                .map_err(|e| format!("Failed to read .codepage: {}", e))?
                .trim()
                .parse()
                .map_err(|e| format!("Invalid .codepage value: {}", e))?
        } else {
            // Fallback: read from vbaProject.bin
            get_code_page_from_xlsm(&xlsm_path)?
        }
    };

    // Create backup
    let backup_path = format!("{}.bak", xlsm_path);
    fs::copy(&xlsm_path, &backup_path)
        .map_err(|e| format!("Failed to create backup: {}", e))?;

    // Read the original ZIP file
    let original_bytes = fs::read(&xlsm_path)
        .map_err(|e| format!("Failed to read file: {}", e))?;

    // Extract vbaProject.bin from ZIP
    let mut archive = zip::ZipArchive::new(Cursor::new(&original_bytes))
        .map_err(|e| format!("Failed to read ZIP archive: {}", e))?;

    let vba_bin = {
        let mut entry = archive
            .by_name("xl/vbaProject.bin")
            .map_err(|_| "No vbaProject.bin found in file".to_string())?;
        let mut buf = Vec::new();
        entry.read_to_end(&mut buf)
            .map_err(|e| format!("Failed to read vbaProject.bin: {}", e))?;
        buf
    };

    // Parse OLE2
    let mut comp = cfb::CompoundFile::open(Cursor::new(vba_bin.clone()))
        .map_err(|e| format!("Failed to parse vbaProject.bin: {}", e))?;

    // Read and parse dir stream
    let dir_compressed = {
        let mut stream = comp.open_stream("/VBA/dir")
            .map_err(|e| format!("Failed to open VBA/dir: {}", e))?;
        let mut buf = Vec::new();
        stream.read_to_end(&mut buf)
            .map_err(|e| format!("Failed to read dir stream: {}", e))?;
        buf
    };
    let dir_data = vba_decompress(&dir_compressed)?;
    let project = parse_dir_stream(&dir_data)?;

    // Build module name → stream info mapping
    let module_map: std::collections::HashMap<String, &VbaModuleInfo> = project
        .modules
        .iter()
        .map(|m| (m.name.clone(), m))
        .collect();

    let mut updated_modules = Vec::new();

    for (module_name, source_utf8) in &macro_files {
        let module_info = match module_map.get(module_name.as_str()) {
            Some(info) => info,
            None => {
                // Module not found in vbaProject.bin - skip
                continue;
            }
        };

        // Encode UTF-8 → code page
        let encoded = encode_string(source_utf8, code_page)?;

        // Compress with VBA compression
        let compressed = vba_compress(&encoded);

        // Read original stream to preserve performance cache (bytes before text_offset)
        let stream_path = format!("/VBA/{}", module_info.stream_name);
        let original_stream = {
            let mut stream = comp.open_stream(&stream_path)
                .map_err(|e| format!("Failed to open stream '{}': {}", stream_path, e))?;
            let mut buf = Vec::new();
            stream.read_to_end(&mut buf)
                .map_err(|e| format!("Failed to read stream: {}", e))?;
            buf
        };

        // Build new stream: performance cache + compressed source
        let mut new_stream = Vec::new();
        let offset = module_info.text_offset as usize;
        if offset <= original_stream.len() {
            new_stream.extend_from_slice(&original_stream[..offset]);
        }
        new_stream.extend_from_slice(&compressed);

        // Write back to OLE2
        let mut writer = comp.create_stream(&stream_path)
            .map_err(|e| format!("Failed to write stream '{}': {}", stream_path, e))?;
        std::io::Write::write_all(&mut writer, &new_stream)
            .map_err(|e| format!("Failed to write stream data: {}", e))?;

        updated_modules.push(module_name.clone());
    }

    if updated_modules.is_empty() {
        return Err("No matching modules found to update. Module names in .bas/.cls files must match existing VBA module names.".to_string());
    }

    // Serialize updated OLE2 back to bytes
    let mut updated_vba_bin = Vec::new();
    comp.save(&mut updated_vba_bin)
        .map_err(|e| format!("Failed to serialize vbaProject.bin: {}", e))?;

    // Rebuild ZIP with updated vbaProject.bin
    let output_bytes = replace_zip_entry(&original_bytes, "xl/vbaProject.bin", &updated_vba_bin)?;

    // Write output
    fs::write(&xlsm_path, &output_bytes)
        .map_err(|e| format!("Failed to write updated file: {}", e))?;

    Ok(InjectResult {
        backup_path,
        updated_modules,
    })
}

/// Read code page from vbaProject.bin within an xlsm file.
fn get_code_page_from_xlsm(xlsm_path: &str) -> Result<u16, String> {
    let file = fs::File::open(xlsm_path)
        .map_err(|e| format!("Failed to open file: {}", e))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| format!("Failed to read ZIP: {}", e))?;
    let vba_bin = {
        let mut entry = archive
            .by_name("xl/vbaProject.bin")
            .map_err(|_| "No vbaProject.bin found".to_string())?;
        let mut buf = Vec::new();
        entry.read_to_end(&mut buf)
            .map_err(|e| format!("Failed to read vbaProject.bin: {}", e))?;
        buf
    };
    let mut comp = cfb::CompoundFile::open(Cursor::new(&vba_bin))
        .map_err(|e| format!("Failed to parse OLE2: {}", e))?;
    let dir_compressed = {
        let mut stream = comp.open_stream("/VBA/dir")
            .map_err(|e| format!("Failed to open dir: {}", e))?;
        let mut buf = Vec::new();
        stream.read_to_end(&mut buf)
            .map_err(|e| format!("Failed to read dir: {}", e))?;
        buf
    };
    let dir_data = vba_decompress(&dir_compressed)?;
    let project = parse_dir_stream(&dir_data)?;
    Ok(project.code_page)
}

/// Replace a single entry in a ZIP archive, preserving all other entries.
fn replace_zip_entry(
    original_zip: &[u8],
    entry_name: &str,
    new_data: &[u8],
) -> Result<Vec<u8>, String> {
    let mut archive = zip::ZipArchive::new(Cursor::new(original_zip))
        .map_err(|e| format!("Failed to read ZIP: {}", e))?;

    let mut output = Vec::new();
    {
        let mut writer = zip::ZipWriter::new(Cursor::new(&mut output));

        for i in 0..archive.len() {
            let mut entry = archive.by_index(i)
                .map_err(|e| format!("Failed to read ZIP entry {}: {}", i, e))?;
            let name = entry.name().to_string();

            if name == entry_name {
                // Write replacement data with same options
                let options = zip::write::SimpleFileOptions::default()
                    .compression_method(entry.compression());
                writer.start_file(&name, options)
                    .map_err(|e| format!("Failed to start ZIP entry: {}", e))?;
                std::io::Write::write_all(&mut writer, new_data)
                    .map_err(|e| format!("Failed to write ZIP entry: {}", e))?;
            } else {
                // Copy entry as-is
                let mut buf = Vec::new();
                entry.read_to_end(&mut buf)
                    .map_err(|e| format!("Failed to read ZIP entry '{}': {}", name, e))?;
                let options = zip::write::SimpleFileOptions::default()
                    .compression_method(entry.compression());
                writer.start_file(&name, options)
                    .map_err(|e| format!("Failed to start ZIP entry: {}", e))?;
                std::io::Write::write_all(&mut writer, &buf)
                    .map_err(|e| format!("Failed to write ZIP entry: {}", e))?;
            }
        }

        writer.finish()
            .map_err(|e| format!("Failed to finalize ZIP: {}", e))?;
    }

    Ok(output)
}
```

- [ ] **Step 2: ビルド確認**

Run: `cd src-tauri && cargo check`
Expected: コンパイル成功

- [ ] **Step 3: コミット**

```bash
git add src-tauri/src/commands/vba.rs
git commit -m "feat(vba): implement inject_vba_modules command with backup and ZIP replacement"
```

---

### Task 6: フロントエンド — constants.ts と i18n 更新

**Files:**
- Modify: `src/shared/lib/constants.ts`
- Modify: `src/shared/i18n/locales/ja/editor.json`
- Modify: `src/shared/i18n/locales/en/editor.json`

- [ ] **Step 1: constants.ts に .xlam 追加**

`src/shared/lib/constants.ts` 1行目を変更:

```typescript
export const OFFICE_EXTENSIONS = [".docx", ".xlsx", ".xlsm", ".xlam"];
```

- [ ] **Step 2: ja/editor.json にマクロ i18n キー追加**

`src/shared/i18n/locales/ja/editor.json` — `"commandNotRegistered"` の前 (最後のエントリの前) に追加:

```json
  "exportMacros": "マクロのエクスポート",
  "importMacros": "マクロのインポート",
  "exportingMacros": "エクスポート中...",
  "importingMacros": "インポート中...",
  "macroExportSuccess": "{{count}}個のモジュールをエクスポートしました",
  "macroImportSuccess": "{{count}}個のモジュールをインポートしました（バックアップ: .bak）",
  "macroExportNoVba": "このファイルにはVBAマクロが含まれていません",
  "macroDirNotFound": "マクロフォルダが見つかりません",
  "macroImportSkipped": "{{name}} はスキップされました：対応するモジュールが見つかりません",
  "macroNoFiles": "インポート対象のファイルがありません",
```

- [ ] **Step 3: en/editor.json にマクロ i18n キー追加**

`src/shared/i18n/locales/en/editor.json` — 同様の位置に追加:

```json
  "exportMacros": "Export Macros",
  "importMacros": "Import Macros",
  "exportingMacros": "Exporting...",
  "importingMacros": "Importing...",
  "macroExportSuccess": "Exported {{count}} modules",
  "macroImportSuccess": "Imported {{count}} modules (backup: .bak)",
  "macroExportNoVba": "No VBA macros found in this file",
  "macroDirNotFound": "Macro folder not found",
  "macroImportSkipped": "{{name}} was skipped: no matching module found",
  "macroNoFiles": "No files to import",
```

- [ ] **Step 4: コミット**

```bash
git add src/shared/lib/constants.ts src/shared/i18n/locales/ja/editor.json src/shared/i18n/locales/en/editor.json
git commit -m "feat(vba): add .xlam support to constants and macro i18n keys"
```

---

### Task 7: フロントエンド — PreviewPanel にマクロボタン追加

**Files:**
- Modify: `src/features/preview/components/PreviewPanel.tsx`
- Modify: `src/features/preview/components/OfficePreview.tsx`

- [ ] **Step 1: OfficePreview.tsx に .xlam 対応追加**

`src/features/preview/components/OfficePreview.tsx` の54-55行目を変更:

変更前:
```typescript
    if (fileType !== ".xlsx" && fileType !== ".xlsm") return;
```

変更後:
```typescript
    if (fileType !== ".xlsx" && fileType !== ".xlsm" && fileType !== ".xlam") return;
```

- [ ] **Step 2: PreviewPanel.tsx に状態とハンドラを追加**

`src/features/preview/components/PreviewPanel.tsx` — `converting`/`convertError` 状態宣言の後 (288行目の後) に追加:

```typescript
  const [macroExporting, setMacroExporting] = useState(false);
  const [macroImporting, setMacroImporting] = useState(false);
  const [macroError, setMacroError] = useState<string | null>(null);
  const [macroSuccess, setMacroSuccess] = useState<string | null>(null);
```

- [ ] **Step 3: isXlsx 判定に .xlam を追加し、isMacroEnabled を追加**

`src/features/preview/components/PreviewPanel.tsx` の750-752行目を変更:

変更前:
```typescript
  const isXlsx =
    activeTab?.filePath?.toLowerCase().endsWith(".xlsx") ||
    activeTab?.filePath?.toLowerCase().endsWith(".xlsm");
```

変更後:
```typescript
  const isXlsx =
    activeTab?.filePath?.toLowerCase().endsWith(".xlsx") ||
    activeTab?.filePath?.toLowerCase().endsWith(".xlsm") ||
    activeTab?.filePath?.toLowerCase().endsWith(".xlam");
  const isMacroEnabled =
    activeTab?.filePath?.toLowerCase().endsWith(".xlsm") ||
    activeTab?.filePath?.toLowerCase().endsWith(".xlam");
```

- [ ] **Step 4: handleExportMacros ハンドラを追加**

`handleConvertToMarkdown` の後 (784行目の後) に追加:

```typescript
  const handleExportMacros = useCallback(async () => {
    if (!activeTab?.filePath) return;
    setMacroExporting(true);
    setMacroError(null);
    setMacroSuccess(null);
    try {
      const result = await invoke<{ macrosDir: string; modules: { name: string; moduleType: string; path: string }[] }>(
        "extract_vba_modules",
        { xlsmPath: activeTab.filePath }
      );
      setMacroSuccess(t("macroExportSuccess", { count: result.modules.length }));
      onRefreshFileTree?.();
    } catch (e) {
      setMacroError(e instanceof Error ? e.message : String(e));
    } finally {
      setMacroExporting(false);
    }
  }, [activeTab?.filePath, onRefreshFileTree, t]);
```

- [ ] **Step 5: handleImportMacros ハンドラを追加**

`handleExportMacros` の後に追加:

```typescript
  const handleImportMacros = useCallback(async () => {
    if (!activeTab?.filePath) return;
    setMacroImporting(true);
    setMacroError(null);
    setMacroSuccess(null);
    try {
      // Derive macros_dir from file path
      const filePath = activeTab.filePath;
      const lastDot = filePath.lastIndexOf(".");
      const macrosDir = filePath.substring(0, lastDot) + "_macros";

      const result = await invoke<{ backupPath: string; updatedModules: string[] }>(
        "inject_vba_modules",
        { xlsmPath: filePath, macrosDir }
      );
      setMacroSuccess(t("macroImportSuccess", { count: result.updatedModules.length }));

      // Reload binary data to refresh preview
      const bytes = await invoke<number[]>("read_binary_file", { path: filePath });
      const binaryData = new Uint8Array(bytes);
      const tabs = useTabStore.getState().tabs;
      const activeId = useTabStore.getState().activeTabId;
      useTabStore.setState({
        tabs: tabs.map((tab) =>
          tab.id === activeId ? { ...tab, binaryData } : tab
        ),
      });
    } catch (e) {
      setMacroError(e instanceof Error ? e.message : String(e));
    } finally {
      setMacroImporting(false);
    }
  }, [activeTab?.filePath, t]);
```

- [ ] **Step 6: convert-bar にマクロボタンを追加**

`src/features/preview/components/PreviewPanel.tsx` の799-811行目 (isOfficeFile ブロック内の convert-bar) を変更:

変更前:
```tsx
        {(isDocx || isPdf || isXlsx) && (
          <div className="preview-panel__convert-bar">
            <button
              onClick={handleConvertToMarkdown}
              disabled={converting}
            >
              {converting ? t("converting") : t("convertToMarkdown")}
            </button>
            {convertError && (
              <span className="preview-panel__convert-error">{convertError}</span>
            )}
          </div>
        )}
```

変更後:
```tsx
        {(isDocx || isPdf || isXlsx) && (
          <div className="preview-panel__convert-bar">
            <button
              onClick={handleConvertToMarkdown}
              disabled={converting}
            >
              {converting ? t("converting") : t("convertToMarkdown")}
            </button>
            {isMacroEnabled && (
              <>
                <button
                  onClick={handleExportMacros}
                  disabled={macroExporting || macroImporting}
                >
                  {macroExporting ? t("exportingMacros") : t("exportMacros")}
                </button>
                <button
                  onClick={handleImportMacros}
                  disabled={macroImporting || macroExporting}
                >
                  {macroImporting ? t("importingMacros") : t("importMacros")}
                </button>
              </>
            )}
            {convertError && (
              <span className="preview-panel__convert-error">{convertError}</span>
            )}
            {macroError && (
              <span className="preview-panel__convert-error">{macroError}</span>
            )}
            {macroSuccess && (
              <span className="preview-panel__convert-success">{macroSuccess}</span>
            )}
          </div>
        )}
```

- [ ] **Step 7: xlsm/xlam の Markdown 変換にも .xlam を追加**

`src/features/preview/components/PreviewPanel.tsx` の `handleConvertToMarkdown` 内 (763-765行目) を変更:

変更前:
```typescript
      } else if (
        activeTab.filePath.toLowerCase().endsWith(".xlsx") ||
        activeTab.filePath.toLowerCase().endsWith(".xlsm")
      ) {
```

変更後:
```typescript
      } else if (
        activeTab.filePath.toLowerCase().endsWith(".xlsx") ||
        activeTab.filePath.toLowerCase().endsWith(".xlsm") ||
        activeTab.filePath.toLowerCase().endsWith(".xlam")
      ) {
```

- [ ] **Step 8: ビルド確認**

Run: `cd C:/Users/mtmar/source/repos/mdium && npm run build`
Expected: ビルド成功

- [ ] **Step 9: コミット**

```bash
git add src/features/preview/components/PreviewPanel.tsx src/features/preview/components/OfficePreview.tsx
git commit -m "feat(vba): add macro export/import buttons to Excel preview panel"
```

---

### Task 8: CSS スタイリング

**Files:**
- Modify: `src/features/preview/components/PreviewPanel.css`

- [ ] **Step 1: 成功メッセージのスタイルを追加**

`src/features/preview/components/PreviewPanel.css` に追加（既存の `.preview-panel__convert-error` の近くに）:

```css
.preview-panel__convert-success {
  color: #22c55e;
  font-size: 0.85em;
  margin-left: 8px;
}
```

- [ ] **Step 2: コミット**

```bash
git add src/features/preview/components/PreviewPanel.css
git commit -m "feat(vba): add success message styling for macro operations"
```

---

### Task 9: 手動テスト

**Files:** なし（テスト手順のみ）

- [ ] **Step 1: アプリビルドと起動**

Run: `cd C:/Users/mtmar/source/repos/mdium && npm run tauri dev`

- [ ] **Step 2: エクスポートテスト**

1. `.xlsm` ファイルをアプリで開く
2. プレビューパネルに「マクロのエクスポート」ボタンが表示されることを確認
3. ボタンをクリックし、`{ファイル名}_macros/` フォルダが作成されることを確認
4. フォルダ内に `.bas` / `.cls` ファイルと `.codepage` ファイルが存在することを確認
5. ファイルの中身が UTF-8 で読めること（日本語のコメントが文字化けしていないこと）を確認

- [ ] **Step 3: インポートテスト**

1. エクスポートした `.bas` ファイルをテキストエディタで編集（コメント追加等）
2. 「マクロのインポート」ボタンをクリック
3. `.bak` ファイルが作成されることを確認
4. 成功メッセージが表示されることを確認
5. Excel で `.xlsm` ファイルを開き、変更が反映されていることを確認

- [ ] **Step 4: .xlsx ファイルでマクロボタンが表示されないことを確認**

1. `.xlsx` ファイルを開く
2. 「Markdown変換」ボタンのみが表示され、マクロボタンが表示されないことを確認

- [ ] **Step 5: エラーケーステスト**

1. マクロが存在しない `.xlsm` ファイルでエクスポートを試行 → エラーメッセージ確認
2. `_macros/` フォルダが存在しない状態でインポートを試行 → エラーメッセージ確認
