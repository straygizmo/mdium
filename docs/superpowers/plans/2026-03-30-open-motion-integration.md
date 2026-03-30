# open-motionコンポーネント統合 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace custom animation code in scene-to-composition.tsx with open-motion components, add background effects/new elements, and integrate LLM-based automatic decoration.

**Architecture:** Decompose the monolithic `scene-to-composition.tsx` (618 lines) into a `composition/` directory with individual component files. Each element renderer, background effect, and caption overlay becomes its own file using `@open-motion/components`. A new `scene-decorator.ts` calls the LLM to auto-select visual settings.

**Tech Stack:** React, @open-motion/core, @open-motion/components (Transition, SlideInItem, Typewriter, ThreeCanvas, Lottie, WaveVisualizer, ProgressBar, TikTokCaption, Captions), Three.js, Tauri/Rust, Vitest

**Spec:** `docs/superpowers/specs/2026-03-30-open-motion-integration-design.md`

---

## Task 1: Extend type definitions

**Files:**
- Modify: `src/features/video/types.ts`
- Verify: `src/features/video/lib/__tests__/md-to-scenes.test.ts` (existing tests, not modified)

- [ ] **Step 1: Add BackgroundEffect, VideoTheme, LottiePreset, ProgressBarElement types and extend TransitionType, SceneElement, VideoProject, Scene**

In `src/features/video/types.ts`, add after the `CodeBlockElement` interface (before `SceneElement` union):

```typescript
// ─── Background Effects ──────────────────────────────────────────────────────

export type LottiePreset =
  | "confetti" | "checkmark" | "loading" | "arrows"
  | "sparkle" | "wave" | "pulse";

export type BackgroundEffect =
  | { type: "none" }
  | { type: "gradient"; colors: string[]; angle?: number }
  | { type: "gradient-animation"; colors: string[]; speed?: number }
  | { type: "particles"; preset: "stars" | "snow" | "fireflies" | "bubbles" }
  | { type: "wave-visualizer"; bars?: number; color?: string }
  | { type: "three-particles"; preset: "floating" | "galaxy" | "rain" }
  | { type: "three-geometry"; preset: "wireframe-sphere" | "rotating-cube" | "wave-mesh" }
  | { type: "lottie"; preset: LottiePreset };

export interface VideoTheme {
  backgroundEffect?: BackgroundEffect;
  captionStyle?: "default" | "tiktok";
}
```

Add the new element type:

```typescript
export interface ProgressBarElement {
  type: "progress-bar";
  progress: number;
  color?: string;
  label?: string;
  animation: "grow" | "none";
}
```

Update the `SceneElement` union:

```typescript
export type SceneElement =
  | TitleElement
  | TextElement
  | BulletListElement
  | ImageElement
  | TableElement
  | CodeBlockElement
  | ProgressBarElement;
```

Update `TransitionType`:

```typescript
export type TransitionType =
  | "fade"
  | "slide-left"
  | "slide-right"
  | "slide-up"
  | "wipe-left"
  | "wipe-right"
  | "wipe-up"
  | "wipe-down"
  | "none";
```

Add `theme` to `VideoProject`:

```typescript
export interface VideoProject {
  meta: VideoMeta;
  audio: AudioConfig;
  theme?: VideoTheme;
  scenes: Scene[];
}
```

Add `backgroundEffect` to `Scene`:

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
  backgroundEffect?: BackgroundEffect;
}
```

- [ ] **Step 2: Verify existing tests still pass**

Run: `npx vitest run src/features/video/lib/__tests__/md-to-scenes.test.ts`
Expected: All tests pass (type additions are backward compatible)

- [ ] **Step 3: Verify build succeeds**

Run: `npm run build`
Expected: Build succeeds with no type errors

- [ ] **Step 4: Commit**

```bash
git add src/features/video/types.ts
git commit -m "feat(video): add BackgroundEffect, VideoTheme, ProgressBarElement types and extend TransitionType"
```

---

## Task 2: Extract constants and helpers

**Files:**
- Create: `src/features/video/lib/composition/constants.ts`

- [ ] **Step 1: Create `composition/constants.ts`**

```typescript
// ─── Resolution-based scaling ────────────────────────────────────────────────

export const BASE_WIDTH = 1920;
export const BASE_HEIGHT = 1080;

export function getScale(width: number, height: number): number {
  return Math.min(width / BASE_WIDTH, height / BASE_HEIGHT);
}

