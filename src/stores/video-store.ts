import { create } from "zustand";
import type { VideoProject, Scene, SceneElement } from "@/features/video/types";

const HISTORY_LIMIT = 50;
const HISTORY_DEBOUNCE_MS = 1000;

interface VideoState {
  videoProject: VideoProject | null;
  sourceFilePath: string | null;
  audioGenerated: boolean;
  renderProgress: number;
  exportPhase: string | null;
  selectedSceneId: string | null;
  isVideoMode: boolean;
  _undoStack: VideoProject[];
  _redoStack: VideoProject[];
  _lastPushTime: number;

  setVideoProject: (project: VideoProject | null, sourceFilePath?: string | null) => void;
  updateScene: (sceneId: string, partial: Partial<Scene>) => void;
  updateElement: (sceneId: string, elementIndex: number, updates: Partial<SceneElement>) => void;
  addElement: (sceneId: string, element: SceneElement, atIndex?: number) => void;
  removeElement: (sceneId: string, elementIndex: number) => void;
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
  undo: () => void;
  redo: () => void;
  pushSnapshot: () => void;
}

/** Build history-push fields. Debounces rapid changes (e.g. typing) into one undo step. */
function historyPush(s: VideoState): Pick<VideoState, "_undoStack" | "_redoStack" | "_lastPushTime"> {
  if (!s.videoProject) return { _undoStack: s._undoStack, _redoStack: s._redoStack, _lastPushTime: s._lastPushTime };
  const now = Date.now();
  if (now - s._lastPushTime < HISTORY_DEBOUNCE_MS && s._undoStack.length > 0) {
    return { _undoStack: s._undoStack, _redoStack: [], _lastPushTime: now };
  }
  return {
    _undoStack: [...s._undoStack, structuredClone(s.videoProject)].slice(-HISTORY_LIMIT),
    _redoStack: [],
    _lastPushTime: now,
  };
}

export const useVideoStore = create<VideoState>()((set, get) => ({
  videoProject: null,
  sourceFilePath: null,
  audioGenerated: false,
  renderProgress: 0,
  exportPhase: null,
  selectedSceneId: null,
  isVideoMode: false,
  _undoStack: [],
  _redoStack: [],
  _lastPushTime: 0,

  setVideoProject: (project, sourceFilePath) =>
    set((s) => {
      const isNewFile = sourceFilePath != null && sourceFilePath !== s.sourceFilePath;
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
        ...(isNewFile ? { _undoStack: [] as VideoProject[], _redoStack: [] as VideoProject[], _lastPushTime: 0 } : {}),
      };
    }),

  updateScene: (sceneId, partial) =>
    set((s) => {
      if (!s.videoProject) return s;
      return {
        ...historyPush(s),
        videoProject: {
          ...s.videoProject,
          scenes: s.videoProject.scenes.map((scene) =>
            scene.id === sceneId ? { ...scene, ...partial } : scene
          ),
        },
      };
    }),

  updateElement: (sceneId, elementIndex, updates) =>
    set((s) => {
      if (!s.videoProject) return s;
      return {
        ...historyPush(s),
        videoProject: {
          ...s.videoProject,
          scenes: s.videoProject.scenes.map((scene) => {
            if (scene.id !== sceneId) return scene;
            return {
              ...scene,
              elements: scene.elements.map((el, i) => {
                if (i !== elementIndex) return el;
                return { ...el, ...updates } as SceneElement;
              }),
            };
          }),
        },
      };
    }),

  addElement: (sceneId, element, atIndex) =>
    set((s) => {
      if (!s.videoProject) return s;
      return {
        ...historyPush(s),
        videoProject: {
          ...s.videoProject,
          scenes: s.videoProject.scenes.map((scene) => {
            if (scene.id !== sceneId) return scene;
            const elements = [...scene.elements];
            if (atIndex !== undefined) {
              elements.splice(atIndex, 0, element);
            } else {
              elements.push(element);
            }
            return { ...scene, elements };
          }),
        },
      };
    }),

  removeElement: (sceneId, elementIndex) =>
    set((s) => {
      if (!s.videoProject) return s;
      return {
        ...historyPush(s),
        videoProject: {
          ...s.videoProject,
          scenes: s.videoProject.scenes.map((scene) => {
            if (scene.id !== sceneId) return scene;
            return {
              ...scene,
              elements: scene.elements.filter((_, i) => i !== elementIndex),
            };
          }),
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
        ...historyPush(s),
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
        ...historyPush(s),
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
        ...historyPush(s),
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
        ...historyPush(s),
        videoProject: {
          ...s.videoProject,
          scenes: s.videoProject.scenes.map((scene) => ({
            ...scene,
            captions: { ...scene.captions, enabled },
          })),
        },
      };
    }),

  undo: () => {
    const s = get();
    if (s._undoStack.length === 0 || !s.videoProject) return;
    const prev = s._undoStack[s._undoStack.length - 1];
    set({
      videoProject: prev,
      _undoStack: s._undoStack.slice(0, -1),
      _redoStack: [...s._redoStack, structuredClone(s.videoProject)].slice(-HISTORY_LIMIT),
      _lastPushTime: 0,
    });
  },

  redo: () => {
    const s = get();
    if (s._redoStack.length === 0 || !s.videoProject) return;
    const next = s._redoStack[s._redoStack.length - 1];
    set({
      videoProject: next,
      _redoStack: s._redoStack.slice(0, -1),
      _undoStack: [...s._undoStack, structuredClone(s.videoProject)].slice(-HISTORY_LIMIT),
      _lastPushTime: 0,
    });
  },

  pushSnapshot: () =>
    set((s) => {
      if (!s.videoProject) return s;
      return {
        _undoStack: [...s._undoStack, structuredClone(s.videoProject)].slice(-HISTORY_LIMIT),
        _redoStack: [],
        _lastPushTime: Date.now(),
      };
    }),
}));
