// src/features/code-editor/components/CodeEditorPanel.tsx

import { useCallback, useRef } from "react";
import Editor, { type OnMount, type OnChange } from "@monaco-editor/react";
import type { editor } from "monaco-editor";
import { useTabStore } from "@/stores/tab-store";
import { useSettingsStore } from "@/stores/settings-store";
import { getThemeById } from "@/shared/themes";
import { getMonacoLanguage } from "../lib/language-map";
import "./CodeEditorPanel.css";

const VIEW_STATE_THROTTLE_MS = 200;

function makeThrottle<T extends (...args: never[]) => void>(fn: T, ms: number) {
  let pending: ReturnType<typeof setTimeout> | null = null;
  let lastArgs: Parameters<T> | null = null;
  return (...args: Parameters<T>) => {
    lastArgs = args;
    if (pending !== null) return;
    pending = setTimeout(() => {
      pending = null;
      if (lastArgs) fn(...lastArgs);
    }, ms);
  };
}

export function CodeEditorPanel() {
  const activeTab = useTabStore((s) => s.getActiveTab());
  const updateTabContent = useTabStore((s) => s.updateTabContent);
  const themeId = useSettingsStore((s) => s.themeId);
  const themeType = getThemeById(themeId).type;

  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);

  const language = activeTab?.filePath
    ? getMonacoLanguage(activeTab.filePath)
    : "plaintext";

  const isCsv = !!activeTab?.csvFileType;
  const theme = themeType === "dark"
    ? (isCsv ? "mdium-csv-dark" : "vs-dark")
    : (isCsv ? "mdium-csv-light" : "vs");

  const handleEditorDidMount: OnMount = useCallback((ed) => {
    editorRef.current = ed;

    // Capture tabId at mount; the editor instance is keyed on activeTab.id,
    // so this closure is stable for the lifetime of this Monaco instance.
    const tabId = useTabStore.getState().activeTabId;
    if (tabId) {
      const saved = useTabStore.getState().tabs.find((t) => t.id === tabId)?.editorViewState;
      if (saved) ed.restoreViewState(saved);

      const save = makeThrottle(() => {
        // Editor may be disposed by the time this trailing-throttle fires
        // (e.g. user switched tabs within the throttle window). A disposed
        // editor returns null from saveViewState(), which would clobber the
        // previously-saved good state. Skip the write if disposed or null.
        if (ed.getModel() == null) return;
        const state = ed.saveViewState();
        if (state) useTabStore.getState().updateTabEditorViewState(tabId, state);
      }, VIEW_STATE_THROTTLE_MS);

      ed.onDidScrollChange(save);
      ed.onDidChangeCursorPosition(save);
      ed.onDidChangeCursorSelection(save);
    }

    ed.focus();
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
          theme={theme}
          onChange={handleChange}
          onMount={handleEditorDidMount}
          options={{
            fontSize: 14,
            minimap: { enabled: !isCsv },
            wordWrap: isCsv ? "off" : "on",
            automaticLayout: true,
            scrollBeyondLastLine: false,
            lineNumbers: "on",
            renderLineHighlight: "line",
            bracketPairColorization: { enabled: !isCsv },
            tabSize: 4,
            insertSpaces: true,
          }}
        />
      </div>
    </div>
  );
}
