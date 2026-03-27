import { useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { useSettingsStore } from "@/stores/settings-store";
import "./ImagePasteDialog.css";

interface ImagePasteDialogProps {
  imageUrl: string;
  imageBlob: Blob;
  onInsert: (altText: string) => Promise<void>;
  onClose: () => void;
}

const AI_SYSTEM_PROMPTS: Record<string, string> = {
  ja: "画像のalt属性に使用する簡潔な説明を1文で返してください。",
  en: "Return a concise one-sentence description for use as an image alt attribute.",
};

const AI_USER_MESSAGES: Record<string, string> = {
  ja: "この画像を説明してください。",
  en: "Describe this image.",
};

export function ImagePasteDialog({
  imageUrl,
  imageBlob,
  onInsert,
  onClose,
}: ImagePasteDialogProps) {
  const { t } = useTranslation("editor");
  const { t: tCommon } = useTranslation("common");
  const { aiSettings, language } = useSettingsStore();

  const [altText, setAltText] = useState("");
  const [generating, setGenerating] = useState(false);
  const [inserting, setInserting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hasAiConfig = !!(aiSettings.apiKey && aiSettings.baseUrl && aiSettings.model);

  const handleAiGenerate = useCallback(async () => {
    setGenerating(true);
    setError(null);
    try {
      // Convert blob to base64 using FileReader (handles large images safely)
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = reader.result as string;
          // Strip "data:image/png;base64," prefix
          const base64Data = dataUrl.split(",")[1] ?? "";
          resolve(base64Data);
        };
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(imageBlob);
      });

      const systemPrompt = AI_SYSTEM_PROMPTS[language] ?? AI_SYSTEM_PROMPTS.en;
      const userMessage = AI_USER_MESSAGES[language] ?? AI_USER_MESSAGES.en;

      const result = await invoke<string>("ai_chat_with_image", {
        req: {
          baseUrl: aiSettings.baseUrl,
          apiKey: aiSettings.apiKey,
          model: aiSettings.model,
          apiFormat: aiSettings.apiFormat,
          azureApiVersion: aiSettings.azureApiVersion ?? "",
          systemPrompt,
          userMessage,
          imageBase64: base64,
        },
      });

      setAltText(result.trim());
    } catch (e: any) {
      setError(e.message ?? String(e));
    } finally {
      setGenerating(false);
    }
  }, [imageBlob, aiSettings, language]);

  const handleInsert = useCallback(async () => {
    setInserting(true);
    setError(null);
    try {
      await onInsert(altText);
    } catch (e: any) {
      setError(e.message ?? String(e));
    } finally {
      setInserting(false);
    }
  }, [altText, onInsert]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey && !generating && !inserting) {
        e.preventDefault();
        handleInsert();
      } else if (e.key === "Escape") {
        onClose();
      }
    },
    [handleInsert, onClose, generating, inserting],
  );

  return (
    <div className="image-paste-overlay" onClick={onClose}>
      <div
        className="image-paste-dialog"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <h3 className="image-paste-dialog__title">{t("imagePaste")}</h3>

        <img
          className="image-paste-dialog__preview"
          src={imageUrl}
          alt="Preview"
        />

        <div className="image-paste-dialog__label">{t("imagePasteAlt")}</div>
        <div className="image-paste-dialog__input-wrap">
          <input
            className="image-paste-dialog__input"
            type="text"
            value={altText}
            onChange={(e) => setAltText(e.target.value)}
            placeholder={t("imagePasteAlt")}
            autoFocus
            disabled={generating}
          />
          <button
            className={`image-paste-dialog__ai-btn ${generating ? "image-paste-dialog__ai-btn--generating" : ""}`}
            onClick={handleAiGenerate}
            disabled={generating || !hasAiConfig}
            title={t("imagePasteAiGenerate")}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeLinejoin="round"
              strokeWidth="2"
            >
              <path d="M15 19c1.2-3.678 2.526-5.005 6-6c-3.474-.995-4.8-2.322-6-6c-1.2 3.678-2.526 5.005-6 6c3.474.995 4.8 2.322 6 6Zm-8-9c.6-1.84 1.263-2.503 3-3c-1.737-.497-2.4-1.16-3-3c-.6 1.84-1.263 2.503-3 3c1.737.497 2.4 1.16 3 3Zm1.5 10c.3-.92.631-1.251 1.5-1.5c-.869-.249-1.2-.58-1.5-1.5c-.3.92-.631 1.251-1.5 1.5c.869.249 1.2.58 1.5 1.5Z" />
            </svg>
          </button>
        </div>

        {error && <div className="image-paste-dialog__error">{error}</div>}

        <div className="image-paste-dialog__actions">
          <button
            className="image-paste-dialog__btn image-paste-dialog__btn--cancel"
            onClick={onClose}
          >
            {tCommon("cancel")}
          </button>
          <button
            className="image-paste-dialog__btn image-paste-dialog__btn--primary"
            onClick={handleInsert}
            disabled={inserting || generating}
          >
            {inserting ? tCommon("loading") : t("imagePasteInsert")}
          </button>
        </div>
      </div>
    </div>
  );
}
