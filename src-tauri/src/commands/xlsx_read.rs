//! Read saved cell values from .xlsx/.xlsm/.xlam workbooks without Excel (calamine).

use std::path::Path;

use calamine::{open_workbook_auto, Data, Reader};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::commands::vba::vba_error;

/// Upper bound on cells returned for a single range.
pub const MAX_READ_CELLS: usize = 20_000;

#[derive(Deserialize, Serialize, Debug, Clone)]
pub struct RangeSpec {
    pub sheet: String,
    #[serde(default)]
    pub range: Option<String>,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct CellBlock {
    pub sheet: String,
    pub range: String,
    pub values: Vec<Vec<Value>>,
}

/// 0 -> "A", 26 -> "AA".
pub fn col_label(col: u32) -> String {
    let mut n = col as u64 + 1;
    let mut out = Vec::new();
    while n > 0 {
        let rem = ((n - 1) % 26) as u8;
        out.push(b'A' + rem);
        n = (n - 1) / 26;
    }
    out.reverse();
    String::from_utf8(out).unwrap_or_default()
}

/// Parse one A1 reference ("b2") into zero-based (row, col).
fn parse_cell(s: &str) -> Result<(u32, u32), String> {
    let s = s.trim().trim_start_matches('$');
    let letters: String = s.chars().take_while(|c| c.is_ascii_alphabetic()).collect();
    let rest = s[letters.len()..].trim_start_matches('$');
    if letters.is_empty() || letters.len() > 3 || rest.is_empty() || !rest.chars().all(|c| c.is_ascii_digit()) {
        return Err(format!("invalid cell reference '{}'", s));
    }
    let mut col: u64 = 0;
    for c in letters.chars() {
        col = col * 26 + (c.to_ascii_uppercase() as u64 - 'A' as u64 + 1);
    }
    let row: u64 = rest.parse().map_err(|_| format!("invalid cell reference '{}'", s))?;
    if row == 0 || row > 1_048_576 || col > 16_384 {
        return Err(format!("cell reference '{}' is out of bounds", s));
    }
    Ok(((row - 1) as u32, (col - 1) as u32))
}

/// Zero-based (row, col) inclusive corners; "A1" alone is a single cell.
pub fn parse_a1_range(s: &str) -> Result<((u32, u32), (u32, u32)), String> {
    let s = s.trim();
    if s.is_empty() {
        return Err("empty range".to_string());
    }
    let (a, b) = match s.split_once(':') {
        Some((a, b)) => (parse_cell(a)?, parse_cell(b)?),
        None => {
            let c = parse_cell(s)?;
            (c, c)
        }
    };
    Ok(((a.0.min(b.0), a.1.min(b.1)), (a.0.max(b.0), a.1.max(b.1))))
}

/// "A1:C10" (or "A1" for a single cell).
pub fn a1_of(range: ((u32, u32), (u32, u32))) -> String {
    let ((r0, c0), (r1, c1)) = range;
    let start = format!("{}{}", col_label(c0), r0 + 1);
    if (r0, c0) == (r1, c1) {
        start
    } else {
        format!("{}:{}{}", start, col_label(c1), r1 + 1)
    }
}

/// Map an Excel COM error code to its display label.
pub fn cell_error_label(com_code: i64) -> Option<&'static str> {
    match com_code {
        -2146826288 => Some("#NULL!"),
        -2146826281 => Some("#DIV/0!"),
        -2146826273 => Some("#VALUE!"),
        -2146826265 => Some("#REF!"),
        -2146826259 => Some("#NAME?"),
        -2146826252 => Some("#NUM!"),
        -2146826246 => Some("#N/A"),
        _ => None,
    }
}

fn data_to_json(d: &Data) -> Value {
    match d {
        Data::Empty => Value::Null,
        Data::Int(i) => Value::from(*i),
        Data::Float(f) => serde_json::Number::from_f64(*f).map(Value::Number).unwrap_or(Value::Null),
        Data::String(s) => Value::String(s.clone()),
        Data::Bool(b) => Value::Bool(*b),
        Data::DateTime(dt) => serde_json::Number::from_f64(dt.as_f64()).map(Value::Number).unwrap_or(Value::Null),
        Data::DateTimeIso(s) | Data::DurationIso(s) => Value::String(s.clone()),
        Data::Error(e) => Value::String(e.to_string()),
    }
}

