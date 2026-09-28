import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { showConfirm, showMessage } from "@/stores/dialog-store";
import type { IntakeSessionView } from "@/shared/types/workflow";
import { formatCommandError, formatWarning } from "../lib/format";
import { workflowApi } from "../lib/workflow-api";
import { useWorkflowStore } from "../workflow-store";
import "./IntakeList.css";

/** Whether a session is still in progress (listed in the panel). */
function isOpen(session: IntakeSessionView): boolean {
  return session.status === "active" || session.status === "finalizing";
}

/**
 * Whether the session can be abandoned: no agent turn is running, and it is
 * in conversation or its finalize has not created (or started creating)
 * anything yet (what the backend accepts).
 */
function canAbandon(session: IntakeSessionView): boolean {
  if (session.busy) return false;
  if (session.status === "active") return true;
  const f = session.finalize;
  return session.status === "finalizing" && f.stage === "ready" && f.issue === null && !f.issueCreating;
}

/** The proposal title, else the first line of the first user message; null when neither exists. */
function sessionTitle(session: IntakeSessionView): string | null {
  const proposed = session.proposal?.title.trim();
  if (proposed) return proposed;
  const first = session.messages.find((m) => m.role === "user" && m.text.trim());
  return first ? first.text.trim().split(/\r?\n/, 1)[0] : null;
}

/** In-progress requirement intakes of the active project, with Open and Abandon. */
export function IntakeList() {
  const { t, i18n } = useTranslation("workflow");
  const activeRoot = useWorkflowStore((s) => s.activeRoot);
  const project = useWorkflowStore((s) => (s.activeRoot ? s.projects[s.activeRoot] : undefined));
  /** Ids of the sessions whose Open or Abandon request is in flight. */
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  /** Synchronous copy of `pending`, so a second click before the re-render is ignored. */
  const pendingRef = useRef(new Set<string>());
  const dateFormat = useMemo(
    () => new Intl.DateTimeFormat(i18n.language, { dateStyle: "short", timeStyle: "short" }),
    [i18n.language],
  );

  if (!activeRoot || !project) return null;

  const sessions = project.intakes.filter(isOpen);
  const warnings = project.intakeWarnings;

  /** Runs one request per session at a time. */
  const withPending = async (id: string, fn: () => Promise<void>) => {
    if (pendingRef.current.has(id)) return;
    pendingRef.current.add(id);
    setPending(new Set(pendingRef.current));
    try {
      await fn();
    } finally {
      pendingRef.current.delete(id);
      setPending(new Set(pendingRef.current));
    }
  };

  const open = (session: IntakeSessionView) =>
    withPending(session.id, async () => {
      try {
        await workflowApi.openIntakeWindow(activeRoot, session.id);
      } catch (err) {
        void showMessage(formatCommandError(err), { title: t("intake.list.openFailed"), kind: "error" });
      }
    });

  const abandon = (session: IntakeSessionView, title: string) =>
    withPending(session.id, async () => {
      if (!(await showConfirm(t("intake.list.abandonConfirm", { title }), { kind: "warning" }))) return;
      try {
        await workflowApi.intakeAbandon(activeRoot, session.id);
      } catch (err) {
        void showMessage(formatCommandError(err), { title: t("intake.list.abandonFailed"), kind: "error" });
      }
      // Show the real state whether or not the session was abandoned.
      await useWorkflowStore.getState().refreshIntakes(activeRoot);
    });

  const formatTime = (iso: string) => {
    const time = Date.parse(iso);
    return Number.isNaN(time) ? iso : dateFormat.format(time);
  };

  return (
    <section className="intake-list" aria-labelledby="intake-list-title">
      <h3 id="intake-list-title" className="intake-list__heading">
        {t("intake.list.title")}
      </h3>
      {project.intakeError && (
        <p className="intake-list__error" role="alert">
          {`${t("intake.list.loadFailed")} ${project.intakeError}`}
        </p>
      )}
      {project.intakesLoaded && sessions.length === 0 && <p className="intake-list__message">{t("intake.list.empty")}</p>}
      {sessions.length > 0 && (
        <ul className="intake-list__items">
          {sessions.map((session) => {
            const title = sessionTitle(session);
            const shownTitle = title ?? t("intake.list.untitled");
            const inFlight = pending.has(session.id);
            return (
              <li key={session.id} className="intake-list__item" data-intake-id={session.id}>
                <span className="intake-list__title" title={shownTitle}>
                  {shownTitle}
                </span>
                <div className="intake-list__meta">
                  <span className="intake-list__badge">{t(`intake.kind.${session.kind}`)}</span>
                  <span className="intake-list__badge">{t(`intake.status.${session.status}`)}</span>
                  {session.busy && (
                    <span className="intake-list__busy" role="status">
                      {t("intake.list.busy")}
                    </span>
                  )}
                </div>
                <span className="intake-list__time">
                  {t("intake.list.updatedAt", { time: formatTime(session.updatedAt) })}
                </span>
                <div className="intake-list__actions">
                  <button
                    type="button"
                    className="intake-list__btn"
                    disabled={inFlight}
                    onClick={() => void open(session)}
                  >
                    {t("intake.list.open")}
                  </button>
                  {canAbandon(session) && (
                    <button
                      type="button"
                      className="intake-list__btn"
                      disabled={inFlight}
                      onClick={() => void abandon(session, shownTitle)}
                    >
                      {t("intake.list.abandon")}
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {warnings.length > 0 && (
        <details className="intake-list__warnings">
          <summary>{t("intake.list.warnings", { count: warnings.length })}</summary>
          <ul className="intake-list__warning-list">
            {warnings.map((w, i) => (
              <li key={`${w.file}-${i}`} className="intake-list__warning">
                <span className="intake-list__warning-file">{w.file}</span>
                <span className="intake-list__warning-message">{formatWarning(w)}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