// Base sizes at 1920x1080
export const BASE = {
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

export function scaled(base: number, scale: number): number {
  return Math.round(base * scale);
}

// ─── Animation constants ────────────────────────────────────────────────────

export const ANIM = {
  fadeInDuration: 30,
  staggerDelay: 20,
  slideDistance: 60,
  bulletDelay: 20,
  tableRowDuration: 20,
  tableRowDelay: 15,
  floatAmplitude: 3,
  floatPeriodFrames: 120,
  kenBurnsScale: 1.05,
  kenBurnsPanX: 15,
} as const;

// ─── Asset URL helper ────────────────────────────────────────────────────────

/** Convert a local file path to a URL the webview can load. */
export function toPlayableSrc(filePath: string): string {
  if (
    !filePath ||
    filePath.startsWith("http") ||
    filePath.startsWith("blob:") ||
    filePath.startsWith("data:")
  ) {
    return filePath;
  }
  try {
    const internals = (window as any).__TAURI_INTERNALS__;
    if (internals?.convertFileSrc) {
      return internals.convertFileSrc(filePath, "asset");
    }
  } catch {
    // not in Tauri environment
  }
  return filePath;
}
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: Build succeeds (new file, no existing references yet)

- [ ] **Step 3: Commit**

```bash
git add src/features/video/lib/composition/constants.ts
git commit -m "feat(video): extract composition constants and helpers"
```

---

## Task 3: Create element components using open-motion

**Files:**
- Create: `src/features/video/lib/composition/elements/TitleElement.tsx`
- Create: `src/features/video/lib/composition/elements/TextElement.tsx`
- Create: `src/features/video/lib/composition/elements/BulletListElement.tsx`
- Create: `src/features/video/lib/composition/elements/ImageElement.tsx`
- Create: `src/features/video/lib/composition/elements/TableElement.tsx`
- Create: `src/features/video/lib/composition/elements/CodeBlockElement.tsx`
- Create: `src/features/video/lib/composition/elements/ProgressBarElement.tsx`

- [ ] **Step 1: Create TitleElement.tsx**

Uses `SlideInItem` for slide-in animation, `Typewriter` for typewriter effect, and `Transition` for fade-in.

```tsx
import React from "react";
import { useCurrentFrame, interpolate } from "@open-motion/core";
import { Transition, SlideInItem, Typewriter } from "@open-motion/components";
import { BASE, ANIM, scaled } from "../constants";

export function TitleElement({
  element,
  index,
  scale: s,
}: {
  element: { text: string; level: 1 | 2 | 3; animation: string };
  index: number;
  scale: number;
}) {
  const baseFontSize =
    element.level === 1 ? BASE.fontH1 : element.level === 2 ? BASE.fontH2 : BASE.fontH3;
  const delay = index * ANIM.staggerDelay;

  const baseStyle: React.CSSProperties = {
    fontSize: scaled(baseFontSize, s),
    fontWeight: "bold",
    lineHeight: BASE.lineHeightHeading,
  };

  if (element.animation === "none") {
    return <div style={baseStyle}>{element.text}</div>;
  }

  if (element.animation === "typewriter") {
    return (
      <div style={baseStyle}>
        <Typewriter text={element.text} speed={2} delay={delay} />
      </div>
    );
  }

  if (element.animation === "slide-in") {
    return (
      <SlideInItem index={0} delay={delay} stagger={0} distance={ANIM.slideDistance} style={baseStyle}>
        {element.text}
      </SlideInItem>
    );
  }

  // Default: fade-in
  return (
    <Transition type="fade" style={baseStyle}>
      {element.text}
    </Transition>
  );
}
```

- [ ] **Step 2: Create TextElement.tsx**

```tsx
import React from "react";
import { Transition } from "@open-motion/components";
import { BASE, scaled } from "../constants";

export function TextElement({
  element,
  index,
  scale: s,
}: {
  element: { content: string; animation: string };
  index: number;
  scale: number;
}) {
  const style: React.CSSProperties = {
    fontSize: scaled(BASE.fontText, s),
    lineHeight: BASE.lineHeightText,
    margin: 0,
  };

  if (element.animation === "none") {
    return <p style={style}>{element.content}</p>;
  }

  return (
    <Transition type="fade" style={style}>
      <p style={{ margin: 0 }}>{element.content}</p>
    </Transition>
  );
}
```

- [ ] **Step 3: Create BulletListElement.tsx**

```tsx
import React from "react";
import { SlideInItem } from "@open-motion/components";
import { BASE, ANIM, scaled } from "../constants";

export function BulletListElement({
  element,
  index,
  scale: s,
}: {
  element: { items: string[]; animation: string; delayPerItem: number };
  index: number;
  scale: number;
}) {
  const delay = index * ANIM.staggerDelay;

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
        if (element.animation === "none") {
          return (
            <li key={itemIndex} style={{ marginBottom: scaled(8, s) }}>
              {item}
            </li>
          );
        }

        return (
          <SlideInItem
            key={itemIndex}
            index={itemIndex}
            delay={delay}
            stagger={element.delayPerItem}
            distance={scaled(ANIM.slideDistance, s)}
            style={{ marginBottom: scaled(8, s), listStyle: "disc" }}
          >
            {item}
          </SlideInItem>
        );
      })}
    </ul>
  );
}
```

- [ ] **Step 4: Create ImageElement.tsx**

```tsx
import React from "react";
import {
  useCurrentFrame,
  useVideoConfig,
  interpolate,
} from "@open-motion/core";
import { Transition } from "@open-motion/components";
import { ANIM, scaled } from "../constants";

export function ImageElement({
  element,
  index,
  scale: s,
}: {
  element: { src: string; alt?: string; position: string; animation: string };
  index: number;
  scale: number;
}) {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const delay = index * ANIM.staggerDelay;

  const kenProgress = interpolate(frame, [0, durationInFrames], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  let imgScale = 1;
  let imgTranslateX = 0;

  if (element.animation === "zoom-in") {
    const zoomRaw = interpolate(
      frame,
      [delay, delay + ANIM.fadeInDuration],
      [0, 1],
      { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
    );
    const t = zoomRaw; // spring-like is handled by Transition wrapper
    imgScale = 0.85 + t * 0.15;
  } else if (
    element.animation === "ken-burns" ||
    element.animation === "fade-in"
  ) {
    imgScale = 1 + kenProgress * (ANIM.kenBurnsScale - 1);
    imgTranslateX =
      kenProgress * ANIM.kenBurnsPanX - ANIM.kenBurnsPanX / 2;
  }

  const imgStyle: React.CSSProperties = {
    maxWidth: "80%",
    maxHeight: scaled(400, s),
    borderRadius: scaled(8, s),
    transform: `scale(${imgScale}) translateX(${imgTranslateX}px)`,
    display: "block",
    margin: element.position === "center" ? "0 auto" : undefined,
  };

  if (element.animation === "none") {
    return <img src={element.src} alt={element.alt ?? ""} style={imgStyle} />;
  }

  return (
    <Transition type="fade">
      <img src={element.src} alt={element.alt ?? ""} style={imgStyle} />
    </Transition>
  );
}
```

- [ ] **Step 5: Create TableElement.tsx**

```tsx
import React from "react";
import { SlideInItem } from "@open-motion/components";
import { Transition } from "@open-motion/components";
import { BASE, ANIM, scaled } from "../constants";

export function TableElement({
  element,
  index,
  scale: s,
}: {
  element: { headers: string[]; rows: string[][]; animation: string };
  index: number;
  scale: number;
}) {
  const delay = index * ANIM.staggerDelay;

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
          const rowContent = (
            <tr key={rowIndex}>
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

          if (element.animation === "none") {
            return rowContent;
          }

          return (
            <SlideInItem
              key={rowIndex}
              index={rowIndex}
              delay={delay}
              stagger={ANIM.tableRowDelay}
              distance={30}
            >
              {rowContent}
            </SlideInItem>
          );
        })}
      </tbody>
    </table>
  );
}
```

- [ ] **Step 6: Create CodeBlockElement.tsx**

```tsx
import React from "react";
import { Transition, Typewriter } from "@open-motion/components";
import { BASE, ANIM, scaled } from "../constants";

export function CodeBlockElement({
  element,
  index,
  scale: s,
}: {
  element: { code: string; language: string; animation: string };
  index: number;
  scale: number;
}) {
  const codeStyle: React.CSSProperties = {
    fontFamily: '"Fira Code", "Cascadia Code", monospace',
    fontSize: scaled(BASE.fontCode, s),
    color: "#e6edf3",
    whiteSpace: "pre",
  };

  const preStyle: React.CSSProperties = {
    backgroundColor: "#0d1117",
    padding: `${scaled(20, s)}px ${scaled(24, s)}px`,
    borderRadius: scaled(8, s),
    overflow: "auto",
    margin: 0,
  };

  if (element.animation === "none") {
    return (
      <pre style={preStyle}>
        <code style={codeStyle}>{element.code}</code>
      </pre>
    );
  }

  return (
    <Transition type="fade">
      <pre style={preStyle}>
        <code style={codeStyle}>{element.code}</code>
      </pre>
    </Transition>
  );
}
```

- [ ] **Step 7: Create ProgressBarElement.tsx**

```tsx
import React from "react";
import { useCurrentFrame, interpolate } from "@open-motion/core";
import { ProgressBar } from "@open-motion/components";
import { ANIM, scaled } from "../constants";

export function ProgressBarElement({
  element,
  index,
  scale: s,
}: {
  element: { progress: number; color?: string; label?: string; animation: string };
  index: number;
  scale: number;
}) {
  const frame = useCurrentFrame();
  const delay = index * ANIM.staggerDelay;

  let displayProgress = element.progress;

  if (element.animation === "grow") {
    const raw = interpolate(
      frame,
      [delay, delay + ANIM.fadeInDuration * 2],
      [0, 1],
      { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
    );
    displayProgress = element.progress * raw;
  }

  return (
    <div>
      {element.label && (
        <div style={{ fontSize: scaled(BASE.fontText * 0.75, s), marginBottom: scaled(8, s), color: "#e0e0e0" }}>
          {element.label}
        </div>
      )}
      <ProgressBar
        progress={displayProgress}
        color={element.color ?? "#3b82f6"}
        height={scaled(16, s)}
      />
    </div>
  );
}
```

- [ ] **Step 8: Verify build**

Run: `npm run build`
Expected: Build succeeds (new files, no existing references yet)

- [ ] **Step 9: Commit**

```bash
git add src/features/video/lib/composition/elements/
git commit -m "feat(video): add element components using open-motion (Transition, SlideInItem, Typewriter, ProgressBar)"
```

---

## Task 4: Create ElementRenderer dispatcher

**Files:**
- Create: `src/features/video/lib/composition/ElementRenderer.tsx`

- [ ] **Step 1: Create ElementRenderer.tsx**

```tsx
import React from "react";
import type { SceneElement } from "../../types";
import { TitleElement } from "./elements/TitleElement";
import { TextElement } from "./elements/TextElement";
import { BulletListElement } from "./elements/BulletListElement";
import { ImageElement } from "./elements/ImageElement";
import { TableElement } from "./elements/TableElement";
import { CodeBlockElement } from "./elements/CodeBlockElement";
import { ProgressBarElement } from "./elements/ProgressBarElement";

export function ElementRenderer({
  element,
  index,
  scale,
}: {
  element: SceneElement;
  index: number;
  scale: number;
}) {
  switch (element.type) {
    case "title":
      return <TitleElement element={element} index={index} scale={scale} />;
    case "text":
      return <TextElement element={element} index={index} scale={scale} />;
    case "bullet-list":
      return <BulletListElement element={element} index={index} scale={scale} />;
    case "image":
      return <ImageElement element={element} index={index} scale={scale} />;
    case "table":
      return <TableElement element={element} index={index} scale={scale} />;
    case "code-block":
      return <CodeBlockElement element={element} index={index} scale={scale} />;
    case "progress-bar":
      return <ProgressBarElement element={element} index={index} scale={scale} />;
    default:
      return <></>;
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/features/video/lib/composition/ElementRenderer.tsx
git commit -m "feat(video): add ElementRenderer dispatcher"
```

---

## Task 5: Extract SceneAudio and CaptionsOverlay

**Files:**
- Create: `src/features/video/lib/composition/SceneAudio.tsx`
- Create: `src/features/video/lib/composition/CaptionsOverlay.tsx`
- Create: `src/features/video/lib/composition/TikTokCaptionsOverlay.tsx`

- [ ] **Step 1: Create SceneAudio.tsx**

```tsx
import React from "react";
import { Sequence, Audio } from "@open-motion/core";
import type { Scene } from "../../types";
import { toPlayableSrc } from "./constants";

export function SceneAudio({
  scene,
  ttsVolume,
  fps,
}: {
  scene: Scene;
  ttsVolume: number;
  fps: number;
}) {
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

  if (scene.narrationAudio) {
    return <Audio src={toPlayableSrc(scene.narrationAudio)} volume={ttsVolume} />;
  }

  return <></>;
}
```

- [ ] **Step 2: Create CaptionsOverlay.tsx**

```tsx
import React from "react";
import { useCurrentFrame, useVideoConfig, parseSrt } from "@open-motion/core";
import { BASE, scaled } from "./constants";

export function CaptionsOverlay({
  srt,
  scale: s,
}: {
  srt: string;
  scale: number;
}) {
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
        zIndex: 30,
      }}
    >
      {activeSubtitle.text}
    </div>
  );
}
```

- [ ] **Step 3: Create TikTokCaptionsOverlay.tsx**

```tsx
import React from "react";
import { parseSrt } from "@open-motion/core";
import { Captions, TikTokCaption } from "@open-motion/components";
import { scaled } from "./constants";

export function TikTokCaptionsOverlay({
  srt,
  scale: s,
}: {
  srt: string;
  scale: number;
}) {
  const subtitles = React.useMemo(() => parseSrt(srt), [srt]);

  return (
    <div
      style={{
        position: "absolute",
        bottom: scaled(48, s),
        left: "10%",
        width: "80%",
        pointerEvents: "none",
        zIndex: 30,
        display: "flex",
        justifyContent: "center",
      }}
    >
      <Captions
        subtitles={subtitles}
        renderCaption={(text, active) => (
          <TikTokCaption
            text={text}
            active={active}
            style={{ fontSize: scaled(60, s) }}
          />
        )}
      />
    </div>
  );
}
```

- [ ] **Step 4: Commit**

```bash
git add src/features/video/lib/composition/SceneAudio.tsx src/features/video/lib/composition/CaptionsOverlay.tsx src/features/video/lib/composition/TikTokCaptionsOverlay.tsx
git commit -m "feat(video): extract SceneAudio, CaptionsOverlay, and add TikTokCaptionsOverlay"
```

---

## Task 6: Create background effect components (CSS-based)

**Files:**
- Create: `src/features/video/lib/composition/backgrounds/GradientBackground.tsx`
- Create: `src/features/video/lib/composition/backgrounds/GradientAnimationBackground.tsx`
- Create: `src/features/video/lib/composition/backgrounds/ParticlesBackground.tsx`

- [ ] **Step 1: Create GradientBackground.tsx**

```tsx
import React from "react";

export function GradientBackground({
  colors,
  angle = 135,
}: {
  colors: string[];
  angle?: number;
}) {
  const gradient = `linear-gradient(${angle}deg, ${colors.join(", ")})`;

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        background: gradient,
        zIndex: 10,
        pointerEvents: "none",
      }}
    />
  );
}
```

- [ ] **Step 2: Create GradientAnimationBackground.tsx**

```tsx
import React from "react";
import { useCurrentFrame } from "@open-motion/core";

export function GradientAnimationBackground({
  colors,
  speed = 0.5,
}: {
  colors: string[];
  speed?: number;
}) {
  const frame = useCurrentFrame();
  const angle = (frame * speed) % 360;
  const gradient = `linear-gradient(${angle}deg, ${colors.join(", ")})`;

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        background: gradient,
        zIndex: 10,
        pointerEvents: "none",
      }}
    />
  );
}
```

- [ ] **Step 3: Create ParticlesBackground.tsx**

CSS-based particle animation using deterministic positioning from frame number.

```tsx
import React, { useMemo } from "react";
import { useCurrentFrame, useVideoConfig } from "@open-motion/core";

const PRESETS = {
  stars: { count: 60, color: "#ffffff", sizeRange: [1, 3], speed: 0.2, opacity: 0.8 },
  snow: { count: 40, color: "#ffffff", sizeRange: [2, 6], speed: 0.8, opacity: 0.6 },
  fireflies: { count: 25, color: "#ffdd44", sizeRange: [2, 5], speed: 0.3, opacity: 0.7 },
  bubbles: { count: 20, color: "#88ccff", sizeRange: [4, 12], speed: 0.4, opacity: 0.3 },
} as const;

function seededRandom(seed: number): number {
  const x = Math.sin(seed * 9301 + 49297) * 233280;
  return x - Math.floor(x);
}

export function ParticlesBackground({
  preset,
}: {
  preset: keyof typeof PRESETS;
}) {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const config = PRESETS[preset];

  const particles = useMemo(() => {
    return Array.from({ length: config.count }, (_, i) => ({
      x: seededRandom(i * 7 + 1) * 100,
      y: seededRandom(i * 13 + 2) * 100,
      size: config.sizeRange[0] + seededRandom(i * 17 + 3) * (config.sizeRange[1] - config.sizeRange[0]),
      phase: seededRandom(i * 23 + 4) * Math.PI * 2,
      speedX: (seededRandom(i * 29 + 5) - 0.5) * 0.5,
      speedY: (seededRandom(i * 31 + 6) - 0.5) * 0.5,
    }));
  }, [config]);

  return (
    <div style={{ position: "absolute", inset: 0, zIndex: 10, pointerEvents: "none", overflow: "hidden" }}>
      {particles.map((p, i) => {
        const x = (p.x + frame * p.speedX * config.speed) % 100;
        const y = (p.y + frame * p.speedY * config.speed) % 100;
        const flickerOpacity = config.opacity * (0.6 + 0.4 * Math.sin(frame * 0.05 + p.phase));

        return (
          <div
            key={i}
            style={{
              position: "absolute",
              left: `${((x % 100) + 100) % 100}%`,
              top: `${((y % 100) + 100) % 100}%`,
              width: p.size,
              height: p.size,
              borderRadius: "50%",
              backgroundColor: config.color,
              opacity: flickerOpacity,
            }}
          />
        );
      })}
    </div>
  );
}
```

- [ ] **Step 4: Commit**

```bash
git add src/features/video/lib/composition/backgrounds/
git commit -m "feat(video): add CSS-based background effects (gradient, gradient-animation, particles)"
```

---

## Task 7: Create Three.js background effect components

**Files:**
- Create: `src/features/video/lib/composition/backgrounds/ThreeParticlesBackground.tsx`
- Create: `src/features/video/lib/composition/backgrounds/ThreeGeometryBackground.tsx`

- [ ] **Step 1: Create ThreeParticlesBackground.tsx**

```tsx
import React, { useCallback } from "react";
import { useVideoConfig } from "@open-motion/core";
import { ThreeCanvas } from "@open-motion/components";
import * as THREE from "three";

const PRESETS = {
  floating: { count: 200, speed: 0.3, size: 2, color: 0xffffff },
  galaxy: { count: 500, speed: 0.1, size: 1, color: 0x8888ff },
  rain: { count: 300, speed: 1.0, size: 1, color: 0xaaddff },
} as const;

export function ThreeParticlesBackground({
  preset,
}: {
  preset: keyof typeof PRESETS;
}) {
  const { width, height } = useVideoConfig();
  const config = PRESETS[preset];

  const init = useCallback(
    (scene: THREE.Scene, camera: THREE.Camera) => {
      (camera as THREE.PerspectiveCamera).position.z = 5;
      scene.background = null;

      const geometry = new THREE.BufferGeometry();
      const positions = new Float32Array(config.count * 3);
      for (let i = 0; i < config.count; i++) {
        positions[i * 3] = (Math.random() - 0.5) * 10;
        positions[i * 3 + 1] = (Math.random() - 0.5) * 10;
        positions[i * 3 + 2] = (Math.random() - 0.5) * 10;
      }
      geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));

      const material = new THREE.PointsMaterial({
        size: config.size * 0.02,
        color: config.color,
        transparent: true,
        opacity: 0.8,
      });

      const points = new THREE.Points(geometry, material);
      points.name = "particles";
      scene.add(points);
    },
    [config]
  );

  const renderScene = useCallback(
    (scene: THREE.Scene, _camera: THREE.Camera, frame: number) => {
      const points = scene.getObjectByName("particles") as THREE.Points;
      if (points) {
        points.rotation.y = frame * 0.002 * config.speed;
        points.rotation.x = frame * 0.001 * config.speed;
      }
    },
    [config]
  );

  return (
    <div style={{ position: "absolute", inset: 0, zIndex: 10, pointerEvents: "none" }}>
      <ThreeCanvas width={width} height={height} init={init} renderScene={renderScene} />
    </div>
  );
}
```

- [ ] **Step 2: Create ThreeGeometryBackground.tsx**

```tsx
import React, { useCallback } from "react";
import { useVideoConfig } from "@open-motion/core";
import { ThreeCanvas } from "@open-motion/components";
import * as THREE from "three";

export function ThreeGeometryBackground({
  preset,
}: {
  preset: "wireframe-sphere" | "rotating-cube" | "wave-mesh";
}) {
  const { width, height } = useVideoConfig();

  const init = useCallback(
    (scene: THREE.Scene, camera: THREE.Camera) => {
      (camera as THREE.PerspectiveCamera).position.z = 5;
      scene.background = null;

      const material = new THREE.MeshBasicMaterial({
        color: 0x4488ff,
        wireframe: true,
        transparent: true,
        opacity: 0.3,
      });

      let geometry: THREE.BufferGeometry;

      switch (preset) {
        case "wireframe-sphere":
          geometry = new THREE.SphereGeometry(2, 32, 32);
          break;
        case "rotating-cube":
          geometry = new THREE.BoxGeometry(2, 2, 2);
          break;
        case "wave-mesh":
        default:
          geometry = new THREE.PlaneGeometry(10, 10, 40, 40);
          break;
      }

      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = "geometry";
      scene.add(mesh);
    },
    [preset]
  );

  const renderScene = useCallback(
    (scene: THREE.Scene, _camera: THREE.Camera, frame: number) => {
      const mesh = scene.getObjectByName("geometry") as THREE.Mesh;
      if (!mesh) return;

      if (preset === "wave-mesh") {
        const positions = mesh.geometry.attributes.position;
        for (let i = 0; i < positions.count; i++) {
          const x = positions.getX(i);
          const y = positions.getY(i);
          const z = Math.sin(x * 0.5 + frame * 0.03) * Math.cos(y * 0.5 + frame * 0.02) * 0.5;
          positions.setZ(i, z);
        }
        positions.needsUpdate = true;
      } else {
        mesh.rotation.x = frame * 0.01;
        mesh.rotation.y = frame * 0.015;
      }
    },
    [preset]
  );

  return (
    <div style={{ position: "absolute", inset: 0, zIndex: 10, pointerEvents: "none" }}>
      <ThreeCanvas width={width} height={height} init={init} renderScene={renderScene} />
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add src/features/video/lib/composition/backgrounds/ThreeParticlesBackground.tsx src/features/video/lib/composition/backgrounds/ThreeGeometryBackground.tsx
git commit -m "feat(video): add Three.js background effects (particles, geometry)"
```

---

## Task 8: Create WaveVisualizer and Lottie backgrounds

**Files:**
- Create: `src/features/video/lib/composition/backgrounds/WaveVisualizerBackground.tsx`
- Create: `src/features/video/lib/composition/backgrounds/LottieBackground.tsx`

- [ ] **Step 1: Create WaveVisualizerBackground.tsx**

```tsx
import React from "react";
import { WaveVisualizer } from "@open-motion/components";
import { useVideoConfig } from "@open-motion/core";
import { scaled } from "../constants";

export function WaveVisualizerBackground({
  bars = 30,
  color = "#3b82f6",
}: {
  bars?: number;
  color?: string;
}) {
  const { height } = useVideoConfig();

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 10,
        pointerEvents: "none",
        display: "flex",
        alignItems: "flex-end",
        justifyContent: "center",
        opacity: 0.3,
        padding: "0 5%",
      }}
    >
      <WaveVisualizer bars={bars} color={color} height={Math.round(height * 0.4)} />
    </div>
  );
}
```

- [ ] **Step 2: Create LottieBackground.tsx**

```tsx
import React from "react";
import { Lottie } from "@open-motion/components";
import type { LottiePreset } from "../../types";

export function LottieBackground({ preset }: { preset: LottiePreset }) {
  // In export env: served from public/lottie/
  // In preview env: served from Tauri asset protocol
  const url = `/lottie/${preset}.json`;

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 10,
        pointerEvents: "none",
        opacity: 0.4,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Lottie url={url} style={{ width: "60%", height: "60%" }} />
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add src/features/video/lib/composition/backgrounds/WaveVisualizerBackground.tsx src/features/video/lib/composition/backgrounds/LottieBackground.tsx
git commit -m "feat(video): add WaveVisualizer and Lottie background effects"
```

---

## Task 9: Create BackgroundEffectRenderer dispatcher

**Files:**
- Create: `src/features/video/lib/composition/BackgroundEffectRenderer.tsx`

- [ ] **Step 1: Create BackgroundEffectRenderer.tsx**

```tsx
import React from "react";
import type { BackgroundEffect } from "../../types";
import { GradientBackground } from "./backgrounds/GradientBackground";
import { GradientAnimationBackground } from "./backgrounds/GradientAnimationBackground";
import { ParticlesBackground } from "./backgrounds/ParticlesBackground";
import { ThreeParticlesBackground } from "./backgrounds/ThreeParticlesBackground";
import { ThreeGeometryBackground } from "./backgrounds/ThreeGeometryBackground";
import { WaveVisualizerBackground } from "./backgrounds/WaveVisualizerBackground";
import { LottieBackground } from "./backgrounds/LottieBackground";

export function BackgroundEffectRenderer({
  effect,
}: {
  effect: BackgroundEffect;
}) {
  switch (effect.type) {
    case "gradient":
      return <GradientBackground colors={effect.colors} angle={effect.angle} />;
    case "gradient-animation":
      return <GradientAnimationBackground colors={effect.colors} speed={effect.speed} />;
    case "particles":
      return <ParticlesBackground preset={effect.preset} />;
    case "three-particles":
      return <ThreeParticlesBackground preset={effect.preset} />;
    case "three-geometry":
      return <ThreeGeometryBackground preset={effect.preset} />;
    case "wave-visualizer":
      return <WaveVisualizerBackground bars={effect.bars} color={effect.color} />;
    case "lottie":
      return <LottieBackground preset={effect.preset} />;
    case "none":
    default:
      return null;
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/features/video/lib/composition/BackgroundEffectRenderer.tsx
git commit -m "feat(video): add BackgroundEffectRenderer dispatcher"
```

---

## Task 10: Create SceneRenderer with Transition

**Files:**
- Create: `src/features/video/lib/composition/SceneRenderer.tsx`

- [ ] **Step 1: Create SceneRenderer.tsx**

Maps `TransitionType` to open-motion's `<Transition>` component. Renders layers: background → background effect → elements → captions.

```tsx
import React from "react";
import { Transition } from "@open-motion/components";
import type { Scene, VideoProject, BackgroundEffect, TransitionType } from "../../types";
import { BASE, scaled } from "./constants";
import { ElementRenderer } from "./ElementRenderer";
import { BackgroundEffectRenderer } from "./BackgroundEffectRenderer";
import { CaptionsOverlay } from "./CaptionsOverlay";
import { TikTokCaptionsOverlay } from "./TikTokCaptionsOverlay";

function mapTransition(t: TransitionType): {
  type: "fade" | "slide" | "wipe";
  direction: "left" | "right" | "top" | "bottom";
} | null {
  switch (t) {
    case "fade":
      return { type: "fade", direction: "left" };
    case "slide-left":
      return { type: "slide", direction: "left" };
    case "slide-right":
      return { type: "slide", direction: "right" };
    case "slide-up":
      return { type: "slide", direction: "top" };
    case "wipe-left":
      return { type: "wipe", direction: "left" };
    case "wipe-right":
      return { type: "wipe", direction: "right" };
    case "wipe-up":
      return { type: "wipe", direction: "top" };
    case "wipe-down":
      return { type: "wipe", direction: "bottom" };
    case "none":
    default:
      return null;
  }
}

export function SceneRenderer({
  scene,
  project,
  scale: s,
}: {
  scene: Scene;
  project: VideoProject;
  scale: number;
}) {
  const effect: BackgroundEffect =
    scene.backgroundEffect ?? project.theme?.backgroundEffect ?? { type: "none" };
  const captionStyle = project.theme?.captionStyle ?? "default";
  const transition = mapTransition(scene.transition?.type ?? "none");

  const content = (
    <div
      style={{
        width: "100%",
        height: "100%",
        backgroundColor: "#1a1a2e",
        color: "#ffffff",
        fontFamily: '"Noto Sans JP", sans-serif',
        boxSizing: "border-box",
        overflow: "hidden",
        position: "absolute",
        inset: 0,
      }}
    >
      {/* Background effect layer */}
      {effect.type !== "none" && <BackgroundEffectRenderer effect={effect} />}

      {/* Elements layer */}
      <div
        style={{
          position: "relative",
          zIndex: 20,
          width: "100%",
          height: "100%",
          padding: `${scaled(BASE.paddingV, s)}px ${scaled(BASE.paddingH, s)}px`,
          boxSizing: "border-box",
          display: "flex",
          flexDirection: "column",
          gap: `${scaled(BASE.gap, s)}px`,
        }}
      >
        {scene.elements.map((element, i) => (
          <ElementRenderer key={i} element={element} index={i} scale={s} />
        ))}
      </div>

      {/* Captions layer */}
      {scene.captions?.enabled && scene.captions.srt && (
        captionStyle === "tiktok" ? (
          <TikTokCaptionsOverlay srt={scene.captions.srt} scale={s} />
        ) : (
          <CaptionsOverlay srt={scene.captions.srt} scale={s} />
        )
      )}
    </div>
  );

  if (!transition) {
    return content;
  }

  return (
    <Transition
      type={transition.type}
      direction={transition.direction}
      durationInFrames={scene.transition?.durationInFrames ?? 30}
      style={{ position: "absolute", inset: 0 }}
    >
      {content}
    </Transition>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/features/video/lib/composition/SceneRenderer.tsx
git commit -m "feat(video): add SceneRenderer with open-motion Transition"
```

---

## Task 11: Create VideoComposition entry point and update imports

**Files:**
- Create: `src/features/video/lib/composition/index.tsx`
- Modify: `src/features/video/components/VideoPanel.tsx`

- [ ] **Step 1: Create composition/index.tsx**

```tsx
import React from "react";
import { Sequence, Audio } from "@open-motion/core";
import type { VideoProject } from "../../types";
import { getScale, toPlayableSrc } from "./constants";
import { SceneRenderer } from "./SceneRenderer";
import { SceneAudio } from "./SceneAudio";

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
}) {
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
            <SceneRenderer scene={scene} project={project} scale={s} />
            <SceneAudio
              scene={scene}
              ttsVolume={project.audio.tts?.volume ?? 1}
              fps={project.meta.fps}
            />
          </Sequence>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 2: Update VideoPanel.tsx import**

In `src/features/video/components/VideoPanel.tsx`, change the import:

```typescript
// Before:
import { VideoComposition, calculateTotalDuration } from "../lib/scene-to-composition";

// After:
import { VideoComposition, calculateTotalDuration } from "../lib/composition";
```

- [ ] **Step 3: Delete the old file**

Remove `src/features/video/lib/scene-to-composition.tsx` — its functionality is now split across the `composition/` directory.

- [ ] **Step 4: Verify build**

Run: `npm run build`
Expected: Build succeeds

- [ ] **Step 5: Verify existing tests still pass**

Run: `npx vitest run src/features/video/lib/__tests__/`
Expected: All tests pass

- [ ] **Step 6: Commit**

```bash
git add src/features/video/lib/composition/index.tsx src/features/video/components/VideoPanel.tsx
git rm src/features/video/lib/scene-to-composition.tsx
git commit -m "feat(video): replace scene-to-composition.tsx with composition/ directory using open-motion components"
```

---

## Task 12: Update export pipeline

**Files:**
- Modify: `src-tauri/src/commands/video.rs`
- Modify: `resources/video-env/template/src/main.tsx`
- Modify: `resources/video-env/package.json`

- [ ] **Step 1: Update main.tsx template to import from composition/**

In `resources/video-env/template/src/main.tsx`, change line 4:

```typescript
// Before:
import { VideoComposition, calculateTotalDuration } from "./scene-to-composition";

// After:
import { VideoComposition, calculateTotalDuration } from "./composition";
```

- [ ] **Step 2: Add `three` dependency to video-env/package.json**

In `resources/video-env/package.json`, add `three` to dependencies:

```json
{
  "name": "mdium-video-env",
  "private": true,
  "dependencies": {
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "vite": "^7.0.0",
    "@vitejs/plugin-react": "^4.0.0",
    "playwright": "^1.50.0",
    "fluent-ffmpeg": "^2.1.3",
    "tsx": "^4.0.0",
    "three": "^0.150.0"
  }
}
```

- [ ] **Step 3: Update video.rs to copy composition/ directory instead of single file**

In `src-tauri/src/commands/video.rs`, replace the section that copies `scene-to-composition.tsx` (lines 269-283) with code that copies the entire `composition/` directory and types:

```rust
    // Copy composition/ directory and types.ts into temp src/
    let src_dir = temp_dir.join("src");
    fs::create_dir_all(&src_dir)
        .map_err(|e| format!("Failed to create src dir: {}", e))?;

    let composition_dir = video_feature_dir.join("lib").join("composition");
    if composition_dir.exists() {
        copy_dir_recursive(&composition_dir, &src_dir.join("composition"))?;
    }
    let types_src = video_feature_dir.join("types.ts");
    if types_src.exists() {
        fs::copy(&types_src, src_dir.join("types.ts"))
            .map_err(|e| format!("Failed to copy types.ts: {}", e))?;
    }
```

Also add Lottie asset copying after the `copy_dir_recursive` for open-motion (around line 267):

```rust
    // Copy Lottie presets into public/lottie/ for Vite to serve
    let lottie_src = resource_dir.join("lottie-presets");
    if lottie_src.exists() {
        let lottie_dest = temp_dir.join("public").join("lottie");
        fs::create_dir_all(&lottie_dest)
            .map_err(|e| format!("Failed to create lottie dir: {}", e))?;
        copy_dir_recursive(&lottie_src, &lottie_dest)?;
    }
```

- [ ] **Step 4: Verify Rust build**

Run: `cd src-tauri && cargo check`
Expected: Build succeeds

- [ ] **Step 5: Commit**

```bash
git add resources/video-env/template/src/main.tsx resources/video-env/package.json src-tauri/src/commands/video.rs
git commit -m "feat(video): update export pipeline for composition/ directory, add three dependency and Lottie asset copy"
```

---

## Task 13: Add Lottie preset assets

**Files:**
- Create: `resources/lottie-presets/confetti.json`
- Create: `resources/lottie-presets/checkmark.json`
- Create: `resources/lottie-presets/loading.json`
- Create: `resources/lottie-presets/arrows.json`
- Create: `resources/lottie-presets/sparkle.json`
- Create: `resources/lottie-presets/wave.json`
- Create: `resources/lottie-presets/pulse.json`

- [ ] **Step 1: Create minimal Lottie JSON presets**

Each Lottie preset is a self-contained JSON animation file. Create minimal but visually effective animations. Below is the structure for each — the actual animation data should use the standard Lottie/Bodymovin format (Adobe After Effects export).

For each preset, create a Lottie JSON file in `resources/lottie-presets/`. Use a minimal Lottie structure with shape layers. Example structure for `confetti.json`:

```json
{
  "v": "5.7.0",
  "fr": 30,
  "ip": 0,
  "op": 90,
  "w": 400,
  "h": 400,
  "nm": "confetti",
  "layers": [
    {
      "ty": 4,
      "nm": "confetti-piece",
      "ip": 0,
      "op": 90,
      "st": 0,
      "shapes": [
        {
          "ty": "rc",
          "d": 1,
          "s": { "a": 0, "k": [8, 8] },
          "p": { "a": 1, "k": [
            { "t": 0, "s": [200, 50], "e": [200, 350] },
            { "t": 90, "s": [200, 350] }
          ]},
          "r": { "a": 1, "k": [
            { "t": 0, "s": [0], "e": [720] },
            { "t": 90, "s": [720] }
          ]}
        },
        {
          "ty": "fl",
          "c": { "a": 0, "k": [1, 0.3, 0.3, 1] },
          "o": { "a": 0, "k": 100 }
        }
      ]
    }
  ]
}
```

Create similar files for: `checkmark.json`, `loading.json`, `arrows.json`, `sparkle.json`, `wave.json`, `pulse.json`. Each should be a self-contained Lottie animation (30fps, 90 frames, 400x400).

Note: For production quality, consider downloading open-source Lottie files from LottieFiles (MIT-licensed) or creating them with tools. The minimal placeholder JSONs above ensure the pipeline works end-to-end.

- [ ] **Step 2: Commit**

```bash
git add resources/lottie-presets/
git commit -m "feat(video): add Lottie preset animation assets"
```

---

## Task 14: Create scene-decorator.ts (LLM integration)

**Files:**
- Create: `src/features/video/lib/scene-decorator.ts`

- [ ] **Step 1: Create scene-decorator.ts**

```typescript
import { invoke } from "@tauri-apps/api/core";
import type {
  VideoProject,
  Scene,
  SceneElement,
  BackgroundEffect,
  VideoTheme,
} from "../types";

const SYSTEM_PROMPT = `あなたは動画シーンのビジュアルデザイナーです。
各シーンの内容を分析し、適切な背景エフェクトとアニメーション設定をJSON形式で返してください。

利用可能な背景エフェクト:
- gradient: グラデーション背景 (colors: string[], angle?: number)
- gradient-animation: アニメーション付きグラデーション (colors: string[], speed?: number)
- particles: パーティクル (preset: "stars"|"snow"|"fireflies"|"bubbles")
- wave-visualizer: 波形 (bars?: number, color?: string)
- three-particles: 3Dパーティクル (preset: "floating"|"galaxy"|"rain")
- three-geometry: 3Dジオメトリ (preset: "wireframe-sphere"|"rotating-cube"|"wave-mesh")
- lottie: Lottieアニメーション (preset: "confetti"|"checkmark"|"loading"|"arrows"|"sparkle"|"wave"|"pulse")
- none: エフェクトなし

利用可能なエレメントアニメーション:
- title: "fade-in"|"slide-in"|"typewriter"|"none"
- text: "fade-in"|"none"
- bullet-list: "sequential"|"fade-in"|"none"
- image: "fade-in"|"zoom-in"|"ken-burns"|"none"
- table: "fade-in"|"row-by-row"|"none"
- code-block: "fade-in"|"none"

利用可能な字幕スタイル:
- "default": 通常字幕
- "tiktok": 単語ハイライト付きアニメーション字幕

ガイドライン:
- 技術的な内容 → gradient(青系) + particles(stars)
- 導入・まとめ → gradient-animation + lottie(sparkle)
- データ・数値系 → three-geometry(wave-mesh)
- コード解説 → gradient(暗い色) + none
- 全体トーンに合わせてプロジェクトテーマも提案
- 背景エフェクトはコンテンツの邪魔にならないものを選ぶ
- 同じエフェクトを連続で使わず、シーンごとに変化をつける

JSON形式のみを返してください（説明や注釈は不要）。`;

interface SceneSummary {
  id: string;
  title: string | undefined;
  elementSummary: string;
  hasNarration: boolean;
}

interface DecorationResult {
  theme: {
    backgroundEffect: BackgroundEffect;
    captionStyle: "default" | "tiktok";
  };
  scenes: Record<
    string,
    {
      backgroundEffect?: BackgroundEffect;
      elementAnimations?: Record<string, { animation: string }>;
    }
  >;
}

function buildElementSummary(elements: SceneElement[]): string {
  return elements
    .map((el) => {
      switch (el.type) {
        case "title":
          return `[見出し${el.level}] ${el.text}`;
        case "text":
          return `[テキスト] ${el.content.slice(0, 50)}`;
        case "bullet-list":
          return `[箇条書き] ${el.items.length}項目`;
        case "image":
          return `[画像] ${el.alt ?? ""}`;
        case "table":
          return `[表] ${el.headers.join(", ")}`;
        case "code-block":
          return `[コード: ${el.language}]`;
        case "progress-bar":
          return `[プログレスバー] ${Math.round(el.progress * 100)}%`;
        default:
          return "";
      }
    })
    .filter(Boolean)
    .join(", ");
}

function buildUserMessage(project: VideoProject): string {
  const summaries: SceneSummary[] = project.scenes.map((scene) => ({
    id: scene.id,
    title: scene.title,
    elementSummary: buildElementSummary(scene.elements),
    hasNarration: !!scene.narration?.trim(),
  }));

  return JSON.stringify(
    {
      projectTitle: project.meta.title,
      sceneCount: project.scenes.length,
      scenes: summaries,
    },
    null,
    2
  );
}

function applyResult(project: VideoProject, result: DecorationResult): VideoProject {
  const updatedProject = { ...project };

  // Apply theme
  updatedProject.theme = {
    backgroundEffect: result.theme.backgroundEffect,
    captionStyle: result.theme.captionStyle,
  };

  // Apply per-scene decorations
  updatedProject.scenes = project.scenes.map((scene) => {
    const sceneDecor = result.scenes[scene.id];
    if (!sceneDecor) return scene;

    const updatedScene = { ...scene };

    if (sceneDecor.backgroundEffect) {
      updatedScene.backgroundEffect = sceneDecor.backgroundEffect;
    }

    if (sceneDecor.elementAnimations) {
      updatedScene.elements = scene.elements.map((el, i) => {
        const anim = sceneDecor.elementAnimations?.[String(i)];
        if (!anim) return el;
        return { ...el, animation: anim.animation } as typeof el;
      });
    }

    return updatedScene;
  });

  return updatedProject;
}

export async function decorateWithLLM(project: VideoProject): Promise<VideoProject> {
  const userMessage = buildUserMessage(project);

  try {
    const response = await invoke<string>("ai_chat", {
      systemPrompt: SYSTEM_PROMPT,
      userMessage,
    });

    // Extract JSON from response (handle possible markdown code fences)
    let jsonStr = response.trim();
    const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) {
      jsonStr = fenceMatch[1].trim();
    }

    const result: DecorationResult = JSON.parse(jsonStr);
    return applyResult(project, result);
  } catch (e) {
    console.error("scene-decorator LLM call failed:", e);
    // Fallback: return project unchanged
    return project;
  }
}
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: Build succeeds

