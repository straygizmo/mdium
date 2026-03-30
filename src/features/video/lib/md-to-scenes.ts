import type {
  VideoProject,
  Scene,
  SceneElement,
  TitleElement,
  TextElement,
  BulletListElement,
  ImageElement,
  TableElement,
  CodeBlockElement,
} from "../types";
import { DEFAULT_META, DEFAULT_TRANSITION, DEFAULT_TTS_CONFIG } from "../types";

// ─── Scene splitting ──────────────────────────────────────────────────────────

function splitOnPagebreaks(markdown: string): string[] {
  const parts = markdown.split(/<!--\s*pagebreak\s*-->/i);
  return parts;
}

// ─── Line-level helpers ────────────────────────────────────────────────────────

function parseTableRow(line: string): string[] {
  return line
    .split("|")
    .map((cell) => cell.trim())
    .filter((cell) => cell.length > 0);
}

function isTableSeparator(line: string): boolean {
  return /^\|?\s*[-:]+[-| :]*\|?\s*$/.test(line);
}

// ─── Element parsing ──────────────────────────────────────────────────────────

/**
 * Parse a single scene's markdown content into SceneElements.
 * Returns elements AND the extracted narration (if any).
 */
function parseElements(
  content: string,
  fileDir: string
): { elements: SceneElement[]; narration: string | null } {
  const lines = content.split("\n");
  const elements: SceneElement[] = [];
  let narration: string | null = null;

  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // ── Empty line ────────────────────────────────────────────────────────────
    if (line.trim() === "") {
      i++;
      continue;
    }

    // ── Fenced code block ─────────────────────────────────────────────────────
    const fenceMatch = line.match(/^```(\w*)/);
    if (fenceMatch) {
      const lang = fenceMatch[1].toLowerCase();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // consume closing ```

      if (lang === "mermaid") {
        // Skip mermaid blocks
        continue;
      }

      const el: CodeBlockElement = {
        type: "code-block",
        code: codeLines.join("\n"),
        language: lang,
        animation: "fade-in",
      };
      elements.push(el);
      continue;
    }

    // ── Narration HTML comment ────────────────────────────────────────────────
    const narrationMatch = line.match(/<!--\s*narration:\s*(.*?)\s*-->/i);
    if (narrationMatch) {
      narration = narrationMatch[1];
      i++;
      continue;
    }

    // ── Other HTML comments (skip) ────────────────────────────────────────────
    if (/<!--.*-->/.test(line)) {
      i++;
      continue;
    }

    // ── <div> / </div> (skip) ─────────────────────────────────────────────────
    if (/^\s*<\/?div[^>]*>\s*$/.test(line)) {
      i++;
      continue;
    }

    // ── Horizontal rule (skip) ────────────────────────────────────────────────
    if (/^\s*---+\s*$/.test(line) || /^\s*\*\*\*+\s*$/.test(line) || /^\s*___+\s*$/.test(line)) {
      i++;
      continue;
    }

    // ── Heading ───────────────────────────────────────────────────────────────
    const headingMatch = line.match(/^(#{1,3})\s+(.*)/);
    if (headingMatch) {
      const level = headingMatch[1].length as 1 | 2 | 3;
      const el: TitleElement = {
        type: "title",
        text: headingMatch[2].trim(),
        level,
        animation: "fade-in",
      };
      elements.push(el);
      i++;
      continue;
    }

    // ── Bullet list ───────────────────────────────────────────────────────────
    const bulletMatch = line.match(/^[-*]\s+(.*)/);
    if (bulletMatch) {
      // Collect consecutive bullet items
      const items: string[] = [bulletMatch[1].trim()];
      i++;
      while (i < lines.length) {
        const next = lines[i];
        const nextBullet = next.match(/^[-*]\s+(.*)/);
        if (nextBullet) {
          items.push(nextBullet[1].trim());
          i++;
        } else {
          break;
        }
      }

      // Check if last element is also a bullet list (merge consecutive groups)
      const last = elements[elements.length - 1];
      if (last && last.type === "bullet-list") {
        (last as BulletListElement).items.push(...items);
      } else {
        const el: BulletListElement = {
          type: "bullet-list",
          items,
          animation: "sequential",
          delayPerItem: 20,
        };
        elements.push(el);
      }
      continue;
    }

    // ── Markdown image ────────────────────────────────────────────────────────
    const mdImageMatch = line.match(/!\[([^\]]*)\]\(([^)]+)\)/);
    if (mdImageMatch) {
      const alt = mdImageMatch[1];
      const src = resolveImagePath(mdImageMatch[2], fileDir);
      const el: ImageElement = {
        type: "image",
        src,
        alt: alt || undefined,
        position: "center",
        animation: "fade-in",
      };
      elements.push(el);
      i++;
      continue;
    }

    // ── <img> tag ─────────────────────────────────────────────────────────────
    const imgTagMatch = line.match(/<img\s[^>]*src="([^"]+)"[^>]*>/i);
    if (imgTagMatch) {
      const src = resolveImagePath(imgTagMatch[1], fileDir);
      const altTagMatch = line.match(/alt="([^"]*)"/i);
      const el: ImageElement = {
        type: "image",
        src,
        alt: altTagMatch ? altTagMatch[1] : undefined,
        position: "center",
        animation: "fade-in",
      };
      elements.push(el);
      i++;
      continue;
    }

    // ── Table ─────────────────────────────────────────────────────────────────
    if (line.trim().startsWith("|")) {
      const headers = parseTableRow(line);
      const rows: string[][] = [];
      i++;

      // Next line should be separator
      if (i < lines.length && isTableSeparator(lines[i])) {
        i++; // skip separator
      }

      // Collect data rows
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        rows.push(parseTableRow(lines[i]));
        i++;
      }

      const el: TableElement = {
        type: "table",
        headers,
        rows,
        animation: "row-by-row",
      };
      elements.push(el);
      continue;
    }

    // ── Plain text ────────────────────────────────────────────────────────────
    const trimmed = line.trim();
    if (trimmed.length > 0) {
      const el: TextElement = {
        type: "text",
        content: trimmed,
        animation: "fade-in",
      };
      elements.push(el);
    }
    i++;
  }

  return { elements, narration };
}

