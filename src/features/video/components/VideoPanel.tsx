import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useVideoStore } from "@/stores/video-store";
import { useVideoGeneration } from "../hooks/useVideoGeneration";
import { VideoSettingsBar } from "./VideoSettingsBar";
import { SceneEditForm } from "./SceneEditForm";
import { ExportPanel } from "./ExportPanel";
import { Player } from "@open-motion/core";
import { VideoComposition, calculateTotalDuration } from "../lib/composition";
import { decorateWithLLM } from "../lib/scene-decorator";
import { PromptEditDialog } from "./PromptEditDialog";
import { useImageBlobUrls } from "../hooks/useImageBlobUrls";
import type { ExportOptions } from "./ExportPanel";
import "./VideoPanel.css";

export function VideoPanel() {
  const { t } = useTranslation("video");

  const videoProject = useVideoStore((s) => s.videoProject);
  const playerProject = useImageBlobUrls(videoProject);
  const scenes = videoProject?.scenes ?? [];
  const audioGenerated = useVideoStore((s) => s.audioGenerated);

  const { generating, generatingStatus, generateAudioForAllScenes, generateAudioForScene } =
    useVideoGeneration();

  const setVideoProject = useVideoStore((s) => s.setVideoProject);
  const pushSnapshot = useVideoStore((s) => s.pushSnapshot);

  const [decorating, setDecorating] = useState(false);
  const [showPromptDialog, setShowPromptDialog] = useState(false);

  const handleDecorateClick = useCallback(() => {
    if (!videoProject) return;
    setShowPromptDialog(true);
  }, [videoProject]);

  const handleDecorateExecute = useCallback(async (prompt: string) => {
    if (!videoProject) return;
    setShowPromptDialog(false);
    setDecorating(true);
    try {
      pushSnapshot();
      const decorated = await decorateWithLLM(videoProject, prompt);
      setVideoProject(decorated);
    } catch (e) {
      console.error("Decoration failed:", e);
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setDecorating(false);
    }
  }, [videoProject, setVideoProject, pushSnapshot]);

  // Splitter drag logic
  const [leftWidth, setLeftWidth] = useState(300);
  const splitterDragging = useRef(false);

  const handleSplitterMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    splitterDragging.current = true;
    const startX = e.clientX;
    const startWidth = leftWidth;

    const onMouseMove = (ev: MouseEvent) => {
      const newWidth = Math.max(200, Math.min(800, startWidth + ev.clientX - startX));
      setLeftWidth(newWidth);
    };
    const onMouseUp = () => {
      splitterDragging.current = false;
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, [leftWidth]);

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

  const setRenderProgress = useVideoStore((s) => s.setRenderProgress);
  const setExportPhase = useVideoStore((s) => s.setExportPhase);
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

  // Undo / Redo keyboard shortcuts (Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      if (e.key === "z" && !e.shiftKey) {
        e.preventDefault();
        useVideoStore.getState().undo();
      } else if ((e.key === "z" && e.shiftKey) || e.key === "y") {
        e.preventDefault();
        useVideoStore.getState().redo();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // Listen for render progress events from Rust backend
  useEffect(() => {
    const unlisten = listen<{ phase?: string; percent?: number; message?: string }>(
      "video-progress",
      (event) => {
        const { percent, phase } = event.payload;
        if (typeof percent === "number") {
          setRenderProgress(percent);
        }
        if (phase) {
          setExportPhase(phase);
        }
      },
    );
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [setRenderProgress, setExportPhase]);

  const handleExport = useCallback(
    async (options: ExportOptions) => {
      if (!videoProject) return;

      // Check ffmpeg availability before starting export
      const ffmpegOk = await invoke<boolean>("video_check_ffmpeg").catch(() => false);
      if (!ffmpegOk) {
        alert(t("ffmpegNotFound"));
        return;
      }

      setRenderProgress(0);
      setExportPhase("setup");
      try {
        const projectJson = JSON.stringify(videoProject);
        await invoke<string>("video_export", {
          projectJson,
          outputPath: options.outputPath,
          fps: options.fps,
          concurrency: options.concurrency,
          format: options.format,
        });
        setRenderProgress(100);
        setExportPhase("done");
      } catch (e: any) {
        alert(e instanceof Error ? e.message : String(e));
        setRenderProgress(0);
        setExportPhase(null);
      }
    },
    [videoProject, setRenderProgress],
  );

  const [expandedScenes, setExpandedScenes] = useState<Record<string, boolean>>({});

  // Auto-expand first scene on load
  const firstSceneId = scenes[0]?.id;
  const expandedScenesResolved = useMemo(() => {
    if (firstSceneId && Object.keys(expandedScenes).length === 0) {
      return { [firstSceneId]: true };
    }
    return expandedScenes;
  }, [expandedScenes, firstSceneId]);

  const toggleScene = useCallback((sceneId: string) => {
    setExpandedScenes((prev) => {
      const base = Object.keys(prev).length === 0 && firstSceneId ? { [firstSceneId]: true } : prev;
      return { ...base, [sceneId]: !base[sceneId] };
    });
  }, [firstSceneId]);

  return (
    <div className="video-panel">
      <div className="video-panel__left" style={{ width: leftWidth }}>
        <div className="video-panel__scenes">
          <VideoSettingsBar
            onGenerateAudio={handleGenerateAudio}
            generating={generating}
            generatingStatus={generatingStatus}
            onDecorateWithLLM={handleDecorateClick}
            decorating={decorating}
          />
          {scenes.map((scene, idx) => (
            <div key={scene.id} className="video-panel__scene-block">
              <button
                className={`video-panel__scene-header${expandedScenesResolved[scene.id] ? " video-panel__scene-header--expanded" : ""}`}
                onClick={() => toggleScene(scene.id)}
              >
                <span className="video-panel__scene-arrow">{expandedScenesResolved[scene.id] ? "▼" : "▶"}</span>
                <span className="video-panel__scene-number">{idx + 1}</span>
                <span className="video-panel__scene-title">{scene.title ?? `Scene ${idx + 1}`}</span>
                {scene.narrationDirty && <span className="scene-edit-form__dirty">{t("narrationDirty")}</span>}
              </button>
              {expandedScenesResolved[scene.id] && (
                <SceneEditForm
                  scene={scene}
                  onRegenerateAudio={generateAudioForScene}
                  audioGenerating={generating}
                />
              )}
            </div>
          ))}
        </div>
      </div>

      <div
        className={`video-panel__splitter${splitterDragging.current ? " video-panel__splitter--dragging" : ""}`}
        onMouseDown={handleSplitterMouseDown}
      />

      <div className="video-panel__right">
        <div className="video-panel__player">
          {playerProject?.meta && (
            <Player
              component={() => <VideoComposition project={playerProject} />}
              config={{
                width: playerProject.meta.width,
                height: playerProject.meta.height,
                fps: playerProject.meta.fps,
                durationInFrames: calculateTotalDuration(playerProject),
              }}
            />
          )}
        </div>
        <ExportPanel
          disabled={!audioGenerated}
          onExport={handleExport}
        />
      </div>
      {showPromptDialog && (
        <PromptEditDialog
          onExecute={handleDecorateExecute}
          onClose={() => setShowPromptDialog(false)}
        />
      )}
    </div>
  );
}
