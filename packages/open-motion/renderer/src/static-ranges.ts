export interface SceneInfo {
  /** Global frame number where this scene starts */
  startFrame: number;
  /** Total frames in this scene */
  durationInFrames: number;
  /** Scene-local frame number after which content is static (includes +5 buffer) */
  lastAnimatedFrame: number;
  /** If true, entire scene is dynamic (animated background, ken-burns, captions) */
  isFullyDynamic: boolean;
}

/**
 * Compute the set of global frame numbers that can be skipped during rendering.
 * A skippable frame is visually identical to the frame before it.
 */
export function computeSkippableFrames(
  scenes: SceneInfo[],
  totalFrames: number
): Set<number> {
  const skippable = new Set<number>();

  for (const scene of scenes) {
    if (scene.isFullyDynamic) {
      continue;
    }

    const staticStart = scene.startFrame + scene.lastAnimatedFrame;
    const sceneEnd = scene.startFrame + scene.durationInFrames;

    for (
      let frame = staticStart;
      frame < sceneEnd && frame < totalFrames;
      frame++
    ) {
      skippable.add(frame);
    }
  }

  // Remove frames that overlap with the next scene's animated range.
  // Scenes can overlap due to transitions (Sequence overlap).
  for (let i = 0; i < scenes.length - 1; i++) {
    const currentEnd = scenes[i].startFrame + scenes[i].durationInFrames;
    const nextStart = scenes[i + 1].startFrame;

    if (currentEnd > nextStart) {
      // Overlap region: these frames show both scenes blending, so they are dynamic
      for (
        let frame = nextStart;
        frame < currentEnd && frame < totalFrames;
        frame++
      ) {
        skippable.delete(frame);
      }
    }
  }

  return skippable;
}

// Animation constants matching composition/constants.ts ANIM values
const ANIM_FADE_IN_DURATION = 30;
const ANIM_STAGGER_DELAY = 20;
const ANIM_TABLE_ROW_DURATION = 20;
const ANIM_TABLE_ROW_DELAY = 15;
const SAFETY_BUFFER = 5;

const DYNAMIC_BACKGROUNDS = new Set([
  "gradient-animation",
  "particles",
  "three-particles",
  "three-geometry",
  "wave-visualizer",
  "lottie",
]);

export interface SceneData {
  durationInFrames: number;
  transition: { type: string; durationInFrames: number };
  elements: Array<{
    type: string;
    animation: string;
    items?: string[];
    delayPerItem?: number;
    rows?: string[][];
    text?: string;
  }>;
  backgroundEffect: { type: string };
  captionsEnabled: boolean;
}

function computeElementEndFrame(
  element: SceneData["elements"][number],
  index: number
): number {
  if (element.animation === "none") {
    return 0;
  }

  const baseDelay = index * ANIM_STAGGER_DELAY;

  // Image fade-in and ken-burns are continuous — handled as fully dynamic at scene level
  if (element.type === "image" && (element.animation === "ken-burns" || element.animation === "fade-in")) {
    return Infinity;
  }

  switch (element.animation) {
    case "fade-in":
    case "slide-in":
    case "zoom-in":
      return baseDelay + ANIM_FADE_IN_DURATION;

    case "typewriter":
      return baseDelay + (element.text?.length ?? 0) * 3;

    case "sequential":
      return baseDelay + (element.items?.length ?? 0) * (element.delayPerItem ?? ANIM_STAGGER_DELAY) + ANIM_FADE_IN_DURATION;

    case "row-by-row":
      return baseDelay + (element.rows?.length ?? 0) * ANIM_TABLE_ROW_DELAY + ANIM_TABLE_ROW_DURATION;

    case "grow":
      return baseDelay + ANIM_FADE_IN_DURATION * 2;

    default:
      return baseDelay + ANIM_FADE_IN_DURATION;
  }
}

export function analyzeScenes(scenes: SceneData[], fps: number): SceneInfo[] {
  const result: SceneInfo[] = [];
  let frameOffset = 0;

  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];
    const duration = scene.durationInFrames;

    // Check if entire scene is fully dynamic
    const hasDynamicBackground = DYNAMIC_BACKGROUNDS.has(scene.backgroundEffect.type);
    const hasCaptions = scene.captionsEnabled;

    let hasFullyDynamicElement = false;
    let maxElementEnd = 0;

    for (let ei = 0; ei < scene.elements.length; ei++) {
      const endFrame = computeElementEndFrame(scene.elements[ei], ei);
      if (endFrame === Infinity) {
        hasFullyDynamicElement = true;
        break;
      }
      maxElementEnd = Math.max(maxElementEnd, endFrame);
    }

    const isFullyDynamic = hasDynamicBackground || hasCaptions || hasFullyDynamicElement;

    const transitionFrames =
      scene.transition.type !== "none" ? scene.transition.durationInFrames : 0;

    const lastAnimatedFrame = isFullyDynamic
      ? duration
      : Math.min(
          Math.max(transitionFrames, maxElementEnd) + SAFETY_BUFFER,
          duration
        );

    result.push({
      startFrame: frameOffset,
      durationInFrames: duration,
      lastAnimatedFrame,
      isFullyDynamic,
    });

    // Advance offset, subtracting transition overlap with next scene
    const transitionOverlap =
      i < scenes.length - 1 ? scene.transition.durationInFrames : 0;
    frameOffset += duration - transitionOverlap;
  }

  return result;
}
