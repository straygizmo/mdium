import { useState } from "react";
import { useTranslation } from "react-i18next";
import { showConfirm } from "@/stores/dialog-store";
import { useSettingsStore, type MdiumRagProvider } from "@/stores/settings-store";
import { deleteIndex, JobRunningError } from "@/features/rag/lib/index-jobs";
import type { RagSettings } from "@/shared/types";

const PROVIDERS: { id: MdiumRagProvider; labelKey: string }[] = [
  { id: "claude", labelKey: "indexToolsClaude" },
  { id: "codex", labelKey: "indexToolsCodex" },
  { id: "copilot", labelKey: "indexToolsCopilot" },
];

interface IndexSettingsDrawerProps {
  folder: string;
  canDelete: boolean;
  busy: boolean;
  onClose: () => void;
}

/** Drawer under the index strip: RAG settings form, delete, and agent tool toggles. */
export function IndexSettingsDrawer({ folder, canDelete, busy, onClose }: IndexSettingsDrawerProps) {
  const { t } = useTranslation(["agent-chat", "common"]);
  const language = useSettingsStore((s) => s.language);
  const ragSettings = useSettingsStore((s) => s.ragSettings);
  const setRagSettings = useSettingsStore((s) => s.setRagSettings);
  const mdiumRagTools = useSettingsStore((s) => s.mdiumRagTools);
  const setMdiumRagTool = useSettingsStore((s) => s.setMdiumRagTool);
  const [local, setLocal] = useState<RagSettings>(ragSettings);

  const handleDelete = async () => {
    const modelLabel = ragSettings.embeddingModel.split("/").pop() ?? ragSettings.embeddingModel;
    if (!(await showConfirm(t("common:ragDeleteIndexConfirm", { model: modelLabel }), { kind: "warning" }))) return;
    try {
      await deleteIndex(folder);
    } catch (e) {
      if (!(e instanceof JobRunningError)) console.error("[RAG] Failed to delete index:", e);
    }
  };

  return (
    <div className="index-drawer">
      <div className="index-drawer__title">{t("common:ragSettings")}</div>
      <label className="index-drawer__label">
        {t("common:ragEmbeddingModel")}
        <select
          className="index-drawer__select"
          value={local.embeddingModel}
          onChange={(e) => setLocal({ ...local, embeddingModel: e.target.value as RagSettings["embeddingModel"] })}
        >
          <option value="Xenova/multilingual-e5-large">multilingual-e5-large</option>
          <option value="Xenova/multilingual-e5-base">multilingual-e5-base</option>
          <option value="Xenova/multilingual-e5-small">multilingual-e5-small</option>
          {language === "ja" && <option value="sirasagi62/ruri-v3-30m-ONNX">ruri-v3-30m</option>}
          {language === "ja" && <option value="sirasagi62/ruri-v3-130m-ONNX">ruri-v3-130m</option>}
        </select>
      </label>
      {local.embeddingModel !== ragSettings.embeddingModel && (
        <div className="index-drawer__warning">{t("common:ragModelChangeWarning")}</div>
      )}

      <label className="index-drawer__label">
        {t("common:ragFileExtensions")}
        <input className="index-drawer__input" type="text" value={local.fileExtensions} readOnly placeholder=".md" />
      </label>

      <label className="index-drawer__label">
        {t("common:ragMinChunkLength")}
        <input
          className="index-drawer__input"
          type="number"
          min={0}
          value={local.minChunkLength}
          onChange={(e) => setLocal({ ...local, minChunkLength: Math.max(0, parseInt(e.target.value) || 0) })}
        />
      </label>

      <label className="index-drawer__label">
        {t("common:ragRetrieveTopK")}: {local.retrieveTopK}
        <input
          type="range"
          min={1}
          max={10}
          step={1}
          value={local.retrieveTopK}
          onChange={(e) => setLocal({ ...local, retrieveTopK: parseInt(e.target.value) })}
        />
      </label>

      <label className="index-drawer__label">
        {t("common:ragRetrieveMinScore")}: {local.retrieveMinScore.toFixed(2)}
        <input
          type="range"
          min={0.1}
          max={1.0}
          step={0.05}
          value={local.retrieveMinScore}
          onChange={(e) => setLocal({ ...local, retrieveMinScore: parseFloat(e.target.value) })}
        />
      </label>

      <label className="index-drawer__label">
        {t("common:ragSearchMode")}
        <select
          className="index-drawer__select"
          value={local.searchMode}
          onChange={(e) => setLocal({ ...local, searchMode: e.target.value as RagSettings["searchMode"] })}
        >
          <option value="hybrid">{t("common:ragSearchModeHybrid")}</option>
          <option value="vector">{t("common:ragSearchModeVector")}</option>
        </select>
      </label>

      {local.searchMode === "hybrid" && (
        <label className="index-drawer__label">
          {t("common:ragBm25Weight")}: {local.bm25Weight.toFixed(2)}
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={local.bm25Weight}
            onChange={(e) => setLocal({ ...local, bm25Weight: parseFloat(e.target.value) })}
          />
        </label>
      )}

      <div className="index-drawer__actions">
        <button
          type="button"
          className="index-strip__btn index-strip__btn--primary"
          onClick={() => { setRagSettings(local); onClose(); }}
        >
          {t("common:save")}
        </button>
        <button type="button" className="index-strip__btn" onClick={onClose}>
          {t("common:cancel")}
        </button>
        {canDelete && (
          <button
            type="button"
            className="index-strip__btn index-strip__btn--danger index-drawer__delete"
            onClick={handleDelete}
            disabled={busy}
          >
            {t("indexDelete")}
          </button>
        )}
      </div>

      <fieldset className="index-drawer__tools">
        <legend>{t("indexToolsHeading")}</legend>
        {PROVIDERS.map(({ id, labelKey }) => (
          <label key={id} className="index-drawer__tool">
            <input
              type="checkbox"
              checked={mdiumRagTools[id]}
              onChange={(e) => setMdiumRagTool(id, e.target.checked)}
            />
            {t(labelKey)}
          </label>
        ))}
        <div className="index-drawer__hint">{t("indexToolsHint")}</div>
      </fieldset>
    </div>
  );
}
