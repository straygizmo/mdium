import { useState, useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
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

  const setRenderProgress = useVideoStore((s) => s.setRenderProgress);
  const sourceFilePath = useVideoStore((s) => s.sourceFilePath);

  // Auto-save video project settings to .video.json
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!videoProject || !sourceFilePath) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      invoke("video_save_project", {
        mdPath: sourceFilePath,
        projectJson: JSON.stringify(videoProject),
      }).catch(() => {});
    }, 500);
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [videoProject, sourceFilePath]);

  // Listen for render progress events from Rust backend
  useEffect(() => {
    const unlisten = listen<{ phase?: string; percent?: number; message?: string }>(
      "video-progress",
      (event) => {
        const { percent } = event.payload;
        if (typeof percent === "number") {
          setRenderProgress(percent);
        }
      },
    );
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [setRenderProgress]);

  const handleExport = useCallback(
    async (options: ExportOptions) => {
      if (!videoProject) return;
      setRenderProgress(0);
      try {
        const projectJson = JSON.stringify(videoProject);
        await invoke<string>("video_export", {
          projectJson,
          outputPath: options.outputPath,
          fps: options.fps,
          concurrency: options.concurrency,
          format: options.format,
        });
        setShowExport(false);
        setRenderProgress(100);
      } catch (e: any) {
        alert(e instanceof Error ? e.message : String(e));
        setRenderProgress(0);
      }
    },
    [videoProject, setRenderProgress],
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
