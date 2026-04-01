import { describe, it, expect } from "vitest";
import { computeSkippableFrames, type SceneInfo } from "./static-ranges";

describe("computeSkippableFrames", () => {
  it("marks frames after lastAnimatedFrame as skippable", () => {
    const scenes: SceneInfo[] = [
      {
        startFrame: 0,
        durationInFrames: 100,
        lastAnimatedFrame: 30,
        isFullyDynamic: false,
      },
    ];
    const result = computeSkippableFrames(scenes, 100);
    // Frames 0-29: animated (not skippable)
    for (let i = 0; i < 30; i++) {
      expect(result.has(i), `frame ${i} should NOT be skippable`).toBe(false);
    }
    // Frames 30-99: static (skippable)
    for (let i = 30; i < 100; i++) {
      expect(result.has(i), `frame ${i} should be skippable`).toBe(true);
    }
  });

  it("does not skip any frames for fully dynamic scenes", () => {
    const scenes: SceneInfo[] = [
      {
        startFrame: 0,
        durationInFrames: 100,
        lastAnimatedFrame: 0,
        isFullyDynamic: true,
      },
    ];
    const result = computeSkippableFrames(scenes, 100);
    expect(result.size).toBe(0);
  });

  it("removes skippable frames in overlap region between scenes", () => {
    // Scene 0: frames 0-99, static after frame 30
    // Scene 1: starts at frame 80 (20-frame overlap), fully animated transition
    const scenes: SceneInfo[] = [
      {
        startFrame: 0,
        durationInFrames: 100,
        lastAnimatedFrame: 30,
        isFullyDynamic: false,
      },
      {
        startFrame: 80,
        durationInFrames: 100,
        lastAnimatedFrame: 40,
        isFullyDynamic: false,
      },
    ];
    const result = computeSkippableFrames(scenes, 180);

    // Frames 30-79: skippable (scene 0 static, no overlap)
    for (let i = 30; i < 80; i++) {
      expect(result.has(i), `frame ${i} should be skippable`).toBe(true);
    }
    // Frames 80-99: NOT skippable (overlap region)
    for (let i = 80; i < 100; i++) {
      expect(result.has(i), `frame ${i} should NOT be skippable (overlap)`).toBe(false);
    }
    // Scene 1: frames 120-179 should be skippable (80 + 40 = 120)
    for (let i = 120; i < 180; i++) {
      expect(result.has(i), `frame ${i} should be skippable`).toBe(true);
    }
  });

  it("handles mixed dynamic and static scenes", () => {
    const scenes: SceneInfo[] = [
      {
        startFrame: 0,
        durationInFrames: 60,
        lastAnimatedFrame: 20,
        isFullyDynamic: false,
      },
      {
        startFrame: 60,
        durationInFrames: 60,
        lastAnimatedFrame: 0,
        isFullyDynamic: true,
      },
      {
        startFrame: 120,
        durationInFrames: 60,
        lastAnimatedFrame: 10,
        isFullyDynamic: false,
      },
    ];
    const result = computeSkippableFrames(scenes, 180);

    // Scene 0: frames 20-59 skippable
    for (let i = 20; i < 60; i++) {
      expect(result.has(i)).toBe(true);
    }
    // Scene 1: fully dynamic, nothing skippable (60-119)
    for (let i = 60; i < 120; i++) {
      expect(result.has(i)).toBe(false);
    }
    // Scene 2: frames 130-179 skippable
    for (let i = 130; i < 180; i++) {
      expect(result.has(i)).toBe(true);
    }
  });

  it("returns empty set when no scenes provided", () => {
    const result = computeSkippableFrames([], 0);
    expect(result.size).toBe(0);
  });
});
