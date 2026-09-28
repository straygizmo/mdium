import mammoth from "mammoth";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import type { ConvertedDocument } from "./types";

/** Decode base64 without relying on Node's Buffer (works in browsers and Node). */
function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** An ArrayBuffer holding exactly the bytes of `data` (a view may cover part of a larger buffer). */
export function exactArrayBuffer(data: Uint8Array): ArrayBuffer {
  if (data.byteOffset === 0 && data.byteLength === data.buffer.byteLength) {
    return data.buffer as ArrayBuffer;
  }
  return data.slice().buffer as ArrayBuffer;
}

/**
 * Prepare mammoth's table HTML for turndown's GFM table rule:
 * - cell paragraphs would become line breaks that split a Markdown table
 *   row, so they are joined with spaces;
 * - mammoth emits Word tables without header cells, which the GFM rule keeps
 *   as raw HTML, so the first row of such a table is promoted to header cells.
 * Cells or first rows that contain a nested table are left alone.
 */
export function prepareTablesForMarkdown(html: string): string {
  const flattened = html.replace(
    /<(td|th)((?:\s[^>]*)?)>([\s\S]*?)<\/\1>/g,
    (whole, tag: string, attrs: string, inner: string) => {
      if (inner.includes("<table")) return whole;
      const flat = inner
        .replace(/<\/p>\s*<p(?:\s[^>]*)?>/g, " ")
        .replace(/<\/?p(?:\s[^>]*)?>/g, "")
        .trim();
      return `<${tag}${attrs}>${flat}</${tag}>`;
    },
  );
  return flattened.replace(/<table>(\s*(?:<thead>|<tbody>)?\s*)<tr>([\s\S]*?)<\/tr>/g, (whole, lead: string, row: string) => {
    if (row.includes("<th") || row.includes("<table")) return whole;
    const header = row.replace(/<td(\s|>)/g, "<th$1").replace(/<\/td>/g, "</th>");
    return `<table>${lead}<tr>${header}</tr>`;
  });
}

/**
 * Convert a .docx file to Markdown. Images are returned as assets under
 * `{baseName}_images/` and referenced relatively from the Markdown.
 */
export async function convertDocx(data: Uint8Array, baseName: string): Promise<ConvertedDocument> {
  const images: { index: number; name: string; data: Uint8Array }[] = [];
  let imageIndex = 0;

  // mammoth's browser build reads `arrayBuffer`, its Node build `buffer`;
  // give both so the same code runs in the app and in the Node sidecars.
  const input = { arrayBuffer: exactArrayBuffer(data), buffer: data } as unknown as { arrayBuffer: ArrayBuffer };
  const result = await mammoth.convertToHtml(
    input,
    {
      convertImage: mammoth.images.imgElement((image) => {
        imageIndex++;
        const index = imageIndex;
        const ext = (image.contentType?.split("/")[1] || "png").replace("jpeg", "jpg");
        const name = `image${index}.${ext}`;
        return image.read("base64").then((base64Data) => {
          images.push({ index, name, data: base64ToBytes(base64Data) });
          return { src: `__IMG_PLACEHOLDER_${index}__` };
        });
      }),
    },
  );

  const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
  turndown.use(gfm);
  let markdown = turndown.turndown(prepareTablesForMarkdown(result.value));

  // Replace image placeholders with relative paths. Image reads may settle
  // out of order, so each placeholder is matched by its own index.
  images.sort((a, b) => a.index - b.index);
  for (const img of images) {
    const relativePath = `${baseName}_images/${img.name}`;
    markdown = markdown.split(`__IMG_PLACEHOLDER_${img.index}__`).join(relativePath);
  }

  return {
    markdown,
    assets: images.map((img) => ({ path: `${baseName}_images/${img.name}`, data: img.data })),
  };
}
