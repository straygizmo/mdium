/**
 * Convert an HTML string containing a <table> to a markdown table string.
 * Returns null if no valid table is found (no <table>, fewer than 2 columns, parse error).
 */
export function htmlTableToMarkdown(html: string): string | null {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const table = doc.querySelector("table");
  if (!table) return null;

  const rows = Array.from(table.querySelectorAll(":scope > tr, :scope > thead > tr, :scope > tbody > tr"));
  if (rows.length === 0) return null;

  // Determine max column count
  const maxCols = Math.max(...rows.map((r) => r.querySelectorAll("td, th").length));
  if (maxCols < 2) return null;

  // Extract header and data rows
  const thead = table.querySelector("thead");
  let headerRow: Element;
  let dataRows: Element[];

  if (thead) {
    const theadRows = Array.from(thead.querySelectorAll("tr"));
    headerRow = theadRows[0];
    const tbody = table.querySelector("tbody");
    dataRows = tbody
      ? Array.from(tbody.querySelectorAll("tr"))
      : rows.filter((r) => !thead.contains(r));
  } else {
    headerRow = rows[0];
    dataRows = rows.slice(1);
  }

  // Extract cells from a row, padding to maxCols
  const extractCells = (row: Element): string[] => {
    const cells = Array.from(row.querySelectorAll(":scope > td, :scope > th"));
    const result = cells.map((cell) => convertCellContent(cell));
    while (result.length < maxCols) result.push("");
    return result.slice(0, maxCols);
  };

  const headers = extractCells(headerRow);
  const bodyRows = dataRows.map((r) => extractCells(r));

  // Detect alignments from header row, fallback to first data row
  const alignments = detectAlignments(headerRow, maxCols);
  if (bodyRows.length > 0) {
    const firstDataAlignments = detectAlignments(dataRows[0], maxCols);
    for (let i = 0; i < maxCols; i++) {
      if (!alignments[i] && firstDataAlignments[i]) {
        alignments[i] = firstDataAlignments[i];
      }
    }
  }

  // Calculate column widths (minimum 3 for separator)
  const colWidths = headers.map((h, i) => {
    const cellWidths = [h.length, ...bodyRows.map((r) => r[i].length)];
    return Math.max(3, ...cellWidths);
  });

  // Format rows
  const pad = (text: string, width: number) => text + " ".repeat(width - text.length);

  const headerLine = "| " + headers.map((h, i) => pad(h, colWidths[i])).join(" | ") + " |";

  const separatorLine = "| " + colWidths.map((w, i) => {
    const align = alignments[i];
    if (align === "center") return ":" + "-".repeat(w - 2) + ":";
    if (align === "right") return "-".repeat(w - 1) + ":";
    return "-".repeat(w);
  }).join(" | ") + " |";

  const dataLines = bodyRows.map(
    (row) => "| " + row.map((cell, i) => pad(cell, colWidths[i])).join(" | ") + " |"
  );

  return [headerLine, separatorLine, ...dataLines].join("\n");
}

type Alignment = "left" | "center" | "right" | null;

function detectAlignments(row: Element, maxCols: number): Alignment[] {
  const cells = Array.from(row.querySelectorAll(":scope > td, :scope > th"));
  const result: Alignment[] = [];
  for (let i = 0; i < maxCols; i++) {
    const cell = cells[i] as HTMLElement | undefined;
    if (!cell) {
      result.push(null);
      continue;
    }
    const style = cell.style?.textAlign || cell.getAttribute("align") || "";
    const normalized = style.toLowerCase();
    if (normalized === "center") result.push("center");
    else if (normalized === "right") result.push("right");
    else if (normalized === "left") result.push("left");
    else result.push(null);
  }
  return result;
}

function convertCellContent(cell: Element): string {
  return convertNodeContent(cell).trim().replace(/\|/g, "\\|");
}

function convertNodeContent(node: Node): string {
  let result = "";
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      result += child.textContent ?? "";
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      const el = child as HTMLElement;
      const tag = el.tagName.toLowerCase();
      const inner = convertNodeContent(el);

      switch (tag) {
        case "b":
        case "strong":
          result += `**${inner}**`;
          break;
        case "i":
        case "em":
          result += `*${inner}*`;
          break;
        case "s":
        case "del":
          result += `~~${inner}~~`;
          break;
        case "code":
          result += `\`${inner}\``;
          break;
        case "a":
          result += `[${inner}](${el.getAttribute("href") ?? ""})`;
          break;
        case "br":
          result += "<br>";
          break;
        default:
          result += inner;
          break;
      }
    }
  }
  return result;
}
