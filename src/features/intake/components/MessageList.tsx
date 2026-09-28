import { type ReactNode, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AttachmentMeta, IntakeMessage, IntakeSessionView } from "@/shared/types/workflow";
import { SafeMarkdown } from "@/features/workflow/components/SafeMarkdown";
import { formatCode } from "@/features/workflow/lib/format";
import { useIntakeStore } from "../intake-store";
import "./MessageList.css";

interface MessageListProps {
  session: IntakeSessionView;
  /** Every draft of the session, used to name the files sent with messages. */
  drafts: AttachmentMeta[];
  /** Drafts sent together with an option answer. */
  pendingDraftIds: string[];
}

/**
 * The messages of an intake session, the options of the latest question and
 * the thinking indicator. Scrolls to the bottom when messages arrive.
 */
export function MessageList({ session, drafts, pendingDraftIds }: MessageListProps) {
  const { t } = useTranslation("workflow");
  const send = useIntakeStore((s) => s.send);
  const sending = useIntakeStore((s) => s.sending);
  const retry = useIntakeStore((s) => s.retry);
  const cancelTurn = useIntakeStore((s) => s.cancelTurn);
  const [retrying, setRetrying] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  const active = session.status === "active";
  const { messages, busy, lastQuestion } = session;
  const last = messages[messages.length - 1];
  // Options answer the question only while it is the latest message.
  const showOptions = active && !busy && !!lastQuestion && lastQuestion.options.length > 0 && last?.role === "assistant";

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, busy, showOptions]);

  const names = new Map(drafts.map((d) => [d.id, d.originalName]));

  const onRetry = async () => {
    if (retrying) return;
    setRetrying(true);
    try {
      await retry();
    } finally {
      setRetrying(false);
    }
  };

  const onCancel = async () => {
    if (cancelling) return;
    setCancelling(true);
    try {
      await cancelTurn();
    } finally {
      setCancelling(false);
    }
  };

  return (
    <div className="intake-messages" ref={listRef}>
      {messages.length === 0 && <p className="intake-messages__empty">{t("intake.conversation.empty")}</p>}
      {messages.map((message) => (
        <MessageItem
          key={message.id}
          message={message}
          names={names}
          retry={
            message === last && message.role === "error" ? (
              <button
                type="button"
                className="intake-message__retry"
                onClick={() => void onRetry()}
                disabled={!active || busy || retrying}
              >
                {t("intake.conversation.retry")}
              </button>
            ) : null
          }
        />
      ))}
      {showOptions && (
        <div className="intake-question" role="group" aria-label={t("intake.conversation.question")}>
          <p className="intake-question__hint">{t("intake.conversation.options")}</p>
          <div className="intake-question__options">
            {lastQuestion.options.map((option, i) => (
              <button
                key={i}
                type="button"
                className="intake-question__option"
                disabled={sending}
                onClick={() => void send(option, pendingDraftIds)}
              >
                {option}
              </button>
            ))}
          </div>
        </div>
      )}
      {busy && (
        <div className="intake-thinking">
          <span className="intake-thinking__text" role="status">
            {t("intake.conversation.thinking")}
          </span>
          <button
            type="button"
            className="intake-thinking__cancel"
            onClick={() => void onCancel()}
            disabled={cancelling}
          >
            {t("intake.conversation.cancel")}
          </button>
        </div>
      )}
    </div>
  );
}

interface MessageItemProps {
  message: IntakeMessage;
  names: Map<string, string>;
  retry: ReactNode;
}

function MessageItem({ message, names, retry }: MessageItemProps) {
  const { t } = useTranslation("workflow");
  const roleLabel =
    message.role === "user"
      ? t("intake.conversation.you")
      : message.role === "assistant"
        ? t("intake.conversation.agent")
        : t("intake.conversation.error");

  return (
    <article className={`intake-message intake-message--${message.role}`}>
      <header className="intake-message__role">{roleLabel}</header>
      {message.role === "assistant" && <SafeMarkdown source={message.text} className="intake-message__markdown" />}
      {message.role === "user" && message.text && <p className="intake-message__text">{message.text}</p>}
      {message.role === "error" && (
        <>
          <p className="intake-message__text">
            {formatCode(message.text)}
          </p>
          {message.detail && (
            <details className="intake-message__detail">
              <summary>{t("intake.conversation.details")}</summary>
              <pre>{message.detail}</pre>
            </details>
          )}
          {retry}
        </>
      )}
      {message.draftIds.length > 0 && (
        <ul className="intake-message__chips" aria-label={t("intake.conversation.attachments")}>
          {message.draftIds.map((id) => (
            <li key={id} className="intake-message__chip">
              {names.get(id) ?? t("intake.conversation.attachedFile")}
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}
