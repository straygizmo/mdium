import { type ReactNode, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AttachmentMeta, IntakeMessage, IntakeSessionView } from "@/shared/types/workflow";
import { SafeMarkdown } from "@/features/workflow/components/SafeMarkdown";
import { formatCode } from "@/features/workflow/lib/format";
import { turnRequestInFlight, useIntakeStore } from "../intake-store";
import "./MessageList.css";

interface MessageListProps {
  session: IntakeSessionView;
  /** Every draft of the session, used to name the files sent with messages. */
  drafts: AttachmentMeta[];
  /** Drafts sent together with an option answer. */
  pendingDraftIds: string[];
}

/** Distance from the bottom (px) within which the list follows new content. */
const STICK_THRESHOLD = 48;

/** Localized role label of a message. */
function roleLabel(t: (key: string) => string, role: IntakeMessage["role"]): string {
  if (role === "user") return t("intake.conversation.you");
  if (role === "assistant") return t("intake.conversation.agent");
  return t("intake.conversation.error");
}

/**
 * The messages of an intake session, the options of the latest question and
 * the thinking indicator. Follows new content while scrolled to the bottom
 * and announces new agent replies and errors to screen readers.
 */
export function MessageList({ session, drafts, pendingDraftIds }: MessageListProps) {
  const { t } = useTranslation("workflow");
  const send = useIntakeStore((s) => s.send);
  const inFlight = useIntakeStore(turnRequestInFlight);
  const retry = useIntakeStore((s) => s.retry);
  const cancelTurn = useIntakeStore((s) => s.cancelTurn);
  const [cancelling, setCancelling] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  // Whether the user is at the bottom; scrolling up stops following new content.
  const stickRef = useRef(true);
  // Messages present at mount or already announced.
  const seenRef = useRef<Set<string> | null>(null);

  const active = session.status === "active";
  const { messages, busy, lastQuestion } = session;
  const last = messages[messages.length - 1];
  // Options answer the question only while it is the latest message.
  const showOptions = active && !busy && !!lastQuestion && lastQuestion.options.length > 0 && last?.role === "assistant";

  useEffect(() => {
    const el = listRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [messages.length, busy, showOptions]);

  useEffect(() => {
    const seen = seenRef.current;
    if (!seen) {
      // The history present when the window opens is not announced.
      seenRef.current = new Set(messages.map((m) => m.id));
      return;
    }
    let latest: IntakeMessage | undefined;
    for (const m of messages) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      if (m.role !== "user") latest = m;
    }
    if (latest) {
      const text = latest.role === "error" ? formatCode(latest.text) : latest.text;
      setAnnouncement(t("intake.conversation.announce", { role: roleLabel(t, latest.role), text }));
    }
  }, [messages, t]);

  const onScroll = () => {
    const el = listRef.current;
    if (el) stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_THRESHOLD;
  };

  const names = new Map(drafts.map((d) => [d.id, d.originalName]));

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
    <div className="intake-messages" ref={listRef} onScroll={onScroll}>
      <p className="intake-messages__live" aria-live="polite">
        {announcement}
      </p>
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
                onClick={() => void retry()}
                disabled={!active || busy || inFlight}
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
                disabled={inFlight}
                // Answers with the option; text typed in the compose box is
                // kept for the next message rather than sent or discarded.
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

  return (
    <article className={`intake-message intake-message--${message.role}`}>
      <header className="intake-message__role">{roleLabel(t, message.role)}</header>
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
