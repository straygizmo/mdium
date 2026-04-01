import { describe, it, expect } from "vitest";
import { computeSkippableFrames, analyzeScenes, type SceneInfo, type SceneData } from "./static-ranges";

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

describe("analyzeScenes", () => {
  const baseScene: SceneData = {
    durationInFrames: 150,
    transition: { type: "fade", durationInFrames: 30 },
    elements: [],
    backgroundEffect: { type: "none" },
    captionsEnabled: false,
  };

  it("marks scene with animated background as fully dynamic", () => {
    const scenes: SceneData[] = [
      { ...baseScene, backgroundEffect: { type: "particles" } },
    ];
    const result = analyzeScenes(scenes, 30);
    expect(result[0].isFullyDynamic).toBe(true);
  });

  it("marks scene with gradient background as static-capable", () => {
    const scenes: SceneData[] = [
      { ...baseScene, backgroundEffect: { type: "gradient" } },
    ];
    const result = analyzeScenes(scenes, 30);
    expect(result[0].isFullyDynamic).toBe(false);
  });

  it("marks scene with captions as fully dynamic", () => {
    const scenes: SceneData[] = [
      { ...baseScene, captionsEnabled: true },
    ];
    const result = analyzeScenes(scenes, 30);
    expect(result[0].isFullyDynamic).toBe(true);
  });

  it("marks scene with ken-burns image as fully dynamic", () => {
    const scenes: SceneData[] = [
      {
        ...baseScene,
        elements: [{ type: "image", animation: "ken-burns" }],
      },
    ];
    const result = analyzeScenes(scenes, 30);
    expect(result[0].isFullyDynamic).toBe(true);
  });

  it("marks scene with fade-in image as fully dynamic", () => {
    const scenes: SceneData[] = [
      {
        ...baseScene,
        elements: [{ type: "image", animation: "fade-in" }],
      },
    ];
    const result = analyzeScenes(scenes, 30);
    expect(result[0].isFullyDynamic).toBe(true);
  });

  it("computes lastAnimatedFrame from transition + element animations + buffer", () => {
    const scenes: SceneData[] = [
      {
        ...baseScene,
        transition: { type: "fade", durationInFrames: 30 },
        elements: [
          { type: "title", animation: "fade-in" },
          { type: "text", animation: "fade-in" },
        ],
      },
    ];
    const result = analyzeScenes(scenes, 30);
    // max(transition=30, element: index0=0*20+30=30, index1=1*20+30=50) + 5 buffer = 55
    expect(result[0].lastAnimatedFrame).toBe(55);
    expect(result[0].isFullyDynamic).toBe(false);
  });

  it("computes lastAnimatedFrame for bullet-list sequential animation", () => {
    const scenes: SceneData[] = [
      {
        ...baseScene,
        elements: [
          {
            type: "bullet-list",
            animation: "sequential",
            items: ["a", "b", "c"],
            delayPerItem: 20,
          },
        ],
      },
    ];
    const result = analyzeScenes(scenes, 30);
    // index 0: 0*20 + 3*20 + 30 = 90, + 5 buffer = 95
    expect(result[0].lastAnimatedFrame).toBe(95);
  });

  it("computes lastAnimatedFrame for table row-by-row animation", () => {
    const scenes: SceneData[] = [
      {
        ...baseScene,
        elements: [
          {
            type: "table",
            animation: "row-by-row",
            rows: [["a"], ["b"], ["c"], ["d"]],
          },
        ],
      },
    ];
    const result = analyzeScenes(scenes, 30);
    // index 0: 0*20 + 4*15 + 20 = 80, + 5 buffer = 85
    expect(result[0].lastAnimatedFrame).toBe(85);
  });

  it("computes lastAnimatedFrame for progress-bar grow animation", () => {
    const scenes: SceneData[] = [
      {
        ...baseScene,
        elements: [
          { type: "text", animation: "none" },
          { type: "progress-bar", animation: "grow" },
        ],
      },
    ];
    const result = analyzeScenes(scenes, 30);
    // index 1: 1*20 + 60 = 80, + 5 buffer = 85
    expect(result[0].lastAnimatedFrame).toBe(85);
  });

  it("computes correct frame offsets for multiple scenes with transitions", () => {
    const scenes: SceneData[] = [
      {
        ...baseScene,
        durationInFrames: 100,
        transition: { type: "fade", durationInFrames: 20 },
        elements: [],
      },
      {
        ...baseScene,
        durationInFrames: 100,
        transition: { type: "fade", durationInFrames: 20 },
        elements: [],
      },
    ];
    const result = analyzeScenes(scenes, 30);
    expect(result[0].startFrame).toBe(0);
    // Scene 1 starts at 100 - 20 (transition overlap) = 80
    expect(result[1].startFrame).toBe(80);
  });

  it("handles all-none animations with only transition as animated range", () => {
    const scenes: SceneData[] = [
      {
        ...baseScene,
        transition: { type: "fade", durationInFrames: 30 },
        elements: [
          { type: "title", animation: "none" },
          { type: "text", animation: "none" },
        ],
      },
    ];
    const result = analyzeScenes(scenes, 30);
    // max(transition=30, elements=0) + 5 = 35
    expect(result[0].lastAnimatedFrame).toBe(35);
  });

  it("handles transition type none", () => {
    const scenes: SceneData[] = [
      {
        ...baseScene,
        transition: { type: "none", durationInFrames: 0 },
        elements: [{ type: "title", animation: "none" }],
      },
    ];
    const result = analyzeScenes(scenes, 30);
    // max(0, 0) + 5 = 5
    expect(result[0].lastAnimatedFrame).toBe(5);
  });
});
