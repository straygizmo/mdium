import { useCallback, useEffect, useRef } from "react";
import Editor, { type OnChange, type OnMount } from "@monaco-editor/react";
import type { editor } from "monaco-editor";
import { useSettingsStore } from "@/stores/settings-store";
import { getThemeById } from "@/shared/themes";
import type { FlowIssue } from "@/shared/types/flow";

const MARKER_OWNER = "flow-yaml";

/** One squiggle in the YAML text (1-based line and column). */
export interface FlowYamlMarker {
  message: string;
  line: number;
  column: number;
}

/** Markers for the `FLOW_PARSE_FAILED` errors that carry a position. */
export function parseErrorMarkers(errors: FlowIssue[]): FlowYamlMarker[] {
  const markers: FlowYamlMarker[] = [];
  for (const e of errors) {
    if (e.code !== "FLOW_PARSE_FAILED") continue;
    const line = Number(e.params.line);
    const column = Number(e.params.column);
    if (!Number.isFinite(line) || line < 1) continue;
    markers.push({
      message: typeof e.params.message === "string" ? e.params.message : e.code,
      line,
      column: Number.isFinite(column) && column >= 1 ? column : 1,
    });
  }
  return markers;
}

interface FlowYamlPaneProps {
  value: string;
  /** Called on every edit; debouncing is the store's job. */
  onChange: (text: string) => void;
  readOnly?: boolean;
  markers?: FlowYamlMarker[];
}

type MonacoApi = Parameters<OnMount>[1];

export function FlowYamlPane({ value, onChange, readOnly = false, markers = [] }: FlowYamlPaneProps) {
  const themeId = useSettingsStore((s) => s.themeId);
  const theme = getThemeById(themeId).type === "dark" ? "vs-dark" : "vs";
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<MonacoApi | null>(null);

  const applyMarkers = useCallback((list: FlowYamlMarker[]) => {
    const ed = editorRef.current;
    const monaco = monacoRef.current;
    const model = ed?.getModel();
    if (!monaco || !model) return;
    monaco.editor.setModelMarkers(
      model,
      MARKER_OWNER,
      list.map((m) => ({
        severity: monaco.MarkerSeverity.Error,
        message: m.message,
        startLineNumber: m.line,
        startColumn: m.column,
        endLineNumber: m.line,
        endColumn: model.getLineMaxColumn(Math.min(m.line, model.getLineCount())),
      })),
    );
  }, []);

  const markersRef = useRef(markers);
  markersRef.current = markers;

  const handleMount: OnMount = useCallback(
    (ed, monaco) => {
      editorRef.current = ed;
      monacoRef.current = monaco;
      applyMarkers(markersRef.current);
    },
    [applyMarkers],
  );

  useEffect(() => {
    applyMarkers(markers);
  }, [markers, applyMarkers]);

  const handleChange: OnChange = useCallback(
    (text) => {
      if (text !== undefined) onChange(text);
    },
    [onChange],
  );

  return (
    <Editor
      value={value}
      language="yaml"
      theme={theme}
      onChange={handleChange}
      onMount={handleMount}
      options={{
        readOnly,
        fontSize: 13,
        minimap: { enabled: false },
        automaticLayout: true,
        scrollBeyondLastLine: false,
        tabSize: 2,
        insertSpaces: true,
      }}
    />
  );
}
