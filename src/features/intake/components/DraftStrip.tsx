import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { readFile } from "@tauri-apps/plugin-fs";
import type { AttachmentMeta } from "@/shared/types/workflow";
import { workflowApi } from "@/features/workflow/lib/workflow-api";
import { useIntakeStore } from "../intake-store";
import "./DraftStrip.css";

/*
 * Draft limits; keep in sync with `MAX_ATTACHMENTS_PER_TASK` and
 * `MAX_ATTACHMENT_BYTES` in src-tauri/src/workflow/attachments.rs.
 */
export const MAX_DRAFTS = 20;
export const MAX_DRAFT_MB = 20;
export const MAX_DRAFT_BYTES = MAX_DRAFT_MB * 1024 * 1024;

interface DraftStripProps {
  /** Drafts not sent yet. */
  drafts: AttachmentMeta[];
  disabled: boolean;
}

/** Pending draft attachments as removable chips; images show a thumbnail. */
export function DraftStrip({ drafts, disabled }: DraftStripProps) {
  const { t } = useTranslation("workflow");
  const removeDraft = useIntakeStore((s) => s.removeDraft);
  const [removing, setRemoving] = useState<Set<string>>(() => new Set());

  if (drafts.length === 0) return null;

  const onRemove = async (id: string) => {
    if (removing.has(id)) return;
    setRemoving((s) => new Set(s).add(id));
    try {
      await removeDraft(id);
    } finally {
      setRemoving((s) => {
        const next = new Set(s);
        next.delete(id);
        return next;
      });
    }
  };

  return (
    <div className="intake-drafts">
      <ul className="intake-drafts__list" aria-label={t("intake.drafts.label")}>
        {drafts.map((draft) => (
          <li key={draft.id} className="intake-drafts__chip">
            {draft.mime.startsWith("image/") && <DraftThumbnail draft={draft} />}
            <span className="intake-drafts__name">{draft.originalName}</span>
            <button
              type="button"
              className="intake-drafts__remove"
              aria-label={t("intake.drafts.remove", { name: draft.originalName })}
              title={t("intake.drafts.remove", { name: draft.originalName })}
              disabled={disabled || removing.has(draft.id)}
              onClick={() => void onRemove(draft.id)}
            >
              <span aria-hidden="true">×</span>
            </button>
          </li>
        ))}
      </ul>
      <p className="intake-drafts__limit">{t("intake.drafts.limit", { count: MAX_DRAFTS, size: MAX_DRAFT_MB })}</p>
    </div>
  );
}

/**
 * Thumbnail of an image draft, read with the fs plugin into a blob URL (the
 * asset protocol stays disabled). The URL is revoked on unmount, including
 * when the read finishes after unmounting.
 */
function DraftThumbnail({ draft }: { draft: AttachmentMeta }) {
  const root = useIntakeStore((s) => s.root);
  const intakeId = useIntakeStore((s) => s.intakeId);
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!intakeId) return;
    let disposed = false;
    let created: string | null = null;
    (async () => {
      try {
        const path = await workflowApi.intakeDraftPath(root, intakeId, draft.id);
        const bytes = await readFile(path);
        if (disposed) return;
        created = URL.createObjectURL(new Blob([bytes], { type: draft.mime }));
        setUrl(created);
      } catch (err) {
        // The chip still shows the name; only the preview is missing.
        console.warn("[intake] loading a draft thumbnail failed", err);
      }
    })();
    return () => {
      disposed = true;
      if (created) URL.revokeObjectURL(created);
    };
  }, [root, intakeId, draft.id, draft.mime]);

  return url ? <img className="intake-drafts__thumb" src={url} alt="" /> : null;
}
