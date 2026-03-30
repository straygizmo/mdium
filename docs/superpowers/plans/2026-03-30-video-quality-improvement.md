# Video Quality Improvement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve video generation quality by scaling fonts to resolution, enhancing animations with professional motion, and redesigning the subtitle system to use per-segment audio files with editable narration.

**Architecture:** Three independent changes to the video pipeline: (1) resolution-based scaling in scene-to-composition.tsx, (2) animation parameter tuning + subtle motion in the same file, (3) subtitle system redesign across types, TTS provider, SRT generator, generation hook, composition renderer, merge logic, and edit form UI.

**Tech Stack:** React, TypeScript, open-motion (interpolate, spring, Sequence, Audio, parseSrt), Zustand, Tauri, VOICEVOX TTS

---

### Task 1: Add NarrationSegment type and update Scene type

**Files:**
- Modify: `src/features/video/types.ts`

- [ ] **Step 1: Add NarrationSegment interface after TimingEntry**

In `src/features/video/types.ts`, add the new interface after line 65 (after the `TimingEntry` closing brace):

```typescript
export interface NarrationSegment {
  text: string;
  audioPath?: string;
  durationMs?: number;
}
```

- [ ] **Step 2: Add narrationSegments to Scene interface**

In the `Scene` interface, add the `narrationSegments` field after `narrationAudio`:

```typescript
export interface Scene {
  id: string;
  title?: string;
  durationInFrames?: number;
  narration: string;
  narrationAudio?: string;
  narrationSegments?: NarrationSegment[];
  narrationDirty?: boolean;
  transition: TransitionConfig;
  elements: SceneElement[];
  captions?: CaptionsConfig;
}
```

- [ ] **Step 3: Update DEFAULT_TRANSITION duration**

Change `DEFAULT_TRANSITION` to use the new default of 30 frames:

```typescript
export const DEFAULT_TRANSITION: TransitionConfig = {
  type: "fade",
  durationInFrames: 30,
};
```

- [ ] **Step 4: Verify TypeScript compiles**

Run: `npx tsc --noEmit --pretty 2>&1 | head -30`
Expected: Compilation errors in files that reference `narrationAudio` exclusively — these will be fixed in subsequent tasks.

- [ ] **Step 5: Commit**

```bash
git add src/features/video/types.ts
git commit -m "feat(video): add NarrationSegment type and increase default transition duration"
```

---

### Task 2: Update SRT generator to work with NarrationSegment[]

**Files:**
- Modify: `src/features/video/lib/srt-generator.ts`

- [ ] **Step 1: Add NarrationSegment import and new function**

Replace the entire file content with:

```typescript
import type { NarrationSegment, TimingEntry } from "../types";

/**
 * Formats a millisecond timestamp as SRT time: HH:MM:SS,mmm
 */
function formatSrtTime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const milliseconds = ms % 1000;
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);

  const hh = String(hours).padStart(2, "0");
  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");
  const mmm = String(milliseconds).padStart(3, "0");

  return `${hh}:${mm}:${ss},${mmm}`;
}

/**
 * Generate SRT from NarrationSegment[].
 * Each segment becomes one subtitle entry, timed by accumulating durationMs.
 */
export function generateSrtFromSegments(segments: NarrationSegment[]): string {
  const entries: string[] = [];
  let offsetMs = 0;

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (!seg.durationMs || seg.durationMs <= 0) continue;

    const start = formatSrtTime(offsetMs);
    const end = formatSrtTime(offsetMs + seg.durationMs);
    entries.push(`${entries.length + 1}\n${start} --> ${end}\n${seg.text}\n`);
    offsetMs += seg.durationMs;
  }

  return entries.join("\n");
}

/**
 * Legacy: Generates SRT from timing data or fallback text/duration.
 * Kept for backward compatibility with old projects that have no segments.
 */
export function generateSrt(
  timingData?: TimingEntry[],
  fallbackText?: string,
  fallbackDurationMs?: number,
): string {
  if (timingData && timingData.length > 0) {
    return timingData
      .map((entry, index) => {
        const start = formatSrtTime(entry.startMs);
        const end = formatSrtTime(entry.endMs);
        return `${index + 1}\n${start} --> ${end}\n${entry.text}\n`;
      })
      .join("\n");
  }

  if (fallbackText && fallbackDurationMs && fallbackDurationMs > 0) {
    const start = formatSrtTime(0);
    const end = formatSrtTime(fallbackDurationMs);
    return `1\n${start} --> ${end}\n${fallbackText}\n`;
  }

  return "";
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit --pretty 2>&1 | head -30`
Expected: No new errors from this file.

