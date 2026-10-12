// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/shared/i18n";
import { FLOW_ERROR_CODES, FLOW_WARNING_CODES, type FlowLoadResult } from "@/shared/types/flow";
import { useTabStore } from "@/stores/tab-store";
import { useFlowViewStore } from "../../flow-store";
import { useFlowEditorStore } from "../../editor-store";
import { docDigest } from "../../lib/__tests__/doc-digest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({
  invoke,
  convertFileSrc: vi.fn((p: string, proto: string) => `${proto}://${p}`),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

import { FlowPanel } from "../FlowPanel";
import { FlowWorkspace } from "../FlowWorkspace";
import { FlowIssueList, issueParams } from "../FlowIssueList";
import { edgeLabel } from "../FlowCanvas";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const FOLDER = "C:/proj";
const PATH = ".mdium/flows/doc-digest.flow.yaml";

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

/** Waits until `check` passes (React effects + async layout). */
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

/** Answers the panel's two commands: `flow_list` via `list`, and an absent manifest. */
function answerPanel(list: () => Promise<unknown>) {
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "flow_list") return list();
    if (cmd === "flow_project_load") {
      return { exists: false, path: ".mdium/project.yaml", project: null, errors: [], warnings: [] };
    }
    throw new Error(`unexpected ${cmd}`);
  });
}

/** Answers the workspace's commands: `flow_load` / `flow_validate` with `result`, an empty list, no manifest, no runs. */
function answerWorkspace(result: FlowLoadResult) {
  invoke.mockImplementation(async (cmd: string) => {
    switch (cmd) {
      case "flow_load":
      case "flow_validate":
        return result;
      case "flow_list":
      case "flow_run_list":
        return [];
      case "flow_project_load":
        return { exists: false, path: ".mdium/project.yaml", project: null, errors: [], warnings: [] };
      case "flow_gitignore_status":
        return { ignored: true };
      case "watch_folder":
      case "unwatch_folder":
        return undefined;
      default:
        throw new Error(`unexpected ${cmd}`);
    }
  });
}

