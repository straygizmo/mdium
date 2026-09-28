import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import type { IntakeProposal, IntakeSessionView } from "@/shared/types/workflow";
import { SafeMarkdown } from "@/features/workflow/components/SafeMarkdown";
import { showConfirm } from "@/stores/dialog-store";
import { turnRequestInFlight, useIntakeStore } from "../intake-store";
import "./ProposalCard.css";

/**
 * The agent's proposed requirement: rendered Markdown, editable by the user
 * while the session is in conversation and no agent turn runs.
 */
export function ProposalCard({ session }: { session: IntakeSessionView }) {
  const { t } = useTranslation("workflow");
  const updateProposal = useIntakeStore((s) => s.updateProposal);
  const turnInFlight = useIntakeStore(turnRequestInFlight);
  const ids = useId();
  // The edited values; null while not editing.
  const [draft, setDraft] = useState<IntakeProposal | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const proposal = session.proposal;
  if (!proposal) return null;
  const active = session.status === "active";
  // An agent reply would replace the edit, so the backend refuses it meanwhile.
  const locked = session.busy || turnInFlight;

  const startEdit = () => {
    setError(null);
    setDraft({ title: proposal.title, body: proposal.body });
  };

  const cancelEdit = async () => {
    if (saving || !draft) return;
    const changed = draft.title !== proposal.title || draft.body !== proposal.body;
    if (changed && !(await showConfirm(t("intake.proposal.discardConfirm"), { kind: "warning" }))) return;
    setDraft(null);
    setError(null);
  };

  const save = async () => {
    if (saving || !draft) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await updateProposal(draft.title, draft.body, (reason) => setError(reason));
      if (saved) setDraft(null);
    } finally {
      setSaving(false);
    }
  };

  const editing = active && draft !== null;

  return (
    <section className="intake-proposal" aria-labelledby={`${ids}-heading`}>
      <header className="intake-proposal__header">
        <h2 id={`${ids}-heading`} className="intake-proposal__heading">
          {t("intake.proposal.title")}
        </h2>
        {active && !editing && (
          <button type="button" className="intake-proposal__edit" disabled={locked} onClick={startEdit}>
            {t("intake.proposal.edit")}
          </button>
        )}
      </header>

      {editing ? (
        <form
          className="intake-proposal__form"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <label className="intake-proposal__field">
            <span>{t("intake.proposal.titleLabel")}</span>
            <input
              className="intake-proposal__title-input"
              value={draft.title}
              disabled={saving}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            />
          </label>
          <label className="intake-proposal__field">
            <span>{t("intake.proposal.bodyLabel")}</span>
            <textarea
              className="intake-proposal__body-input"
              rows={12}
              value={draft.body}
              disabled={saving}
              onChange={(e) => setDraft({ ...draft, body: e.target.value })}
            />
          </label>
          {error && (
            <p className="intake-proposal__error" role="alert">
              {error}
            </p>
          )}
          <div className="intake-proposal__buttons">
            <button type="submit" className="intake-proposal__save" disabled={saving || locked}>
              {saving ? t("intake.proposal.saving") : t("intake.proposal.save")}
            </button>
            <button
              type="button"
              className="intake-proposal__cancel"
              disabled={saving}
              onClick={() => void cancelEdit()}
            >
              {t("intake.proposal.cancel")}
            </button>
          </div>
        </form>
      ) : (
        <>
          <h3 className="intake-proposal__title">{proposal.title}</h3>
          <SafeMarkdown source={proposal.body} className="intake-proposal__body" />
        </>
      )}

      {active && (
        <p className="intake-proposal__hint">
          {session.busy ? t("intake.proposal.busyHint") : t("intake.proposal.refineHint")}
        </p>
      )}
    </section>
  );
}
