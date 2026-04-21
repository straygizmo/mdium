import { marked } from "marked";
import hljs from "highlight.js";
import { preprocessMath } from "./math-preprocess";

// outputLineIndex -> inputLineIndex (-1 = synthetic / no mapping)
type LineMap = number[];

const SOURCE_LINE_ATTR = "data-source-line";

export const SOURCE_LINE_SELECTOR = `[${SOURCE_LINE_ATTR}]`;
export const SOURCE_LINE_ATTR_NAME = SOURCE_LINE_ATTR;

/**
 * Extract YAML front matter and return body along with the 0-indexed source line
 * on which the body begins (so body line 0 maps to original line `bodyLineOffset`).
 */
export function splitFrontMatter(content: string): {
  meta: Record<string, string> | null;
  body: string;
  bodyLineOffset: number;
} {
  if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) {
    return { meta: null, body: content, bodyLineOffset: 0 };
  }
  const end = content.indexOf("\n---", 4);
  if (end === -1) return { meta: null, body: content, bodyLineOffset: 0 };

  const yaml = content.slice(4, end).trim();
  let fmEnd = end + 4;
  if (content[fmEnd] === "\r") fmEnd++;
  if (content[fmEnd] === "\n") fmEnd++;

  const prefix = content.slice(0, fmEnd);
  const bodyLineOffset = prefix.split("\n").length - 1;
  const body = content.slice(fmEnd);

  const meta: Record<string, string> = {};
  for (const line of yaml.split("\n")) {
    const colon = line.indexOf(":");
    if (colon > 0) {
      const key = line.slice(0, colon).trim();
      const value = line
        .slice(colon + 1)
        .trim()
        .replace(/^["']|["']$/g, "");
      if (key) meta[key] = value;
    }
  }
  return {
    meta: Object.keys(meta).length > 0 ? meta : null,
    body,
    bodyLineOffset,
  };
}

/**
 * Run preprocess + marked pipeline and annotate top-level block elements with
 * data-source-line pointing at the original source line (1-indexed for easy
 * comparison with editor cursor positions).
 */
export function renderMarkdownWithSourceLines(
  body: string,
  bodyLineOffset: number,
): string {
  const zenn = preprocessZennWithMap(body);
  const pb = preprocessPageBreaksWithMap(zenn.output);
  const math = preprocessMathWithMap(pb.output);
  const nt = normalizeTableLinesWithMap(math.output);

  const finalToBody = composeMaps([
    nt.lineMap,
    math.lineMap,
    pb.lineMap,
    zenn.lineMap,
  ]);
  const finalText = nt.output;

  const lineStarts = computeLineStarts(finalText);
  const tokens = marked.lexer(finalText);

  let pos = 0;
  let html = "";
  for (const token of tokens) {
    const rawLen = (token.raw ?? "").length;
    const finalLine = offsetToLine(lineStarts, pos);
    pos += rawLen;

    if (token.type === "space" || token.type === "def") continue;

    const bodyLine = finalToBody[finalLine];
    const sourceLine =
      bodyLine === undefined || bodyLine < 0 ? -1 : bodyLine + bodyLineOffset;

    const partial = marked.parser([token]);
    html +=
      sourceLine >= 0
        ? injectAttrOnFirstTag(partial, SOURCE_LINE_ATTR, String(sourceLine + 1))
        : partial;
  }

  return html;
}

function composeMaps(maps: LineMap[]): LineMap {
  if (maps.length === 0) return [];
  let result = maps[0].slice();
  for (let i = 1; i < maps.length; i++) {
    const next = maps[i];
    result = result.map((v) => (v < 0 ? -1 : next[v] ?? -1));
  }
  return result;
}

function computeLineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return starts;
}

