import { type MouseEvent, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { renderMarkdownSafe } from "@/shared/lib/markdown/render-markdown-safe";

/**
 * Characters the Windows URL opener (`cmd /C start`) would interpret instead
 * of passing on: command separators, redirections, escapes and `%VAR%`
 * expansion. Links containing them are not opened on Windows.
 */
const WINDOWS_SHELL_CHARS = /[\s"%&<>^|!`]/;

const isWindows = () => navigator.userAgent.includes("Windows");

/**
 * The normalized URL an untrusted link may be opened with, or null. Only
 * absolute http/https URLs qualify; on Windows, URLs with shell
 * metacharacters are refused as well.
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
  if (isWindows() && WINDOWS_SHELL_CHARS.test(url.href)) return null;
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
