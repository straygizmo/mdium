use serde::{Deserialize, Serialize};

/// Struct representing a single table in a Markdown document
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MarkdownTable {
    /// Heading text immediately before the table (if any)
    pub heading: Option<String>,
    /// Cell values of the header row
    pub headers: Vec<String>,
    /// Alignment info (left / center / right / none)
    pub alignments: Vec<String>,
    /// Body rows: each row is an array of cell values
    pub rows: Vec<Vec<String>>,
    /// Table start line number in the document
    pub start_line: usize,
    /// Table end line number in the document
    pub end_line: usize,
}

/// Parse result for the entire Markdown document
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParsedDocument {
    /// Original file content (line by line)
    pub lines: Vec<String>,
    /// Extracted tables
    pub tables: Vec<MarkdownTable>,
}

/// Parse a pipe-delimited line into an array of cell values
fn parse_row(line: &str) -> Vec<String> {
    let trimmed = line.trim();
    // Strip leading/trailing pipes before splitting
    let inner = trimmed
        .strip_prefix('|')
        .unwrap_or(trimmed)
        .strip_suffix('|')
        .unwrap_or(trimmed);
    inner.split('|').map(|s| s.trim().to_string()).collect()
}

/// Check if a line is a separator line (e.g., |---|:---:|---:|)
fn is_separator_line(line: &str) -> bool {
    let trimmed = line.trim();
    if !trimmed.contains('|') {
        return false;
    }
    let inner = trimmed
        .strip_prefix('|')
        .unwrap_or(trimmed)
        .strip_suffix('|')
        .unwrap_or(trimmed);
    inner.split('|').all(|cell| {
        let c = cell.trim();
        if c.is_empty() {
            return false;
        }
        c.chars().all(|ch| ch == '-' || ch == ':')
    })
}

/// Extract alignment info from a separator line
fn parse_alignments(line: &str) -> Vec<String> {
    let trimmed = line.trim();
    let inner = trimmed
        .strip_prefix('|')
        .unwrap_or(trimmed)
        .strip_suffix('|')
        .unwrap_or(trimmed);
    inner
        .split('|')
        .map(|cell| {
            let c = cell.trim();
            let left = c.starts_with(':');
            let right = c.ends_with(':');
            match (left, right) {
                (true, true) => "center".to_string(),
                (false, true) => "right".to_string(),
                (true, false) => "left".to_string(),
                _ => "none".to_string(),
            }
        })
        .collect()
}

/// Check if a line is a table row (non-empty line containing pipes)
fn is_table_line(line: &str) -> bool {
    let trimmed = line.trim();
    !trimmed.is_empty() && trimmed.contains('|')
}

/// Parse entire Markdown text and extract tables
pub fn parse_markdown(content: &str) -> ParsedDocument {
    let lines: Vec<String> = content.lines().map(|l| l.to_string()).collect();
    let mut tables: Vec<MarkdownTable> = Vec::new();
    let mut i = 0;
    let len = lines.len();
    let mut last_heading: Option<String> = None;

    while i < len {
        let trimmed = lines[i].trim();

        // Track headings
        if trimmed.starts_with('#') {
            last_heading = Some(trimmed.trim_start_matches('#').trim().to_string());
            i += 1;
            continue;
        }

        // Detect table start: header row + separator row
        if i + 1 < len && is_table_line(&lines[i]) && is_separator_line(&lines[i + 1]) {
            let start_line = i;
            let headers = parse_row(&lines[i]);
            let alignments = parse_alignments(&lines[i + 1]);
            let mut rows: Vec<Vec<String>> = Vec::new();

            let mut j = i + 2;
            while j < len && is_table_line(&lines[j]) && !is_separator_line(&lines[j]) {
                let mut row = parse_row(&lines[j]);
                // Adjust column count to match headers
                row.resize(headers.len(), String::new());
                row.truncate(headers.len());
                rows.push(row);
                j += 1;
            }

            tables.push(MarkdownTable {
                heading: last_heading.clone(),
                headers,
                alignments,
                rows,
                start_line,
                end_line: j - 1,
            });

            i = j;
            continue;
        }

        i += 1;
    }

    ParsedDocument { lines, tables }
}

/// Convert a table to Markdown text
pub fn serialize_table(table: &MarkdownTable) -> String {
    let col_count = table.headers.len();

    // Calculate max width of each column
    let mut widths: Vec<usize> = table.headers.iter().map(|h| h.len().max(3)).collect();
    for row in &table.rows {
        for (ci, cell) in row.iter().enumerate() {
            if ci < col_count {
                widths[ci] = widths[ci].max(cell.len());
            }
        }
    }

    let mut out = String::new();

    // Header row
    out.push('|');
    for (ci, header) in table.headers.iter().enumerate() {
        let w = widths.get(ci).copied().unwrap_or(3);
        out.push_str(&format!(" {:<width$} |", header, width = w));
    }
    out.push('\n');

    // Separator row
    out.push('|');
    for ci in 0..col_count {
        let w = widths.get(ci).copied().unwrap_or(3);
        let align = table
            .alignments
            .get(ci)
            .map(|s| s.as_str())
            .unwrap_or("none");
        let sep = match align {
            "left" => format!(":{}-|", "-".repeat(w)),
            "right" => format!(" {}:|", "-".repeat(w)),
            "center" => format!(":{}:|", "-".repeat(w)),
            _ => format!(" {}-|", "-".repeat(w)),
        };
        out.push_str(&sep);
    }
    out.push('\n');

    // Data rows
    for row in &table.rows {
        out.push('|');
        for ci in 0..col_count {
            let w = widths.get(ci).copied().unwrap_or(3);
            let cell = row.get(ci).map(|s| s.as_str()).unwrap_or("");
            out.push_str(&format!(" {:<width$} |", cell, width = w));
        }
        out.push('\n');
    }

    out
}

/// Rebuild the entire document (replace table sections with updated tables)
pub fn rebuild_document(original_lines: &[String], tables: &[MarkdownTable]) -> String {
    if tables.is_empty() {
        return original_lines.join("\n");
    }

    let mut result = String::new();
    let mut cursor = 0;

    for table in tables {
        // Output text before table as-is
        for line in &original_lines[cursor..table.start_line] {
            result.push_str(line);
            result.push('\n');
        }
        // Output updated table
        result.push_str(&serialize_table(table));
        cursor = table.end_line + 1;
    }

    // Text after the last table
    for line in &original_lines[cursor..] {
        result.push_str(line);
        result.push('\n');
    }

    // Remove trailing extra newline
    if result.ends_with('\n') && !original_lines.last().map_or(false, |l| l.is_empty()) {
        result.pop();
    }

    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_simple_table() {
        let md = "# Test\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |\n";
        let doc = parse_markdown(md);
        assert_eq!(doc.tables.len(), 1);
        assert_eq!(doc.tables[0].headers, vec!["A", "B"]);
        assert_eq!(doc.tables[0].rows.len(), 2);
    }

    #[test]
    fn test_roundtrip() {
        let md = "# Heading\n\n| Name | Age |\n| --- | --- |\n| Alice | 30 |\n| Bob | 25 |\n";
        let doc = parse_markdown(md);
        let rebuilt = rebuild_document(&doc.lines, &doc.tables);
        // Verify that re-parsing yields the same table
        let doc2 = parse_markdown(&rebuilt);
        assert_eq!(doc2.tables[0].headers, doc.tables[0].headers);
        assert_eq!(doc2.tables[0].rows, doc.tables[0].rows);
    }
}
