import { useRef, useCallback, useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useTabStore } from "@/stores/tab-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useEditorContextStore } from "@/stores/editor-context-store";
import { useEditorFormatting } from "../hooks/useEditorFormatting";
import { useImagePaste } from "../hooks/useImagePaste";
import TableGridSelector from "@/features/table/components/TableGridSelector";
import EditorContextMenu from "./EditorContextMenu";
import { ImagePasteDialog } from "./ImagePasteDialog";
import { useSpeechToText } from "@/features/speech/hooks/useSpeechToText";
import { message } from "@tauri-apps/plugin-dialog";
import "./EditorPanel.css";

interface EditorPanelProps {
  editorRef: React.RefObject<HTMLTextAreaElement | null>;
}

export function EditorPanel({ editorRef }: EditorPanelProps) {
  const { t } = useTranslation("editor");
  const activeTab = useTabStore((s) => s.getActiveTab());
  const updateTabContent = useTabStore((s) => s.updateTabContent);
  const formatBarRef = useRef<HTMLDivElement>(null);
  const tableGridBtnRef = useRef<HTMLButtonElement>(null);
  const [showTableGrid, setShowTableGrid] = useState(false);
  // (spaceTimerRef / isSpaceRecordingRef removed — Shift+Space is now instant toggle)
  const scrollSync = useSettingsStore((s) => s.scrollSync);
  const setScrollSync = useSettingsStore((s) => s.setScrollSync);
  const speechEnabled = useSettingsStore((s) => s.speechEnabled);
  const speechModel = useSettingsStore((s) => s.speechModel);
  const { status: speechStatus, transcript, partialTranscript, toggle: toggleSpeech, setTranscript } = useSpeechToText(
    speechModel ?? "Xenova/whisper-small"
  );

  const updateCursor = useEditorContextStore((s) => s.updateCursor);
  const updateEditorContext = useEditorContextStore((s) => s.updateContext);

  const content = activeTab?.content ?? "";

  const handleContentChange = useCallback(
    (newContent: string) => {
      if (activeTab) {
        updateTabContent(activeTab.id, newContent);
      }
    },
    [activeTab, updateTabContent]
  );

  useEffect(() => {
    if (!transcript || !editorRef.current) return;
    const textarea = editorRef.current;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const newContent = content.substring(0, start) + transcript + content.substring(end);
    handleContentChange(newContent);
    setTranscript("");
    const newPos = start + transcript.length;
    setTimeout(() => {
      textarea.selectionStart = textarea.selectionEnd = newPos;
    }, 0);
  }, [transcript]); // eslint-disable-line react-hooks/exhaustive-deps


  const [ctxMenu, setCtxMenu] = useState({ x: 0, y: 0, visible: false, selStart: 0, selEnd: 0 });

  const { handleInsertFormatting, handleInsertTable, handleInsertMermaidTemplate } = useEditorFormatting({
    editorRef,
    content,
    onContentChange: handleContentChange,
  });

  const handleNoFile = useCallback(() => {
    message(t("imagePasteNoFile"), { kind: "warning" });
  }, [t]);

  const {
    handlePaste,
    pasteDialogState,
    closePasteDialog,
    confirmPaste,
  } = useImagePaste({
    editorRef,
    content,
    filePath: activeTab?.filePath ?? null,
    onContentChange: handleContentChange,
    onNoFile: handleNoFile,
  });

  const handleTextareaChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      handleContentChange(e.target.value);
    },
    [handleContentChange]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // Ctrl+Shift+M: toggle speech (works even with IME active)
      if (e.key.toLowerCase() === "m" && e.shiftKey && (e.ctrlKey || e.metaKey) && !e.altKey && speechEnabled && !e.repeat) {
        e.preventDefault();
        if (speechStatus === "idle" || speechStatus === "recording") {
          toggleSpeech();
        }
        return;
      }


      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        handleInsertFormatting("pagebreak");
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        const textarea = e.currentTarget;
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        const newContent =
          content.substring(0, start) + "  " + content.substring(end);
        handleContentChange(newContent);
        setTimeout(() => {
          textarea.selectionStart = textarea.selectionEnd = start + 2;
        }, 0);
      }
    },
    [content, handleContentChange, handleInsertFormatting, speechEnabled, speechStatus, toggleSpeech]
  );

  const handleKeyUp = useCallback(
    (_e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // No-op — kept for onKeyUp binding compatibility
    },
    []
  );

  const computeLineCol = useCallback((text: string, pos: number) => {
    const before = text.substring(0, pos);
    const lines = before.split("\n");
    return { line: lines.length, col: lines[lines.length - 1].length + 1 };
  }, []);

  const handleCursorChange = useCallback(() => {
    const textarea = editorRef.current;
    if (!textarea) return;
    const { selectionStart, selectionEnd } = textarea;
    const { line, col } = computeLineCol(content, selectionStart);
    const selectedText = content.substring(selectionStart, selectionEnd);
    updateCursor(line, col, selectionStart, selectionEnd, selectedText);
  }, [content, computeLineCol, updateCursor, editorRef]);

  const handleContextMenu = useCallback(
    (e: React.MouseEvent<HTMLTextAreaElement>) => {
      e.preventDefault();
      const textarea = editorRef.current;
      const selStart = textarea?.selectionStart ?? 0;
      const selEnd = textarea?.selectionEnd ?? 0;
      setCtxMenu({ x: e.clientX, y: e.clientY, visible: true, selStart, selEnd });
    },
    [editorRef]
  );

  const handleCtxCopy = useCallback(() => {
    const { selStart, selEnd } = ctxMenu;
    if (selStart !== selEnd) {
      navigator.clipboard.writeText(content.substring(selStart, selEnd));
    }
  }, [ctxMenu, content]);

  const handleCtxCut = useCallback(() => {
    const { selStart, selEnd } = ctxMenu;
    if (selStart === selEnd) return;
    navigator.clipboard.writeText(content.substring(selStart, selEnd));
    const newContent = content.substring(0, selStart) + content.substring(selEnd);
    handleContentChange(newContent);
    setTimeout(() => {
      const textarea = editorRef.current;
      if (textarea) {
        textarea.focus();
        textarea.setSelectionRange(selStart, selStart);
      }
    }, 0);
  }, [ctxMenu, content, handleContentChange, editorRef]);

  const handleCtxPaste = useCallback(async () => {
    const text = await navigator.clipboard.readText();
    if (!text) return;
    const { selStart, selEnd } = ctxMenu;
    const newContent = content.substring(0, selStart) + text + content.substring(selEnd);
    handleContentChange(newContent);
    const newPos = selStart + text.length;
    setTimeout(() => {
      const textarea = editorRef.current;
      if (textarea) {
        textarea.focus();
        textarea.setSelectionRange(newPos, newPos);
      }
    }, 0);
  }, [ctxMenu, content, handleContentChange, editorRef]);

  const handleCtxSelectAll = useCallback(() => {
    const textarea = editorRef.current;
    if (textarea) {
      textarea.focus();
      textarea.setSelectionRange(0, content.length);
    }
  }, [editorRef, content]);

  useEffect(() => {
    updateEditorContext(activeTab?.filePath ?? null, content);
  }, [activeTab?.filePath, content, updateEditorContext]);

  return (
    <div className="editor-panel">
      <div className="editor-panel__format-bar" ref={formatBarRef}>
        <button onClick={() => handleInsertFormatting("bold")} title={t("bold")}>
          <b>B</b>
        </button>
        <button onClick={() => handleInsertFormatting("italic")} title={t("italic")}>
          <i>I</i>
        </button>
        <button onClick={() => handleInsertFormatting("strike")} title={t("strikethrough")}>
          <s>S</s>
        </button>
        <span className="editor-panel__separator" />
        <button onClick={() => handleInsertFormatting("h1")} title={t("heading")}>
          H1
        </button>
        <button onClick={() => handleInsertFormatting("h2")}>H2</button>
        <button onClick={() => handleInsertFormatting("h3")}>H3</button>
        <span className="editor-panel__separator" />
        <button onClick={() => handleInsertFormatting("ul")} title={t("bulletList")}>
          •
        </button>
        <button onClick={() => handleInsertFormatting("ol")} title={t("numberedList")}>
          1.
        </button>
        <button onClick={() => handleInsertFormatting("quote")} title={t("blockquote")}>
          &gt;
        </button>
        <button onClick={() => handleInsertFormatting("code")} title={t("codeBlock")}>
          {"</>"}
        </button>
        <button onClick={() => handleInsertFormatting("codeblock")} title={t("fencedCodeBlock")}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="16 18 22 12 16 6" />
            <polyline points="8 6 2 12 8 18" />
            <line x1="10" y1="2" x2="14" y2="22" />
          </svg>
        </button>
        <button onClick={() => handleInsertFormatting("link")} title={t("link")}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
          </svg>
        </button>
        <button onClick={() => handleInsertFormatting("hr")} title={t("horizontalRule")}>
          ―
        </button>
        <button onClick={() => handleInsertFormatting("pagebreak")} title={t("pageBreak", { defaultValue: "改ページ (Ctrl+Enter)" })}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="17 1 21 5 17 9" />
            <path d="M21 5H9" />
            <polyline points="7 15 3 19 7 23" />
            <path d="M3 19h12" />
            <line x1="1" y1="12" x2="5" y2="12" />
            <line x1="10" y1="12" x2="14" y2="12" />
            <line x1="19" y1="12" x2="23" y2="12" />
          </svg>
        </button>
        <button
          ref={tableGridBtnRef}
          onMouseDown={(e) => { e.preventDefault(); setShowTableGrid((v) => !v); }}
          title={t("table")}
        >
          ⊞
        </button>
        {showTableGrid && (
          <TableGridSelector
            anchorRef={tableGridBtnRef}
            onSelect={(rows, cols) => {
              handleInsertTable(rows, cols);
              setShowTableGrid(false);
            }}
            onClose={() => setShowTableGrid(false)}
          />
        )}
        {speechEnabled && (
          <>
            <span className="editor-panel__separator" />
            <button
              className={`editor-panel__mic-btn editor-panel__mic-btn--${speechStatus}`}
              onClick={toggleSpeech}
              disabled={speechStatus === "loading" || speechStatus === "transcribing"}
              title={t("voiceInput")}
            >
              {speechStatus === "loading" || speechStatus === "transcribing" ? (
                <svg className="editor-panel__mic-spinner" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
                </svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="9" y="1" width="6" height="11" rx="3" />
                  <path d="M19 10v1a7 7 0 0 1-14 0v-1" />
                  <line x1="12" y1="19" x2="12" y2="23" />
                  <line x1="8" y1="23" x2="16" y2="23" />
                </svg>
              )}
            </button>
          </>
        )}
        <span className="editor-panel__spacer" />
        <button
          className={scrollSync ? "editor-panel__btn--active" : ""}
          onClick={() => setScrollSync(!scrollSync)}
          title={t("scrollSync")}
        >
          ⇕
        </button>
      </div>

      <div className="editor-panel__textarea-wrapper">
        <textarea
          ref={editorRef}
          className="editor-panel__textarea"
          value={content}
          onChange={handleTextareaChange}
          onKeyDown={handleKeyDown}
          onKeyUp={(e) => { handleKeyUp(e); handleCursorChange(); }}
          onSelect={handleCursorChange}
          onClick={handleCursorChange}
          onBlur={handleCursorChange}
          onContextMenu={handleContextMenu}
          onPaste={handlePaste}
          placeholder={t("placeholder", { defaultValue: "" })}
          spellCheck={false}
        />
        {(speechStatus === "recording" || speechStatus === "transcribing") && (
          <div className={`editor-panel__speech-overlay editor-panel__speech-overlay--${speechStatus}`}>
            <div className="editor-panel__speech-overlay-status">
              <div className="editor-panel__speech-overlay-icon">
                {speechStatus === "recording" ? (
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                    <rect x="9" y="1" width="6" height="11" rx="3" />
                    <path d="M19 10v1a7 7 0 0 1-14 0v-1" fill="none" stroke="currentColor" strokeWidth="2" />
                  </svg>
                ) : (
                  <svg className="editor-panel__mic-spinner" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
                  </svg>
                )}
              </div>
              <span className="editor-panel__speech-overlay-text">
                {speechStatus === "recording" ? t("speechRecording", { defaultValue: "録音中…" }) : t("speechTranscribing", { defaultValue: "認識中…" })}
              </span>
            </div>
            {speechStatus === "recording" && partialTranscript && (
              <span className="editor-panel__speech-overlay-partial">{partialTranscript}</span>
            )}
          </div>
        )}
      </div>
      <EditorContextMenu
        x={ctxMenu.x}
        y={ctxMenu.y}
        visible={ctxMenu.visible}
        hasSelection={ctxMenu.selStart !== ctxMenu.selEnd}
        onClose={() => setCtxMenu((prev) => ({ ...prev, visible: false }))}
        onCopy={handleCtxCopy}
        onCut={handleCtxCut}
        onPaste={handleCtxPaste}
        onSelectAll={handleCtxSelectAll}
        onInsertMermaid={handleInsertMermaidTemplate}
        onInsertTable={handleInsertTable}
        onInsertPageBreak={() => handleInsertFormatting("pagebreak")}
        onInsertCodeBlock={() => handleInsertFormatting("codeblock")}
        onInsertDetails={() => handleInsertFormatting("details")}
      />
      {pasteDialogState.visible && pasteDialogState.imageBlob && pasteDialogState.imageUrl && (
        <ImagePasteDialog
          imageUrl={pasteDialogState.imageUrl}
          imageBlob={pasteDialogState.imageBlob}
          onInsert={confirmPaste}
          onClose={closePasteDialog}
        />
      )}
    </div>
  );
}
