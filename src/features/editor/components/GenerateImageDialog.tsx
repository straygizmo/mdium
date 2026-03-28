import { type FC, useState } from "react";
import { useTranslation } from "react-i18next";
import { getOpencodeClient } from "@/features/opencode-config/hooks/useOpencodeChat";
import "./GenerateImageDialog.css";

interface Props {
  visible: boolean;
  onClose: () => void;
  onInsert: (markdownImage: string) => void;
}

export const GenerateImageDialog: FC<Props> = ({ visible, onClose, onInsert }) => {
  const { t } = useTranslation("editor");
  const [prompt, setPrompt] = useState("");
  const [filename, setFilename] = useState("");
  const [width, setWidth] = useState(1024);
  const [height, setHeight] = useState(768);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState("");
  const [generatedPath, setGeneratedPath] = useState("");

  if (!visible) return null;

  const handleGenerate = async () => {
    if (!prompt.trim() || !filename.trim()) return;
    setGenerating(true);
    setError("");
    setGeneratedPath("");

    try {
      const client = getOpencodeClient();
      if (!client) {
        setError(t("genImageNoOpencode"));
        return;
      }

      // Use opencode chat to call the generate_image tool
      const sessionRes = await client.session.create({ body: { title: "Image Generation" } });
      const sessionData = sessionRes.data as any;
      const sessionId: string = sessionData?.id ?? "";
      await client.session.promptAsync({
        path: { id: sessionId },
        body: {
          parts: [{
            type: "text",
            text: `Use the generate_image tool with these exact parameters:\n- prompt: "${prompt}"\n- width: ${width}\n- height: ${height}\n- filename: "${filename}"\n\nCall the tool and return the result.`,
          }],
        },
      });

      // Parse result from session messages
      const messagesRes = await client.session.messages({ path: { id: sessionId } });
      const messagesData = messagesRes.data as any;
      const msgArray: any[] = Array.isArray(messagesData) ? messagesData : [];
      const lastMsg = msgArray[msgArray.length - 1];
      if (lastMsg) {
        // Try to find the image path in the response
        const parts: any[] = lastMsg.parts ?? [];
        const textParts = parts.filter((p: any) => p.type === "text");
        for (const part of textParts) {
          const text = String(part.text ?? "");
          // Look for JSON with path field
          const jsonMatch = text.match(/\{[^}]*"path"\s*:\s*"([^"]+)"[^}]*\}/);
          if (jsonMatch) {
            setGeneratedPath(jsonMatch[1]);
            return;
          }
        }
      }
      // Fallback path
      setGeneratedPath(`/images/${filename}`);
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
    setWidth(1024);
    setHeight(768);
    setError("");
    setGeneratedPath("");
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
          <label className="gen-image-dialog__label">{t("genImageSize")}</label>
          <div className="gen-image-dialog__size-row">
            <input
              className="gen-image-dialog__size-input"
              type="number"
              value={width}
              onChange={(e) => setWidth(Number(e.target.value))}
              disabled={generating}
            />
            <span>×</span>
            <input
              className="gen-image-dialog__size-input"
              type="number"
              value={height}
              onChange={(e) => setHeight(Number(e.target.value))}
              disabled={generating}
            />
          </div>
        </div>

        {error && <div className="gen-image-dialog__error">{error}</div>}

        {generatedPath ? (
          <div style={{ marginTop: 12 }}>
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