// ─── Image path resolution ─────────────────────────────────────────────────────

function resolveImagePath(src: string, fileDir: string): string {
  if (/^([a-zA-Z]:|\/|\\)/.test(src)) {
    return src;
  }
  if (src.startsWith("http://") || src.startsWith("https://") || src.startsWith("data:")) {
    return src;
  }
  // Relative path: resolve relative to the markdown file's directory
  const sep = fileDir.includes("\\") ? "\\" : "/";
  return fileDir + sep + src;
}

// ─── Auto narration ────────────────────────────────────────────────────────────

function autoNarration(elements: SceneElement[]): string {
  const parts: string[] = [];
  for (const el of elements) {
    if (el.type === "title") {
      parts.push((el as TitleElement).text);
    } else if (el.type === "bullet-list") {
      parts.push(...(el as BulletListElement).items);
    }
  }
  return parts.join("。");
}

// ─── Main conversion ──────────────────────────────────────────────────────────

export function convertMdToVideoProject(markdown: string, filePath: string): VideoProject {
  const lastSep = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  const fileDir = lastSep >= 0 ? filePath.slice(0, lastSep) : ".";
  const fileName = lastSep >= 0 ? filePath.slice(lastSep + 1) : filePath;
  const dotIdx = fileName.lastIndexOf(".");
  const fileBasename = dotIdx > 0 ? fileName.slice(0, dotIdx) : fileName;

  const chunks = splitOnPagebreaks(markdown);

  const scenes: Scene[] = chunks.map((chunk, index) => {
    const { elements, narration: extractedNarration } = parseElements(chunk, fileDir);

    // Determine scene title from first heading
    const firstTitle = elements.find((e) => e.type === "title") as TitleElement | undefined;
    const sceneTitle = firstTitle?.text;

    // Narration: use extracted or auto-generate
    const narration =
      extractedNarration !== null ? extractedNarration : autoNarration(elements);

    const scene: Scene = {
      id: `scene-${index + 1}`,
      title: sceneTitle,
      narration,
      transition: { ...DEFAULT_TRANSITION },
      elements,
      captions: { enabled: true },
    };

    return scene;
  });

  // meta.title: first scene's title or filename
  const firstSceneTitle = scenes[0]?.title;
  const metaTitle = firstSceneTitle ?? fileBasename;

  const project: VideoProject = {
    meta: {
      ...DEFAULT_META,
      title: metaTitle,
    },
    audio: {
      tts: { ...DEFAULT_TTS_CONFIG },
    },
    scenes,
  };

  return project;
}