- [ ] **Step 3: Commit**

```bash
git add src/features/video/lib/scene-decorator.ts
git commit -m "feat(video): add scene-decorator for LLM-based automatic visual decoration"
```

---

## Task 15: Update UI — SceneEditForm

**Files:**
- Modify: `src/features/video/components/SceneEditForm.tsx`

- [ ] **Step 1: Read the current SceneEditForm.tsx to get the exact current code**

Read `src/features/video/components/SceneEditForm.tsx` before modifying.

- [ ] **Step 2: Add background effect selector and caption style selector**

Add a new section to SceneEditForm after the transition selector. Import the necessary types:

```typescript
import type { BackgroundEffect, TransitionType } from "../types";
```

Add a background effect type dropdown:

```tsx
{/* Background Effect */}
<div style={{ marginBottom: 12 }}>
  <label style={{ display: "block", fontWeight: 600, fontSize: 13, marginBottom: 4, color: "var(--foreground)" }}>
    背景エフェクト
  </label>
  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
    <label style={{ fontSize: 12, color: "var(--foreground-muted)" }}>
      <input
        type="checkbox"
        checked={!scene.backgroundEffect}
        onChange={(e) => {
          if (e.target.checked) {
            updateScene(scene.id, { backgroundEffect: undefined });
          } else {
            updateScene(scene.id, { backgroundEffect: { type: "none" } });
          }
        }}
      />
      プロジェクトデフォルト
    </label>
  </div>
  {scene.backgroundEffect && (
    <select
      value={scene.backgroundEffect.type}
      onChange={(e) => {
        const type = e.target.value;
        let effect: BackgroundEffect;
        switch (type) {
          case "gradient":
            effect = { type: "gradient", colors: ["#1a1a2e", "#16213e"] };
            break;
          case "gradient-animation":
            effect = { type: "gradient-animation", colors: ["#1a1a2e", "#0f3460", "#533483"] };
            break;
          case "particles":
            effect = { type: "particles", preset: "stars" };
            break;
          case "wave-visualizer":
            effect = { type: "wave-visualizer" };
            break;
          case "three-particles":
            effect = { type: "three-particles", preset: "floating" };
            break;
          case "three-geometry":
            effect = { type: "three-geometry", preset: "wireframe-sphere" };
            break;
          case "lottie":
            effect = { type: "lottie", preset: "sparkle" };
            break;
          default:
            effect = { type: "none" };
        }
        updateScene(scene.id, { backgroundEffect: effect });
      }}
      style={{
        width: "100%",
        padding: "4px 8px",
        borderRadius: 4,
        border: "1px solid var(--border)",
        background: "var(--background)",
        color: "var(--foreground)",
        fontSize: 13,
        marginTop: 4,
      }}
    >
      <option value="none">なし</option>
      <option value="gradient">グラデーション</option>
      <option value="gradient-animation">アニメーショングラデーション</option>
      <option value="particles">パーティクル</option>
      <option value="wave-visualizer">波形ビジュアライザー</option>
      <option value="three-particles">3Dパーティクル</option>
      <option value="three-geometry">3Dジオメトリ</option>
      <option value="lottie">Lottieアニメーション</option>
    </select>
  )}
</div>
```

