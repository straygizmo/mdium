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
