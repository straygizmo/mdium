import { useState } from "react";
import { useTranslation } from "react-i18next";
import { showConfirm, showMessage } from "@/stores/dialog-store";
import { useFtpMirrorStore, type ResolveAction, type SyncStatus } from "@/stores/ftp-mirror-store";
import "./FtpSyncStatus.css";

function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function badgeText(status: SyncStatus | undefined, t: (key: string, opts?: Record<string, unknown>) => string): string {
  if (!status) return t("notSynced");
  if (status.syncing) {
    return status.progress
      ? t("syncingProgress", { done: status.progress.done, total: status.progress.total })
      : t("syncing");
  }
  const attention = status.conflicts.length + status.pendingDeletes.length;
  if (status.error) return `⚠ ${t("syncError")}`;
  if (attention > 0) return `⚠ ${t("needsAttention", { count: attention })}`;
  return status.lastSync ? t("synced", { time: formatTime(status.lastSync) }) : t("notSynced");
}

/** Sync state of an FTP mirror folder; opens the details on click. */
export function FtpSyncBadge({ root }: { root: string }) {
  const { t } = useTranslation("remote");
  const status = useFtpMirrorStore((s) => s.statuses[root]);
  const [open, setOpen] = useState(false);
  const warn = !!status && !status.syncing &&
    (!!status.error || status.conflicts.length + status.pendingDeletes.length > 0);

  return (
    <>
      <button
        className={`ftp-sync-badge ${warn ? "ftp-sync-badge--warn" : ""}`}
        onClick={() => setOpen(true)}
        title={t("syncTitle")}
      >
        {badgeText(status, t)}
      </button>
      {open && <FtpSyncDialog root={root} onClose={() => setOpen(false)} />}
    </>
  );
}

function FtpSyncDialog({ root, onClose }: { root: string; onClose: () => void }) {
  const { t } = useTranslation("remote");
  const status = useFtpMirrorStore((s) => s.statuses[root]);
  const uri = useFtpMirrorStore((s) => s.mirrors[root]);
  const { sync, resolve } = useFtpMirrorStore.getState();
  const [busy, setBusy] = useState<string | null>(null);

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    try {
      await fn();
    } catch (e) {
      await showMessage(t("resolveFailed", { error: String(e) }), { kind: "error" });
    } finally {
      setBusy(null);
    }
  };

  const act = (path: string, action: ResolveAction) =>
    run(`${action}:${path}`, () => resolve(root, path, action));

  const approveAll = async () => {
    const paths = status?.pendingDeletes ?? [];
    if (!(await showConfirm(t("approveAllConfirm", { count: paths.length }), { kind: "warning" }))) return;
    await run("approveAll", async () => {
      for (const p of paths) await resolve(root, p, "approveDelete");
    });
  };

  const conflicts = status?.conflicts ?? [];
  const pending = status?.pendingDeletes ?? [];
  const fileErrors = status?.fileErrors ?? [];

  return (
    <div className="ftp-sync__overlay" onMouseDown={() => !busy && onClose()}>
      <div className="ftp-sync" onMouseDown={(e) => e.stopPropagation()}>
        <h2 className="ftp-sync__title">{t("syncTitle")}</h2>
        <div className="ftp-sync__uri">{uri}</div>
        <div className="ftp-sync__note">{t("mirrorNote", { path: root })}</div>

        <div className="ftp-sync__row">
          <span className="ftp-sync__state">
            {status?.syncing
              ? badgeText(status, t)
              : status?.lastSync
                ? t("lastSync", { time: formatTime(status.lastSync) })
                : t("notSynced")}
          </span>
          <button className="ftp-sync__btn" disabled={!!busy || status?.syncing} onClick={() => run("sync", () => sync(root))}>
            {t("syncNow")}
          </button>
        </div>
        {status?.error && <div className="ftp-sync__error">{status.error}</div>}

        {conflicts.length > 0 && (
          <section className="ftp-sync__section">
            <h3 className="ftp-sync__heading">{t("conflictsTitle")}</h3>
            {conflicts.map((c) => (
              <div key={c.path} className="ftp-sync__item">
                <div className="ftp-sync__item-main">
                  <div className="ftp-sync__path">{c.path}</div>
                  <div className="ftp-sync__detail">
                    {t(`conflictKind.${c.kind}`)}
                    {c.copy && ` / ${t("serverCopy", { path: c.copy })}`}
                  </div>
                </div>
                <div className="ftp-sync__actions">
                  <button className="ftp-sync__btn" disabled={!!busy} onClick={() => act(c.path, "keepLocal")}>
                    {t("keepLocal")}
                  </button>
                  <button className="ftp-sync__btn" disabled={!!busy} onClick={() => act(c.path, "useRemote")}>
                    {t("useRemote")}
                  </button>
                </div>
              </div>
            ))}
          </section>
        )}

        {pending.length > 0 && (
          <section className="ftp-sync__section">
            <div className="ftp-sync__row">
              <h3 className="ftp-sync__heading">{t("pendingTitle")}</h3>
              {pending.length > 1 && (
                <button className="ftp-sync__btn ftp-sync__btn--danger" disabled={!!busy} onClick={approveAll}>
                  {t("approveAll")}
                </button>
              )}
            </div>
            <div className="ftp-sync__detail">{t("pendingNote")}</div>
            {pending.map((p) => (
              <div key={p} className="ftp-sync__item">
                <div className="ftp-sync__item-main">
                  <div className="ftp-sync__path">{p}</div>
                </div>
                <div className="ftp-sync__actions">
                  <button className="ftp-sync__btn ftp-sync__btn--danger" disabled={!!busy} onClick={() => act(p, "approveDelete")}>
                    {t("approveDelete")}
                  </button>
                  <button className="ftp-sync__btn" disabled={!!busy} onClick={() => act(p, "restore")}>
                    {t("restore")}
                  </button>
                </div>
              </div>
            ))}
          </section>
        )}

        {fileErrors.length > 0 && (
          <section className="ftp-sync__section">
            <h3 className="ftp-sync__heading">{t("fileErrorsTitle")}</h3>
            {fileErrors.map((e) => (
              <div key={e} className="ftp-sync__detail ftp-sync__detail--error">{e}</div>
            ))}
          </section>
        )}

        {conflicts.length === 0 && pending.length === 0 && fileErrors.length === 0 && !status?.error && (
          <div className="ftp-sync__detail">{t("nothingToReview")}</div>
        )}

        <div className="ftp-sync__footer">
          <button className="ftp-sync__btn" disabled={!!busy} onClick={onClose}>
            {t("close")}
          </button>
        </div>
      </div>
    </div>
  );
}
