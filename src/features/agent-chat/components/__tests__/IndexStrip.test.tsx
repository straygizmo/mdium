// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/shared/i18n";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("@/features/rag/lib/index-jobs", () => ({
  refreshIndexStatus: vi.fn(async () => {}),
  startUpdateIndex: vi.fn(),
  deleteIndex: vi.fn(async () => {}),
}));
vi.mock("@/features/rag/hooks/useLocalEmbedding", () => ({
  useLocalEmbedding: () => ({
    status: "idle",
    progress: 0,
    error: null,
    load: vi.fn(),
    embed: vi.fn(),
    getManualPlacement: () => ({ dir: "C:/models/x", files: ["model.onnx"] }),
  }),
}));

import { useTabStore } from "@/stores/tab-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useRagIndexStore } from "@/features/rag/stores/rag-index-store";
import { refreshIndexStatus } from "@/features/rag/lib/index-jobs";
import { IndexStrip } from "../IndexStrip";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("IndexStrip", () => {
  let root: ReturnType<typeof createRoot>;
  let container: HTMLDivElement;

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    useTabStore.setState({ activeFolderPath: "C:/w" });
    useRagIndexStore.setState({
      folder: "C:/w", state: "empty", totalChunks: 0, totalFiles: 0, progress: null, error: null, job: null,
    });
    vi.mocked(refreshIndexStatus).mockClear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    useTabStore.setState({ activeFolderPath: null });
  });

  it("renders nothing without a folder", async () => {
    useTabStore.setState({ activeFolderPath: null });
    await act(async () => root.render(<IndexStrip />));
    expect(container.querySelector(".index-strip")).toBeNull();
  });

  it("refreshes status on mount and shows the empty state with a build button", async () => {
    await act(async () => root.render(<IndexStrip />));
    expect(refreshIndexStatus).toHaveBeenCalledWith("C:/w");
    expect(container.querySelector(".index-strip__pill")?.textContent).toBe("No index");
    const btn = container.querySelector<HTMLButtonElement>(".index-strip__update")!;
    expect(btn.title).toBe(i18n.t("common:ragBuildIndex"));
    expect(btn.textContent).toBe(i18n.t("common:ragBuildIndex"));
    expect(btn.disabled).toBe(false);
  });

  it("labels the button as rebuild once an index is ready", async () => {
    useRagIndexStore.setState({ state: "ready", totalChunks: 5, totalFiles: 1 });
    await act(async () => root.render(<IndexStrip />));
    const btn = container.querySelector<HTMLButtonElement>(".index-strip__update")!;
    expect(btn.textContent).toBe(i18n.t("common:ragRebuildIndex"));
  });

  it("re-reads status when the embedding model changes", async () => {
    await act(async () => root.render(<IndexStrip />));
    vi.mocked(refreshIndexStatus).mockClear();
    await act(async () => {
      useSettingsStore.setState({
        ragSettings: { ...useSettingsStore.getState().ragSettings, embeddingModel: useSettingsStore.getState().ragSettings.embeddingModel === "Xenova/multilingual-e5-small" ? "Xenova/multilingual-e5-base" : "Xenova/multilingual-e5-small" },
      });
    });
    expect(refreshIndexStatus).toHaveBeenCalledWith("C:/w");
  });

  it("shows chunk count and ready state", async () => {
    useRagIndexStore.setState({ state: "ready", totalChunks: 128, totalFiles: 7 });
    await act(async () => root.render(<IndexStrip />));
    expect(container.querySelector(".index-strip")?.getAttribute("data-state")).toBe("ready");
    expect(container.querySelector(".index-strip__pill")?.textContent).toContain("128");
    expect(container.querySelector(".index-strip__meta")?.textContent).toContain("7 files");
  });

  it("disables the update button while updating", async () => {
    useRagIndexStore.setState({ state: "updating" });
    await act(async () => root.render(<IndexStrip />));
    expect(container.querySelector<HTMLButtonElement>(".index-strip__update")!.disabled).toBe(true);
  });

  it("shows converting progress from the job", async () => {
    useRagIndexStore.setState({
      state: "converting",
      job: { id: "j", kind: "convert", folder: "C:/w", state: "running", done: 2, total: 5, current_file: "", errors: [] },
    });
    await act(async () => root.render(<IndexStrip />));
    expect(container.querySelector(".index-strip__pill")?.textContent).toBe("Converting 2/5");
  });

  it("renders the model-missing block for MODEL_MISSING errors", async () => {
    useRagIndexStore.setState({ state: "error", error: "MODEL_MISSING" });
    await act(async () => root.render(<IndexStrip />));
    expect(container.textContent).toContain(i18n.t("common:ragModelMissingTitle"));
  });

  it("opens the drawer and toggles the codex tool", async () => {
    const spy = vi.fn();
    useSettingsStore.setState({
      mdiumRagTools: { claude: true, codex: true, copilot: true },
      setMdiumRagTool: spy,
    });
    await act(async () => root.render(<IndexStrip />));
    await act(async () => container.querySelector<HTMLButtonElement>(".index-strip__settings")!.click());
    const boxes = container.querySelectorAll<HTMLInputElement>('.index-drawer__tools input[type="checkbox"]');
    expect(boxes.length).toBe(3);
    await act(async () => boxes[1].click());
    expect(spy).toHaveBeenCalledWith("codex", false);
  });
});
