import { DiffEditor } from "@monaco-editor/react";
import { useTabStore } from "@/stores/tab-store";
import { useSettingsStore } from "@/stores/settings-store";
import { getThemeById } from "@/shared/themes";
import "./GitDiffViewer.css";

export function GitDiffViewer() {
  const activeTab = useTabStore((s) => s.getActiveTab());
  const themeId = useSettingsStore((s) => s.themeId);
  const themeType = getThemeById(themeId).type;

  if (!activeTab?.isDiffTab) return null;

  return (
    <div className="git-diff-viewer">
      <div className="git-diff-viewer__header">
        <span className="git-diff-viewer__label">
          {activeTab.diffOriginalLabel}
        </span>
        <span className="git-diff-viewer__label">
          {activeTab.diffModifiedLabel}
        </span>
      </div>
      <div className="git-diff-viewer__editor">
        <DiffEditor
          key={activeTab.id}
          original={activeTab.diffOriginal ?? ""}
          modified={activeTab.diffModified ?? ""}
          language={activeTab.diffLanguage ?? "plaintext"}
          theme={themeType === "dark" ? "vs-dark" : "vs"}
          options={{
            readOnly: true,
            originalEditable: false,
            renderSideBySide: true,
            automaticLayout: true,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            fontSize: 14,
            lineNumbers: "on",
          }}
        />
      </div>
    </div>
  );
}
