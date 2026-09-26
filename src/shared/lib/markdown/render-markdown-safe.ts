import DOMPurify from "dompurify";
import { marked } from "marked";

let hookRegistered = false;

// Registers the link hardening hook once per DOMPurify instance.
function ensureLinkHook(): void {
  if (hookRegistered) return;
  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    if (node.tagName === "A" && node.hasAttribute("href")) {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer");
    }
  });
  hookRegistered = true;
}

/**
 * Renders untrusted Markdown (from tasks, agents, or the repository) to HTML
 * that is safe for dangerouslySetInnerHTML: scripts, event handlers, inline
 * styles, embedded frames and form controls are removed.
 */
export function renderMarkdownSafe(markdown: string): string {
  if (typeof markdown !== "string") return "";
  ensureLinkHook();
  const html = marked.parse(markdown, { async: false }) as string;
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["style", "iframe", "form", "input", "button"],
    FORBID_ATTR: ["style"],
  });
}
