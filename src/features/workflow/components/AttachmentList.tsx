import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { readFile } from "@tauri-apps/plugin-fs";
import i18n from "@/shared/i18n";
import type { AttachmentMeta } from "@/shared/types/workflow";
import { showMessage } from "@/stores/dialog-store";
import { formatCommandError } from "../lib/format";
import { workflowApi } from "../lib/workflow-api";
import "./AttachmentList.css";

const KB = 1024;
const MB = 1024 * 1024;

/** A byte count with a localized number and unit (B, KB or MB). */
export function formatSize(bytes: number): string {
  const number = new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 1 });
  if (bytes < KB) return i18n.t("workflow:intake.attachments.sizeBytes", { size: number.format(bytes) });
  if (bytes < MB) return i18n.t("workflow:intake.attachments.sizeKB", { size: number.format(bytes / KB) });
  return i18n.t("workflow:intake.attachments.sizeMB", { size: number.format(bytes / MB) });
}

/** The directory part of an absolute Windows or POSIX path, or null without one. */
export function attachmentDirectory(path: string): string | null {
  const index = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return index > 0 ? path.slice(0, index) : null;
}

type Loaded = { key: string; attachments: AttachmentMeta[] } | { key: string; error: string };

interface AttachmentListProps {
  root: string;
  /** The root task whose committed attachments are listed. */
  rootTaskId: string;
  /** The shown task is a child task: the list is labelled as the root task's. */
  fromRootTask: boolean;
}

/**
 * Committed attachments of a run's root task: name, size and type, image
 * thumbnails and "show in folder". Renders nothing when there are none.
 */
export function AttachmentList({ root, rootTaskId, fromRootTask }: AttachmentListProps) {
  const { t } = useTranslation("workflow");
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const key = `${root}|${rootTaskId}`;

  useEffect(() => {
    let cancelled = false;
    workflowApi.listAttachments(root, rootTaskId).then(
      (attachments) => {
        if (!cancelled) setLoaded({ key, attachments });
      },
      (err: unknown) => {
        if (!cancelled) setLoaded({ key, error: formatCommandError(err) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [root, rootTaskId, key]);

  const current = loaded?.key === key ? loaded : null;
  if (!current) return null;

  if ("error" in current) {
    return (
      <section className="workflow-detail__section workflow-attachments" data-section="attachments">
        <h3 className="workflow-detail__heading">{t("intake.attachments.title")}</h3>
        <p className="workflow-attachments__error" role="alert">
          {t("intake.attachments.loadFailed")}
          <br />
          {current.error}
        </p>
      </section>
    );
  }
  if (current.attachments.length === 0) return null;

  const showInFolder = async (attachment: AttachmentMeta) => {
    if (opening) return;
    setOpening(attachment.id);
    try {
      const path = await workflowApi.attachmentPath(root, rootTaskId, attachment.id);
      const directory = attachmentDirectory(path);
      if (directory) await invoke("open_external_url", { url: directory });
    } catch (err) {
      void showMessage(formatCommandError(err), { title: t("intake.attachments.showInFolderFailed"), kind: "error" });
    } finally {
      setOpening(null);
    }
  };

  return (
    <section className="workflow-detail__section workflow-attachments" data-section="attachments">
      <h3 className="workflow-detail__heading">{t("intake.attachments.title")}</h3>
      {fromRootTask && <p className="workflow-attachments__note">{t("intake.attachments.rootTask")}</p>}
      <ul className="workflow-attachments__list">
        {current.attachments.map((attachment) => (
          <li key={attachment.id} className="workflow-attachments__item">
            {attachment.mime.startsWith("image/") && (
              <AttachmentThumbnail root={root} rootTaskId={rootTaskId} attachment={attachment} />
            )}
            <span className="workflow-attachments__name">{attachment.originalName}</span>
            <span className="workflow-attachments__meta">{formatSize(attachment.size)}</span>
            <span className="workflow-attachments__meta">{attachment.mime}</span>
            <button
              type="button"
              className="workflow-attachments__btn"
              data-action="showInFolder"
              disabled={opening !== null}
              onClick={() => void showInFolder(attachment)}
            >
              {t("intake.attachments.showInFolder")}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

interface AttachmentThumbnailProps {
  root: string;
  rootTaskId: string;
  attachment: AttachmentMeta;
}

/**
 * Thumbnail of an image attachment, read with the fs plugin into a blob URL
 * (the asset protocol stays disabled). The URL is revoked on unmount, and a
 * read that finishes after unmounting never creates one.
 */
function AttachmentThumbnail({ root, rootTaskId, attachment }: AttachmentThumbnailProps) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    let created: string | null = null;
    (async () => {
      try {
        const path = await workflowApi.attachmentPath(root, rootTaskId, attachment.id);
        const bytes = await readFile(path);
        if (disposed) return;
        created = URL.createObjectURL(new Blob([bytes], { type: attachment.mime }));
        setUrl(created);
      } catch (err) {
        // The item still shows the name; only the preview is missing.
        console.warn("[workflow] loading an attachment thumbnail failed", err);
      }
    })();
    return () => {
      disposed = true;
      if (created) URL.revokeObjectURL(created);
    };
  }, [root, rootTaskId, attachment.id, attachment.mime]);

  return url ? <img className="workflow-attachments__thumb" src={url} alt="" /> : null;
}