/// Read the requested ranges. Err is a `vba_error` JSON string.
pub fn read_ranges(path: &Path, ranges: &[RangeSpec]) -> Result<Vec<CellBlock>, String> {
    let ext_ok = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| matches!(e.to_ascii_lowercase().as_str(), "xlsx" | "xlsm" | "xlam"))
        .unwrap_or(false);
    if !ext_ok {
        return Err(vba_error("invalid_workbook", "Only .xlsx, .xlsm and .xlam workbooks can be read."));
    }
    if !path.is_file() {
        return Err(vba_error("invalid_workbook", format!("Workbook not found: {}", path.display())));
    }
    let mut wb = open_workbook_auto(path)
        .map_err(|e| vba_error("read_failed", format!("Failed to open workbook: {}", e)))?;

    let mut blocks = Vec::with_capacity(ranges.len());
    for spec in ranges {
        let sheet = wb
            .worksheet_range(&spec.sheet)
            .map_err(|e| vba_error("invalid_range", format!("Cannot read sheet '{}': {}", spec.sheet, e)))?;
        let corners = match spec.range.as_deref().map(str::trim).filter(|r| !r.is_empty()) {
            Some(r) => parse_a1_range(r)
                .map_err(|m| vba_error("invalid_range", format!("{} (range '{}')", m, r)))?,
            None => match (sheet.start(), sheet.end()) {
                (Some(s), Some(e)) => (s, e),
                _ => ((0, 0), (0, 0)),
            },
        };
        let ((r0, c0), (r1, c1)) = corners;
        let count = (r1 - r0 + 1) as u64 * (c1 - c0 + 1) as u64;
        if count > MAX_READ_CELLS as u64 {
            return Err(vba_error(
                "invalid_range",
                format!("range has {} cells; the limit is {}, narrow the range", count, MAX_READ_CELLS),
            ));
        }
        let values = (r0..=r1)
            .map(|r| {
                (c0..=c1)
                    .map(|c| sheet.get_value((r, c)).map(data_to_json).unwrap_or(Value::Null))
                    .collect()
            })
            .collect();
        blocks.push(CellBlock { sheet: spec.sheet.clone(), range: a1_of(corners), values });
    }
    Ok(blocks)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::path::PathBuf;

    fn fixture() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/xlsx/read_sample.xlsx")
    }

    fn code_of(err: &str) -> String {
        let v: Value = serde_json::from_str(err).unwrap();
        v["error"].as_str().unwrap().to_string()
    }

    #[test]
    fn parses_a1_ranges() {
        assert_eq!(parse_a1_range("A1:C10").unwrap(), ((0, 0), (9, 2)));
        assert_eq!(parse_a1_range("b2").unwrap(), ((1, 1), (1, 1)));
        assert_eq!(parse_a1_range("AA1:AB2").unwrap(), ((0, 26), (1, 27)));
        assert!(parse_a1_range("1A").is_err());
        assert!(parse_a1_range("").is_err());
        assert_eq!(a1_of(((0, 0), (9, 2))), "A1:C10");
        assert_eq!(col_label(26), "AA");
    }

    #[test]
    fn maps_com_error_codes() {
        assert_eq!(cell_error_label(-2146826246), Some("#N/A"));
        assert_eq!(cell_error_label(-2146826281), Some("#DIV/0!"));
        assert_eq!(cell_error_label(5), None);
    }

    #[test]
    fn reads_values_with_types_dates_and_errors() {
        let b = read_ranges(&fixture(), &[RangeSpec { sheet: "Sheet1".into(), range: Some("A1:D4".into()) }]).unwrap();
        assert_eq!(b[0].range, "A1:D4");
        assert_eq!(b[0].values[0], vec![json!("名前"), json!("数量"), json!(12.5), json!("#N/A")]);
        assert_eq!(b[0].values[1][1], json!(true));
        assert_eq!(b[0].values[1][2], json!(null));
        assert_eq!(b[0].values[1][3], json!("#DIV/0!"));
        assert_eq!(b[0].values[2][2], json!(3.0));
        assert_eq!(b[0].values[3][2], json!(45000.0));
    }

    #[test]
    fn omitted_range_reads_the_used_range() {
        let b = read_ranges(&fixture(), &[RangeSpec { sheet: "Other".into(), range: None }]).unwrap();
        assert_eq!(b[0].range, "A1");
        assert_eq!(b[0].values, vec![vec![json!("x")]]);
    }

    #[test]
    fn unknown_sheet_and_oversized_range_are_invalid_range() {
        let e = read_ranges(&fixture(), &[RangeSpec { sheet: "Nope".into(), range: None }]).unwrap_err();
        assert_eq!(code_of(&e), "invalid_range");
        let e = read_ranges(&fixture(), &[RangeSpec { sheet: "Sheet1".into(), range: Some("A1:ZZ1000".into()) }]).unwrap_err();
        assert_eq!(code_of(&e), "invalid_range");
        assert!(e.contains("20000"));
    }

    #[test]
    fn non_workbook_extension_is_invalid_workbook() {
        let e = read_ranges(Path::new("notes.txt"), &[]).unwrap_err();
        assert_eq!(code_of(&e), "invalid_workbook");
        let e = read_ranges(Path::new("missing.xlsx"), &[]).unwrap_err();
        assert_eq!(code_of(&e), "invalid_workbook");
    }
}
