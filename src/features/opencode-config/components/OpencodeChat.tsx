import { useState, useCallback, useEffect, useRef, Fragment } from "react";
import { useTranslation } from "react-i18next";
import { showConfirm } from "@/stores/dialog-store";
import { useOpencodeChat, useChatUIStore } from "../hooks/useOpencodeChat";
import type { OpencodeSessionInfo, ImageAttachment } from "../hooks/useOpencodeChat";
import type { Part } from "@opencode-ai/sdk/client";
import { useTabStore } from "@/stores/tab-store";
import { useEditorContextStore } from "@/stores/editor-context-store";
import { OpencodeConfigBadges } from "./OpencodeConfigBadges";
import { CompletionPopup } from "./CompletionPopup";
import { QuestionsCard } from "./QuestionsCard";
import { useCompletion } from "../hooks/useCompletion";
import { useInputHistoryStore, useInputHistoryNav } from "../hooks/useInputHistory";
import { useInputUndoRedo } from "../hooks/useInputUndoRedo";
import { useDividerDragVertical } from "@/shared/hooks/useDividerDragVertical";
import "./OpencodeChat.css";

function computeLineColFromContext(text: string, pos: number) {
  const before = text.substring(0, pos);
  const lines = before.split("\n");
  return { line: lines.length, col: lines[lines.length - 1].length + 1 };
}

