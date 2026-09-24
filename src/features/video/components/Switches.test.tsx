// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/shared/i18n";
import type { Scene, VideoProject } from "@/features/video/types";
import { useVideoStore } from "@/stores/video-store";
import { SceneEditForm } from "./SceneEditForm";
import { VideoSettingsBar } from "./VideoSettingsBar";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("./SceneContentEditor", () => ({ SceneContentEditor: () => null }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(false) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@tauri-apps/plugin-fs", () => ({ readFile: vi.fn() }));

const baseProject: VideoProject = {
  meta: { title: "Switches", width: 1920, height: 1080, fps: 30, aspectRatio: "16:9" },
  audio: { tts: { provider: "voicevox", volume: 1, speed: 1 } },
  scenes: [],
};

function makeScene(id = "scene-1"): Scene {
  return {
    id,
    narration: "Narration",
    transition: { type: "fade", durationInFrames: 30 },
    elements: [{ type: "image", src: "data:image/png;base64,AA==", position: "center", animation: "none", enabled: true }],
    captions: { enabled: false },
  };
}

const originalActions = {
  updateImageElement: useVideoStore.getState().updateImageElement,
  updateScene: useVideoStore.getState().updateScene,
  setAllCaptions: useVideoStore.getState().setAllCaptions,
};

function resetVideoStore() {
  useVideoStore.setState({ videoProject: null, ...originalActions });
}

const switches = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLElement>('[data-switch][role="switch"]')];
const press = (element: HTMLElement, key: string) =>
  element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));

describe("video span switches", () => {
  beforeEach(resetVideoStore);
  afterEach(resetVideoStore);

  it("toggles the image switch once per Enter and Space and labels it", async () => {
    const scene = makeScene();
    useVideoStore.setState({ videoProject: { ...baseProject, scenes: [scene] } });
    const updateImageElement = vi.fn(originalActions.updateImageElement);
    useVideoStore.setState({ updateImageElement });
    const container = document.createElement("div");
    const root = createRoot(container);
    const render = (s: Scene) => root.render(<SceneEditForm scene={s} onRegenerateAudio={vi.fn().mockResolvedValue(undefined)} audioGenerating={false} />);

    await act(async () => render(scene));
    expect(switches(container)[0].getAttribute("aria-checked")).toBe("true");
    expect(switches(container)[0].getAttribute("aria-label")).toBeTruthy();

    await act(async () => press(switches(container)[0], "Enter"));
    expect(updateImageElement).toHaveBeenCalledTimes(1);
    await act(async () => render(useVideoStore.getState().videoProject!.scenes[0]));
    expect(switches(container)[0].getAttribute("aria-checked")).toBe("false");

    await act(async () => press(switches(container)[0], " "));
    expect(updateImageElement).toHaveBeenCalledTimes(2);
    await act(async () => render(useVideoStore.getState().videoProject!.scenes[0]));
    expect(switches(container)[0].getAttribute("aria-checked")).toBe("true");

    await act(async () => root.unmount());
  });

  it("keeps the captions switch aria state and visual state in sync", async () => {
    const scene = makeScene();
    useVideoStore.setState({ videoProject: { ...baseProject, scenes: [scene] } });
    const updateScene = vi.fn(originalActions.updateScene);
    useVideoStore.setState({ updateScene });
    const container = document.createElement("div");
    const root = createRoot(container);
    const render = (s: Scene) => root.render(<SceneEditForm scene={s} onRegenerateAudio={vi.fn().mockResolvedValue(undefined)} audioGenerating={false} />);
    const captionsLabel = i18n.t("captions", { ns: "video" });
    const captions = () => switches(container).find((el) => el.getAttribute("aria-label") === captionsLabel)!;

    await act(async () => render(scene));
    expect(captions().getAttribute("aria-checked")).toBe("false");

    await act(async () => press(captions(), " "));
    expect(updateScene).toHaveBeenCalledTimes(1);
    await act(async () => render(useVideoStore.getState().videoProject!.scenes[0]));
    expect(captions().getAttribute("aria-checked")).toBe("true");
    expect(captions().className).toContain("--on");

    await act(async () => press(captions(), "Enter"));
    expect(updateScene).toHaveBeenCalledTimes(2);
    await act(async () => root.unmount());
  });

  it("updates all captions once for Enter and Space", async () => {
    useVideoStore.setState({ videoProject: { ...baseProject, scenes: [makeScene(), makeScene("scene-2")] } });
    const setAllCaptions = vi.fn(originalActions.setAllCaptions);
    useVideoStore.setState({ setAllCaptions });
    const container = document.createElement("div");
    const root = createRoot(container);

    await act(async () => root.render(
      <VideoSettingsBar onGenerateAudio={vi.fn()} generating={false} generatingStatus="" onDecorateWithLLM={vi.fn()} decorating={false} />,
    ));
    expect(switches(container)[0].getAttribute("aria-checked")).toBe("false");
    await act(async () => press(switches(container)[0], "Enter"));
    expect(setAllCaptions).toHaveBeenCalledTimes(1);
    expect(useVideoStore.getState().videoProject?.scenes.every((s) => s.captions?.enabled)).toBe(true);
    expect(switches(container)[0].className).toContain("--on");

    await act(async () => press(switches(container)[0], " "));
    expect(setAllCaptions).toHaveBeenCalledTimes(2);
    expect(useVideoStore.getState().videoProject?.scenes.every((s) => !s.captions?.enabled)).toBe(true);
    await act(async () => root.unmount());
  });
});
