import { useState, useEffect, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { useTabStore } from "@/stores/tab-store";
import { marked } from "marked";
import { useOpencodeConfigContext, toRelativeProjectPath } from "../OpencodeConfigContext";
import { ScopeToggle, type Scope } from "../shared/ScopeToggle";
import { ScopeFormWrapper } from "../shared/ScopeFormWrapper";

type RulesViewTab = "editor" | "preview";

export function RulesSection() {
  const { t } = useTranslation("opencode-config");
  const activeFolderPath = useTabStore((s) => s.activeFolderPath);
  const { useRelativePaths } = useOpencodeConfigContext();

  const [scope, setScope] = useState<Scope>("global");
  const [displayPath, setDisplayPath] = useState("");
  const [content, setContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [loading, setLoading] = useState(false);
  const [viewTab, setViewTab] = useState<RulesViewTab>("editor");

  const getRulesPath = useCallback(async (): Promise<string | null> => {
    if (scope === "global") {
      const home = await invoke<string>("get_home_dir");
      const sep = home.includes("\\") ? "\\" : "/";
      return `${home}${sep}.config${sep}opencode${sep}AGENTS.md`;
    }
    if (activeFolderPath) {
      const sep = activeFolderPath.includes("\\") ? "\\" : "/";
      return `${activeFolderPath}${sep}AGENTS.md`;
    }
    return null;
  }, [scope, activeFolderPath]);

  const loadContent = useCallback(async () => {
    const path = await getRulesPath();
    setDisplayPath(path ?? "");
    if (!path) {
      setContent("");
      setSavedContent("");
      return;
    }
    setLoading(true);
    try {
      const raw = await invoke<string>("read_text_file", { path });
      setContent(raw);
      setSavedContent(raw);
    } catch {
      setContent("");
      setSavedContent("");
    }
    setLoading(false);
  }, [getRulesPath]);

  useEffect(() => {
    loadContent();
  }, [loadContent]);

  const handleSave = async () => {
    const path = await getRulesPath();
    if (!path) return;
    await invoke("write_text_file_with_dirs", { path, content });
    setSavedContent(content);
  };

  const previewHtml = useMemo(() => {
    if (!content) return "";
    try {
      return marked(content, { async: false, gfm: true, breaks: true }) as string;
    } catch {
      return "<p>Markdown rendering error</p>";
    }
  }, [content]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Tab") {
        e.preventDefault();
        const textarea = e.currentTarget;
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        const newContent =
          content.substring(0, start) + "  " + content.substring(end);
        setContent(newContent);
        setTimeout(() => {
          textarea.selectionStart = textarea.selectionEnd = start + 2;
        }, 0);
      }
    },
    [content]
  );

  const noProject = scope === "project" && !activeFolderPath;
  const isDirty = content !== savedContent;

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <div className="oc-section__hint">
        {t("rulesDescription")}
        {" "}
        <a
          href="#"
          onClick={(e) => {
            e.preventDefault();
            invoke("open_external_url", { url: t("rulesDocsUrl") });
          }}
          style={{ textDecoration: "none", cursor: "pointer" }}
          title={t("rulesDocsUrl")}
        >
          🔗
        </a>
      </div>

      <ScopeToggle value={scope} onChange={setScope} />

      {noProject && (
        <div className="oc-section__empty">{t("agentNoProject")}</div>
      )}

      {!noProject && loading && (
        <div className="oc-section__empty">...</div>
      )}

      {!noProject && !loading && (
        <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
        <ScopeFormWrapper scope={scope}>
          <div className="oc-rules__editor-panel">
            <div className="oc-rules__panel-tabs">
              <button
                className={`oc-rules__panel-tab${viewTab === "editor" ? " oc-rules__panel-tab--active" : ""}`}
                onClick={() => setViewTab("editor")}
              >
                {t("rulesTabEditor")}
              </button>
              <button
                className={`oc-rules__panel-tab${viewTab === "preview" ? " oc-rules__panel-tab--active" : ""}`}
                onClick={() => setViewTab("preview")}
              >
                {t("rulesTabPreview")}
              </button>
            </div>

            {viewTab === "editor" ? (
              <textarea
                className="oc-rules__editor-textarea"
                value={content}
                onChange={(e) => setContent(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={t("rulesPlaceholder")}
                spellCheck={false}
              />
            ) : (
              content ? (
                <div
                  className="oc-rules__preview"
                  dangerouslySetInnerHTML={{ __html: previewHtml }}
                />
              ) : (
                <div className="oc-rules__preview">
                  <div className="oc-rules__preview-empty">
                    {t("rulesPlaceholder")}
                  </div>
                </div>
              )
            )}
          </div>
        </ScopeFormWrapper>

          {displayPath && (
            <div className="oc-section__path-hint">
              {t("rulesSavePath")}:{" "}
              {useRelativePaths && scope === "project" && activeFolderPath
                ? toRelativeProjectPath(activeFolderPath, displayPath)
                : displayPath}
            </div>
          )}
          <div className="oc-section__form-actions" style={{ marginTop: 8, flexShrink: 0 }}>
            <button
              className="oc-section__save-btn"
              onClick={handleSave}
              disabled={!isDirty}
              style={{ opacity: isDirty ? 1 : 0.5 }}
            >
              {t("save")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