export function OpencodeChat() {
  const { t } = useTranslation("opencode-config");
  const activeFolderPath = useTabStore((s) => s.activeFolderPath);
  const activeTabName = useTabStore((s) => s.getActiveTab()?.fileName);
  const {
    connected,
    connecting,
    error,
    messages,
    loading,
    pendingQuestions,
    sessions,
    currentSessionId,
    connect,
    sendMessage,
    executeCommand,
    abortSession,
    createNewSession,
    loadSession,
    deleteSession,
    getSessionHistory,
    selectedAgent,
    setSelectedAgent,
    availableAgents,
    useMdContext,
    setUseMdContext,
  } = useOpencodeChat(activeFolderPath ?? undefined);

  const input = useChatUIStore((s) => s.chatInput);
  const setInput = useCallback((v: string) => useChatUIStore.setState({ chatInput: v }), []);
  const [attachedImages, setAttachedImages] = useState<ImageAttachment[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [expandedTools, setExpandedTools] = useState<Set<string>>(new Set());
  const [expandedToolGroups, setExpandedToolGroups] = useState<Set<number>>(new Set());
  const [toastKey, setToastKey] = useState(0);
  const [toastMsg, setToastMsg] = useState("");
  const aborted = useChatUIStore((s) => s.aborted);
  const prevLoadingRef = useRef(false);
  const messagesRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const agentOverrideRef = useRef<string | null>(null);

  // Vertical splitter between messages and input
  const chatSplitRatio = useChatUIStore((s) => s.chatSplitRatio);
  const setChatSplitRatio = useCallback(
    (r: number) => useChatUIStore.setState({ chatSplitRatio: r }),
    []
  );
  const chatContainerRef = useRef<HTMLDivElement>(null);
  const handleSplitterDrag = useDividerDragVertical(
    chatContainerRef,
    chatSplitRatio,
    setChatSplitRatio,
    30,
    85
  );

  // Show toast when loading finishes (loading: true → false with messages present)
  // Skip the toast when the session was aborted by the user
  useEffect(() => {
    if (prevLoadingRef.current && !loading && messages.length > 0 && !aborted) {
      const last = messages[messages.length - 1];
      const hasError = last?.role === "assistant" && last.parts?.some(
        (p) => p.type === "tool" && (p as any).state?.status === "error"
      );
      setToastMsg(hasError ? t("ocChatDoneError", "Done (with errors)") : t("ocChatDone", "Done"));
      setToastKey((k) => k + 1);
    }
    prevLoadingRef.current = loading;
  }, [loading, messages, t, aborted]);

  const completion = useCompletion({
    connected,
    input,
    folderPath: activeFolderPath ?? undefined,
    onInputChange: setInput,
    onCommandSelect: (name) => {
      executeCommand(name);
    },
    onAgentSelect: (agent) => {
      agentOverrideRef.current = agent;
    },
  });

  const { handleHistoryKey, resetNav: resetHistoryNav } = useInputHistoryNav(input, setInput);
  const { undo, redo } = useInputUndoRedo(input, setInput);

  // Scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    const imageItems: DataTransferItem[] = [];
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.startsWith("image/")) {
        imageItems.push(items[i]);
      }
    }

    if (imageItems.length === 0) return;

    e.preventDefault();
    for (const item of imageItems) {
      const file = item.getAsFile();
      if (!file) continue;

      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result as string;
        const ext = file.type.split("/")[1] ?? "png";
        const filename = file.name || `image.${ext}`;
        setAttachedImages((prev) => [...prev, { mime: file.type, dataUrl, filename }]);
      };
      reader.readAsDataURL(file);
    }
  }, []);

  const removeImage = useCallback((index: number) => {
    setAttachedImages((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const handleSubmit = useCallback(() => {
    if (!input.trim() && attachedImages.length === 0) return;
    if (loading) return;

    let textToSend = input.trim();
    let agent: string | undefined;

    // Only use agent override when the @agent prefix is still present
    if (agentOverrideRef.current && textToSend.startsWith(`@${agentOverrideRef.current}`)) {
      agent = agentOverrideRef.current;
      textToSend = textToSend.slice(`@${agent}`.length).trim();
    }

    agentOverrideRef.current = null;
    if (!textToSend && attachedImages.length === 0) return;

    // Save to input history
    if (input.trim()) {
      useInputHistoryStore.getState().addEntry(input.trim());
    }
    resetHistoryNav();

    // MD Context prefix
    if (useMdContext) {
      const ctx = useEditorContextStore.getState();
      if (ctx.filePath) {
        let prefix = `${t("ocChatMdContextPrefix")}\n\nFile: ${ctx.filePath}\nCursor position: line ${ctx.cursorLine}, column ${ctx.cursorColumn}`;
        if (ctx.selectionStart !== ctx.selectionEnd) {
          const startLC = computeLineColFromContext(ctx.content, ctx.selectionStart);
          const endLC = computeLineColFromContext(ctx.content, ctx.selectionEnd);
          prefix += `\nSelection: line ${startLC.line} col ${startLC.col} - line ${endLC.line} col ${endLC.col}`;
          prefix += `\n\n--- Selected Text ---\n${ctx.selectedText}\n--- End Selected Text ---`;
        }
        textToSend = prefix + `\n\nInstruction: ${textToSend}`;
      }
    }

    const imagesToSend = attachedImages.length > 0 ? [...attachedImages] : undefined;
    sendMessage(textToSend, agent, imagesToSend);
    setInput("");
    setAttachedImages([]);
  }, [input, loading, sendMessage, useMdContext, resetHistoryNav, attachedImages]);

  const handleQuestionsSubmit = useCallback(
    (answers: string) => {
      sendMessage(answers);
    },
    [sendMessage]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // Undo/Redo/Paste: handle before anything else, stop propagation
      // to prevent the global handler in App.tsx from intercepting
      if (e.ctrlKey && e.key === "z") {
        e.preventDefault();
        e.stopPropagation();
        undo();
        return;
      }
      if (e.ctrlKey && e.key === "y") {
        e.preventDefault();
        e.stopPropagation();
        redo();
        return;
      }
      if (e.ctrlKey && e.key === "v") {
        e.stopPropagation();
        return;
      }

      // Let completion handle the key first
      if (completion.handleKeyDown(e)) return;

      // Input history navigation (only when completion is not visible)
      if (handleHistoryKey(e)) return;

      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit, completion.handleKeyDown, handleHistoryKey, undo, redo] // eslint-disable-line react-hooks/exhaustive-deps
  );

  const handleMessagesKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "End") {
      e.preventDefault();
      messagesRef.current?.scrollTo({ top: messagesRef.current.scrollHeight, behavior: "smooth" });
    }
  }, []);

  const handleOpenHistory = useCallback(async () => {
    await getSessionHistory();
    setShowHistory(true);
  }, [getSessionHistory]);

  const handleLoadSession = useCallback(
    (sessionId: string) => {
      loadSession(sessionId);
      setShowHistory(false);
    },
    [loadSession]
  );

  const handleDeleteSession = useCallback(
    async (e: React.MouseEvent, sessionId: string) => {
      e.stopPropagation();
      if (await showConfirm(t("ocChatDeleteConfirm"), { kind: "warning" })) {
        deleteSession(sessionId);
      }
    },
    [deleteSession, t]
  );

  const toggleToolExpand = useCallback((callId: string) => {
    setExpandedTools((prev) => {
      const next = new Set(prev);
      if (next.has(callId)) next.delete(callId);
      else next.add(callId);
      return next;
    });
  }, []);

  const toggleToolGroup = useCallback((msgIndex: number) => {
    setExpandedToolGroups((prev) => {
      const next = new Set(prev);
      if (next.has(msgIndex)) next.delete(msgIndex);
      else next.add(msgIndex);
      return next;
    });
  }, []);

  const renderToolPart = (part: Part, defaultExpanded = false) => {
    if (part.type !== "tool") return null;
    const toolPart = part as Extract<Part, { type: "tool" }>;
    const hasExplicitToggle = expandedTools.has(toolPart.callID);
    const isExpanded = defaultExpanded ? !hasExplicitToggle : hasExplicitToggle;
    const statusIcon = toolPart.state.status === "completed" ? "\u2713"
      : toolPart.state.status === "error" ? "\u2717"
      : toolPart.state.status === "running" ? "\u25B6"
      : "\u23F3";
    const statusClass = `oc-chat__tool-status--${toolPart.state.status}`;

    return (
      <div key={toolPart.id} className="oc-chat__tool">
        <button
          className="oc-chat__tool-header"
          onClick={() => toggleToolExpand(toolPart.callID)}
        >
          <span className={`oc-chat__tool-status ${statusClass}`}>{statusIcon}</span>
          <span className="oc-chat__tool-name">{toolPart.tool}</span>
          {toolPart.state.status === "completed" && toolPart.state.title && (
            <span className="oc-chat__tool-title">{toolPart.state.title}</span>
          )}
          <span className="oc-chat__tool-toggle">{isExpanded ? "\u25BC" : "\u25B6"}</span>
        </button>
        {isExpanded && (
          <div className="oc-chat__tool-body">
            <pre className="oc-chat__tool-input">
              {JSON.stringify(toolPart.state.input, null, 2)}
            </pre>
            {toolPart.state.status === "completed" && (
              <pre className="oc-chat__tool-output">{toolPart.state.output}</pre>
            )}
            {toolPart.state.status === "error" && (
              <pre className="oc-chat__tool-error">{toolPart.state.error}</pre>
            )}
          </div>
        )}
      </div>
    );
  };

  const renderToolsSummary = (toolParts: Part[], msgIndex: number) => {
    const items = toolParts.map((p) => {
      const tp = p as Extract<Part, { type: "tool" }>;
      const icon = tp.state.status === "completed" ? "\u2713"
        : tp.state.status === "error" ? "\u2717"
        : "\u23F3";
      const title = tp.state.status === "completed" && tp.state.title
        ? ` ${tp.state.title}`
        : "";
      return `${icon} ${tp.tool}${title}`;
    });
    const summaryText = items.join(", ");

    return (
      <button
        className="oc-chat__tools-summary"
        onClick={() => toggleToolGroup(msgIndex)}
      >
        <span className="oc-chat__tools-summary-toggle">
          {expandedToolGroups.has(msgIndex) ? "\u25BC" : "\u25B6"}
        </span>
        <span className="oc-chat__tools-summary-text">{summaryText}</span>
      </button>
    );
  };

  return (
    <div className="oc-chat">
      {/* Toast */}
      {toastKey > 0 && (
        <div
          key={toastKey}
          className={`oc-chat__toast${toastMsg.includes("error") ? " oc-chat__toast--error" : ""}`}
        >
          {toastMsg}
        </div>
      )}
      {/* Toolbar */}
      <div className="oc-chat__toolbar">
        <button
          className="oc-chat__toolbar-btn"
          onClick={createNewSession}
          disabled={!connected || (messages.length === 0 && !currentSessionId)}
          title={t("ocChatNewSession")}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
            <line x1="12" y1="18" x2="12" y2="12" />
            <line x1="9" y1="15" x2="15" y2="15" />
          </svg>
        </button>
        <button
          className="oc-chat__toolbar-btn"
          onClick={handleOpenHistory}
          disabled={!connected}
          title={t("ocChatHistory")}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <polyline points="12 6 12 12 16 14" />
          </svg>
        </button>
        <select
          className="oc-chat__agent-select"
          value={selectedAgent ?? "build"}
          onChange={(e) => setSelectedAgent(e.target.value)}
          disabled={!connected}
          title={t("ocChatAgentSelect")}
        >
          {availableAgents.length > 0
            ? availableAgents.map((a) => (
                <option key={a.name} value={a.name}>
                  {a.name}
                </option>
              ))
            : (
              <>
                <option value="build">build</option>
                <option value="plan">plan</option>
              </>
            )
          }
        </select>
        <span
          className={`oc-chat__badge oc-chat__badge--${connected ? "connected" : connecting ? "connecting" : "disconnected"}`}
        >
          {connecting
            ? t("ocChatConnecting")
            : connected
              ? t("ocChatConnected")
              : t("ocChatDisconnected")}
        </span>
        <button
          className="oc-chat__toolbar-btn oc-chat__toolbar-btn--right"
          onClick={createNewSession}
          disabled={messages.length === 0}
          title={t("ocChatDiscard")}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 6h18" />
            <path d="M8 6V4h8v2" />
            <path d="M5 6v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V6" />
          </svg>
        </button>
      </div>

      {error && (
        <div className="oc-chat__error">
          {t("ocChatError")}: {error}
        </div>
      )}

      {/* Status bar */}
      <div className="oc-chat__status">
        <OpencodeConfigBadges />
        {!connected && !connecting && (
          <button className="oc-chat__connect-btn" onClick={connect}>
            {t("ocChatConnecting").replace("...", "")}
          </button>
        )}
      </div>

      {/* Splittable area */}
      <div className="oc-chat__split" ref={chatContainerRef}>
        {/* Messages */}
        <div
          className="oc-chat__messages"
          ref={messagesRef}
          tabIndex={0}
          onKeyDown={handleMessagesKeyDown}
          style={{ flex: `0 0 ${chatSplitRatio}%` }}
        >
          {messages.map((msg, i) => {
            if (msg.role === "user") {
              return (
                <div key={i} className="oc-chat__msg oc-chat__msg--user">
                  <div className="oc-chat__msg-content">{msg.content}</div>
                </div>
              );
            }

            const toolParts = (msg.parts ?? []).filter((p) => p.type === "tool");
            const reasoningParts = (msg.parts ?? []).filter((p) => p.type === "reasoning");
            const hasTools = toolParts.length > 0;
            const hasReasoning = reasoningParts.length > 0;
            const isStreaming = !msg.completed;

            // Strip echoed user question from content
            // During streaming: raw text; after completion: HTML from marked()
            let displayContent = msg.content;
            if (i > 0 && msg.parts) {
              const prevUser = messages[i - 1];
              if (prevUser?.role === "user" && prevUser.content) {
                const userText = prevUser.content.trim();
                const textParts = msg.parts.filter((p) => p.type === "text");
                const firstText = textParts.length > 0 ? ((textParts[0] as any).text ?? "") : "";
                if (firstText.trim().startsWith(userText)) {
                  if (isStreaming) {
                    // Raw text: strip directly
                    const stripped = firstText.trim().slice(userText.length).trimStart();
                    const restParts = textParts.slice(1).map((p) => (p as any).text ?? "").join("");
                    displayContent = stripped + restParts;
                  } else {
                    // HTML from marked(): strip the leading <p>question</p> or plain text prefix
                    const escapedUser = userText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
                    displayContent = displayContent
                      .replace(new RegExp(`^\\s*<p>${escapedUser}\\s*`), "<p>")
                      .replace(/^<p>\s*<\/p>\s*/, "");
                  }
                }
              }
            }
            // Hide raw JSON text when questions are pending for the last assistant message
            const isLastMsg = i === messages.length - 1;
            const hideForQuestions = isLastMsg && !!pendingQuestions;
            const hasContent = !!displayContent && !hideForQuestions;

            return (
              <Fragment key={i}>
                {/* Reasoning / thinking parts */}
                {hasReasoning && (
                  <div className="oc-chat__msg oc-chat__msg--assistant oc-chat__msg--reasoning">
                    <details open={isStreaming}>
                      <summary className="oc-chat__reasoning-summary">
                        {t("ocChatReasoning", "Thinking")}
                      </summary>
                      <div className="oc-chat__reasoning-body">
                        {reasoningParts.map((p) => (
                          <p key={(p as any).id}>{(p as any).text ?? ""}</p>
                        ))}
                      </div>
                    </details>
                  </div>
                )}
                {/* Tool parts bubble */}
                {hasTools && (
                  <div className="oc-chat__msg oc-chat__msg--assistant oc-chat__msg--tools">
                    {isStreaming ? (
                      // During streaming: show tools individually, expanded by default
                      toolParts.map((p) => renderToolPart(p, true))
                    ) : (
                      // Completed: collapsible summary
                      <>
                        {renderToolsSummary(toolParts, i)}
                        {expandedToolGroups.has(i) && toolParts.map((p) => renderToolPart(p))}
                      </>
                    )}
                  </div>
                )}
                {/* Text answer bubble (separate from tools) */}
                {hasContent && (
                  <div className="oc-chat__msg oc-chat__msg--assistant">
                    <div
                      className="oc-chat__msg-content"
                      dangerouslySetInnerHTML={{ __html: displayContent }}
                    />
                  </div>
                )}
              </Fragment>
            );
          })}
          {loading && !pendingQuestions && (
            <div className="oc-chat__loading">
              <span className="oc-chat__loading-dots">
                <span className="oc-chat__loading-dot" />
                <span className="oc-chat__loading-dot" />
                <span className="oc-chat__loading-dot" />
              </span>
              <span className="oc-chat__loading-label">{t("ocChatThinking", "Thinking...")}</span>
              <button
                className="oc-chat__abort-btn"
                onClick={abortSession}
                title={t("ocChatAbort", "Stop")}
              >
                {t("ocChatAbort", "Stop")}
              </button>
            </div>
          )}
          {pendingQuestions && (
            <div className="oc-chat__msg oc-chat__msg--assistant">
              <QuestionsCard
                key={JSON.stringify(pendingQuestions)}
                questions={pendingQuestions}
                onSubmit={handleQuestionsSubmit}
              />
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Splitter handle */}
        <div className="oc-chat__splitter" onMouseDown={handleSplitterDrag} />

        {/* Bottom section */}
        <div className="oc-chat__bottom" style={{ flex: `0 0 ${100 - chatSplitRatio}%` }}>
          {/* MD context toggle */}
          <label className="oc-chat__md-toggle-bar" title={t("ocChatMdContext")}>
            <input
              type="checkbox"
              checked={useMdContext}
              onChange={(e) => setUseMdContext(e.target.checked)}
            />
            <span className="oc-chat__md-toggle-slider" />
            <span className="oc-chat__md-toggle-label">
              {t("ocChatMdToggleLabel", { name: activeTabName ?? "MD" })}
            </span>
          </label>

          {/* Input area */}
          <div className="oc-chat__input-area">
            <CompletionPopup
              items={completion.items}
              selectedIndex={completion.selectedIndex}
              visible={completion.visible}
              onItemClick={completion.handleItemClick}
            />
            <div className="oc-chat__input-wrapper">
              {attachedImages.length > 0 && (
                <div className="oc-chat__image-preview">
                  {attachedImages.map((img, i) => (
                    <div key={i} className="oc-chat__image-preview-item">
                      <img src={img.dataUrl} alt={img.filename} />
                      <button
                        className="oc-chat__image-preview-remove"
                        onClick={() => removeImage(i)}
                        title={t("ocChatRemoveImage", "Remove")}
                      >
                        &#x2715;
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <textarea
                className="oc-chat__input"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
                placeholder={connected ? t("ocChatPlaceholder") : t("ocChatDisconnected")}
                rows={2}
                disabled={!connected || loading}
              />
              <div className="oc-chat__input-actions">
                <button
                  className="oc-chat__send"
                  onClick={handleSubmit}
                  disabled={(!input.trim() && attachedImages.length === 0) || loading || !connected}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="m14 10l-3 3m9.288-9.969a.535.535 0 0 1 .68.681l-5.924 16.93a.535.535 0 0 1-.994.04l-3.219-7.242a.54.54 0 0 0-.271-.271l-7.242-3.22a.535.535 0 0 1 .04-.993z"/>
                  </svg>
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* History dialog */}
      {showHistory && (
        <div className="oc-chat__overlay" onClick={() => setShowHistory(false)}>
          <div className="oc-chat__dialog" onClick={(e) => e.stopPropagation()}>
            <div className="oc-chat__dialog-header">
              <span>{t("ocChatHistory")}</span>
              <button className="oc-chat__dialog-close" onClick={() => setShowHistory(false)}>
                ✕
              </button>
            </div>
            {sessions.length === 0 ? (
              <div className="oc-chat__history-empty">{t("ocChatNoHistory")}</div>
            ) : (
              <ul className="oc-chat__history-list">
                {sessions.map((session: OpencodeSessionInfo) => (
                  <li
                    key={session.id}
                    className="oc-chat__history-item"
                    onClick={() => handleLoadSession(session.id)}
                  >
                    <div className="oc-chat__history-title">{session.title}</div>
                    <div className="oc-chat__history-meta">
                      <span>{new Date(session.updatedAt).toLocaleString()}</span>
                      <button
                        className="oc-chat__history-delete"
                        onClick={(e) => handleDeleteSession(e, session.id)}
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
