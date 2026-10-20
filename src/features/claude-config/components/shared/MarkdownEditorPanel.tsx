import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { marked } from "marked";
import { useEditorKeyDown } from "@/features/opencode-config/hooks/useEditorKeyDown";

type ViewTab = "editor" | "preview";

interface MarkdownEditorPanelProps {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  /** Changing this clears the undo history, e.g. after loading new content. */
  resetKey?: unknown;
}

/** Markdown textarea with an Editor / Preview tab strip. */
export function MarkdownEditorPanel({ value, onChange, placeholder, resetKey }: MarkdownEditorPanelProps) {
  const { t } = useTranslation("claude-config");
  const [view, setView] = useState<ViewTab>("editor");
  const { handleKeyDown, resetUndo } = useEditorKeyDown(value, onChange);

  useEffect(() => {
    resetUndo();
  }, [resetKey, resetUndo]);

  const previewHtml = useMemo(() => {
    if (!value) return "";
    try {
      return marked(value, { async: false, gfm: true, breaks: true }) as string;
    } catch {
      return "<p>Markdown rendering error</p>";
    }
  }, [value]);

  return (
    <div className="claude-md-editor">
      <div className="claude-md-editor__tabs">
        <button
          type="button"
          className={`claude-md-editor__tab${view === "editor" ? " claude-md-editor__tab--active" : ""}`}
          onClick={() => setView("editor")}
        >
          {t("editorTabEditor")}
        </button>
        <button
          type="button"
          className={`claude-md-editor__tab${view === "preview" ? " claude-md-editor__tab--active" : ""}`}
          onClick={() => setView("preview")}
        >
          {t("editorTabPreview")}
        </button>
      </div>

      {view === "editor" ? (
        <textarea
          className="claude-md-editor__textarea"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          spellCheck={false}
        />
      ) : previewHtml ? (
        <div className="claude-md-editor__preview" dangerouslySetInnerHTML={{ __html: previewHtml }} />
      ) : (
        <div className="claude-md-editor__preview">
          <div className="claude-md-editor__preview-empty">{placeholder}</div>
        </div>
      )}
    </div>
  );
}
