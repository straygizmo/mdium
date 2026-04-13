import { useState, useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { showConfirm } from "@/stores/dialog-store";
import { useRagFeatures } from "../hooks/useRagFeatures";
import type { ChatSession } from "../hooks/useRagFeatures";
import { useSettingsStore } from "@/stores/settings-store";
import { useUiStore } from "@/stores/ui-store";
import { useSpeechToText } from "@/features/speech/hooks/useSpeechToText";
import type { AiSettings, RagSettings } from "@/shared/types";
import "./RagPanel.css";

interface RagPanelProps {
  folderPath: string | null;
  aiSettings: AiSettings;
  onOpenFile?: (path: string) => void;
}

export function RagPanel({ folderPath, aiSettings, onOpenFile }: RagPanelProps) {
  const { t } = useTranslation(["common", "editor"]);
  const {
    status,
    messages,
    loading,
    buildError,
    buildProgress,
    embedStatus,
    embedProgress,
    embedError,
    checkStatus,
    buildIndex,
    deleteIndex,
    askQuestion,
    saveAndNewChat,
    discardAndNewChat,
    getChatHistory,
    loadChat,
    deleteChatSession,
  } = useRagFeatures({ folderPath, aiSettings, onOpenFile });

  const setShowSettings = useSettingsStore((s) => s.setShowSettings);
  const language = useSettingsStore((s) => s.language);
  const ragSettings = useSettingsStore((s) => s.ragSettings);
  const setRagSettings = useSettingsStore((s) => s.setRagSettings);
  const speechEnabled = useSettingsStore((s) => s.speechEnabled);
  const speechModel = useSettingsStore((s) => s.speechModel);
  const { status: speechStatus, transcript, toggle: toggleSpeech, setTranscript } = useSpeechToText(speechModel);
  const input = useUiStore((s) => s.ragChatInput);
  const setInput = useUiStore((s) => s.setRagChatInput);
  const [showRagSettings, setShowRagSettings] = useState(false);
  const [localRagSettings, setLocalRagSettings] = useState<RagSettings>(ragSettings);
  const [showFileList, setShowFileList] = useState(false);
  const [indexedFiles, setIndexedFiles] = useState<string[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [historyList, setHistoryList] = useState<ChatSession[]>([]);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const apiKeyMissing = !aiSettings.apiKey;
  const folderName = folderPath?.split(/[\\/]/).pop() ?? "";

  const handleBadgeClick = useCallback(async () => {
    if (status.state !== "ready" || !folderPath) return;
    try {
      const files = await invoke<string[]>("rag_list_files", { folderPath, modelName: ragSettings.embeddingModel });
      const prefix = folderPath.replace(/\\/g, "/").replace(/\/$/, "") + "/";
      setIndexedFiles(files.map((f) => {
        const normalized = f.replace(/\\/g, "/");
        return normalized.startsWith(prefix) ? normalized.slice(prefix.length) : normalized;
      }));
      setShowFileList(true);
    } catch (e) {
      console.error("Failed to list indexed files:", e);
    }
  }, [status.state, folderPath]);

  const handleOpenHistory = useCallback(() => {
    setHistoryList(getChatHistory());
    setShowHistory(true);
  }, [getChatHistory]);

  const handleLoadChat = useCallback(async (sessionId: string) => {
    if (messages.length > 0) {
      if (!(await showConfirm(t("ragLoadChatConfirm"), { kind: "warning" }))) return;
    }
    loadChat(sessionId);
    setShowHistory(false);
  }, [messages, loadChat, t]);

  const handleDeleteChatSession = useCallback((e: React.MouseEvent, sessionId: string) => {
    e.stopPropagation();
    deleteChatSession(sessionId);
    setHistoryList((prev) => prev.filter((s) => s.id !== sessionId));
  }, [deleteChatSession]);

  useEffect(() => {
    if (transcript) {
      setInput(input + transcript);
      setTranscript("");
    }
  }, [transcript, setTranscript]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    checkStatus();
  }, [checkStatus]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSubmit = useCallback(() => {
    if (!input.trim() || loading) return;
    askQuestion(input.trim());
    setInput("");
  }, [input, loading, askQuestion]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key.toLowerCase() === "m" && e.shiftKey && (e.ctrlKey || e.metaKey) && !e.altKey && speechEnabled && !e.repeat) {
        e.preventDefault();
        if (speechStatus === "idle" || speechStatus === "recording") {
          toggleSpeech();
        }
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit, speechEnabled, speechStatus, toggleSpeech]
  );

  if (!folderPath) {
    return (
      <div className="rag-panel rag-panel--disabled">
        <div className="rag-panel__no-folder">
          {t("noFolder")}
        </div>
      </div>
    );
  }

  return (
    <div className="rag-panel">
      <div className="rag-panel__status">
        <span
          className={`rag-panel__badge rag-panel__badge--${status.state}`}
          onClick={handleBadgeClick}
          style={status.state === "ready" ? { cursor: "pointer" } : undefined}
        >
          {status.state === "ready"
            ? `${status.totalFiles} files / ${status.totalChunks} chunks`
            : status.state === "building"
              ? embedStatus === "downloading"
                ? `Building... ${t("ragDownloadingModel")}`
                : embedStatus === "loading"
                  ? `Building... (${embedProgress}%)`
                  : buildProgress
                    ? `${buildProgress.currentIndex}/${buildProgress.totalChunks}`
                    : "Building..."
              : "No index"}
        </span>
        <div className="rag-panel__actions">
          <button
            className="rag-panel__btn"
            onClick={buildIndex}
            disabled={status.state === "building" || !folderPath}
            title={status.state === "ready" ? t("ragRebuildIndex") : t("ragBuildIndex")}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <ellipse cx="12" cy="5" rx="9" ry="3" />
              <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
              <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
            </svg>
          </button>
          {status.state === "ready" && (
            <button
              className="rag-panel__btn rag-panel__btn--danger"
              onClick={async () => {
                const modelLabel = ragSettings.embeddingModel.split("/").pop() ?? ragSettings.embeddingModel;
                if (await showConfirm(t("ragDeleteIndexConfirm", { model: modelLabel }), { kind: "warning" })) {
                  deleteIndex();
                }
              }}
              title={t("ragDeleteIndex")}
            >
              ✕
            </button>
          )}
          <button
            className="rag-panel__btn"
            onClick={() => { setLocalRagSettings(ragSettings); setShowRagSettings(true); }}
            title={t("ragSettings")}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
        </div>
      </div>

      {status.state === "building" && buildProgress && (
        <div className="rag-panel__build-progress">
          <div className="rag-panel__build-progress-bar">
            <div
              className="rag-panel__build-progress-fill"
              style={{ width: `${Math.round((buildProgress.currentIndex / buildProgress.totalChunks) * 100)}%` }}
            />
          </div>
          <span className="rag-panel__build-progress-file" title={buildProgress.currentFile}>
            {buildProgress.currentFile}
          </span>
        </div>
      )}

      {(buildError || embedError) && (
        <div className="rag-panel__error">
          {(embedError === "NETWORK_ERROR" || buildError?.includes("NETWORK_ERROR"))
            ? t("ragNetworkError")
            : (embedError === "DOWNLOAD_ERROR" || buildError?.includes("DOWNLOAD_ERROR"))
              ? t("ragDownloadError")
              : `${t("ragBuildError")}: ${buildError || embedError}`}
        </div>
      )}

      {apiKeyMissing && (
        <div className="rag-panel__warning">
          {t("ragApiKeyMissing")}
          <button className="rag-panel__warning-link" onClick={() => setShowSettings(true)}>
            {t("ragOpenSettings")}
          </button>
        </div>
      )}

      <div className="rag-panel__toolbar">
        <button
          className="rag-panel__toolbar-btn"
          onClick={saveAndNewChat}
          disabled={messages.length === 0}
          title={t("ragSaveAndNew")}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
            <line x1="12" y1="18" x2="12" y2="12" />
            <line x1="9" y1="15" x2="15" y2="15" />
          </svg>
        </button>
        <button
          className="rag-panel__toolbar-btn"
          onClick={handleOpenHistory}
          title={t("ragChatHistory")}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <polyline points="12 6 12 12 16 14" />
          </svg>
        </button>
        <button
          className="rag-panel__toolbar-btn rag-panel__toolbar-btn--right"
          onClick={discardAndNewChat}
          disabled={messages.length === 0}
          title={t("ragDiscardAndNew")}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 6h18" />
            <path d="M8 6V4h8v2" />
            <path d="M5 6v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V6" />
          </svg>
        </button>
      </div>

      <div className="rag-panel__messages">
        {messages.map((msg, i) => (
          <div key={i} className={`rag-panel__msg rag-panel__msg--${msg.role}`}>
            <div className="rag-panel__msg-content" dangerouslySetInnerHTML={{ __html: msg.content }} />
            {msg.sources && msg.sources.length > 0 && (
              <div className="rag-panel__sources">
                {msg.sources.map((src, j) => (
                  <button
                    key={j}
                    className="rag-panel__source-btn"
                    onClick={() => onOpenFile?.(src.file)}
                    title={`${src.file} (${Math.round(src.score * 100)}%)`}
                  >
                    {src.file.split(/[\\/]/).pop()} {src.heading && `#${src.heading}`}
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
        {loading && <div className="rag-panel__loading">{t("loading")}</div>}
        <div ref={messagesEndRef} />
      </div>

      <div className="rag-panel__input-area">
        <div className="rag-panel__input-wrapper">
          <textarea
            className="rag-panel__input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={status.state === "ready" ? t("search") : t("ragPleaseBuildIndex")}
            title={status.state === "ready" ? t("ragInputTooltip", { folder: folderName }) : undefined}
            rows={2}
            disabled={status.state !== "ready" || loading || apiKeyMissing}
          />
          <div className="rag-panel__input-actions">
            {speechEnabled && (
              <button
                className={`rag-panel__mic-btn${speechStatus === "recording" ? " rag-panel__mic-btn--recording" : ""}`}
                onClick={toggleSpeech}
                disabled={speechStatus === "loading" || speechStatus === "transcribing" || status.state !== "ready"}
                title={t("editor:voiceInput")}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                  <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                  <line x1="12" y1="19" x2="12" y2="23" />
                  <line x1="8" y1="23" x2="16" y2="23" />
                </svg>
              </button>
            )}
            <button
              className="rag-panel__send"
              onClick={handleSubmit}
              disabled={!input.trim() || loading || status.state !== "ready" || apiKeyMissing}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="m14 10l-3 3m9.288-9.969a.535.535 0 0 1 .68.681l-5.924 16.93a.535.535 0 0 1-.994.04l-3.219-7.242a.54.54 0 0 0-.271-.271l-7.242-3.22a.535.535 0 0 1 .04-.993z"/>
              </svg>
            </button>
          </div>
        </div>
      </div>

      {showFileList && (
        <div className="rag-panel__overlay" onClick={() => setShowFileList(false)}>
          <div className="rag-panel__dialog" onClick={(e) => e.stopPropagation()}>
            <div className="rag-panel__dialog-header">
              <span>{t("ragIndexedFiles")} ({indexedFiles.length})</span>
              <button className="rag-panel__dialog-close" onClick={() => setShowFileList(false)}>✕</button>
            </div>
            <ul className="rag-panel__file-list">
              {indexedFiles.map((file, i) => (
                <li key={i} className="rag-panel__file-item" title={file}>{file}</li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {showRagSettings && (
        <div className="rag-panel__overlay" onClick={() => setShowRagSettings(false)}>
          <div className="rag-panel__dialog rag-panel__dialog--settings" onClick={(e) => e.stopPropagation()}>
            <div className="rag-panel__dialog-header">
              <span>{t("ragSettings")}</span>
              <button className="rag-panel__dialog-close" onClick={() => setShowRagSettings(false)}>✕</button>
            </div>
            <div className="rag-panel__settings-body">
              <label className="rag-panel__settings-label">
                {t("ragEmbeddingModel")}
                <select
                  className="rag-panel__settings-select"
                  value={localRagSettings.embeddingModel}
                  onChange={(e) => setLocalRagSettings({ ...localRagSettings, embeddingModel: e.target.value as RagSettings["embeddingModel"] })}
                >
                  <option value="Xenova/multilingual-e5-large">multilingual-e5-large</option>
                  <option value="Xenova/multilingual-e5-base">multilingual-e5-base</option>
                  <option value="Xenova/multilingual-e5-small">multilingual-e5-small</option>
                  <option value="onnx-community/harrier-oss-v1-270m-ONNX">harrier-oss-v1-270m</option>
                  {language === "ja" && <option value="sirasagi62/ruri-v3-30m-ONNX">ruri-v3-30m</option>}
                  {language === "ja" && <option value="sirasagi62/ruri-v3-130m-ONNX">ruri-v3-130m</option>}
                </select>
              </label>
              {localRagSettings.embeddingModel !== ragSettings.embeddingModel && (
                <div className="rag-panel__settings-warning">{t("ragModelChangeWarning")}</div>
              )}

              <label className="rag-panel__settings-label">
                {t("ragFileExtensions")}
                <input
                  className="rag-panel__settings-input"
                  type="text"
                  value={localRagSettings.fileExtensions}
                  readOnly
                  placeholder=".md"
                />
              </label>

              <label className="rag-panel__settings-label">
                {t("ragMinChunkLength")}
                <input
                  className="rag-panel__settings-input"
                  type="number"
                  min={0}
                  value={localRagSettings.minChunkLength}
                  onChange={(e) => setLocalRagSettings({ ...localRagSettings, minChunkLength: Math.max(0, parseInt(e.target.value) || 0) })}
                />
              </label>

              <label className="rag-panel__settings-label">
                {t("ragRetrieveTopK")}: {localRagSettings.retrieveTopK}
                <input
                  className="rag-panel__settings-slider"
                  type="range"
                  min={1}
                  max={10}
                  step={1}
                  value={localRagSettings.retrieveTopK}
                  onChange={(e) => setLocalRagSettings({ ...localRagSettings, retrieveTopK: parseInt(e.target.value) })}
                />
              </label>

              <label className="rag-panel__settings-label">
                {t("ragRetrieveMinScore")}: {localRagSettings.retrieveMinScore.toFixed(2)}
                <input
                  className="rag-panel__settings-slider"
                  type="range"
                  min={0.1}
                  max={1.0}
                  step={0.05}
                  value={localRagSettings.retrieveMinScore}
                  onChange={(e) => setLocalRagSettings({ ...localRagSettings, retrieveMinScore: parseFloat(e.target.value) })}
                />
              </label>

              <div className="rag-panel__settings-actions">
                <button
                  className="rag-panel__settings-save"
                  onClick={() => { setRagSettings(localRagSettings); setShowRagSettings(false); }}
                >
                  {t("save")}
                </button>
                <button
                  className="rag-panel__settings-cancel"
                  onClick={() => setShowRagSettings(false)}
                >
                  {t("cancel")}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {showHistory && (
        <div className="rag-panel__overlay" onClick={() => setShowHistory(false)}>
          <div className="rag-panel__dialog" onClick={(e) => e.stopPropagation()}>
            <div className="rag-panel__dialog-header">
              <span>{t("ragChatHistory")}</span>
              <button className="rag-panel__dialog-close" onClick={() => setShowHistory(false)}>✕</button>
            </div>
            {historyList.length === 0 ? (
              <div className="rag-panel__history-empty">{t("ragNoChatHistory")}</div>
            ) : (
              <ul className="rag-panel__history-list">
                {historyList.map((session) => (
                  <li
                    key={session.id}
                    className="rag-panel__history-item"
                    onClick={() => handleLoadChat(session.id)}
                  >
                    <div className="rag-panel__history-title">{session.title || t("untitled")}</div>
                    <div className="rag-panel__history-meta">
                      <span>{new Date(session.updatedAt).toLocaleString()}</span>
                      <button
                        className="rag-panel__history-delete"
                        onClick={(e) => handleDeleteChatSession(e, session.id)}
                        title={t("ragDeleteChat")}
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M3 6h18" />
                          <path d="M8 6V4h8v2" />
                          <path d="M5 6v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V6" />
                        </svg>
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
