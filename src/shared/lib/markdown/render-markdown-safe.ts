import DOMPurify, { type DOMPurify as DOMPurifyInstance } from "dompurify";
import { Marked } from "marked";

// Private parser so global `marked.use` configuration (e.g. the preview's
// custom renderers) never leaks into untrusted content rendering.
const parser = new Marked({ gfm: true, async: false });

// Private sanitizer instance so the link hook below does not affect other
// DOMPurify users. Created lazily in case no window exists at import time.
let purify: DOMPurifyInstance | null = null;

function getPurify(): DOMPurifyInstance {
  if (purify) return purify;
  const instance = DOMPurify(window);
  instance.addHook("afterSanitizeAttributes", (node) => {
    if (node.tagName === "A" && node.hasAttribute("href")) {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer");
    }
  });
  purify = instance;
  return instance;
}

/**
 * Renders untrusted Markdown (from tasks, agents, or the repository) to HTML
 * that is safe for dangerouslySetInnerHTML: scripts, event handlers, inline
 * styles, embedded frames and form controls are removed.
 */
export function renderMarkdownSafe(markdown: string): string {
  if (typeof markdown !== "string") return "";
  const html = parser.parse(markdown, { async: false }) as string;
  return getPurify().sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["style", "iframe", "form", "input", "button"],
    FORBID_ATTR: ["style"],
  });
}
