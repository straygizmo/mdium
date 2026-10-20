import type { ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";

interface SectionHintProps {
  docsUrl: string;
  children: ReactNode;
}

/** Description box shown at the top of a settings section, with a link to the docs. */
export function SectionHint({ docsUrl, children }: SectionHintProps) {
  return (
    <div className="claude-section__hint">
      {children}{" "}
      <a
        href="#"
        className="claude-section__doc-link"
        title={docsUrl}
        onClick={(e) => {
          e.preventDefault();
          void invoke("open_external_url", { url: docsUrl });
        }}
      >
        🔗
      </a>
    </div>
  );
}
