import { useCallback, useState } from "react";
import { useVideoStore } from "@/stores/video-store";
import { createTTSProvider } from "../lib/tts-provider";
import { generateSrt } from "../lib/srt-generator";
import { generateNarrationForScene } from "../lib/narration-generator";
import type { TTSOptions } from "../types";

export function useVideoGeneration() {
  const [generating, setGenerating] = useState(false);
  const [generatingStatus, setGeneratingStatus] = useState("");

  const videoProject = useVideoStore((s) => s.videoProject);
  const updateScene = useVideoStore((s) => s.updateScene);
  const setAudioGenerated = useVideoStore((s) => s.setAudioGenerated);

  const generateAudioForAllScenes = useCallback(async () => {
    if (!videoProject) return;

    const tts = videoProject.audio.tts;
    if (!tts) return;

    setGenerating(true);
    setGeneratingStatus("");

    try {
      const provider = createTTSProvider(tts.provider);
      const scenes = videoProject.scenes;
      const total = scenes.length;

      for (let i = 0; i < total; i++) {
        const scene = scenes[i];

        // Skip if audio exists and is not dirty
        if (scene.narrationAudio && !scene.narrationDirty) {
          continue;
        }

        setGeneratingStatus(`${i + 1}/${total}: ${scene.title ?? scene.id}`);

        let narrationText = scene.narration;

        // Generate narration text if empty
        if (!narrationText || !narrationText.trim()) {
          narrationText = await generateNarrationForScene(scene);
          updateScene(scene.id, { narration: narrationText });
        }

        const options: TTSOptions = {
          speaker: tts.speaker,
          speed: tts.speed,
          volume: tts.volume,
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
  }, [videoProject, updateScene, setAudioGenerated]);

  const generateAudioForScene = useCallback(
    async (sceneId: string) => {
      if (!videoProject) return;

      const tts = videoProject.audio.tts;
      if (!tts) return;

      const scene = videoProject.scenes.find((s) => s.id === sceneId);
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

        const options: TTSOptions = {
          speaker: tts.speaker,
          speed: tts.speed,
          volume: tts.volume,
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
    [videoProject, updateScene]
  );

  return {
    generating,
    generatingStatus,
    generateAudioForAllScenes,
    generateAudioForScene,
  };
}
