import { useCallback, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useVideoStore } from "@/stores/video-store";
import { createTTSProvider } from "../lib/tts-provider";
import { generateSrt } from "../lib/srt-generator";
import { generateNarrationForScene } from "../lib/narration-generator";
import type { TTSOptions } from "../types";

export function useVideoGeneration() {
  const [generating, setGenerating] = useState(false);
  const [generatingStatus, setGeneratingStatus] = useState("");

  const videoProject = useVideoStore((s) => s.videoProject);
  const sourceFilePath = useVideoStore((s) => s.sourceFilePath);
  const updateScene = useVideoStore((s) => s.updateScene);
  const setAudioGenerated = useVideoStore((s) => s.setAudioGenerated);

  const generateAudioForAllScenes = useCallback(async () => {
    if (!videoProject) return;

    const tts = videoProject.audio.tts;
    if (!tts) return;

    setGenerating(true);
    setGeneratingStatus("");

    try {
      // Check VOICEVOX connectivity before starting
      if (tts.provider === "voicevox") {
        try {
          const res = await fetch("http://localhost:50021/version");
          if (!res.ok) throw new Error();
        } catch {
          throw new Error("voicevox_not_running");
        }
      }

      const provider = createTTSProvider(tts.provider);
      const scenes = videoProject.scenes;
      const total = scenes.length;

      for (let i = 0; i < total; i++) {
        const scene = scenes[i];

        // Skip if audio file exists in the project's audio folder and is not dirty
        if (scene.narrationAudio && !scene.narrationDirty) {
          const isInAudioFolder = sourceFilePath
            ? scene.narrationAudio.replace(/\\/g, "/").startsWith(
                sourceFilePath.replace(/\\/g, "/").replace(/\/[^/]+$/, "/audio/")
              )
            : false;
          if (isInAudioFolder) {
            const exists = await invoke<boolean>("video_file_exists", { path: scene.narrationAudio });
            if (exists) continue;
          }
        }

        setGeneratingStatus(`${i + 1}/${total}: ${scene.title ?? scene.id}`);

        let narrationText = scene.narration;

        // Generate narration text if empty
        if (!narrationText || !narrationText.trim()) {
          narrationText = await generateNarrationForScene(scene);
          updateScene(scene.id, { narration: narrationText });
        }

        const sceneNum = String(i + 1).padStart(2, "0");
        const options: TTSOptions = {
          speaker: tts.speaker,
          speed: tts.speed,
          volume: tts.volume,
          mdPath: sourceFilePath ?? undefined,
          filename: `scene_${sceneNum}.wav`,
        };

        const result = await provider.synthesize(narrationText, options);

        const srt = generateSrt(result.timingData, narrationText, result.durationMs);

        const fps = videoProject.meta.fps;
        const durationInFrames = Math.ceil((result.durationMs / 1000) * fps) + 15;

        updateScene(scene.id, {
          narrationAudio: result.audioPath,
          durationInFrames,
          narrationDirty: false,
          captions: {
            enabled: true,
            srt,
          },
        });
      }

      setAudioGenerated(true);
    } finally {
      setGenerating(false);
      setGeneratingStatus("");
    }
  }, [videoProject, sourceFilePath, updateScene, setAudioGenerated]);

  const generateAudioForScene = useCallback(
    async (sceneId: string) => {
      if (!videoProject) return;

      const tts = videoProject.audio.tts;
      if (!tts) return;

      const sceneIndex = videoProject.scenes.findIndex((s) => s.id === sceneId);
      const scene = sceneIndex >= 0 ? videoProject.scenes[sceneIndex] : undefined;
      if (!scene) return;

      setGenerating(true);
      setGeneratingStatus(scene.title ?? scene.id);

      try {
        const provider = createTTSProvider(tts.provider);

        let narrationText = scene.narration;

        if (!narrationText || !narrationText.trim()) {
          narrationText = await generateNarrationForScene(scene);
          updateScene(scene.id, { narration: narrationText });
        }

        const sceneNum = String(sceneIndex + 1).padStart(2, "0");
        const options: TTSOptions = {
          speaker: tts.speaker,
          speed: tts.speed,
          volume: tts.volume,
          mdPath: sourceFilePath ?? undefined,
          filename: `scene_${sceneNum}.wav`,
        };

        const result = await provider.synthesize(narrationText, options);

        const srt = generateSrt(result.timingData, narrationText, result.durationMs);

        const fps = videoProject.meta.fps;
        const durationInFrames = Math.ceil((result.durationMs / 1000) * fps) + 15;

        updateScene(scene.id, {
          narrationAudio: result.audioPath,
          durationInFrames,
          narrationDirty: false,
          captions: {
            enabled: true,
            srt,
          },
        });
      } finally {
        setGenerating(false);
        setGeneratingStatus("");
      }
    },
    [videoProject, sourceFilePath, updateScene]
  );

  return {
    generating,
    generatingStatus,
    generateAudioForAllScenes,
    generateAudioForScene,
  };
}
