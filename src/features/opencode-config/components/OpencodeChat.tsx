import { useState, useCallback, useEffect, useRef, Fragment } from "react";
import { useTranslation } from "react-i18next";
import { useOpencodeChat, useChatUIStore } from "../hooks/useOpencodeChat";
import type { OpencodeSessionInfo } from "../hooks/useOpencodeChat";
import type { Part } from "@opencode-ai/sdk/client";
import { useTabStore } from "@/stores/tab-store";
import { useEditorContextStore } from "@/stores/editor-context-store";
import { OpencodeConfigBadges } from "./OpencodeConfigBadges";
import { CompletionPopup } from "./CompletionPopup";
import { useCompletion } from "../hooks/useCompletion";
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
    sessions,
    currentSessionId,
    connect,
    sendMessage,
    executeCommand,
    createNewSession,
    loadSession,
    deleteSession,
    getSessionHistory,
    usePlanAgent,
    setUsePlanAgent,
    useMdContext,
    setUseMdContext,
  } = useOpencodeChat(activeFolderPath ?? undefined);

  const input = useChatUIStore((s) => s.chatInput);
  const setInput = useCallback((v: string) => useChatUIStore.setState({ chatInput: v }), []);
  const [showHistory, setShowHistory] = useState(false);
  const [expandedTools, setExpandedTools] = useState<Set<string>>(new Set());
  const [expandedToolGroups, setExpandedToolGroups] = useState<Set<number>>(new Set());
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const agentOverrideRef = useRef<string | null>(null);

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

  // Scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSubmit = useCallback(() => {
    if (!input.trim() || loading) return;

    let textToSend = input.trim();
    let agent: string | undefined;

    // Only use agent override when the @agent prefix is still present
    if (agentOverrideRef.current && textToSend.startsWith(`@${agentOverrideRef.current}`)) {
      agent = agentOverrideRef.current;
      textToSend = textToSend.slice(`@${agent}`.length).trim();
    }

    agentOverrideRef.current = null;
    if (!textToSend) return;

    // MD Context prefix
    if (useMdContext) {
      const ctx = useEditorContextStore.getState();
      if (ctx.filePath) {
        let prefix = `Instructions about the following Markdown file.\n\nFile: ${ctx.filePath}\nCursor position: line ${ctx.cursorLine}, column ${ctx.cursorColumn}`;
        if (ctx.selectionStart !== ctx.selectionEnd) {
          const startLC = computeLineColFromContext(ctx.content, ctx.selectionStart);
          const endLC = computeLineColFromContext(ctx.content, ctx.selectionEnd);
          prefix += `\nSelection: line ${startLC.line} col ${startLC.col} - line ${endLC.line} col ${endLC.col}`;
          prefix += `\n\n--- Selected Text ---\n${ctx.selectedText}\n--- End Selected Text ---`;
        }
        textToSend = prefix + `\n\nInstruction: ${textToSend}`;
      }
    }

    sendMessage(textToSend, agent);
    setInput("");
  }, [input, loading, sendMessage, useMdContext]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // Let completion handle the key first
      if (completion.handleKeyDown(e)) return;

      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit, completion.handleKeyDown] // eslint-disable-line react-hooks/exhaustive-deps
  );

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
    (e: React.MouseEvent, sessionId: string) => {
      e.stopPropagation();
      if (window.confirm(t("ocChatDeleteConfirm"))) {
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
      {/* Status bar */}
      <div className="oc-chat__status">
        <OpencodeConfigBadges />
        {!connected && !connecting && (
          <button className="oc-chat__connect-btn" onClick={connect}>
            {t("ocChatConnecting").replace("...", "")}
          </button>
        )}
      </div>

      {error && (
        <div className="oc-chat__error">
          {t("ocChatError")}: {error}
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
        <label className="oc-chat__plan-toggle" title="Plan Agent">
          <input
            type="checkbox"
            checked={usePlanAgent}
            onChange={(e) => setUsePlanAgent(e.target.checked)}
          />
          <span className="oc-chat__plan-toggle-slider" />
          <span className="oc-chat__plan-toggle-label">Plan</span>
        </label>
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

      {/* Messages */}
      <div className="oc-chat__messages">
        {messages.map((msg, i) => {
          if (msg.role === "user") {
            return (
              <div key={i} className="oc-chat__msg oc-chat__msg--user">
                <div className="oc-chat__msg-content">{msg.content}</div>
              </div>
            );
          }

          const toolParts = (msg.parts ?? []).filter((p) => p.type === "tool");
          const hasTools = toolParts.length > 0;
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
          const hasContent = !!displayContent;

          return (
            <Fragment key={i}>
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
        {loading && <div className="oc-chat__loading">...</div>}
        <div ref={messagesEndRef} />
      </div>

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
          <textarea
            className="oc-chat__input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={connected ? t("ocChatPlaceholder") : t("ocChatDisconnected")}
            rows={2}
            disabled={!connected || loading}
          />
          <div className="oc-chat__input-actions">
            <button
              className="oc-chat__send"
              onClick={handleSubmit}
              disabled={!input.trim() || loading || !connected}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="m14 10l-3 3m9.288-9.969a.535.535 0 0 1 .68.681l-5.924 16.93a.535.535 0 0 1-.994.04l-3.219-7.242a.54.54 0 0 0-.271-.271l-7.242-3.22a.535.535 0 0 1 .04-.993z"/>
              </svg>
            </button>
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
