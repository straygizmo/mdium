import { type FC, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { useTabStore } from "@/stores/tab-store";
import "./GenerateImageDialog.css";

interface Props {
  visible: boolean;
  onClose: () => void;
  onInsert: (markdownImage: string) => void;
}

const ASPECT_RATIOS = [
  "1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9",
] as const;
const IMAGE_SIZES = ["512", "1K", "2K", "4K"] as const;

export const GenerateImageDialog: FC<Props> = ({ visible, onClose, onInsert }) => {
  const { t } = useTranslation("editor");
  const activeFolderPath = useTabStore((s) => s.activeFolderPath);
  const [prompt, setPrompt] = useState("");
  const [filename, setFilename] = useState("");
  const [aspectRatio, setAspectRatio] = useState<string>("16:9");
  const [imageSize, setImageSize] = useState<string>("1K");
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState("");
  const [generatedPath, setGeneratedPath] = useState("");
  const [previewUrl, setPreviewUrl] = useState("");

  if (!visible) return null;

  const handleGenerate = async () => {
    if (!prompt.trim() || !filename.trim()) return;
    setGenerating(true);
    setError("");
    setGeneratedPath("");

    try {
      // Read API key from environment
      let apiKey: string;
      try {
        apiKey = await invoke<string>("get_env_var", { name: "GEMINI_API_KEY" });
      } catch {
        setError("GEMINI_API_KEY environment variable is not set");
        return;
      }

      const model = "gemini-3.1-flash-image-preview";
      const outputDir = activeFolderPath
        ? `${activeFolderPath.replace(/\\/g, "/")}/images`
        : "";

      if (!outputDir) {
        setError("No folder is open");
        return;
      }

      const resultJson = await invoke<string>("gemini_generate_image", {
        req: {
          apiKey,
          model,
          prompt: prompt.trim(),
          filename: filename.trim(),
          outputDir,
          aspectRatio,
          imageSize,
        },
      });

      const result = JSON.parse(resultJson);
      setGeneratedPath(result.path);

      // Load preview from the saved file
      try {
        const bytes = await invoke<number[]>("read_binary_file", { path: result.absolutePath });
        const mime = result.mimeType || "image/png";
        const blob = new Blob([new Uint8Array(bytes)], { type: mime });
        if (previewUrl) URL.revokeObjectURL(previewUrl);
        setPreviewUrl(URL.createObjectURL(blob));
      } catch {
        // Preview failed silently — not critical
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setGenerating(false);
    }
  };

  const handleInsert = () => {
    const path = generatedPath || `/images/${filename}`;
    onInsert(`![${prompt}](${path})`);
    handleReset();
  };

  const handleReset = () => {
    setPrompt("");
    setFilename("");
    setAspectRatio("16:9");
    setImageSize("1K");
    setError("");
    setGeneratedPath("");
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl("");
    setGenerating(false);
    onClose();
  };

  return (
    <div className="gen-image-dialog-overlay" onClick={handleReset}>
      <div className="gen-image-dialog" onClick={(e) => e.stopPropagation()}>
        <h3 className="gen-image-dialog__title">{t("genImageTitle")}</h3>

        <div className="gen-image-dialog__field">
          <label className="gen-image-dialog__label">{t("genImagePrompt")}</label>
          <textarea
            className="gen-image-dialog__textarea"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={t("genImagePromptPlaceholder")}
            disabled={generating}
          />
        </div>

        <div className="gen-image-dialog__field">
          <label className="gen-image-dialog__label">{t("genImageFilename")}</label>
          <input
            className="gen-image-dialog__input"
            value={filename}
            onChange={(e) => setFilename(e.target.value)}
            placeholder="architecture-diagram.png"
            disabled={generating}
          />
        </div>

        <div className="gen-image-dialog__field">
          <label className="gen-image-dialog__label">{t("genImageAspectRatio")}</label>
          <select
            className="gen-image-dialog__select"
            value={aspectRatio}
            onChange={(e) => setAspectRatio(e.target.value)}
            disabled={generating}
          >
            {ASPECT_RATIOS.map((r) => (
              <option key={r} value={r}>{r}</option>
            ))}
          </select>
        </div>

        <div className="gen-image-dialog__field">
          <label className="gen-image-dialog__label">{t("genImageResolution")}</label>
          <select
            className="gen-image-dialog__select"
            value={imageSize}
            onChange={(e) => setImageSize(e.target.value)}
            disabled={generating}
          >
            {IMAGE_SIZES.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </div>

        {error && <div className="gen-image-dialog__error">{error}</div>}

        {generatedPath ? (
          <div style={{ marginTop: 12 }}>
            {previewUrl && (
              <img
                className="gen-image-dialog__preview"
                src={previewUrl}
                alt={prompt}
              />
            )}
            <p style={{ fontSize: 12, opacity: 0.7, marginBottom: 8 }}>{t("genImageGenerated")}: {generatedPath}</p>
            <div className="gen-image-dialog__actions">
              <button className="gen-image-dialog__btn gen-image-dialog__btn--primary" onClick={handleInsert}>
                {t("genImageInsert")}
              </button>
              <button className="gen-image-dialog__btn" onClick={handleGenerate} disabled={generating}>
                {t("genImageRegenerate")}
              </button>
              <button className="gen-image-dialog__btn" onClick={handleReset}>
                {t("cancel", { ns: "common" })}
              </button>
            </div>
          </div>
        ) : (
          <div className="gen-image-dialog__actions">
            <button
              className="gen-image-dialog__btn gen-image-dialog__btn--primary"
              onClick={handleGenerate}
              disabled={generating || !prompt.trim() || !filename.trim()}
            >
              {generating ? t("genImageGenerating") : t("genImageGenerate")}
            </button>
            <button className="gen-image-dialog__btn" onClick={handleReset}>
              {t("cancel", { ns: "common" })}
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
