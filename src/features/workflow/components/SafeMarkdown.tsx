import { type MouseEvent, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { renderMarkdownSafe } from "@/shared/lib/markdown/render-markdown-safe";

/** Whether `text` contains whitespace or a control character (code 0x20 and below, or DEL). */
function hasUnsafeChar(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * The normalized URL an untrusted link may be opened with, or null. Only
 * absolute http/https URLs without whitespace or control characters qualify.
 * The backend opens the URL without a shell, so other characters are safe.
 */
export function externalUrl(href: string): string | null {
  let url: URL;
  try {
    // No base URL: relative links fail to parse and are never opened.
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (hasUnsafeChar(url.href)) return null;
  return url.href;
}

/** The anchor a click inside `container` landed on, if any. */
function clickedAnchor(e: MouseEvent<HTMLElement>): HTMLAnchorElement | null {
  const target = e.target;
  if (!(target instanceof Element)) return null;
  const anchor = target.closest("a");
  return anchor && e.currentTarget.contains(anchor) ? anchor : null;
}

interface SafeMarkdownProps {
  /** Untrusted Markdown (from a task, an agent or the user). */
  source: string;
  className: string;
}

/**
 * Renders untrusted Markdown through the sanitizing renderer. Links never
 * navigate the app: http/https links open in the external browser, every
 * other link does nothing.
 */
export function SafeMarkdown({ source, className }: SafeMarkdownProps) {
  const html = useMemo(() => renderMarkdownSafe(source), [source]);

  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    const anchor = clickedAnchor(e);
    if (!anchor) return;
    e.preventDefault();
    const url = externalUrl(anchor.getAttribute("href") ?? "");
    if (!url) return;
    invoke("open_external_url", { url }).catch((err: unknown) => console.warn("[workflow] open link failed", err));
  };

  const onAuxClick = (e: MouseEvent<HTMLDivElement>) => {
    // A middle click would otherwise open the link inside the app.
    if (clickedAnchor(e)) e.preventDefault();
  };

  return (
    <div className={className} onClick={onClick} onAuxClick={onAuxClick} dangerouslySetInnerHTML={{ __html: html }} />
  );
}
