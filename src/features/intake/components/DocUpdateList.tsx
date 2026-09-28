import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { createTwoFilesPatch } from "diff";
import { join } from "@tauri-apps/api/path";
import { readTextFile } from "@tauri-apps/plugin-fs";
import type { DocUpdateProposal, IntakeSessionView } from "@/shared/types/workflow";
import { UnifiedDiffView } from "@/shared/components/UnifiedDiffView";
import { formatCode } from "@/features/workflow/lib/format";
import { useIntakeStore } from "../intake-store";
import "./DocUpdateList.css";

const DOC_CHANGED = "INTAKE_DOC_CHANGED_SINCE_PROPOSAL";

/** Error messages of a read that failed because the file does not exist. */
const NOT_FOUND = /os error 2\b|not found|no such file|cannot find/i;

/**
 * The hunks of a unified diff from `current` to `proposed` (the file header
 * is left out: the path is shown next to it); "" when they are equal.
 */
export function docDiff(path: string, current: string, proposed: string): string {
  const patch = createTwoFilesPatch(path, path, current, proposed, "", "", { context: 3 });
  const start = patch.indexOf("\n@@");
  return start < 0 ? "" : patch.slice(start + 1);
}

/**
 * The agent's proposed document updates: a diff against the current file
 * for pending ones (with Apply / Reject), the status of the others, and a
 * reminder to commit the applied files. Pending updates are hidden once the
 * session is done or abandoned (they can no longer be applied).
 */
export function DocUpdateList({ session }: { session: IntakeSessionView }) {
  const { t } = useTranslation("workflow");
  const closed = session.status === "done" || session.status === "abandoned";
  const docs = closed ? session.docUpdates.filter((d) => d.status !== "pending") : session.docUpdates;
  const applied = session.appliedDocPaths;

  if (docs.length === 0 && applied.length === 0) return null;

  return (
    <section className="intake-docs" aria-label={t("intake.docUpdates.title")}>
      {docs.length > 0 && (
        <>
          <h2 className="intake-docs__title">{t("intake.docUpdates.title")}</h2>
          <ul className="intake-docs__list">
            {docs.map((doc) => (
              <DocUpdateItem key={doc.id} doc={doc} active={session.status === "active"} />
            ))}
          </ul>
        </>
      )}
      {applied.length > 0 && (
        <div className="intake-docs__applied" role="note">
          <h3 className="intake-docs__applied-title">{t("intake.docUpdates.appliedTitle")}</h3>
          <p className="intake-docs__applied-notice">{t("intake.docUpdates.appliedNotice")}</p>
          <ul className="intake-docs__applied-list">
            {applied.map((path) => (
              <li key={path}>{path}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

/** Result of reading the current file of a pending update. */
type Current = { kind: "loading" } | { kind: "loaded"; content: string; missing: boolean } | { kind: "failed" };

interface DocUpdateItemProps {
  doc: DocUpdateProposal;
  /** Updates can be applied or rejected only while in conversation. */
  active: boolean;
}

function DocUpdateItem({ doc, active }: DocUpdateItemProps) {
  const { t } = useTranslation("workflow");
  const pending = doc.status === "pending";

  return (
    <li className={`intake-doc intake-doc--${doc.status}`}>
      <div className="intake-doc__header">
        <span className="intake-doc__path">{doc.path}</span>
        <span className="intake-doc__status">{t(`intake.docUpdates.status.${doc.status}`)}</span>
      </div>
      {doc.status === "rejected" && doc.reason && (
        <p className="intake-doc__reason">{t("intake.docUpdates.reason", { reason: formatCode(doc.reason) })}</p>
      )}
      {pending && <PendingDoc doc={doc} active={active} />}
    </li>
  );
}

/** Diff and Apply / Reject of a pending update. */
function PendingDoc({ doc, active }: DocUpdateItemProps) {
  const { t } = useTranslation("workflow");
  const root = useIntakeStore((s) => s.root);
  const applyDocUpdate = useIntakeStore((s) => s.applyDocUpdate);
  const [current, setCurrent] = useState<Current>({ kind: "loading" });
  // Incremented by "Reload diff" to read the file again.
  const [reloads, setReloads] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code: string | null; text: string } | null>(null);

  useEffect(() => {
    let disposed = false;
    setCurrent({ kind: "loading" });
    (async () => {
      let next: Current;
      try {
        const content = await readTextFile(await join(root, doc.path));
        next = { kind: "loaded", content, missing: false };
      } catch (err) {
        // A file that does not exist is diffed as empty (a new file).
        const missing = doc.baseSha256 === null || NOT_FOUND.test(String(err));
        if (!missing) console.warn("[intake] reading a document failed", err);
        next = missing ? { kind: "loaded", content: "", missing: true } : { kind: "failed" };
      }
      if (!disposed) setCurrent(next);
    })();
    return () => {
      disposed = true;
    };
  }, [root, doc.path, doc.baseSha256, reloads]);

  const decide = async (accept: boolean) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await applyDocUpdate(doc.id, accept, (text, code) => setError({ code, text }));
    } finally {
      setBusy(false);
    }
  };

  const reload = () => {
    setError(null);
    setReloads((n) => n + 1);
  };

  const diff = current.kind === "loaded" ? docDiff(doc.path, current.content, doc.content) : "";

  return (
    <>
      {current.kind === "loaded" && current.missing && (
        <span className="intake-doc__new">{t("intake.docUpdates.newFile")}</span>
      )}
      <div className="intake-doc__diff">
        {current.kind === "loading" && <p className="intake-doc__note">{t("intake.loading")}</p>}
        {current.kind === "failed" && <p className="intake-doc__note">{t("intake.docUpdates.readFailed")}</p>}
        {current.kind === "loaded" &&
          (diff ? <UnifiedDiffView diff={diff} /> : <p className="intake-doc__note">{t("intake.docUpdates.noChanges")}</p>)}
      </div>
      {error && (
        <div className="intake-doc__failure" role="alert">
          <p className="intake-doc__error">{error.code === DOC_CHANGED ? t("intake.docUpdates.changed") : error.text}</p>
          {error.code === DOC_CHANGED && (
            <button type="button" className="intake-doc__reload" onClick={reload}>
              {t("intake.docUpdates.reloadDiff")}
            </button>
          )}
        </div>
      )}
      {active && (
        <div className="intake-doc__buttons">
          <button
            type="button"
            className="intake-doc__apply"
            disabled={busy || current.kind !== "loaded"}
            onClick={() => void decide(true)}
          >
            {t("intake.docUpdates.apply")}
          </button>
          <button type="button" className="intake-doc__reject" disabled={busy} onClick={() => void decide(false)}>
            {t("intake.docUpdates.reject")}
          </button>
        </div>
      )}
    </>
  );
}