describe("flow views", () => {
  let root: ReturnType<typeof createRoot>;
  let container: HTMLDivElement;

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    invoke.mockReset();
    useTabStore.setState({ activeFolderPath: FOLDER });
    useFlowViewStore.setState({ selected: {} });
    // The editor state outlives the workspace view: start every test from a closed editor.
    useFlowEditorStore.getState().close();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    useTabStore.setState({ activeFolderPath: null });
  });

  it("lists flow files and selects one", async () => {
    answerPanel(async () => [
      { path: PATH, kind: "entry", params: {}, outputs: [], id: "doc-digest", name: "Document digest", errorCount: 0, warningCount: 1 },
      { path: ".mdium/flows/broken.flow.yaml", kind: "entry", params: {}, outputs: [], id: null, name: null, errorCount: 2, warningCount: 0 },
    ]);
    await act(async () => root.render(<FlowPanel />));
    await waitFor(() => expect(container.textContent).toContain("Document digest"));
    expect(invoke).toHaveBeenCalledWith("flow_list", { projectRoot: FOLDER });
    expect(container.textContent).toContain("broken.flow.yaml");
    expect(container.textContent).toContain("Errors: 2");
    expect(container.textContent).toContain("Warnings: 1");
    const first = container.querySelector<HTMLButtonElement>(".flow-panel__item")!;
    await act(async () => first.click());
    expect(useFlowViewStore.getState().selected[FOLDER]).toBe(PATH);
  });

  it("shows the empty state and list errors", async () => {
    answerPanel(async () => []);
    await act(async () => root.render(<FlowPanel />));
    await waitFor(() => expect(container.textContent).toContain(i18n.t("list.empty", { ns: "flow" })));
    answerPanel(async () => {
      throw { code: "FLOW_LIST_FAILED", message: "x" };
    });
    await act(async () => container.querySelector<HTMLButtonElement>(".flow-panel__refresh")!.click());
    await waitFor(() => expect(container.textContent).toContain("FLOW_LIST_FAILED"));
  });

  it("renders the doc-digest graph with its loop body and issues", async () => {
    const result: FlowLoadResult = {
      path: PATH,
      format: "yaml",
      kind: "entry",
      flow: docDigest(),
      errors: [],
      warnings: [{ code: "FLOW_UNKNOWN_KEY", path: "labels", params: { key: "labels" } }],
      content: "",
      sha256: "h",
    };
    answerWorkspace(result);
    useFlowViewStore.getState().setSelected(FOLDER, PATH);
    await act(async () => root.render(<FlowWorkspace />));
    await waitFor(() => expect(container.querySelectorAll(".react-flow__node").length).toBe(9));
    expect(invoke).toHaveBeenCalledWith("flow_load", { projectRoot: FOLDER, path: PATH });
    // The workspace is an editor now: no read-only badge, a toolbar instead.
    expect(container.querySelector(".flow-workspace__readonly")).toBeNull();
    expect(container.querySelector(".flow-toolbar")).not.toBeNull();
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("watch_folder", { folderPath: `${FOLDER}/.mdium/flows` }));
    expect(container.textContent).toContain("Document digest");
    for (const id of ["collect", "docs", "summarize", "check", "quality_gate", "compile", "review", "publish"]) {
      expect(container.querySelector(`[title="${id}"]`), id).not.toBeNull();
    }
    expect(container.querySelector(".flow-group")).not.toBeNull();
    expect(container.textContent).toContain('Unknown top-level key "labels" (ignored).');

    // Collapse the loop: its three body nodes disappear.
    const toggle = container.querySelector<HTMLButtonElement>(".flow-group .flow-node__toggle")!;
    await act(async () => toggle.click());
    await waitFor(() => expect(container.querySelectorAll(".react-flow__node").length).toBe(6));
    expect(container.textContent).toContain("3 nodes inside");
  });

  it("shows a sub-flow node's argument mapping and outputs on its card", async () => {
    const result: FlowLoadResult = {
      path: PATH,
      format: "yaml",
      kind: "entry",
      flow: {
        schemaVersion: 1,
        id: "m",
        name: "Main",
        nodes: [{ id: "call", kind: "subflow", flow: "lib/p.flow.yaml", params: { doc: "${{ item }}" } }],
      } as unknown as FlowLoadResult["flow"],
      errors: [],
      warnings: [],
      content: "",
      sha256: "h",
    };
    answerWorkspace(result);
    const base = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (cmd: string, args: unknown) =>
      cmd === "flow_list"
        ? [
            {
              path: ".mdium/flows/lib/p.flow.yaml",
              kind: "part",
              id: "p",
              name: "P",
              params: { doc: { type: "string" }, lang: { type: "string" } },
              outputs: ["summary"],
              errorCount: 0,
              warningCount: 0,
            },
          ]
        : base(cmd, args),
    );
    useFlowViewStore.getState().setSelected(FOLDER, PATH);
    await act(async () => root.render(<FlowWorkspace />));
    await waitFor(() => expect(container.querySelector(".flow-node__signature")).not.toBeNull());
    const text = container.querySelector(".flow-node__signature")!.textContent!;
    expect(text).toContain("doc = ${{ item }}");
    const chips = [...container.querySelectorAll(".flow-node__chip")].map((el) => el.textContent);
    expect(chips).toContain("summary");
  });

  it("shows issues without a canvas when the file could not be decoded", async () => {
    answerWorkspace({
      path: PATH,
      format: "yaml",
      kind: "entry",
      flow: null,
      errors: [{ code: "FLOW_PARSE_FAILED", path: "", params: { message: "bad", line: 3, column: 7 } }],
      warnings: [],
      content: "x: [",
      sha256: "h",
    } satisfies FlowLoadResult);
    useFlowViewStore.getState().setSelected(FOLDER, PATH);
    await act(async () => root.render(<FlowWorkspace />));
    await waitFor(() => expect(container.textContent).toContain("The file could not be parsed: bad"));
    expect(container.textContent).toContain("line 3, column 7");
    expect(container.querySelector(".react-flow")).toBeNull();
  });

  it("asks for a selection when no flow is selected", async () => {
    await act(async () => root.render(<FlowWorkspace />));
    expect(container.textContent).toContain(i18n.t("workspace.noSelection", { ns: "flow" }));
    expect(invoke).not.toHaveBeenCalled();
  });

  it("selects the node an issue points to", async () => {
    const onSelect = vi.fn();
    await act(async () =>
      root.render(
        <FlowIssueList
          errors={[{ code: "FLOW_UNKNOWN_FIELD", path: "nodes[1].body.nodes[0].retries", params: { field: "retries" } }]}
          warnings={[]}
          onSelectNode={onSelect}
        />,
      ),
    );
    expect(container.textContent).toContain('Unknown attribute "retries".');
    await act(async () => container.querySelector<HTMLButtonElement>(".flow-issue__button")!.click());
    expect(onSelect).toHaveBeenCalledWith("nodes[1].body.nodes[0]");
  });

  it("explains an empty node list instead of the generic invalid-value text", async () => {
    await act(async () =>
      root.render(
        <FlowIssueList
          errors={[
            { code: "FLOW_INVALID_VALUE", path: "nodes", params: { reason: "empty" } },
            { code: "FLOW_INVALID_VALUE", path: "nodes[0].body.nodes", params: { reason: "empty" } },
            { code: "FLOW_INVALID_VALUE", path: "name", params: { reason: "empty" } },
          ]}
          warnings={[]}
        />,
      ),
    );
    const messages = [...container.querySelectorAll(".flow-issue__message")].map((el) => el.textContent);
    expect(messages[0]).toBe("The flow has no nodes yet. Use \"Add node\" to place the first one.");
    expect(messages[1]).toBe("The flow has no nodes yet. Use \"Add node\" to place the first one.");
    expect(messages[2]).toBe("Invalid value (empty).");
  });
});

describe("issue messages", () => {
  it("exist in every language for every code", () => {
    for (const lng of ["en", "ja"]) {
      for (const code of [...FLOW_ERROR_CODES, ...FLOW_WARNING_CODES]) {
        expect(i18n.exists(`issue.${code}`, { ns: "flow", lng }), `${lng} ${code}`).toBe(true);
      }
    }
  });

  it("flattens params for interpolation", () => {
    expect(
      issueParams({ code: "FLOW_CYCLE_WITHOUT_LIMIT", path: "edges", params: { nodes: ["a", "b"], n: 1, o: { x: 1 } } }),
    ).toEqual({ nodes: "a, b", n: 1, o: '{"x":1}' });
  });

  it("labels edges by port and back-edge bound", () => {
    expect(edgeLabel("success")).toBe("");
    expect(edgeLabel("failure")).toBe("failure");
    expect(edgeLabel("low", 2)).toBe("low ↺ ≤2");
  });
});