- [ ] **Step 3: Commit**

```bash
git add src/features/video/lib/srt-generator.ts
git commit -m "feat(video): add generateSrtFromSegments for per-segment subtitle generation"
```

---

### Task 3: Add narration splitting utility

**Files:**
- Create: `src/features/video/lib/narration-splitter.ts`

- [ ] **Step 1: Create the splitter module**

```typescript
/**
 * Split narration text into segments by Japanese period (。) and newlines.
 * Empty segments are filtered out.
 */
export function splitNarration(text: string): string[] {
  // First split by newlines
  const lines = text.split(/\n/);
  const segments: string[] = [];

  for (const line of lines) {
    // Then split each line by 。 (keep the 。 attached to the preceding text)
    const parts = line.split(/(?<=。)/);
    for (const part of parts) {
      const trimmed = part.trim();
      if (trimmed.length > 0) {
        segments.push(trimmed);
      }
    }
  }

  return segments;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/features/video/lib/narration-splitter.ts
git commit -m "feat(video): add narration text splitter for segment-based TTS"
```

---

### Task 4: Update useVideoGeneration hook for segment-based audio

**Files:**
- Modify: `src/features/video/hooks/useVideoGeneration.ts`

- [ ] **Step 1: Replace the entire hook file**

```typescript
import { useCallback, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useVideoStore } from "@/stores/video-store";
import { createTTSProvider } from "../lib/tts-provider";
import { generateSrtFromSegments } from "../lib/srt-generator";
import { generateNarrationForScene } from "../lib/narration-generator";
import { splitNarration } from "../lib/narration-splitter";
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

      for (let segIdx = 0; segIdx < texts.length; segIdx++) {
        const segNum = String(segIdx + 1).padStart(2, "0");
        const filename = `scene_${sceneNum}_${segNum}.wav`;

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
      const scenes = videoProject.scenes;
      const total = scenes.length;

      for (let i = 0; i < total; i++) {
        const scene = scenes[i];

        // Skip if segments exist with audio and not dirty
        if (scene.narrationSegments?.length && !scene.narrationDirty) {
          const allHaveAudio = scene.narrationSegments.every((s) => s.audioPath);
          if (allHaveAudio) {
            // Verify at least first file exists
            const firstPath = scene.narrationSegments[0].audioPath!;
            const exists = await invoke<boolean>("video_file_exists", { path: firstPath });
            if (exists) continue;
          }
        }

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
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit --pretty 2>&1 | head -30`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/features/video/hooks/useVideoGeneration.ts
git commit -m "feat(video): rewrite audio generation to produce per-segment WAV files"
```

---

### Task 5: Update scene-to-composition.tsx — resolution scaling, animations, segment audio

This is the largest task. It modifies fonts, layout, animations, subtle motion, segment audio playback, and captions.

**Files:**
- Modify: `src/features/video/lib/scene-to-composition.tsx`

- [ ] **Step 1: Replace the entire file**

```tsx
import React from "react";
import {
  Sequence,
  Audio,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
  parseSrt,
} from "@open-motion/core";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { VideoProject, Scene, SceneElement } from "../types";

