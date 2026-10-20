import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { useTabStore } from "@/stores/tab-store";
import { ScopeToggle, type Scope } from "../shared/ScopeToggle";
import { ScopeFormWrapper } from "../shared/ScopeFormWrapper";
import { SectionHint } from "../shared/SectionHint";
import { MarkdownEditorPanel } from "../shared/MarkdownEditorPanel";
import { joinPath, toRelativeProjectPath } from "../../lib/config-paths";

async function rulesPath(scope: Scope, folder: string): Promise<string> {
  if (scope === "project") return joinPath(folder, "CLAUDE.md");
  const home = await invoke<string>("get_home_dir");
  return joinPath(home, ".claude", "CLAUDE.md");
}

export function RulesSection() {
  const { t } = useTranslation("claude-config");
  const folder = useTabStore((s) => s.activeFolderPath)!;
  const [scope, setScope] = useState<Scope>("project");
  const [path, setPath] = useState("");
  const [text, setText] = useState("");
  const [savedText, setSavedText] = useState("");
  const [loadCount, setLoadCount] = useState(0);
  const [savedAt, setSavedAt] = useState(0);
  const [saveError, setSaveError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const p = await rulesPath(scope, folder);
      let content = "";
      try {
        content = await invoke<string>("read_text_file", { path: p });
      } catch {
        // File does not exist yet.
      }
      if (cancelled) return;
      setPath(p);
      setText(content);
      setSavedText(content);
      setLoadCount((n) => n + 1);
    })();
    return () => { cancelled = true; };
  }, [scope, folder]);

  const save = async () => {
    try {
      const p = await rulesPath(scope, folder);
      await invoke("write_text_file_with_dirs", { path: p, content: text });
      setSavedText(text);
      setSaveError(false);
      setSavedAt(Date.now());
      setTimeout(() => setSavedAt(0), 2000);
    } catch {
      setSaveError(true);
      setTimeout(() => setSaveError(false), 2000);
    }
  };

  const isDirty = text !== savedText;
  const displayPath = scope === "project" ? toRelativeProjectPath(folder, path) : path;

  return (
    <div className="claude-section">
      <SectionHint docsUrl={t("rulesDocsUrl")}>{t("rulesDescription")}</SectionHint>

      <ScopeToggle value={scope} onChange={setScope} />

      <ScopeFormWrapper scope={scope}>
        <MarkdownEditorPanel
          value={text}
          onChange={setText}
          placeholder={t("rulesPlaceholder")}
          resetKey={loadCount}
        />
      </ScopeFormWrapper>

      {path && (
        <div className="claude-section__path-hint">
          {t("rulesSavePath")}: {displayPath}
        </div>
      )}
      <div className="claude-section__form-actions">
        <button className="claude-section__save-btn" onClick={() => void save()} disabled={!isDirty}>
          {t("save")}
        </button>
        {savedAt > 0 && <span className="claude-section__status">{t("saved")}</span>}
        {saveError && (
          <span className="claude-section__status claude-section__status--error">{t("saveFailed")}</span>
        )}
      </div>
    </div>
  );
}