Also add the new wipe transition options to the existing transition type dropdown — add these options inside the `<select>` for transition type:

```html
<option value="wipe-left">Wipe Left</option>
<option value="wipe-right">Wipe Right</option>
<option value="wipe-up">Wipe Up</option>
<option value="wipe-down">Wipe Down</option>
```

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: Build succeeds

- [ ] **Step 4: Commit**

```bash
git add src/features/video/components/SceneEditForm.tsx
git commit -m "feat(video): add background effect and wipe transition selectors to SceneEditForm"
```

---

## Task 16: Update UI — VideoSettingsBar with LLM decoration button

**Files:**
- Modify: `src/features/video/components/VideoSettingsBar.tsx`
- Modify: `src/features/video/components/VideoPanel.tsx`

- [ ] **Step 1: Read current VideoSettingsBar.tsx**

Read `src/features/video/components/VideoSettingsBar.tsx` before modifying.

- [ ] **Step 2: Add theme defaults and LLM auto-decoration button**

Add a new prop to `VideoSettingsBarProps`:

```typescript
interface VideoSettingsBarProps {
  onGenerateAudio: () => void;
  onDecorateWithLLM: () => void;   // NEW
  generating: boolean;
  generatingStatus: string;
  decorating: boolean;             // NEW
}
```