/** Convert a local file path to a URL the webview can load. */
function toPlayableSrc(filePath: string): string {
  if (!filePath || filePath.startsWith("http") || filePath.startsWith("blob:") || filePath.startsWith("data:")) {
    return filePath;
  }
  try {
    return convertFileSrc(filePath);
  } catch {
    return filePath;
  }
}

// ─── Resolution-based scaling ────────────────────────────────────────────────

const BASE_WIDTH = 1920;
const BASE_HEIGHT = 1080;

function getScale(width: number, height: number): number {
  return Math.min(width / BASE_WIDTH, height / BASE_HEIGHT);
}

// Base sizes at 1920x1080
const BASE = {
  fontH1: 112,
  fontH2: 84,
  fontH3: 64,
  fontText: 48,
  fontTable: 40,
  fontCode: 36,
  fontCaption: 48,
  paddingV: 80,
  paddingH: 120,
  gap: 40,
  bulletMarginLeft: 48,
  lineHeightHeading: 1.2,
  lineHeightText: 1.6,
  lineHeightCaption: 1.4,
} as const;

function scaled(base: number, scale: number): number {
  return Math.round(base * scale);
}

// ─── Easing helpers ──────────────────────────────────────────────────────────

function outCubic(t: number): number {
  const t1 = t - 1;
  return t1 * t1 * t1 + 1;
}

