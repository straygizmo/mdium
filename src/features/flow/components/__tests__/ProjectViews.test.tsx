// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/shared/i18n";
import { useTabStore } from "@/stores/tab-store";
import { useFlowViewStore } from "../../flow-store";
import { docDigest } from "../../lib/__tests__/doc-digest";

const invoke = vi.hoisted(() => vi.fn());
const listeners = vi.hoisted(() => new Map<string, (e: { payload: unknown }) => void>());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: (e: { payload: unknown }) => void) => {
    listeners.set(name, handler);
    return () => listeners.delete(name);
  }),
}));

import { FlowPanel } from "../FlowPanel";
import { FlowWorkspace } from "../FlowWorkspace";
import { ProjectSetupDialog } from "../ProjectSetupDialog";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const FOLDER = "C:/proj";

beforeAll(() => {
  // React Flow measures its viewport; happy-dom has no layout engine.
  if (!("ResizeObserver" in globalThis)) {
    (globalThis as Record<string, unknown>).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
});

/** Waits until `check` passes (React effects + async work). */
async function waitFor(check: () => void, timeoutMs = 5000) {
  const start = Date.now();
  for (;;) {
    try {
      check();
      return;
    } catch (err) {
      if (Date.now() - start > timeoutMs) throw err;
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    }
  }
}

describe("project views", () => {
  let root: ReturnType<typeof createRoot>;
  let container: HTMLDivElement;

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    invoke.mockReset();
    listeners.clear();
    useTabStore.setState({ activeFolderPath: FOLDER });
    useFlowViewStore.setState({ selected: {} });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    useTabStore.setState({ activeFolderPath: null });
  });

  describe("FlowPanel with a project", () => {
    it("groups entries and parts and shows the project header", async () => {
      invoke.mockImplementation(async (cmd: string) => {
        if (cmd === "flow_list") {
          return [
            { path: ".mdium/flows/main.flow.yaml", kind: "entry", role: "main", id: "m", name: "Main", params: {}, outputs: ["coverage"], errorCount: 0, warningCount: 0 },
            { path: ".mdium/flows/lib/video.flow.yaml", kind: "part", id: "v", name: "Video", params: { storyDir: { type: "path", required: true } }, outputs: ["videoPath"], errorCount: 0, warningCount: 0 },
          ];
        }
        if (cmd === "flow_project_load") {
          return { exists: true, path: ".mdium/project.yaml", sha256: "abc", project: { schemaVersion: 1, id: "p", name: "Proj", setup: [{ run: ["uv", "sync"] }] }, errors: [], warnings: [] };
        }
        throw new Error(`unexpected ${cmd}`);
      });
      await act(async () => root.render(<FlowPanel />));
      await waitFor(() => expect(container.textContent).toContain("Proj"));
      expect(container.textContent).toContain(i18n.t("list.groupEntries", { ns: "flow" }));
      expect(container.textContent).toContain(i18n.t("list.groupParts", { ns: "flow" }));
      expect(container.querySelector(".flow-panel__role")?.textContent).toBe("main");
      expect(container.textContent).toContain("storyDir → videoPath"); // signature line
      expect(container.querySelector(".flow-panel__setup")).not.toBeNull();
    });

    it("hides the setup button without setup steps and reports manifest errors", async () => {
      invoke.mockImplementation(async (cmd: string) => {
        if (cmd === "flow_list") return [];
        if (cmd === "flow_project_load") {
          return { exists: true, path: ".mdium/project.yaml", project: null, errors: [{ code: "FLOW_INVALID_ID", path: "id", params: { name: "Bad" } }], warnings: [] };
        }
        throw new Error(`unexpected ${cmd}`);
      });
      await act(async () => root.render(<FlowPanel />));
      await waitFor(() => expect(container.textContent).toContain(i18n.t("project.invalid", { ns: "flow", count: 1 })));
      expect(container.querySelector(".flow-panel__setup")).toBeNull();
    });
  });

  describe("FlowPanel when the manifest fails", () => {
    it("still lists the flows without a project header", async () => {
      invoke.mockImplementation(async (cmd: string) => {
        if (cmd === "flow_list") {
          return [{ path: ".mdium/flows/main.flow.yaml", kind: "entry", id: "m", name: "Main", params: {}, outputs: [], errorCount: 0, warningCount: 0 }];
        }
        if (cmd === "flow_project_load") throw { code: "FLOW_PROJECT_INVALID", message: "x" };
        throw new Error(`unexpected ${cmd}`);
      });
      await act(async () => root.render(<FlowPanel />));
      await waitFor(() => expect(container.textContent).toContain("Main"));
      expect(container.querySelector(".flow-panel__project")).toBeNull();
    });
  });

  describe("ProjectSetupDialog", () => {
    it("lists the steps, requires confirmation, runs and shows progress", async () => {
      const project = { schemaVersion: 1 as const, id: "p", name: "Proj", setup: [{ run: ["uv", "sync"], workingDir: "." }] };
      invoke.mockImplementation(async (cmd: string) => {
        if (cmd === "flow_project_setup") {
          listeners.get("flow://setup-progress")?.({ payload: { projectRoot: FOLDER, setupId: "s1", step: 1, total: 1, status: "started", run: ["uv", "sync"] } });
          listeners.get("flow://setup-progress")?.({ payload: { projectRoot: FOLDER, setupId: "s1", step: 1, total: 1, status: "failed", run: ["uv", "sync"], exitCode: 2 } });
          return { setupId: "s1", ok: false, logDir: ".mdium/setup-runs/s1", steps: [{ index: 1, run: ["uv", "sync"], workingDir: ".", exitCode: 2, stdoutTail: "", stderrTail: "boom" }] };
        }
        throw new Error(`unexpected ${cmd}`);
      });
      const onClose = vi.fn();
      await act(async () => root.render(<ProjectSetupDialog projectRoot={FOLDER} project={project} sha256="abc" onClose={onClose} />));
      expect(container.textContent).toContain("uv sync");
      const run = container.querySelector<HTMLButtonElement>(".flow-dialog__button--primary")!;
      expect(run.disabled).toBe(true);
      await act(async () => container.querySelector<HTMLInputElement>(".flow-dialog__confirm input")!.click());
      expect(run.disabled).toBe(false);
      await act(async () => run.click());
      await waitFor(() => expect(container.textContent).toContain(i18n.t("project.setupFailed", { ns: "flow" })));
      expect(container.textContent).toContain("boom");
      expect(invoke).toHaveBeenCalledWith("flow_project_setup", { projectRoot: FOLDER, sha256: "abc" });
    });
  });

  describe("FlowWorkspace with a part", () => {
    it("shows the part hint and offers no start button", async () => {
      const PART = ".mdium/flows/lib/part.flow.yaml";
      useFlowViewStore.setState({ selected: { [FOLDER]: PART } });
      invoke.mockImplementation(async (cmd: string) => {
        if (cmd === "flow_load") return { path: PART, format: "yaml", kind: "part", flow: docDigest(), errors: [], warnings: [] };
        if (cmd === "flow_run_list") return [];
        if (cmd === "flow_gitignore_status") return { ignored: true };
        throw new Error(`unexpected ${cmd}`);
      });
      await act(async () => root.render(<FlowWorkspace />));
      await waitFor(() => expect(container.textContent).toContain(i18n.t("run.partHint", { ns: "flow" })));
      // RunPanel always renders its start button; for a part (flow=null) it is disabled.
      const start = container.querySelector<HTMLButtonElement>(".flow-runs__start");
      expect(start).not.toBeNull();
      expect(start!.disabled).toBe(true);
    });
  });
});
