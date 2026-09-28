import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { startFocusRecheck, startIntakeEvents, useIntakeStore } from "../intake-store";
import { DocUpdateList } from "./DocUpdateList";
import { AbandonIntakeButton, FinalizePanel } from "./FinalizePanel";
import { IntakeConversation } from "./IntakeConversation";
import { ProposalCard } from "./ProposalCard";
import { IntakeStartForm } from "./IntakeStartForm";
import "./IntakeApp.css";

export interface IntakeAppProps {
  /** Normalized project root from the window's query string. */
  root: string;
  /** Session this window serves, or null for the start form. */
  intakeId: string | null;
  /** Workflow the start form preselects (`?workflow=`), if any. */
  workflowId: string | null;
}

/**
 * Content of an intake window. A window serves exactly one session: an
 * `intake-<id>` window loads that session; an `intake-new-*` window shows the
 * start form and, once the session is created, hands it to its own
 * `intake-<id>` window and closes (`useIntakeStore.create`), so every session
 * has one window, which the main window focuses instead of opening another.
 * The start window never serves the created session itself, not even when
 * opening its window fails (it offers a retry instead).
 */
export function IntakeApp({ root, intakeId, workflowId }: IntakeAppProps) {
  const { t } = useTranslation("workflow");
  const loading = useIntakeStore((s) => s.loading);
  const error = useIntakeStore((s) => s.error);
  const session = useIntakeStore((s) => s.session);
  const servedId = useIntakeStore((s) => s.intakeId);
  // `init` sets the root; until then nothing is loaded yet.
  const initialized = useIntakeStore((s) => s.root !== "");

  useEffect(() => {
    let disposed = false;
    let stop: (() => void) | undefined;
    // Listen before loading so no change between the load and the listener is
    // missed (e.g. a turn that ends while the window reopens).
    startIntakeEvents()
      .then((unlisten) => {
        if (disposed) unlisten();
        else stop = unlisten;
      })
      .catch((err) => console.error("[intake] listening to intake events failed", err))
      .finally(() => {
        if (!disposed) void useIntakeStore.getState().init(root, intakeId);
      });
    return () => {
      disposed = true;
      stop?.();
    };
  }, [root, intakeId]);

  // Provider and forge availability may change while the window is in the background.
  useEffect(() => startFocusRecheck(), []);

  // An intake window keeps loading until a session is applied or loading
  // failed (an outdated load dropped by a racing reload is no failure).
  const waiting = loading || !initialized || (servedId !== null && !session && !error);
  if (waiting) {
    return (
      <p className="intake-app__status" role="status">
        {t("intake.loading")}
      </p>
    );
  }

  if (servedId === null) {
    return error ? (
      <LoadFailed error={error} />
    ) : (
      <IntakeStartForm initialWorkflowId={workflowId} />
    );
  }

  if (!session) return <LoadFailed error={error} />;

  // The proposal, document updates and finalize are shown next to the conversation.
  const hasReview = !!session.proposal || session.docUpdates.length > 0 || session.appliedDocPaths.length > 0;

  return (
    <section className="intake-app__session" aria-label={t("intake.conversation.title")}>
      <header className="intake-app__header">
        <span className="intake-app__kind">{t(`intake.kind.${session.kind}`)}</span>
        <span className="intake-app__state">{t(`intake.status.${session.status}`)}</span>
        <span className="intake-app__actions">
          <AbandonIntakeButton />
        </span>
      </header>
      {error && (
        <p className="intake-app__error" role="alert">
          {error}
        </p>
      )}
      <div className="intake-app__body">
        <IntakeConversation session={session} />
        {hasReview && (
          <aside className="intake-app__review">
            <ProposalCard session={session} />
            <DocUpdateList session={session} />
            <FinalizePanel session={session} />
          </aside>
        )}
      </div>
    </section>
  );
}

function LoadFailed({ error }: { error: string | null }) {
  const { t } = useTranslation("workflow");
  return (
    <div className="intake-app__failed" role="alert">
      <p className="intake-app__status">{t("intake.loadFailed")}</p>
      {error && <pre className="intake-app__detail">{error}</pre>}
    </div>
  );
}