function inOutCubic(t: number): number {
  return t < 0.5
    ? 4 * t * t * t
    : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

// ─── Animation constants ────────────────────────────────────────────────────

const ANIM = {
  fadeInDuration: 30,
  staggerDelay: 20,
  slideDistance: 60,
  bulletDelay: 20,
  tableRowDuration: 20,
  tableRowDelay: 15,
  // Subtle motion
  floatAmplitude: 3,
  floatPeriodFrames: 120, // 4 seconds at 30fps
  // Ken Burns
  kenBurnsScale: 1.05,
  kenBurnsPanX: 15,
} as const;

// ─── Public Exports ───────────────────────────────────────────────────────────

export function calculateTotalDuration(project: VideoProject): number {
  const scenes = project.scenes;
  if (scenes.length === 0) return 0;

  let total = scenes.reduce(
    (sum, scene) => sum + (scene.durationInFrames ?? 150),
    0
  );

  for (let i = 1; i < scenes.length; i++) {
    const prevTransition = scenes[i - 1].transition;
    total -= prevTransition?.durationInFrames ?? 0;
  }

  return Math.max(total, 0);
}

export function VideoComposition({
  project,
}: {
  project: VideoProject;
}): React.JSX.Element {
  const { bgm } = project.audio;

  const frameOffsets: number[] = [];
  let offset = 0;
  for (let i = 0; i < project.scenes.length; i++) {
    frameOffsets.push(offset);
    const scene = project.scenes[i];
    const duration = scene.durationInFrames ?? 150;
    const nextOverlap =
      i < project.scenes.length - 1
        ? (scene.transition?.durationInFrames ?? 0)
        : 0;
    offset += duration - nextOverlap;
  }

  const s = getScale(project.meta.width, project.meta.height);

  return (
    <div style={{ width: "100%", height: "100%", position: "relative" }}>
      {bgm && <Audio src={toPlayableSrc(bgm.src)} volume={bgm.volume} />}

      {project.scenes.map((scene, i) => {
        const duration = scene.durationInFrames ?? 150;
        return (
          <Sequence
            key={scene.id}
            from={frameOffsets[i]}
            durationInFrames={duration}
          >
            <SceneRenderer scene={scene} scale={s} />
            <SceneAudio scene={scene} ttsVolume={project.audio.tts?.volume ?? 1} fps={project.meta.fps} />
            {scene.captions?.enabled && scene.captions.srt && (
              <CaptionsOverlay srt={scene.captions.srt} scale={s} />
            )}
          </Sequence>
        );
      })}
    </div>
  );
}

// ─── SceneAudio ──────────────────────────────────────────────────────────────

function SceneAudio({
  scene,
  ttsVolume,
  fps,
}: {
  scene: Scene;
  ttsVolume: number;
  fps: number;
}): React.JSX.Element {
  // Segment-based audio: play each segment WAV sequentially
  if (scene.narrationSegments?.length) {
    let frameOffset = 0;
    return (
      <>
        {scene.narrationSegments.map((seg, i) => {
          if (!seg.audioPath) return null;
          const from = frameOffset;
          const segFrames = seg.durationMs
            ? Math.ceil((seg.durationMs / 1000) * fps)
            : 0;
          frameOffset += segFrames;
          return (
            <Sequence key={i} from={from} durationInFrames={segFrames || 9999}>
              <Audio src={toPlayableSrc(seg.audioPath)} volume={ttsVolume} />
            </Sequence>
          );
        })}
      </>
    );
  }

  // Legacy: single narrationAudio file
  if (scene.narrationAudio) {
    return <Audio src={toPlayableSrc(scene.narrationAudio)} volume={ttsVolume} />;
  }

  return <></>;
}

// ─── SceneRenderer (internal) ─────────────────────────────────────────────────

function SceneRenderer({ scene, scale: s }: { scene: Scene; scale: number }): React.JSX.Element {
  const frame = useCurrentFrame();
  const { transition, elements } = scene;
  const transitionFrames = transition?.durationInFrames ?? 30;
  const transitionType = transition?.type ?? "none";

  let opacity = 1;
  let transform = "none";

  switch (transitionType) {
    case "fade": {
      const raw = interpolate(frame, [0, transitionFrames], [0, 1], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
      });
      opacity = inOutCubic(raw);
      // Subtle scale for depth
      const scaleVal = interpolate(frame, [0, transitionFrames], [0.95, 1], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
      });
      transform = `scale(${scaleVal})`;
      break;
    }
    case "slide-left": {
      const raw = interpolate(frame, [0, transitionFrames], [0, 1], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
      });
      const tx = (1 - inOutCubic(raw)) * 100;
      opacity = inOutCubic(raw);
      transform = `translateX(${tx}%)`;
      break;
    }
    case "slide-right": {
      const raw = interpolate(frame, [0, transitionFrames], [0, 1], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
      });
      const tx = -(1 - inOutCubic(raw)) * 100;
      opacity = inOutCubic(raw);
      transform = `translateX(${tx}%)`;
      break;
    }
    case "slide-up": {
      const raw = interpolate(frame, [0, transitionFrames], [0, 1], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
      });
      const ty = (1 - inOutCubic(raw)) * 100;
      opacity = inOutCubic(raw);
      transform = `translateY(${ty}%)`;
      break;
    }
    case "none":
    default:
      break;
  }

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        backgroundColor: "#1a1a2e",
        color: "#ffffff",
        padding: `${scaled(BASE.paddingV, s)}px ${scaled(BASE.paddingH, s)}px`,
        fontFamily: '"Noto Sans JP", sans-serif',
        boxSizing: "border-box",
        display: "flex",
        flexDirection: "column",
        gap: `${scaled(BASE.gap, s)}px`,
        opacity,
        transform,
        overflow: "hidden",
        position: "absolute",
        inset: 0,
      }}
    >
      {elements.map((element, i) => (
        <ElementRenderer key={i} element={element} index={i} scale={s} />
      ))}
    </div>
  );
}

// ─── Subtle float motion helper ──────────────────────────────────────────────

function useSubtleFloat(frame: number, delay: number): number {
  const elapsed = Math.max(0, frame - delay - ANIM.fadeInDuration);
  if (elapsed <= 0) return 0;
  return Math.sin((elapsed / ANIM.floatPeriodFrames) * Math.PI * 2) * ANIM.floatAmplitude;
}

// ─── ElementRenderer (internal) ──────────────────────────────────────────────

