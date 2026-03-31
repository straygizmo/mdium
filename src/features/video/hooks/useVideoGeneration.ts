import { useCallback, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useVideoStore } from "@/stores/video-store";
import { createTTSProvider } from "../lib/tts-provider";
import { generateSrtFromSegments } from "../lib/srt-generator";
import { generateNarrationForScene } from "../lib/narration-generator";
import { splitNarration } from "../lib/narration-splitter";
import { videoFilePrefix } from "../lib/audio-filename";
import type { TTSOptions, NarrationSegment } from "../types";

export function useVideoGeneration() {
  const [generating, setGenerating] = useState(false);
  const [generatingStatus, setGeneratingStatus] = useState("");

  const videoProject = useVideoStore((s) => s.videoProject);
  const sourceFilePath = useVideoStore((s) => s.sourceFilePath);
  const updateScene = useVideoStore((s) => s.updateScene);
  const setAudioGenerated = useVideoStore((s) => s.setAudioGenerated);

  const generateSegmentsForScene = useCallback(
    async (
      sceneIndex: number,
      sceneId: string,
      narrationText: string,
      provider: ReturnType<typeof createTTSProvider>,
      tts: NonNullable<typeof videoProject>["audio"]["tts"],
      fps: number,
    ) => {
      const texts = splitNarration(narrationText);
      const segments: NarrationSegment[] = [];
      const sceneNum = String(sceneIndex + 1).padStart(2, "0");
      const prefix = videoFilePrefix(sourceFilePath);

      for (let segIdx = 0; segIdx < texts.length; segIdx++) {
        const segNum = String(segIdx + 1).padStart(2, "0");
        const filename = `${prefix}_scene_${sceneNum}_${segNum}.wav`;

        const options: TTSOptions = {
          speaker: tts!.speaker,
          speed: tts!.speed,
          volume: tts!.volume,
          mdPath: sourceFilePath ?? undefined,
          filename,
        };

        const result = await provider.synthesize(texts[segIdx], options);

        segments.push({
          text: texts[segIdx],
          audioPath: result.audioPath,
          durationMs: result.durationMs,
        });
      }

      const srt = generateSrtFromSegments(segments);
      const totalMs = segments.reduce((sum, s) => sum + (s.durationMs ?? 0), 0);
      const durationInFrames = Math.ceil((totalMs / 1000) * fps) + 15;

      updateScene(sceneId, {
        narrationSegments: segments,
        narrationAudio: segments[0]?.audioPath,
        durationInFrames,
        narrationDirty: false,
        captions: { enabled: true, srt },
      });
    },
    [sourceFilePath, updateScene],
  );

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

      // Delete existing audio files for this project before regenerating
      const prefix = videoFilePrefix(sourceFilePath);
      if (sourceFilePath) {
        await invoke("video_delete_audio_by_prefix", { mdPath: sourceFilePath, prefix });
      }

      const scenes = videoProject.scenes;
      const total = scenes.length;

      for (let i = 0; i < total; i++) {
        const scene = scenes[i];

        setGeneratingStatus(`${i + 1}/${total}: ${scene.title ?? scene.id}`);

        let narrationText = scene.narration;

        if (!narrationText || !narrationText.trim()) {
          narrationText = await generateNarrationForScene(scene);
          updateScene(scene.id, { narration: narrationText });
        }

        await generateSegmentsForScene(
          i,
          scene.id,
          narrationText,
          provider,
          tts,
          videoProject.meta.fps,
        );
      }

      setAudioGenerated(true);
    } finally {
      setGenerating(false);
      setGeneratingStatus("");
    }
  }, [videoProject, sourceFilePath, updateScene, setAudioGenerated, generateSegmentsForScene]);

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

        await generateSegmentsForScene(
          sceneIndex,
          scene.id,
          narrationText,
          provider,
          tts,
          videoProject.meta.fps,
        );
      } finally {
        setGenerating(false);
        setGeneratingStatus("");
      }
    },
    [videoProject, sourceFilePath, updateScene, generateSegmentsForScene],
  );

  return {
    generating,
    generatingStatus,
    generateAudioForAllScenes,
    generateAudioForScene,
  };
}
