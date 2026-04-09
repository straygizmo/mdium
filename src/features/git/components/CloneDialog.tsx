import { useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import "./CloneDialog.css";

interface CloneDialogProps {
  open: boolean;
  onClose: () => void;
  onCloned: (path: string) => void;
}

export function CloneDialog({ open: isOpen, onClose, onCloned }: CloneDialogProps) {
  const { t } = useTranslation();
  const [url, setUrl] = useState("");
  const [dest, setDest] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleSelectDest = async () => {
    const selected = await open({ directory: true });
    if (selected && typeof selected === "string") {
      setDest(selected);
      setError(null);
    }
  };

  const handleClone = async () => {
    setLoading(true);
    setError(null);
    try {
      // Extract repo name from URL for the clone subdirectory
      const repoName = url.replace(/\.git$/, "").split("/").pop() || "repo";
      const clonePath = `${dest}/${repoName}`;
      await invoke("git_clone", { url, dest: clonePath });
      setUrl("");
      setDest("");
      onCloned(clonePath);
      onClose();
    } catch (e) {
      setError(`${t("cloneError")}: ${e}`);
    } finally {
      setLoading(false);
    }
  };

  const handleOverlayClick = () => {
    if (!loading) {
      onClose();
    }
  };

  const canClone = url.trim() !== "" && dest !== "" && !loading;

  return (
    <div className="clone-dialog__overlay" onMouseDown={handleOverlayClick}>
      <div className="clone-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <h2 className="clone-dialog__title">{t("cloneRepository")}</h2>

        <div className="clone-dialog__field">
          <label className="clone-dialog__label">{t("cloneUrl")}</label>
          <input
            className="clone-dialog__input"
            type="text"
            value={url}
            onChange={(e) => { setUrl(e.target.value); setError(null); }}
            placeholder={t("cloneUrlPlaceholder")}
            disabled={loading}
            autoFocus
          />
        </div>

        <div className="clone-dialog__field">
          <label className="clone-dialog__label">{t("cloneDest")}</label>
          <div className="clone-dialog__dest-row">
            <span className="clone-dialog__dest-path">
              {dest || t("cloneDestNotSelected")}
            </span>
            <button
              className="clone-dialog__dest-btn"
              onClick={handleSelectDest}
              disabled={loading}
            >
              {t("cloneDestSelect")}
            </button>
          </div>
        </div>

        {loading && (
          <div className="clone-dialog__spinner">{t("cloning")}</div>
        )}

        {error && (
          <div className="clone-dialog__error">{error}</div>
        )}

        <div className="clone-dialog__actions">
          <button
            className="clone-dialog__btn"
            onClick={onClose}
            disabled={loading}
          >
            {t("cancel")}
          </button>
          <button
            className="clone-dialog__btn clone-dialog__btn--primary"
            onClick={handleClone}
            disabled={!canClone}
          >
            {t("cloneRepository")}
          </button>
        </div>
      </div>
    </div>
  );
}
