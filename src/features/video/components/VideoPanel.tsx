import { useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useVideoStore } from "@/stores/video-store";
import { useUiStore } from "@/stores/ui-store";
import { useVideoGeneration } from "../hooks/useVideoGeneration";
import { VideoSettingsBar } from "./VideoSettingsBar";
import { SceneEditForm } from "./SceneEditForm";
import { ExportDialog } from "./ExportDialog";
import { Player } from "@open-motion/core";
import { VideoComposition, calculateTotalDuration } from "../lib/scene-to-composition";
import type { ExportOptions } from "./ExportDialog";
import "./VideoPanel.css";

export function VideoPanel() {
  const { t } = useTranslation("video");
  const [showExport, setShowExport] = useState(false);

  const videoProject = useVideoStore((s) => s.videoProject);
  const scenes = videoProject?.scenes ?? [];
  const audioGenerated = useVideoStore((s) => s.audioGenerated);
  const setIsVideoMode = useVideoStore((s) => s.setIsVideoMode);
  const setActiveViewTab = useUiStore((s) => s.setActiveViewTab);

  const { generating, generatingStatus, generateAudioForAllScenes } =
    useVideoGeneration();

  const handleGenerateAudio = useCallback(async () => {
    try {
      await generateAudioForAllScenes();
    } catch (err: any) {
      if (err?.message === "voicevox_not_running") {
        alert(t("voicevoxNotRunning"));
      } else {
        alert(err instanceof Error ? err.message : String(err));
      }
    }
  }, [generateAudioForAllScenes, t]);

  const handleBackToEditor = useCallback(() => {
    setIsVideoMode(false);
    setActiveViewTab("preview");
  }, [setIsVideoMode, setActiveViewTab]);

  const handleExport = useCallback(
    (options: ExportOptions) => {
      console.log("Export requested:", options);
    },
    []
  );

  return (
    <div className="video-panel">
      <div className="video-panel__left">
        <VideoSettingsBar />
        {scenes.map((scene) => (
          <SceneEditForm key={scene.id} scene={scene} />
        ))}
      </div>

      <div className="video-panel__right">
        <div className="video-panel__player">
          {videoProject && (
            <Player
              component={() => <VideoComposition project={videoProject} />}
              config={{
                width: videoProject.meta.width,
                height: videoProject.meta.height,
                fps: videoProject.meta.fps,
                durationInFrames: calculateTotalDuration(videoProject),
              }}
            />
          )}
        </div>

        <div className="video-panel__actions">
          <button onClick={handleGenerateAudio} disabled={generating}>
            {generating
              ? generatingStatus || t("generatingAudio")
              : t("generateAudio")}
          </button>
          <button
            onClick={() => setShowExport(true)}
            disabled={!audioGenerated}
          >
            {t("export")}
          </button>
          <button onClick={handleBackToEditor}>{t("backToEditor")}</button>
        </div>
      </div>

      {showExport && (
        <ExportDialog
          onClose={() => setShowExport(false)}
          onExport={handleExport}
        />
      )}
    </div>
  );
}