Add a button in the settings bar (after the generate audio section):

```tsx
{/* LLM Decoration */}
<div style={{ display: "flex", alignItems: "center", gap: 8 }}>
  <button
    onClick={onDecorateWithLLM}
    disabled={decorating || generating}
    style={{
      padding: "4px 12px",
      borderRadius: 4,
      border: "1px solid var(--border)",
      background: decorating ? "var(--background-muted)" : "var(--accent)",
      color: decorating ? "var(--foreground-muted)" : "var(--accent-foreground)",
      cursor: decorating ? "not-allowed" : "pointer",
      fontSize: 13,
    }}
  >
    {decorating ? "設定中..." : "LLMで自動設定"}
  </button>
</div>
```

- [ ] **Step 3: Wire up decoration in VideoPanel.tsx**

Read `src/features/video/components/VideoPanel.tsx` and add the decorator integration:

Import `decorateWithLLM`:

```typescript
import { decorateWithLLM } from "../lib/scene-decorator";
```

Add state and handler:

```typescript
const [decorating, setDecorating] = useState(false);

const handleDecorate = useCallback(async () => {
  if (!videoProject) return;
  setDecorating(true);
  try {
    const decorated = await decorateWithLLM(videoProject);
    // Update the store with decorated project
    setVideoProject(decorated);
  } catch (e) {
    console.error("Decoration failed:", e);
  } finally {
    setDecorating(false);
  }
}, [videoProject]);
```

