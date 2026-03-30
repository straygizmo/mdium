// src/features/code-editor/components/CodeEditorPanel.tsx

import { useCallback, useRef } from "react";
import Editor, { type OnMount, type OnChange } from "@monaco-editor/react";
import type { editor } from "monaco-editor";
import { useTabStore } from "@/stores/tab-store";
import { useSettingsStore } from "@/stores/settings-store";
import { getThemeById } from "@/shared/themes";
import { getMonacoLanguage } from "../lib/language-map";
import "./CodeEditorPanel.css";

export function CodeEditorPanel() {
  const activeTab = useTabStore((s) => s.getActiveTab());
  const updateTabContent = useTabStore((s) => s.updateTabContent);
  const themeId = useSettingsStore((s) => s.themeId);
  const themeType = getThemeById(themeId).type;

  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);

  const language = activeTab?.filePath
    ? getMonacoLanguage(activeTab.filePath)
    : "plaintext";

  const handleEditorDidMount: OnMount = useCallback((editor) => {
    editorRef.current = editor;
    editor.focus();
  }, []);

  const handleChange: OnChange = useCallback(
    (value) => {
      if (activeTab && value !== undefined) {
        updateTabContent(activeTab.id, value);
      }
    },
    [activeTab, updateTabContent]
  );

  if (!activeTab) return null;

  return (
    <div className="code-editor-panel">
      <div className="code-editor-panel__editor">
        <Editor
          key={activeTab.id}
          defaultValue={activeTab.content}
          language={language}
          theme={themeType === "dark" ? "vs-dark" : "vs"}
          onChange={handleChange}
          onMount={handleEditorDidMount}
          options={{
            fontSize: 14,
            minimap: { enabled: true },
            wordWrap: "on",
            automaticLayout: true,
            scrollBeyondLastLine: false,
            lineNumbers: "on",
            renderLineHighlight: "line",
            bracketPairColorization: { enabled: true },
            tabSize: 4,
            insertSpaces: true,
          }}
        />
      </div>
    </div>
  );
}
