import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { AttachmentMeta, IntakeSessionView } from "@/shared/types/workflow";
import { useIntakeStore } from "../intake-store";
import { ComposeBox } from "./ComposeBox";
import { DraftStrip } from "./DraftStrip";
import { MessageList } from "./MessageList";
import "./IntakeConversation.css";

/**
 * Drafts not sent yet. The draft list holds every draft of the session (sent
 * ones stay stored until finalize), so the ones referenced by a message are
 * excluded.
 */
export function pendingDrafts(session: IntakeSessionView, drafts: AttachmentMeta[]): AttachmentMeta[] {
  const sent = new Set(session.messages.flatMap((m) => m.draftIds));
  return drafts.filter((d) => !sent.has(d.id));
}

/** The conversation of an intake session: messages, pending drafts and the compose box. */
export function IntakeConversation({ session }: { session: IntakeSessionView }) {
  const { t } = useTranslation("workflow");
  const drafts = useIntakeStore((s) => s.drafts);
  const pending = useMemo(() => pendingDrafts(session, drafts), [session, drafts]);
  const pendingIds = useMemo(() => pending.map((d) => d.id), [pending]);
  const active = session.status === "active";

  return (
    <div className="intake-conversation">
      <MessageList session={session} drafts={drafts} pendingDraftIds={pendingIds} />
      <div className="intake-conversation__footer">
        {!active && (
          <p className="intake-conversation__inactive" role="note">
            {t("intake.conversation.notActive")}
          </p>
        )}
        <DraftStrip drafts={pending} disabled={!active} />
        <ComposeBox session={session} pendingDraftIds={pendingIds} />
      </div>
    </div>
  );
}
