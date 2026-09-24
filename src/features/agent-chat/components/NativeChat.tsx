import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AgentProvider, AgentSessionSummary } from "@/shared/types/agent-runner";
import { chatKey, emptyChat, useAgentChatStore, type ChatEntry } from "../agent-chat-store";
import "@/features/claude-config/components/ClaudePanel.css";

interface Props {
  folder: string;
  provider: AgentProvider;
}

const ERROR_KEYS: Record<string, string> = {
  RUNNER_EXITED: "errorRunnerExited",
  TIMEOUT: "errorTimeout",
  CODEX_NOT_FOUND: "errorNotFound",
  COPILOT_NOT_FOUND: "errorNotFound",
  COPILOT_DISCONNECTED: "errorCopilotDisconnected",
  RUNNER_START_TIMEOUT: "errorRunnerStartTimeout",
  SESSION_CLOSED: "errorSessionUnavailable",
  SESSION_EXISTS: "errorSessionUnavailable",
  NO_SESSION: "errorSessionUnavailable",
  TURN_IN_PROGRESS: "errorSessionUnavailable",
  LIST_UNSUPPORTED: "errorSessionUnavailable",
};

function EntryView({ entry }: { entry: ChatEntry }) {
  const { t } = useTranslation("agent-chat");
  if (entry.role === "error") {
    const key = ERROR_KEYS[entry.text];
    return <div className="claude-chat__error">{key ? t(key) : t("errorGeneric", { message: entry.text })}</div>;
  }
  if (entry.role === "tool") {
    return (
      <div className="claude-chat__text agent-chat__tool">
        {entry.text}
        {entry.ok === false && <span className="agent-chat__tool-failed"> ({t("toolFailed")})</span>}
      </div>
    );
  }
  return (
    <div className={`claude-chat__msg claude-chat__msg--${entry.role}`}>
      <div className="claude-chat__text">{entry.text}</div>
    </div>
  );
}

export function NativeChat({ folder, provider }: Props) {
  const { t } = useTranslation("agent-chat");
  const chat = useAgentChatStore((s) => s.chats[chatKey(folder, provider)] ?? emptyChat);
  const { send, cancel, newSession, respondPermission, listSessions } = useAgentChatStore.getState();
  const [input, setInput] = useState("");
  const [history, setHistory] = useState<AgentSessionSummary[] | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView?.({ block: "end" });
  }, [chat.entries, chat.pendingPermission]);

  const busy = chat.status !== "idle";
  const submit = () => {
    const text = input.trim();
    if (!text || busy) return;
    // Keep the text in the input until the send actually succeeds, so a
    // failed send (e.g. the runner is unavailable) leaves it in place for
    // the user to retry instead of silently discarding it.
    void send(folder, provider, text).then((ok) => {
      if (ok) setInput("");
    });
  };

  return (
    <div className="claude-chat">
      <div className="claude-chat__toolbar">
        <button type="button" className="claude-chat__toolbar-btn" onClick={() => void newSession(folder, provider)} disabled={busy} title={t("newSession")} aria-label={t("newSession")}>
          +
        </button>
        {provider === "copilot" && (
          <button
            type="button"
            className="claude-chat__toolbar-btn"
            disabled={busy}
            title={t("history")}
            aria-label={t("history")}
            onClick={() => void listSessions(folder, provider).then(setHistory).catch(() => setHistory([]))}
          >
            ⟲
          </button>
        )}
        {chat.status === "starting" && <span className="agent-chat__status">{t("starting")}</span>}
        {chat.status === "running" && <span className="agent-chat__status">{t("running")}</span>}
      </div>

      <div className="claude-chat__messages">
        {chat.entries.map((entry) => <EntryView key={entry.id} entry={entry} />)}
        {chat.pendingPermission && (
          <div className="claude-permission">
            <div className="claude-permission__title">{t("permissionTitle")}</div>
            <div className="claude-permission__tool">{t(`permissionKind_${chat.pendingPermission.request.kind}`)}</div>
            <pre className="claude-permission__input">{chat.pendingPermission.request.summary}</pre>
            <div className="claude-permission__actions">
              <button type="button" className="claude-permission__btn claude-permission__btn--allow" onClick={() => void respondPermission(folder, provider, true)}>
                {t("allow")}
              </button>
              <button type="button" className="claude-permission__btn" onClick={() => void respondPermission(folder, provider, false)}>
                {t("deny")}
              </button>
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <div className="claude-chat__input-area">
        <div className="claude-chat__input-wrapper">
          <textarea
            className="claude-chat__input"
            aria-label={t("placeholder")}
            placeholder={t("placeholder")}
            rows={2}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit();
              }
            }}
          />
          <div className="claude-chat__input-actions">
            {chat.status === "running" ? (
              <button type="button" className="claude-chat__send" onClick={() => void cancel(folder, provider)} title={t("stop")} aria-label={t("stop")}>
                ■
              </button>
            ) : (
              <button type="button" className="claude-chat__send" onClick={submit} disabled={busy || !input.trim()} title={t("send")} aria-label={t("send")}>
                ➤
              </button>
            )}
          </div>
        </div>
      </div>

      {history && (
        <div className="claude-chat__overlay" onClick={() => setHistory(null)}>
          <div className="claude-chat__dialog" onClick={(e) => e.stopPropagation()}>
            <div className="claude-chat__dialog-header">
              <span>{t("history")}</span>
              <button type="button" className="claude-chat__dialog-close" onClick={() => setHistory(null)} aria-label={t("close")}>×</button>
            </div>
            {history.length === 0 ? (
              <div className="claude-chat__history-empty">{t("noHistory")}</div>
            ) : (
              <ul className="claude-chat__history-list">
                {history.map((s) => (
                  <li key={s.nativeSessionId}>
                    <button
                      type="button"
                      className="claude-chat__history-item"
                      onClick={() => { setHistory(null); void newSession(folder, provider, s.nativeSessionId); }}
                    >
                      <div className="claude-chat__history-title">{s.title ?? s.nativeSessionId}</div>
                      {s.updatedAt && <div className="claude-chat__history-meta">{new Date(s.updatedAt).toLocaleString()}</div>}
                    </button>
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
