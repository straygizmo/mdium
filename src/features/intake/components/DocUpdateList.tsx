import { useEffect, useMemo, useState } from "react";
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
 * Current files longer than this (in UTF-16 units, about 1 MiB of ASCII) are
 * not diffed. The intake window may not stat files, so the file is read
 * first; only the diff is skipped.
 */
export const MAX_DIFF_SOURCE_CHARS = 1024 * 1024;

/** Bounds of the diff computation; beyond them it gives up. */
const MAX_EDIT_LENGTH = 2000;
const DIFF_TIMEOUT_MS = 500;

/**
 * The hunks of a unified diff from `current` to `proposed` (the file header
 * is left out: the path is shown next to it); "" when they are equal, null
 * when the diff is too large to compute within the bounds.
 */
export function docDiff(path: string, current: string, proposed: string): string | null {
  const patch = createTwoFilesPatch(path, path, current, proposed, "", "", {
    context: 3,
    maxEditLength: MAX_EDIT_LENGTH,
    timeout: DIFF_TIMEOUT_MS,
  });
  if (patch === undefined) return null;
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

/**
 * Result of reading the current file of a pending update: its content
 * (`isNew`: absent, as when it was proposed), deleted since the proposal,
 * too large to diff, or unreadable.
 */
type Current =
  | { kind: "loading" }
  | { kind: "loaded"; content: string; isNew: boolean }
  | { kind: "deleted" }
  | { kind: "tooLarge" }
  | { kind: "failed" };

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
  // Set once applying was refused because the file changed since the
  // proposal; the base never changes, so applying stays impossible.
  const [changed, setChanged] = useState(false);
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
        next = content.length > MAX_DIFF_SOURCE_CHARS ? { kind: "tooLarge" } : { kind: "loaded", content, isNew: false };
      } catch (err) {
        if (NOT_FOUND.test(String(err))) {
          // Still absent: a new file, diffed as empty. Absent now but not
          // when proposed: deleted meanwhile, so it can no longer be applied.
          next = doc.baseSha256 === null ? { kind: "loaded", content: "", isNew: true } : { kind: "deleted" };
        } else {
          console.warn("[intake] reading a document failed", err);
          next = { kind: "failed" };
        }
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
      await applyDocUpdate(doc.id, accept, (text, code) => {
        if (code === DOC_CHANGED) setChanged(true);
        else setError({ code, text });
      });
    } finally {
      setBusy(false);
    }
  };

  const reload = () => setReloads((n) => n + 1);

  const currentContent = current.kind === "loaded" ? current.content : null;
  const diff = useMemo(
    () => (currentContent === null ? null : docDiff(doc.path, currentContent, doc.content)),
    [doc.path, currentContent, doc.content],
  );
  const note = (() => {
    switch (current.kind) {
      case "loading":
        return t("intake.loading");
      case "deleted":
        return t("intake.docUpdates.deleted");
      case "tooLarge":
        return t("intake.docUpdates.fileTooLarge");
      case "failed":
        return t("intake.docUpdates.readFailed");
      case "loaded":
        if (diff === null) return t("intake.docUpdates.diffTooLarge");
        return diff === "" ? t("intake.docUpdates.noChanges") : null;
    }
  })();

  return (
    <>
      {current.kind === "loaded" && current.isNew && (
        <span className="intake-doc__new">{t("intake.docUpdates.newFile")}</span>
      )}
      <div className="intake-doc__diff">
        {note !== null ? <p className="intake-doc__note">{note}</p> : diff && <UnifiedDiffView diff={diff} />}
      </div>
      {changed && (
        <div className="intake-doc__failure" role="alert">
          <p className="intake-doc__error">{t("intake.docUpdates.changed")}</p>
          <button type="button" className="intake-doc__reload" onClick={reload}>
            {t("intake.docUpdates.reloadDiff")}
          </button>
        </div>
      )}
      {error && (
        <p className="intake-doc__error" role="alert">
          {error.text}
        </p>
      )}
      {active && (
        <div className="intake-doc__buttons">
          <button
            type="button"
            className="intake-doc__apply"
            // Applying needs the current content shown; a changed file can never be applied.
            disabled={busy || changed || current.kind !== "loaded"}
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
