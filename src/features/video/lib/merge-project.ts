import { invoke } from "@tauri-apps/api/core";
import type { VideoProject, Scene } from "../types";

/**
 * Load saved .video.json and merge with a freshly parsed project.
 * - Global settings (meta, audio) come from saved project.
 * - Scene list comes from fresh parse (reflects markdown edits).
 * - Per-scene settings (narration, transition, captions, segments) are
 *   restored from saved scenes matched by index.
 */
export async function mergeWithSavedProject(
  freshProject: VideoProject,
  mdFilePath: string,
): Promise<VideoProject> {
  let savedJson: string | null = null;
  try {
    savedJson = await invoke<string | null>("video_load_project", {
      mdPath: mdFilePath,
    });
  } catch {
    return freshProject;
  }

  if (!savedJson) return freshProject;

  let saved: VideoProject;
  try {
    saved = JSON.parse(savedJson) as VideoProject;
  } catch {
    return freshProject;
  }

  const mergedScenes: Scene[] = freshProject.scenes.map((fresh, i) => {
    const savedScene = saved.scenes[i];
    if (!savedScene) return fresh;

    // Migrate legacy: if saved has narrationAudio but no segments, create a
    // single-segment entry so the rest of the pipeline can work uniformly.
    let segments = savedScene.narrationSegments;
    if (!segments && savedScene.narrationAudio) {
      segments = [{
        text: savedScene.narration ?? "",
        audioPath: savedScene.narrationAudio,
        durationMs: savedScene.durationInFrames
          ? Math.round((savedScene.durationInFrames - 15) / (saved.meta.fps || 30) * 1000)
          : undefined,
      }];
    }

    return {
      ...fresh,
      narration: savedScene.narration ?? fresh.narration,
      narrationAudio: savedScene.narrationAudio,
      narrationSegments: segments,
      narrationDirty: savedScene.narrationDirty,
      durationInFrames: savedScene.durationInFrames,
      transition: savedScene.transition ?? fresh.transition,
      captions: savedScene.captions ?? fresh.captions,
    };
  });

  return {
    meta: { ...freshProject.meta, ...saved.meta },
    audio: { ...freshProject.audio, ...saved.audio },
    scenes: mergedScenes,
  };
}
