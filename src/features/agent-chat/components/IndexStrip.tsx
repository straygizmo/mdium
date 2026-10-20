import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useTabStore } from "@/stores/tab-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useRagIndexStore } from "@/features/rag/stores/rag-index-store";
import { refreshIndexStatus, startUpdateIndex, JobRunningError } from "@/features/rag/lib/index-jobs";
import { useLocalEmbedding } from "@/features/rag/hooks/useLocalEmbedding";
import { IndexErrorBlock } from "./IndexErrorBlock";
import { IndexSettingsDrawer } from "./IndexSettingsDrawer";
import "./IndexStrip.css";

/** One-line document index status above the provider tabs. */
export function IndexStrip() {
  const { t } = useTranslation(["agent-chat", "common"]);
  const folder = useTabStore((s) => s.activeFolderPath);
  const store = useRagIndexStore();
  const embeddingModel = useSettingsStore((s) => s.ragSettings.embeddingModel);
  const { status: embedStatus, error: embedError, load, embed, getManualPlacement } = useLocalEmbedding();
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => {
    if (folder) void refreshIndexStatus(folder);
    // The index DB is per embedding model, so a model change must re-read status.
  }, [folder, embeddingModel]);

  if (!folder) return null;

  const busy = store.state === "updating" || store.state === "converting" || store.job?.state === "running";

  // Build for a missing/unknown index, rebuild once one exists (or failed).
  const rebuild = store.state !== "empty" && store.state !== "unknown";

  const update = () => {
    try {
      startUpdateIndex(folder, { load, embed });
    } catch (e) {
      if (!(e instanceof JobRunningError)) console.error("[RAG] Failed to start index update:", e);
    }
  };

  const pillText = (): string => {
    switch (store.state) {
      case "ready":
        return t("indexReady", { count: store.totalChunks });
      case "empty":
        return t("indexEmpty");
      case "error":
        return t("indexError");
      case "converting":
        return store.job?.kind === "convert" && store.job.state === "running"
          ? t("indexConverting", { done: store.job.done, total: store.job.total })
          : t("indexConverting", { done: 0, total: 0 });
      case "updating": {
        if (embedStatus === "downloading") return t("common:ragDownloadingModel");
        const p = store.progress;
        if (!p) return t("common:ragPhasePreparing");
        if (p.phase === "scanning") return `${t("common:ragPhaseScanning")} ${p.current}/${p.total}`;
        if (p.phase === "embedding") return `${t("common:ragPhaseEmbedding")} ${p.current}/${p.total}`;
        return p.phase === "preparing" ? t("common:ragPhasePreparing") : t("common:ragPhaseSaving");
      }
      default:
        return "";
    }
  };

  const modelTail = embeddingModel.split("/").pop() ?? embeddingModel;

  return (
    <div className="index-strip-wrap">
      <div className="index-strip" data-state={store.state}>
        <span className="index-strip__pill">{pillText()}</span>
        {store.state === "ready" && (
          <span className="index-strip__meta">
            {modelTail} · {t("indexFiles", { count: store.totalFiles })}
          </span>
        )}
        <button
          type="button"
          className="index-strip__update"
          onClick={update}
          disabled={busy}
          title={rebuild ? t("common:ragRebuildIndex") : t("common:ragBuildIndex")}
        >
          {rebuild ? t("common:ragRebuildIndex") : t("common:ragBuildIndex")}
        </button>
        <button
          type="button"
          className="index-strip__settings"
          aria-label={t("indexSettings")}
          title={t("indexSettings")}
          aria-expanded={drawerOpen}
          onClick={() => setDrawerOpen((o) => !o)}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
      </div>
      {store.error && (
        <IndexErrorBlock
          buildError={store.error}
          embedError={embedError}
          getManualPlacement={getManualPlacement}
          onRecheck={update}
          busy={busy}
        />
      )}
      {drawerOpen && (
        <IndexSettingsDrawer
          folder={folder}
          canDelete={store.state === "ready"}
          busy={busy}
          onClose={() => setDrawerOpen(false)}
        />
      )}
    </div>
  );
}