Pass to `VideoSettingsBar`:

```tsx
<VideoSettingsBar
  onGenerateAudio={handleGenerateAudio}
  onDecorateWithLLM={handleDecorate}
  generating={generating}
  generatingStatus={generatingStatus}
  decorating={decorating}
/>
```

Note: The `setVideoProject` function must be available from the Zustand store. Check the store and add it if missing.

- [ ] **Step 4: Verify build**

Run: `npm run build`
Expected: Build succeeds

- [ ] **Step 5: Commit**

```bash
git add src/features/video/components/VideoSettingsBar.tsx src/features/video/components/VideoPanel.tsx
git commit -m "feat(video): add LLM auto-decoration button to VideoSettingsBar"
```

---

## Task 17: Integration verification

- [ ] **Step 1: Verify full build**

Run: `npm run build`
Expected: Build succeeds with no type errors

- [ ] **Step 2: Run all existing tests**

Run: `npx vitest run`
Expected: All tests pass

- [ ] **Step 3: Manual smoke test checklist**

Launch the app and verify:
1. Open a markdown file with the video feature
2. Scenes render correctly in the Player preview
3. Transition effects (fade, slide) work in preview
4. Click "LLMで自動設定" — background effects appear
5. Change background effect per-scene via SceneEditForm dropdown
6. TikTok caption style renders when selected
7. Export a short test video — verify output plays correctly

- [ ] **Step 4: Fix any issues found during smoke testing**

Address any rendering, import, or runtime errors.

- [ ] **Step 5: Final commit if any fixes were made**

```bash
git add -u
git commit -m "fix(video): integration fixes for open-motion component migration"
```
