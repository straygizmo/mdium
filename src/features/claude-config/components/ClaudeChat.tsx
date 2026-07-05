import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useTabStore } from "@/stores/tab-store";
import { showConfirm } from "@/stores/dialog-store";
import { useClaudeChat } from "../hooks/useClaudeChat";
import { ToolUseCard } from "./ToolUseCard";
import { PermissionCard } from "./PermissionCard";
import { ClaudeConfigBadges } from "./ClaudeConfigBadges";

export function ClaudeChat() {
  const { t } = useTranslation("claude-config");
  const activeFolderPath = useTabStore((s) => s.activeFolderPath);
  const {
    connected, connecting, error, chat, pendingPermission, stallNotice, sessions, cliMissing,
    connect, sendMessage, interrupt, respondPermission, newSession,
    getSessions, loadSession, deleteSession,
  } = useClaudeChat();
  const [input, setInput] = useState("");
  const [showHistory, setShowHistory] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (activeFolderPath) void connect(activeFolderPath);
  }, [activeFolderPath, connect]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [chat.messages, pendingPermission]);

  const handleSend = () => {
    const text = input.trim();
    if (!text || chat.running || !connected) return;
    setInput("");
    void sendMessage(text);
  };

  const handleOpenHistory = async () => {
    await getSessions();
    setShowHistory(true);
  };

  const handleLoadSession = (id: string) => {
    setShowHistory(false);
    void loadSession(id);
  };

  const handleDeleteSession = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (await showConfirm(t("deleteSessionConfirm"), { kind: "warning" })) {
      void deleteSession(id);
    }
  };

  return (
    <div className="claude-chat">
      <div className="claude-chat__toolbar">
        <button
          className="claude-chat__toolbar-btn"
          onClick={() => void newSession()}
          title={t("newSession")}
          aria-label={t("newSession")}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
            <line x1="12" y1="18" x2="12" y2="12" />
            <line x1="9" y1="15" x2="15" y2="15" />
          </svg>
        </button>
        <button
          className="claude-chat__toolbar-btn"
          onClick={() => void handleOpenHistory()}
          title={t("history")}
          aria-label={t("history")}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <polyline points="12 6 12 12 16 14" />
          </svg>
        </button>
        <span
          className={`claude-chat__badge claude-chat__badge--${connected ? "connected" : connecting ? "connecting" : cliMissing ? "cli-missing" : "disconnected"}`}
        >
          {connecting
            ? t("connecting")
            : connected
              ? t("connected")
              : cliMissing
                ? t("cliMissing")
                : t("disconnected")}
        </span>
        {!connected && !connecting && activeFolderPath && (
          <button
            className="claude-chat__toolbar-btn claude-chat__toolbar-btn--right"
            onClick={() => void connect(activeFolderPath)}
          >
            {t("reconnect")}
          </button>
        )}
      </div>

      <div className="claude-chat__status">
        <ClaudeConfigBadges />
      </div>

      {error && <div className="claude-chat__error">{error}</div>}

      <div className="claude-chat__messages">
        {chat.messages.map((m, i) => (
          <div key={i} className={`claude-chat__msg claude-chat__msg--${m.role}`}>
            {m.parts.map((p, j) =>
              p.type === "text" ? (
                <div key={j} className="claude-chat__text">{p.text}</div>
              ) : (
                <ToolUseCard key={j} part={p} />
              ),
            )}
          </div>
        ))}
        {chat.running && stallNotice && (
          <div className="claude-chat__stall">{t("stallNotice")}</div>
        )}
        {pendingPermission && (
          <PermissionCard
            request={pendingPermission}
            onRespond={(id, behavior) => void respondPermission(id, behavior)}
          />
        )}
        <div ref={bottomRef} />
      </div>

      <div className="claude-chat__input-area">
        <div className="claude-chat__input-wrapper">
          <textarea
            className="claude-chat__input"
            aria-label={t("chatPlaceholder")}
            value={input}
            placeholder={t("chatPlaceholder")}
            rows={2}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                handleSend();
              }
            }}
          />
          <div className="claude-chat__input-actions">
            {chat.running ? (
              <button
                className="claude-chat__send"
                onClick={() => void interrupt()}
                title={t("stop")}
                aria-label={t("stop")}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                  <rect x="6" y="6" width="12" height="12" rx="2" />
                </svg>
              </button>
            ) : (
              <button
                className="claude-chat__send"
                onClick={handleSend}
                disabled={!connected || !input.trim()}
                title={t("send")}
                aria-label={t("send")}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="m14 10l-3 3m9.288-9.969a.535.535 0 0 1 .68.681l-5.924 16.93a.535.535 0 0 1-.994.04l-3.219-7.242a.54.54 0 0 0-.271-.271l-7.242-3.22a.535.535 0 0 1 .04-.993z" />
                </svg>
              </button>
            )}
          </div>
        </div>
      </div>

      {showHistory && (
        <div className="claude-chat__overlay" onClick={() => setShowHistory(false)}>
          <div className="claude-chat__dialog" onClick={(e) => e.stopPropagation()}>
            <div className="claude-chat__dialog-header">
              <span>{t("history")}</span>
              <button className="claude-chat__dialog-close" onClick={() => setShowHistory(false)}>
                ✕
              </button>
            </div>
            {sessions.length === 0 ? (
              <div className="claude-chat__history-empty">{t("noHistory")}</div>
            ) : (
              <ul className="claude-chat__history-list">
                {sessions.map((session) => (
                  <li
                    key={session.id}
                    className="claude-chat__history-item"
                    onClick={() => handleLoadSession(session.id)}
                  >
                    <div className="claude-chat__history-title">
                      {session.title || t("untitledSession")}
                    </div>
                    <div className="claude-chat__history-meta">
                      <span>{new Date(session.updatedAt).toLocaleString()}</span>
                      <button
                        className="claude-chat__history-delete"
                        onClick={(e) => void handleDeleteSession(e, session.id)}
                        title={t("deleteSession")}
                        aria-label={t("deleteSession")}
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
