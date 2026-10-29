import { useTranslation } from "react-i18next";
import { useFtpMirrorStore } from "@/stores/ftp-mirror-store";
import "./FtpDownloadOverlay.css";

/**
 * Shown while an FTP folder is first downloaded to its local mirror: a wait
 * cursor over the whole window and a progress message.
 */
export function FtpDownloadOverlay() {
  const { t } = useTranslation("remote");
  const opening = useFtpMirrorStore((s) => s.opening);
  const progress = useFtpMirrorStore((s) =>
    s.opening ? Object.values(s.statuses).find((st) => st.uri === s.opening)?.progress ?? null : null,
  );

  if (!opening) return null;

  return (
    <div className="ftp-download-overlay" role="status" aria-live="polite">
      <div className="ftp-download-overlay__box">
        <div>
          {progress
            ? t("downloadingProgress", { done: progress.done, total: progress.total })
            : t("downloading")}
        </div>
        <div className="ftp-download-overlay__uri">{opening}</div>
      </div>
    </div>
  );
}
