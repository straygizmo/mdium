import { type MouseEvent, useMemo } from "react";
import { renderMarkdownSafe } from "@/shared/lib/markdown/render-markdown-safe";
import { externalUrl, openExternal } from "../lib/open-external";

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
    const href = anchor.getAttribute("href") ?? "";
    // Relative links and other schemes are expected in documents: ignore them silently.
    if (!externalUrl(href)) return;
    void openExternal(href, "workflow:intake.linkOpenFailed");
  };

  const onAuxClick = (e: MouseEvent<HTMLDivElement>) => {
    // A middle click would otherwise open the link inside the app.
    if (clickedAnchor(e)) e.preventDefault();
  };

  return (
    <div className={className} onClick={onClick} onAuxClick={onAuxClick} dangerouslySetInnerHTML={{ __html: html }} />
  );
}
