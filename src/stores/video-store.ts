import { create } from "zustand";
import type { VideoProject, Scene } from "@/features/video/types";

interface VideoState {
  videoProject: VideoProject | null;
  sourceFilePath: string | null;
  audioGenerated: boolean;
  renderProgress: number;
  selectedSceneId: string | null;
  isVideoMode: boolean;

  setVideoProject: (project: VideoProject | null, sourceFilePath?: string | null) => void;
  updateScene: (sceneId: string, partial: Partial<Scene>) => void;
  setSelectedSceneId: (id: string | null) => void;
  setAudioGenerated: (generated: boolean) => void;
  setRenderProgress: (progress: number) => void;
  setIsVideoMode: (mode: boolean) => void;
  updateMeta: (partial: Partial<VideoProject["meta"]>) => void;
  updateAudioConfig: (partial: Partial<VideoProject["audio"]>) => void;
  markNarrationDirty: (sceneId: string) => void;
}

export const useVideoStore = create<VideoState>()((set) => ({
  videoProject: null,
  sourceFilePath: null,
  audioGenerated: false,
  renderProgress: 0,
  selectedSceneId: null,
  isVideoMode: false,

  setVideoProject: (project, sourceFilePath) =>
    set((s) => {
      // If all scenes already have audio and none are dirty, mark as generated
      const allAudioReady =
        !!project &&
        project.scenes.length > 0 &&
        project.scenes.every((sc) => sc.narrationAudio && !sc.narrationDirty);
      return {
        videoProject: project,
        sourceFilePath: sourceFilePath ?? s.sourceFilePath,
        audioGenerated: allAudioReady,
        renderProgress: 0,
      };
    }),

  updateScene: (sceneId, partial) =>
    set((s) => {
      if (!s.videoProject) return s;
      return {
        videoProject: {
          ...s.videoProject,
          scenes: s.videoProject.scenes.map((scene) =>
            scene.id === sceneId ? { ...scene, ...partial } : scene
          ),
        },
      };
    }),

  setSelectedSceneId: (id) => set({ selectedSceneId: id }),

  setAudioGenerated: (generated) => set({ audioGenerated: generated }),

  setRenderProgress: (progress) => set({ renderProgress: progress }),

  setIsVideoMode: (mode) => set({ isVideoMode: mode }),

  updateMeta: (partial) =>
    set((s) => {
      if (!s.videoProject) return s;
      return {
        videoProject: {
          ...s.videoProject,
          meta: { ...s.videoProject.meta, ...partial },
        },
      };
    }),

  updateAudioConfig: (partial) =>
    set((s) => {
      if (!s.videoProject) return s;
      return {
        videoProject: {
          ...s.videoProject,
          audio: { ...s.videoProject.audio, ...partial },
        },
      };
    }),

  markNarrationDirty: (sceneId) =>
    set((s) => {
      if (!s.videoProject) return s;
      return {
        audioGenerated: false,
        videoProject: {
          ...s.videoProject,
          scenes: s.videoProject.scenes.map((scene) =>
            scene.id === sceneId ? { ...scene, narrationDirty: true } : scene
          ),
        },
      };
    }),
}));