function ElementRenderer({
  element,
  index,
  scale: s,
}: {
  element: SceneElement;
  index: number;
  scale: number;
}): React.JSX.Element {
  const frame = useCurrentFrame();
  const delay = index * ANIM.staggerDelay;

  switch (element.type) {
    case "title": {
      const baseFontSize =
        element.level === 1 ? BASE.fontH1 : element.level === 2 ? BASE.fontH2 : BASE.fontH3;

      const raw =
        element.animation === "none"
          ? 1
          : interpolate(frame, [delay, delay + ANIM.fadeInDuration], [0, 1], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
            });
      const opacity = element.animation === "none" ? 1 : outCubic(raw);

      const slideRaw =
        element.animation === "slide-in"
          ? interpolate(frame, [delay, delay + ANIM.fadeInDuration], [0, 1], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
            })
          : 1;
      const translateY =
        element.animation === "slide-in"
          ? (1 - outCubic(slideRaw)) * ANIM.slideDistance
          : 0;

      const floatY = useSubtleFloat(frame, delay);

      return (
        <div
          style={{
            fontSize: scaled(baseFontSize, s),
            fontWeight: "bold",
            lineHeight: BASE.lineHeightHeading,
            opacity,
            transform: `translateY(${translateY + floatY}px)`,
          }}
        >
          {element.text}
        </div>
      );
    }

    case "text": {
      const raw =
        element.animation === "none"
          ? 1
          : interpolate(frame, [delay, delay + ANIM.fadeInDuration], [0, 1], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
            });
      const opacity = element.animation === "none" ? 1 : outCubic(raw);
      const floatY = useSubtleFloat(frame, delay);

      return (
        <p
          style={{
            fontSize: scaled(BASE.fontText, s),
            lineHeight: BASE.lineHeightText,
            margin: 0,
            opacity,
            transform: `translateY(${floatY}px)`,
          }}
        >
          {element.content}
        </p>
      );
    }

    case "bullet-list": {
      return (
        <ul
          style={{
            fontSize: scaled(BASE.fontText, s),
            lineHeight: BASE.lineHeightText,
            paddingLeft: scaled(BASE.bulletMarginLeft, s),
            margin: 0,
          }}
        >
          {element.items.map((item, itemIndex) => {
            const itemDelay = delay + itemIndex * ANIM.bulletDelay;
            const raw =
              element.animation === "none"
                ? 1
                : interpolate(frame, [itemDelay, itemDelay + ANIM.fadeInDuration], [0, 1], {
                    extrapolateLeft: "clamp",
                    extrapolateRight: "clamp",
                  });
            const opacity = element.animation === "none" ? 1 : outCubic(raw);

            // Slide in from left for each bullet
            const slideRaw =
              element.animation === "none"
                ? 1
                : interpolate(frame, [itemDelay, itemDelay + ANIM.fadeInDuration], [0, 1], {
                    extrapolateLeft: "clamp",
                    extrapolateRight: "clamp",
                  });
            const translateX =
              element.animation === "none"
                ? 0
                : -(1 - outCubic(slideRaw)) * scaled(ANIM.slideDistance, s);

            return (
              <li
                key={itemIndex}
                style={{
                  opacity,
                  marginBottom: scaled(8, s),
                  transform: `translateX(${translateX}px)`,
                }}
              >
                {item}
              </li>
            );
          })}
        </ul>
      );
    }

    case "image": {
      const raw =
        element.animation === "none"
          ? 1
          : interpolate(frame, [delay, delay + ANIM.fadeInDuration], [0, 1], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
            });
      const opacity = element.animation === "none" ? 1 : outCubic(raw);

      // Ken Burns: slow zoom + pan over the entire scene duration
      const { durationInFrames } = useVideoConfig();
      const kenProgress = interpolate(frame, [0, durationInFrames], [0, 1], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
      });

      let imgScale = 1;
      let imgTranslateX = 0;

      if (element.animation === "zoom-in") {
        const zoomRaw = interpolate(frame, [delay, delay + ANIM.fadeInDuration], [0, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        });
        imgScale = 0.85 + outCubic(zoomRaw) * 0.15;
      } else if (element.animation === "ken-burns" || element.animation === "fade-in") {
        // Enhanced Ken Burns for all image animations (except none/zoom-in)
        imgScale = 1 + kenProgress * (ANIM.kenBurnsScale - 1);
        imgTranslateX = kenProgress * ANIM.kenBurnsPanX - ANIM.kenBurnsPanX / 2;
      }

      return (
        <img
          src={element.src}
          alt={element.alt ?? ""}
          style={{
            maxWidth: "80%",
            maxHeight: scaled(400, s),
            borderRadius: scaled(8, s),
            opacity,
            transform: `scale(${imgScale}) translateX(${imgTranslateX}px)`,
            display: "block",
            margin: element.position === "center" ? "0 auto" : undefined,
          }}
        />
      );
    }

    case "table": {
      return (
        <table
          style={{
            borderCollapse: "collapse",
            width: "100%",
            fontSize: scaled(BASE.fontTable, s),
          }}
        >
          <thead>
            <tr>
              {element.headers.map((header, hi) => (
                <th
                  key={hi}
                  style={{
                    backgroundColor: "#2d2d5e",
                    color: "#ffffff",
                    padding: `${scaled(10, s)}px ${scaled(16, s)}px`,
                    textAlign: "left",
                    border: "1px solid #444",
                  }}
                >
                  {header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {element.rows.map((row, rowIndex) => {
              const rowDelay = delay + rowIndex * ANIM.tableRowDelay;
              const raw =
                element.animation === "none"
                  ? 1
                  : interpolate(frame, [rowDelay, rowDelay + ANIM.tableRowDuration], [0, 1], {
                      extrapolateLeft: "clamp",
                      extrapolateRight: "clamp",
                    });
              const opacity = element.animation === "none" ? 1 : outCubic(raw);

              return (
                <tr key={rowIndex} style={{ opacity }}>
                  {row.map((cell, ci) => (
                    <td
                      key={ci}
                      style={{
                        padding: `${scaled(8, s)}px ${scaled(16, s)}px`,
                        border: "1px solid #333",
                        color: "#e0e0e0",
                      }}
                    >
                      {cell}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      );
    }

    case "code-block": {
      const raw =
        element.animation === "none"
          ? 1
          : interpolate(frame, [delay, delay + ANIM.fadeInDuration], [0, 1], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
            });
      const opacity = element.animation === "none" ? 1 : outCubic(raw);

      return (
        <pre
          style={{
            backgroundColor: "#0d1117",
            padding: `${scaled(20, s)}px ${scaled(24, s)}px`,
            borderRadius: scaled(8, s),
            overflow: "auto",
            opacity,
            margin: 0,
          }}
        >
          <code
            style={{
              fontFamily: '"Fira Code", "Cascadia Code", monospace',
              fontSize: scaled(BASE.fontCode, s),
              color: "#e6edf3",
              whiteSpace: "pre",
            }}
          >
            {element.code}
          </code>
        </pre>
      );
    }

    default: {
      return <></>;
    }
  }
}

// ─── CaptionsOverlay (internal) ──────────────────────────────────────────────

function CaptionsOverlay({ srt, scale: s }: { srt: string; scale: number }): React.JSX.Element | null {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const subtitles = React.useMemo(() => parseSrt(srt), [srt]);

  const currentTimeSeconds = frame / fps;

  const activeSubtitle = subtitles.find(
    (sub) =>
      currentTimeSeconds >= sub.startInSeconds &&
      currentTimeSeconds < sub.endInSeconds
  );

  if (!activeSubtitle) return null;

  return (
    <div
      style={{
        position: "absolute",
        bottom: scaled(48, s),
        left: "10%",
        width: "80%",
        backgroundColor: "rgba(0, 0, 0, 0.7)",
        color: "#ffffff",
        textAlign: "center",
        padding: `${scaled(12, s)}px ${scaled(20, s)}px`,
        borderRadius: scaled(6, s),
        fontSize: scaled(BASE.fontCaption, s),
        fontFamily: '"Noto Sans JP", sans-serif',
        lineHeight: BASE.lineHeightCaption,
        pointerEvents: "none",
      }}
    >
      {activeSubtitle.text}
    </div>
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit --pretty 2>&1 | head -30`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/features/video/lib/scene-to-composition.tsx
git commit -m "feat(video): resolution scaling, enhanced animations, segment audio playback"
```

---

### Task 6: Update merge-project.ts for narrationSegments

**Files:**
- Modify: `src/features/video/lib/merge-project.ts`

- [ ] **Step 1: Replace the file with segment-aware merge**

```typescript
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
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit --pretty 2>&1 | head -30`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/features/video/lib/merge-project.ts
git commit -m "feat(video): merge narrationSegments and migrate legacy narrationAudio"
```

---

### Task 7: Update video store for segment-aware audio check

**Files:**
- Modify: `src/stores/video-store.ts`

- [ ] **Step 1: Update setVideoProject to check narrationSegments**

In `src/stores/video-store.ts`, replace the `setVideoProject` function:

```typescript
  setVideoProject: (project, sourceFilePath) =>
    set((s) => {
      // If all scenes already have audio (segments or legacy) and none are dirty, mark as generated
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
      };
    }),
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit --pretty 2>&1 | head -30`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/stores/video-store.ts
git commit -m "feat(video): check narrationSegments in audio readiness detection"
```

---

### Task 8: Update SceneEditForm with segment preview

**Files:**
- Modify: `src/features/video/components/SceneEditForm.tsx`
- Modify: `src/shared/i18n/locales/ja/video.json`
- Modify: `src/shared/i18n/locales/en/video.json`

- [ ] **Step 1: Add segment preview to SceneEditForm**

Replace the entire `SceneEditForm.tsx`:

```tsx
import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useVideoStore } from "@/stores/video-store";
import { splitNarration } from "@/features/video/lib/narration-splitter";
import type { Scene, TransitionType } from "@/features/video/types";

const TRANSITION_OPTIONS: { value: TransitionType; labelKey: string }[] = [
  { value: "fade", labelKey: "fade" },
  { value: "slide-left", labelKey: "slideLeft" },
  { value: "slide-right", labelKey: "slideRight" },
  { value: "slide-up", labelKey: "slideUp" },
  { value: "none", labelKey: "none" },
];

interface SceneEditFormProps {
  scene: Scene;
  onRegenerateAudio: (sceneId: string) => Promise<void>;
  audioGenerating: boolean;
}

export function SceneEditForm({ scene, onRegenerateAudio, audioGenerating }: SceneEditFormProps) {
  const { t } = useTranslation("video");
  const updateScene = useVideoStore((s) => s.updateScene);
  const markNarrationDirty = useVideoStore((s) => s.markNarrationDirty);

  const handleNarrationChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      updateScene(scene.id, { narration: e.target.value });
      markNarrationDirty(scene.id);
    },
    [scene.id, updateScene, markNarrationDirty]
  );

  const handleRegenerateAudio = useCallback(async () => {
    await onRegenerateAudio(scene.id);
  }, [scene.id, onRegenerateAudio]);

  const handleToggleCaptions = useCallback(() => {
    updateScene(scene.id, {
      captions: {
        ...scene.captions,
        enabled: !(scene.captions?.enabled ?? false),
      },
    });
  }, [scene.id, scene.captions, updateScene]);

  const handleTransitionChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      updateScene(scene.id, {
        transition: {
          ...scene.transition,
          type: e.target.value as TransitionType,
        },
      });
    },
    [scene.id, scene.transition, updateScene]
  );

  const captionsEnabled = scene.captions?.enabled ?? false;

  // Preview segments from current narration text
  const previewSegments = useMemo(
    () => splitNarration(scene.narration),
    [scene.narration]
  );

  return (
    <div className="scene-edit-form">
      <div className="scene-edit-form__header">
        <span>{scene.title ?? t("sceneUntitled")}</span>
        {scene.narrationDirty && (
          <span className="scene-edit-form__dirty">{t("narrationDirty")}</span>
        )}
      </div>

      <div className="scene-edit-form__field">
        <div className="scene-edit-form__label-row">
          <label>{t("narration")}</label>
          <button
            className="scene-edit-form__btn scene-edit-form__btn--small"
            onClick={handleRegenerateAudio}
            disabled={audioGenerating}
            title={t("regenerateTtsAudio")}
          >
            ↻
          </button>
        </div>
        <textarea
          value={scene.narration}
          onChange={handleNarrationChange}
          rows={4}
          placeholder={t("narrationPlaceholder")}
        />
        {previewSegments.length > 0 && (
          <div className="scene-edit-form__segments">
            <label className="scene-edit-form__segments-label">
              {t("segmentPreview")} ({previewSegments.length})
            </label>
            <ol className="scene-edit-form__segments-list">
              {previewSegments.map((seg, i) => {
                const generated = scene.narrationSegments?.[i];
                const hasAudio = !!generated?.audioPath && generated.text === seg;
                return (
                  <li key={i} className="scene-edit-form__segment-item">
                    <span className={`scene-edit-form__segment-status${hasAudio ? " scene-edit-form__segment-status--ok" : ""}`}>
                      {hasAudio ? "●" : "○"}
                    </span>
                    <span className="scene-edit-form__segment-text">{seg}</span>
                  </li>
                );
              })}
            </ol>
          </div>
        )}
      </div>

      <div className="scene-edit-form__row">
        <label>{t("captions")}</label>
        <button
          className={`scene-edit-form__toggle${captionsEnabled ? " scene-edit-form__toggle--on" : ""}`}
          onClick={handleToggleCaptions}
        >
          {captionsEnabled ? t("captionsOn") : t("captionsOff")}
        </button>
      </div>

      <div className="scene-edit-form__row">
        <label>{t("transition")}</label>
        <select value={scene.transition.type} onChange={handleTransitionChange}>
          {TRANSITION_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {t(opt.labelKey)}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Add i18n keys for Japanese**

In `src/shared/i18n/locales/ja/video.json`, add these keys before the closing `}`:

```json
  "segmentPreview": "字幕セグメント"
```

- [ ] **Step 3: Add i18n keys for English**

In `src/shared/i18n/locales/en/video.json`, add these keys before the closing `}`:

```json
  "segmentPreview": "Caption segments"
```

- [ ] **Step 4: Verify TypeScript compiles**

Run: `npx tsc --noEmit --pretty 2>&1 | head -30`
Expected: No errors.

- [ ] **Step 5: Commit**

```bash
git add src/features/video/components/SceneEditForm.tsx src/shared/i18n/locales/ja/video.json src/shared/i18n/locales/en/video.json
git commit -m "feat(video): add segment preview with audio status to narration editor"
```

---

### Task 9: Update md-to-scenes default bullet delay

**Files:**
- Modify: `src/features/video/lib/md-to-scenes.ts`

- [ ] **Step 1: Change default delayPerItem from 30 to 20**

In `src/features/video/lib/md-to-scenes.ts`, find line 153 and change:

```typescript
          delayPerItem: 30,
```

to:

```typescript
          delayPerItem: 20,
```

- [ ] **Step 2: Commit**

```bash
git add src/features/video/lib/md-to-scenes.ts
git commit -m "feat(video): reduce bullet delay per item from 30 to 20 frames"
```

---

### Task 10: Final verification

- [ ] **Step 1: Full TypeScript compilation check**

Run: `npx tsc --noEmit --pretty`
Expected: No errors.

- [ ] **Step 2: Verify all changed files are committed**

Run: `git status`
Expected: Clean working tree.

- [ ] **Step 3: Review all commits in this branch**

Run: `git log --oneline -10`
Expected: All task commits visible.
