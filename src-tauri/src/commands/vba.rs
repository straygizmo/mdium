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
                    if pos + 2 > data.len() {
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

/// Number of bits used for the length field in a copy token,
/// based on the current decompressed offset within the chunk.
fn copy_token_bit_count(decompressed_offset: usize) -> u16 {
    // MS-OVBA 2.4.1.3.19.1
    if decompressed_offset <= 0x0010 {
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
    }
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

#[tauri::command]
pub fn extract_vba_modules(xlsm_path: String) -> Result<ExtractResult, String> {
    Err("Not implemented yet".to_string())
}

#[tauri::command]
pub fn inject_vba_modules(xlsm_path: String, macros_dir: String) -> Result<InjectResult, String> {
    Err("Not implemented yet".to_string())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;

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
        // Repeated data should compress well (compressed < original + overhead)
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
        // Shift_JIS bytes for some common Japanese text
        let sjis_bytes: Vec<u8> = vec![
            0x82, 0xB1, 0x82, 0xF1, 0x82, 0xC9, 0x82, 0xBF, 0x82, 0xCD,
        ]; // "こんにちは" in Shift_JIS
        let compressed = vba_compress(&sjis_bytes);
        let decompressed = vba_decompress(&compressed).expect("decompress failed");
        assert_eq!(decompressed, sjis_bytes);
    }

    #[test]
    fn test_vba_decompress_invalid_signature() {
        let bad_data = vec![0x00, 0x01, 0x02];
        let result = vba_decompress(&bad_data);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Invalid VBA compression signature"));
    }

    #[test]
    fn test_vba_compress_empty() {
        let compressed = vba_compress(b"");
        // Empty input gives just the signature byte
        assert_eq!(compressed, vec![0x01]);
    }
}
