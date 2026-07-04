import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { useTabStore } from "@/stores/tab-store";

type Scope = "global" | "project";

async function rulesPath(scope: Scope, folder: string): Promise<string> {
  if (scope === "project") return `${folder}/CLAUDE.md`;
  const home = await invoke<string>("get_home_dir");
  return `${home}/.claude/CLAUDE.md`;
}

export function RulesSection() {
  const { t } = useTranslation("claude-config");
  const folder = useTabStore((s) => s.activeFolderPath)!;
  const [scope, setScope] = useState<Scope>("project");
  const [text, setText] = useState("");
  const [savedAt, setSavedAt] = useState(0);
  const [saveError, setSaveError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const path = await rulesPath(scope, folder);
      let content = "";
      try {
        content = await invoke<string>("read_text_file", { path });
      } catch {
        // File does not exist yet.
      }
      if (!cancelled) setText(content);
    })();
    return () => { cancelled = true; };
  }, [scope, folder]);

  const save = async () => {
    try {
      const path = await rulesPath(scope, folder);
      await invoke("write_text_file_with_dirs", { path, content: text });
      setSaveError(false);
      setSavedAt(Date.now());
      setTimeout(() => setSavedAt(0), 2000);
    } catch {
      setSaveError(true);
      setTimeout(() => setSaveError(false), 2000);
    }
  };

  return (
    <div className="claude-settings__section claude-settings__section--rules">
      <div className="claude-settings__scope">
        <label>
          <input type="radio" checked={scope === "project"} onChange={() => setScope("project")} />
          {t("rulesScopeProject")}
        </label>
        <label>
          <input type="radio" checked={scope === "global"} onChange={() => setScope("global")} />
          {t("rulesScopeGlobal")}
        </label>
      </div>
      <textarea
        className="claude-settings__rules-editor"
        value={text}
        onChange={(e) => setText(e.target.value)}
        spellCheck={false}
      />
      <div>
        <button onClick={() => void save()}>{t("save")}</button>
        {savedAt > 0 && <span className="claude-settings__saved">{t("saved")}</span>}
        {saveError && (
          <span className="claude-settings__saved claude-settings__saved--error">
            {t("saveFailed")}
          </span>
        )}
      </div>
    </div>
  );
}
