import { create } from "zustand";
import type { VideoProject, Scene } from "@/features/video/types";

interface VideoState {
  videoProject: VideoProject | null;
  sourceFilePath: string | null;
  audioGenerated: boolean;
  renderProgress: number;
  exportPhase: string | null;
  selectedSceneId: string | null;
  isVideoMode: boolean;

  setVideoProject: (project: VideoProject | null, sourceFilePath?: string | null) => void;
  updateScene: (sceneId: string, partial: Partial<Scene>) => void;
  setSelectedSceneId: (id: string | null) => void;
  setAudioGenerated: (generated: boolean) => void;
  setRenderProgress: (progress: number) => void;
  setExportPhase: (phase: string | null) => void;
  setIsVideoMode: (mode: boolean) => void;
  updateMeta: (partial: Partial<VideoProject["meta"]>) => void;
  updateAudioConfig: (partial: Partial<VideoProject["audio"]>) => void;
  markNarrationDirty: (sceneId: string) => void;
  updateImageElement: (sceneId: string, elementIndex: number, updates: Partial<{ src: string; position: "center" | "left" | "right" | "background"; animation: "fade-in" | "zoom-in" | "ken-burns" | "none"; enabled: boolean }>) => void;
  setAllCaptions: (enabled: boolean) => void;
}

export const useVideoStore = create<VideoState>()((set) => ({
  videoProject: null,
  sourceFilePath: null,
  audioGenerated: false,
  renderProgress: 0,
  exportPhase: null,
  selectedSceneId: null,
  isVideoMode: false,

  setVideoProject: (project, sourceFilePath) =>
    set((s) => {
      // If all scenes already have audio and none are dirty, mark as generated
      const allAudioReady =
        !!project &&
        project.scenes.length > 0 &&
        project.scenes.every((sc) => {
          if (sc.narrationDirty) return false;
          if (sc.narrationSegments?.length) {
            return sc.narrationSegments.every((seg) => seg.audioPath);
          }
          return !!sc.narrationAudio;
        });
      return {
        videoProject: project,
        sourceFilePath: sourceFilePath ?? s.sourceFilePath,
        audioGenerated: allAudioReady,
        renderProgress: 0,
        exportPhase: null,
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

  setExportPhase: (phase) => set({ exportPhase: phase }),

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

  updateImageElement: (sceneId, elementIndex, updates) =>
    set((s) => {
      if (!s.videoProject) return s;
      return {
        videoProject: {
          ...s.videoProject,
          scenes: s.videoProject.scenes.map((scene) => {
            if (scene.id !== sceneId) return scene;
            return {
              ...scene,
              elements: scene.elements.map((el, i) => {
                if (i !== elementIndex || el.type !== "image") return el;
                return { ...el, ...updates };
              }),
            };
          }),
        },
      };
    }),

  setAllCaptions: (enabled) =>
    set((s) => {
      if (!s.videoProject) return s;
      return {
        videoProject: {
          ...s.videoProject,
          scenes: s.videoProject.scenes.map((scene) => ({
            ...scene,
            captions: { ...scene.captions, enabled },
          })),
        },
      };
    }),
}));
