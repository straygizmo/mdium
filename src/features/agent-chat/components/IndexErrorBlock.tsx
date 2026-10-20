import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { classifyRagError } from "@/features/rag/lib/model-error";
import { useSettingsStore } from "@/stores/settings-store";

interface IndexErrorBlockProps {
  buildError: string | null;
  embedError: string | null;
  getManualPlacement: () => { dir: string; files: string[] } | null;
  onRecheck: () => void;
  busy: boolean;
}

/** Error / model-missing guidance shown under the index strip. */
export function IndexErrorBlock({ buildError, embedError, getManualPlacement, onRecheck, busy }: IndexErrorBlockProps) {
  const { t } = useTranslation("common");
  const embeddingModel = useSettingsStore((s) => s.ragSettings.embeddingModel);
  const kind = classifyRagError(buildError, embedError);
  if (!kind) return null;

  if (kind === "modelMissing") {
    const info = getManualPlacement();
    const sourceUrl = `https://huggingface.co/${embeddingModel}/tree/main`;
    return (
      <div className="index-strip__error">
        <div className="index-strip__error-title">{t("ragModelMissingTitle")}</div>
        <p>{t("ragModelMissingInstructions")}</p>
        {info && (
          <>
            <div>{t("ragModelMissingFolder")}:</div>
            <code className="index-strip__error-path">{info.dir}</code>
            <div>{t("ragModelMissingFiles")}:</div>
            <ul className="index-strip__error-files">
              {info.files.map((f) => (
                <li key={f}><code>{f}</code></li>
              ))}
            </ul>
            <div>{t("ragModelMissingSource")}</div>
            <code className="index-strip__error-path">{sourceUrl}</code>
            <div className="index-strip__error-actions">
              <button
                type="button"
                className="index-strip__btn"
                onClick={async () => {
                  // create_folder errors if the directory already exists (a
                  // prior download attempt commonly created it), so ignore that
                  // and always proceed to open the folder.
                  try {
                    await invoke("create_folder", { path: info.dir });
                  } catch {
                    // directory already exists - fine
                  }
                  try {
                    await invoke("open_in_default_app", { path: info.dir });
                  } catch (e) {
                    console.error("[RAG] Failed to open model folder:", e);
                  }
                }}
              >
                {t("ragOpenModelFolder")}
              </button>
              <button type="button" className="index-strip__btn" onClick={onRecheck} disabled={busy}>
                {t("ragModelRecheck")}
              </button>
            </div>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="index-strip__error">
      {kind === "network"
        ? t("ragNetworkError")
        : kind === "download"
          ? t("ragDownloadError")
          : kind === "engine"
            ? t("ragEngineError")
            : `${t("ragBuildError")}: ${buildError || embedError}`}
    </div>
  );
}