function offsetToLine(lineStarts: number[], offset: number): number {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (lineStarts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function injectAttrOnFirstTag(
  html: string,
  name: string,
  value: string,
): string {
  const escaped = value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  let replaced = false;
  return html.replace(/<([a-zA-Z][\w-]*)/, (match, tag) => {
    if (replaced) return match;
    replaced = true;
    return `<${tag} ${name}="${escaped}"`;
  });
}

function identityMap(text: string): LineMap {
  const n = text.split("\n").length;
  const map: LineMap = new Array(n);
  for (let i = 0; i < n; i++) map[i] = i;
  return map;
}

function preprocessZennWithMap(content: string): {
  output: string;
  lineMap: LineMap;
} {
  const lines = content.split("\n");
  const outLines: string[] = [];
  const lineMap: LineMap = [];
  const push = (line: string, origin: number) => {
    outLines.push(line);
    lineMap.push(origin);
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    const msgMatch = line.match(/^:{3,}message\s*(\w*)$/);
    if (msgMatch) {
      const type = msgMatch[1];
      const cls = type ? `zenn-message zenn-message-${type}` : "zenn-message";
      const startLine = i;
      const innerLines: string[] = [];
      const innerOrigins: number[] = [];
      i++;
      while (i < lines.length && !lines[i].match(/^:{3,}$/)) {
        innerLines.push(lines[i]);
        innerOrigins.push(i);
        i++;
      }
      i++;
      push(`<div class="${cls}">`, startLine);
      push("", startLine);
      for (let k = 0; k < innerLines.length; k++) {
        push(innerLines[k], innerOrigins[k]);
      }
      push("", startLine);
      push("</div>", startLine);
      continue;
    }

    const detailsMatch = line.match(/^:{3,}details\s+(.+)$/);
    if (detailsMatch) {
      const summary = detailsMatch[1];
      const startLine = i;
      const innerLines: string[] = [];
      const innerOrigins: number[] = [];
      i++;
      while (i < lines.length && !lines[i].match(/^:{3,}$/)) {
        innerLines.push(lines[i]);
        innerOrigins.push(i);
        i++;
      }
      i++;
      push(`<details><summary>${summary}</summary>`, startLine);
      push("", startLine);
      for (let k = 0; k < innerLines.length; k++) {
        push(innerLines[k], innerOrigins[k]);
      }
      push("", startLine);
      push("</details>", startLine);
      continue;
    }

    const codeMatch = line.match(/^```(\w+):(.+)$/);
    if (codeMatch) {
      const [, lang, filename] = codeMatch;
      const startLine = i;
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      i++;
      const joined = codeLines.join("\n");
      const escaped = joined
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
      let rendered: string;
      try {
        const highlighted = hljs.highlight(joined, {
          language: lang,
          ignoreIllegals: true,
        });
        rendered = `<div class="zenn-code-block"><div class="zenn-code-filename">${filename}</div><pre><code class="hljs language-${lang}">${highlighted.value}</code></pre></div>`;
      } catch {
        rendered = `<div class="zenn-code-block"><div class="zenn-code-filename">${filename}</div><pre><code>${escaped}</code></pre></div>`;
      }
      push(rendered, startLine);
      continue;
    }

    const imgLine = line.replace(
      /!\[([^\]]*)\]\((.+?)\s+=(\d*)x(\d*)\)/g,
      (_match, alt: string, url: string, w: string, h: string) => {
        const attrs = [
          `src="${url}"`,
          `alt="${alt}"`,
          w ? `width="${w}"` : "",
          h ? `height="${h}"` : "",
        ]
          .filter(Boolean)
          .join(" ");
        return `<p><img ${attrs} /></p>`;
      },
    );
    push(imgLine, i);
    i++;
  }
  return { output: outLines.join("\n"), lineMap };
}

function preprocessPageBreaksWithMap(content: string): {
  output: string;
  lineMap: LineMap;
} {
  const output = content.replace(
    /<!--\s*pagebreak\s*-->/gi,
    '<div class="pagebreak-marker"></div>',
  );
  return { output, lineMap: identityMap(output) };
}

function preprocessMathWithMap(content: string): {
  output: string;
  lineMap: LineMap;
} {
  const lines = content.split("\n");
  const outLines: string[] = [];
  const lineMap: LineMap = [];
  let inFence = false;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Pass through lines inside ``` fenced code blocks unchanged
    if (/^\s*```/.test(line)) {
      outLines.push(line);
      lineMap.push(i);
      inFence = !inFence;
      i++;
      continue;
    }
    if (inFence) {
      outLines.push(line);
      lineMap.push(i);
      i++;
      continue;
    }

    const dollarCount = (line.match(/\$\$/g) ?? []).length;
    if (dollarCount % 2 === 1) {
      // Multi-line $$ block: collect until closing $$ (without crossing fences)
      const startLine = i;
      const buf: string[] = [line];
      i++;
      while (i < lines.length && !lines[i].includes("$$")) {
        if (/^\s*```/.test(lines[i])) break;
        buf.push(lines[i]);
        i++;
      }
      if (i < lines.length && lines[i].includes("$$")) {
        buf.push(lines[i]);
        i++;
      }
      const processed = preprocessMath(buf.join("\n"));
      for (const pl of processed.split("\n")) {
        outLines.push(pl);
        lineMap.push(startLine);
      }
      continue;
    }

    const processed = preprocessMath(line);
    for (const pl of processed.split("\n")) {
      outLines.push(pl);
      lineMap.push(i);
    }
    i++;
  }
  return { output: outLines.join("\n"), lineMap };
}

function normalizeTableLinesWithMap(content: string): {
  output: string;
  lineMap: LineMap;
} {
  const lines = content.split("\n");
  const outLines: string[] = [];
  const lineMap: LineMap = [];
  let i = 0;
  while (i < lines.length) {
    outLines.push(lines[i]);
    lineMap.push(i);
    if (lines[i].trim().startsWith("|")) {
      let j = i + 1;
      while (j < lines.length && lines[j].trim() === "") j++;
      if (j < lines.length && lines[j].trim().startsWith("|") && j > i + 1) {
        i = j;
        continue;
      }
    }
    i++;
  }
  return { output: outLines.join("\n"), lineMap };
}
