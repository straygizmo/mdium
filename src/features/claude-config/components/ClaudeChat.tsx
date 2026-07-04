import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useTabStore } from "@/stores/tab-store";
import { useClaudeChat } from "../hooks/useClaudeChat";
import { ToolUseCard } from "./ToolUseCard";
import { PermissionCard } from "./PermissionCard";

export function ClaudeChat() {
  const { t } = useTranslation("claude-config");
  const activeFolderPath = useTabStore((s) => s.activeFolderPath);
  const {
    connected, connecting, error, chat, pendingPermission, stallNotice,
    connect, sendMessage, interrupt, respondPermission, newSession,
  } = useClaudeChat();
  const [input, setInput] = useState("");
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

  return (
    <div className="claude-chat">
      <div className="claude-chat__toolbar">
        <button className="claude-chat__toolbar-btn" onClick={() => void newSession()}>
          {t("newSession")}
        </button>
        {!connected && !connecting && activeFolderPath && (
          <button className="claude-chat__toolbar-btn" onClick={() => void connect(activeFolderPath)}>
            {t("reconnect")}
          </button>
        )}
        {connecting && <span className="claude-chat__status">{t("connecting")}</span>}
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
        <textarea
          className="claude-chat__input"
          aria-label={t("chatPlaceholder")}
          value={input}
          placeholder={t("chatPlaceholder")}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              handleSend();
            }
          }}
        />
        {chat.running ? (
          <button className="claude-chat__send" onClick={() => void interrupt()}>
            {t("stop")}
          </button>
        ) : (
          <button className="claude-chat__send" onClick={handleSend} disabled={!connected}>
            {t("send")}
          </button>
        )}
      </div>
    </div>
  );
}
