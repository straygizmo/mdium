// @vitest-environment happy-dom
import { act, type ChangeEvent } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/shared/i18n";
import type { FlowDef, FlowIssue, FlowLoadResult, FlowSummary } from "@/shared/types/flow";
import { useTabStore } from "@/stores/tab-store";

const invoke = vi.hoisted(() => vi.fn());
const listeners = vi.hoisted(() => [] as Array<{ name: string; handler: (e: { payload: unknown }) => void }>);
vi.mock("@tauri-apps/api/core", () => ({
  invoke,
  convertFileSrc: vi.fn((p: string, proto: string) => `${proto}://${p}`),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: (e: { payload: unknown }) => void) => {
    const entry = { name, handler };
    listeners.push(entry);
    return () => {
      const i = listeners.indexOf(entry);
      if (i >= 0) listeners.splice(i, 1);
    };
  }),
}));
const showConfirm = vi.hoisted(() => vi.fn(async (_text: string, _options?: unknown) => true));
vi.mock("@/stores/dialog-store", async (orig) => ({ ...(await orig<object>()), showConfirm }));
vi.mock("@monaco-editor/react", () => ({
  default: ({
    value,
    onChange,
    options,
  }: {
    value: string;
    onChange?: (text: string | undefined) => void;
    options?: { readOnly?: boolean };
  }) => (
    <textarea
      className="test-yaml"
      value={value}
      readOnly={options?.readOnly}
      onChange={(e: ChangeEvent<HTMLTextAreaElement>) => onChange?.(e.target.value)}
    />
  ),
}));

import { useFlowViewStore } from "../../flow-store";
import { useFlowEditorStore } from "../../editor-store";
import { parseFlowText, stringifyFlow } from "../../lib/flow-yaml";
import { FlowPanel } from "../FlowPanel";
import { FlowWorkspace } from "../FlowWorkspace";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const FOLDER = "C:/proj";
const PATH = ".mdium/flows/demo.flow.yaml";

const demo: FlowDef = {
  schemaVersion: 1,
  id: "demo",
  name: "Demo",
  nodes: [
    { id: "run", kind: "command", run: ["echo"], shell: false, protocol: "none" },
    { id: "done", kind: "approval" },
  ],
  edges: [{ from: "run", to: "done" }],
};

function loadResult(over: Partial<FlowLoadResult> = {}): FlowLoadResult {
  return {
    path: PATH,
    format: "yaml",
    kind: "entry",
    flow: demo,
    errors: [],
    warnings: [],
    content: stringifyFlow(demo),
    sha256: "h1",
    ...over,
  };
}

type Handler = (args: Record<string, unknown>) => unknown;
let routes: Record<string, Handler>;

/** Decodes posted content the way the backend would (no validation). */
function validated(args: Record<string, unknown>, errors: FlowIssue[] = []): FlowLoadResult {
  const parsed = parseFlowText(String(args.content));
  return loadResult({
    path: String(args.path),
    content: String(args.content),
    flow: "value" in parsed ? (parsed.value as FlowDef) : null,
    errors,
  });
}

function installRoutes(over: Record<string, Handler> = {}) {
  routes = {
    flow_load: () => loadResult(),
    flow_validate: (args) => validated(args),
    flow_save: (args) => loadResult({ content: String(args.content), sha256: "h-saved" }),
    flow_list: () => [],
    flow_project_load: () => ({ exists: false, path: ".mdium/project.yaml", project: null, errors: [], warnings: [] }),
    watch_folder: () => undefined,
    unwatch_folder: () => undefined,
    flow_run_list: () => [],
    flow_gitignore_status: () => ({ ignored: true }),
    ...over,
  };
  invoke.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
    const handler = routes[cmd];
    if (!handler) throw new Error(`unrouted ${cmd}`);
    return handler(args ?? {});
  });
}

const callsTo = (cmd: string) => invoke.mock.calls.filter(([c]) => c === cmd).map(([, args]) => args as Record<string, unknown>);

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
async function waitFor(check: () => void, timeoutMs = 3000) {
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

function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  const proto =
    el instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
}

async function type(el: Element, value: string) {
  await act(async () => {
    setNativeValue(el as HTMLInputElement, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** Types into a text field and leaves it (React maps blur to `focusout`). */
async function typeAndBlur(el: Element, value: string) {
  await type(el, value);
  await act(async () => {
    el.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  });
}

describe("flow workspace editing", () => {
  let root: ReturnType<typeof createRoot>;
  let container: HTMLDivElement;

  const button = (text: string, scope: ParentNode = container): HTMLButtonElement => {
    const found = [...scope.querySelectorAll("button")].find((b) => b.textContent === text);
    if (!found) throw new Error(`no button "${text}" in: ${container.textContent}`);
    return found;
  };
  const click = async (el: HTMLElement) => {
    await act(async () => el.click());
  };
  /** Presses Ctrl+S inside the YAML pane when it is open, else on the workspace root. */
  const pressCtrlS = async (): Promise<KeyboardEvent> => {
    const target = container.querySelector<HTMLElement>(".test-yaml") ?? container.querySelector<HTMLElement>(".flow-workspace")!;
    const event = new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true, cancelable: true });
    await act(async () => {
      target.dispatchEvent(event);
    });
    return event;
  };
  const editName = async (nodeId: string, name: string) => {
    await click(container.querySelector<HTMLElement>(`.react-flow__node[data-id="${nodeId}"]`)!);
    await typeAndBlur(container.querySelector('.flow-workspace__side [aria-label="Name"]')!, name);
  };
  const dialog = () => document.querySelector<HTMLElement>(".flow-dialog");

  async function mountWorkspace() {
    useFlowViewStore.getState().setSelected(FOLDER, PATH);
    await act(async () => root.render(<FlowWorkspace />));
    await waitFor(() => expect(container.querySelectorAll(".react-flow__node").length).toBe(2));
  }

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    invoke.mockReset();
    showConfirm.mockReset();
    showConfirm.mockImplementation(async () => true);
    listeners.length = 0;
    installRoutes();
    useTabStore.setState({ activeFolderPath: FOLDER });
    useFlowViewStore.setState({ selected: {} });
    useFlowEditorStore.getState().close();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    useTabStore.setState({ activeFolderPath: null });
    useFlowEditorStore.getState().close();
  });

  it("edits from the attribute panel reach the YAML text and are saved", async () => {
    await mountWorkspace();
    expect(container.querySelector(".flow-workspace__readonly")).toBeNull();

    await click(container.querySelector<HTMLElement>('.react-flow__node[data-id="nodes[0]"]')!);
    expect(useFlowEditorStore.getState().selection).toEqual({ kind: "node", path: "nodes[0]" });
    const nameInput = container.querySelector('.flow-workspace__side [aria-label="Name"]')!;
    await typeAndBlur(nameInput, "Run");
    expect(container.querySelector(".flow-workspace__dirty")?.textContent).toBe("Unsaved changes");

    await click(button("YAML"));
    expect(container.querySelector(".flow-workspace--split")).not.toBeNull();
    const yaml = container.querySelector<HTMLTextAreaElement>(".test-yaml")!;
    expect(yaml.value).toContain("name: Run");

    const keydown = await pressCtrlS();
    expect(keydown.defaultPrevented).toBe(true);
    await waitFor(() => expect(callsTo("flow_save")).toHaveLength(1));
    const saved = callsTo("flow_save")[0];
    expect(saved.expectedSha256).toBe("h1");
    expect(saved.path).toBe(PATH);
    expect(String(saved.content)).toContain("name: Run");
    expect(dialog()).toBeNull();
    await waitFor(() => expect(container.querySelector(".flow-workspace__dirty")).toBeNull());
  });

  it("does not warn about comments that are still in the text", async () => {
    routes.flow_load = () => loadResult({ content: `# note\n${stringifyFlow(demo)}` });
    await mountWorkspace();
    await pressCtrlS();
    await waitFor(() => expect(callsTo("flow_save")).toHaveLength(1));
    expect(dialog()).toBeNull();
    expect(String(callsTo("flow_save")[0].content)).toContain("# note");
  });

  it("warns about comment loss once before the first save", async () => {
    routes.flow_load = () => loadResult({ content: `# note\n${stringifyFlow(demo)}` });
    await mountWorkspace();
    // A canvas / form edit re-serializes the text, which drops the comment.
    await editName("nodes[0]", "Run");

    await pressCtrlS();
    await waitFor(() => expect(dialog()?.textContent).toContain("Comments in this file will be lost"));
    expect(callsTo("flow_save")).toHaveLength(0);
    await click(button("Continue", dialog()!));
    await waitFor(() => expect(callsTo("flow_save")).toHaveLength(1));
    expect(dialog()).toBeNull();

    // Another edit, then save again: no second warning.
    await click(container.querySelector<HTMLElement>('.react-flow__node[data-id="nodes[1]"]')!);
    await typeAndBlur(container.querySelector('.flow-workspace__side [aria-label="Name"]')!, "Done");
    await pressCtrlS();
    await waitFor(() => expect(callsTo("flow_save")).toHaveLength(2));
    expect(dialog()).toBeNull();
    expect(callsTo("flow_save")[1].expectedSha256).toBe("h-saved");
  });

  it("aborts the save when the comment warning is cancelled", async () => {
    routes.flow_load = () => loadResult({ content: `# note\n${stringifyFlow(demo)}` });
    await mountWorkspace();
    await editName("nodes[0]", "Run");
    await pressCtrlS();
    await waitFor(() => expect(dialog()).not.toBeNull());
    await click(button("Cancel", dialog()!));
    expect(dialog()).toBeNull();
    expect(callsTo("flow_save")).toHaveLength(0);
    expect(useFlowEditorStore.getState().commentWarningPending).toBe(true);
  });

  it("warns but allows saving with validation errors", async () => {
    routes.flow_validate = (args) =>
      validated(args, [{ code: "FLOW_UNKNOWN_NODE_REF", path: "edges[0].to", params: { node: "x" } }]);
    await mountWorkspace();

    await pressCtrlS();
    await waitFor(() => expect(dialog()?.textContent).toContain("The flow has validation errors. Save anyway?"));
    expect(callsTo("flow_validate").length).toBeGreaterThan(0);
    expect(callsTo("flow_save")).toHaveLength(0);
    await click(button("Continue", dialog()!));
    await waitFor(() => expect(callsTo("flow_save")).toHaveLength(1));
  });

  it("offers reload or overwrite when the file changes outside", async () => {
    let saves = 0;
    routes.flow_save = (args) => {
      saves++;
      if (saves === 1) throw { code: "FLOW_FILE_CHANGED", message: "changed" };
      return loadResult({ content: String(args.content), sha256: "h3" });
    };
    await mountWorkspace();

    await pressCtrlS();
    await waitFor(() => expect(container.querySelector(".flow-notice")).not.toBeNull());
    const notice = container.querySelector<HTMLElement>(".flow-notice")!;
    expect(notice.textContent).toContain("The file changed outside the editor.");
    expect(button("Reload", notice)).toBeTruthy();

    routes.flow_load = () => loadResult({ sha256: "h2" });
    invoke.mockClear();
    await click(button("Overwrite", notice));
    await waitFor(() => expect(callsTo("flow_save")).toHaveLength(1));
    const order = invoke.mock.calls.map(([c]) => c).filter((c) => c === "flow_load" || c === "flow_save");
    expect(order).toEqual(["flow_load", "flow_save"]);
    expect(callsTo("flow_save")[0].expectedSha256).toBe("h2");
    await waitFor(() => expect(container.querySelector(".flow-notice")).toBeNull());
  });

  it("reloads silently on an external change when there are no edits", async () => {
    await mountWorkspace();
    await waitFor(() => expect(callsTo("watch_folder")).toEqual([{ folderPath: `${FOLDER}/.mdium/flows` }]));
    await waitFor(() => expect(listeners.some((l) => l.name === "folder-changed")).toBe(true));
    expect(container.querySelector(".flow-workspace__name")?.textContent).toBe("Demo");

    routes.flow_load = () => loadResult({ sha256: "h2", flow: { ...demo, name: "Renamed" } });
    await act(async () => {
      for (const l of listeners.filter((x) => x.name === "folder-changed")) {
        l.handler({ payload: `${FOLDER}/.mdium/flows` });
      }
    });
    await waitFor(() => expect(container.querySelector(".flow-workspace__name")?.textContent).toBe("Renamed"));
    expect(container.querySelector(".flow-notice")).toBeNull();
    expect(useFlowEditorStore.getState().savedSha256).toBe("h2");
  });

  it("shows the notice on an external change when there are edits", async () => {
    await mountWorkspace();
    await waitFor(() => expect(listeners.some((l) => l.name === "folder-changed")).toBe(true));
    await click(container.querySelector<HTMLElement>('.react-flow__node[data-id="nodes[0]"]')!);
    await typeAndBlur(container.querySelector('.flow-workspace__side [aria-label="Name"]')!, "Run");

    routes.flow_load = () => loadResult({ sha256: "h2", flow: { ...demo, name: "Renamed" } });
    await act(async () => {
      for (const l of listeners.filter((x) => x.name === "folder-changed")) {
        l.handler({ payload: `${FOLDER}/.mdium/flows` });
      }
    });
    await waitFor(() => expect(container.querySelector(".flow-notice")).not.toBeNull());
    expect(useFlowEditorStore.getState().dirty).toBe(true);
    expect(container.querySelector(".flow-workspace__name")?.textContent).toBe("Demo");
  });

  it("stops watching when the workspace closes but keeps the editor state", async () => {
    await mountWorkspace();
    await waitFor(() => expect(listeners.some((l) => l.name === "folder-changed")).toBe(true));
    await act(async () => root.render(<div />));
    await waitFor(() => expect(callsTo("unwatch_folder")).toEqual([{ folderPath: `${FOLDER}/.mdium/flows` }]));
    expect(listeners.some((l) => l.name === "folder-changed")).toBe(false);
    expect(useFlowEditorStore.getState().path).toBe(PATH);
  });

  it("keeps edits when the Flows view is unmounted and remounted", async () => {
    await mountWorkspace();
    await editName("nodes[0]", "Run");
    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => root.render(<FlowWorkspace />));
    await waitFor(() => expect(container.querySelectorAll(".react-flow__node").length).toBe(2));
    await click(button("YAML"));
    expect(container.querySelector<HTMLTextAreaElement>(".test-yaml")!.value).toContain("name: Run");
    expect(container.querySelector(".flow-workspace__dirty")).not.toBeNull();
    // The remount only checks the hash on disk (unchanged here); the edits stay.
    await waitFor(() => expect(callsTo("flow_load")).toHaveLength(2));
    expect(useFlowEditorStore.getState().text).toContain("name: Run");
    expect(container.querySelector(".flow-notice")).toBeNull();
    // The watch is subscribed again for the remounted view.
    await waitFor(() => expect(callsTo("watch_folder")).toHaveLength(2));
    expect(showConfirm).not.toHaveBeenCalled();
  });

  it("reloads a clean editor on remount when the file changed meanwhile", async () => {
    await mountWorkspace();
    await act(async () => root.unmount());
    routes.flow_load = () => loadResult({ sha256: "h2", flow: { ...demo, name: "Renamed" } });
    root = createRoot(container);
    await act(async () => root.render(<FlowWorkspace />));
    await waitFor(() => expect(container.querySelector(".flow-workspace__name")?.textContent).toBe("Renamed"));
    expect(useFlowEditorStore.getState().savedSha256).toBe("h2");
  });

  it("shows the deleted notice and re-creates the file on overwrite", async () => {
    await mountWorkspace();
    await waitFor(() => expect(listeners.some((l) => l.name === "folder-changed")).toBe(true));
    routes.flow_load = () => {
      throw { code: "FLOW_FILE_NOT_FOUND", message: PATH };
    };
    await act(async () => {
      for (const l of listeners.filter((x) => x.name === "folder-changed")) {
        l.handler({ payload: `${FOLDER}/.mdium/flows` });
      }
    });
    await waitFor(() => expect(container.querySelector(".flow-notice")).not.toBeNull());
    const notice = container.querySelector<HTMLElement>(".flow-notice")!;
    expect(notice.textContent).toContain("The file was deleted outside the editor.");
    await click(button("Overwrite", notice));
    await waitFor(() => expect(callsTo("flow_save")).toHaveLength(1));
    expect(callsTo("flow_save")[0].expectedSha256).toBeNull();
    await waitFor(() => expect(container.querySelector(".flow-notice")).toBeNull());
  });

  it("overwrite runs the same warnings as a save", async () => {
    routes.flow_save = () => {
      throw { code: "FLOW_FILE_CHANGED", message: "changed" };
    };
    await mountWorkspace();
    await pressCtrlS();
    await waitFor(() => expect(container.querySelector(".flow-notice")).not.toBeNull());
    routes.flow_validate = (args) =>
      validated(args, [{ code: "FLOW_UNKNOWN_NODE_REF", path: "edges[0].to", params: { node: "x" } }]);
    invoke.mockClear();
    await click(button("Overwrite", container.querySelector<HTMLElement>(".flow-notice")!));
    await waitFor(() => expect(dialog()?.textContent).toContain("The flow has validation errors. Save anyway?"));
    await click(button("Cancel", dialog()!));
    expect(callsTo("flow_save")).toHaveLength(0);
    expect(container.querySelector(".flow-notice")).not.toBeNull();
  });

  it("lists unknown keys that the save drops", async () => {
    const unknown: FlowIssue = { code: "FLOW_UNKNOWN_KEY", path: "labels", params: { key: "labels" } };
    routes.flow_load = () => loadResult({ content: `${stringifyFlow(demo)}labels: [a]\n`, warnings: [unknown] });
    await mountWorkspace();
    await editName("nodes[0]", "Run");
    await pressCtrlS();
    await waitFor(() => expect(dialog()?.textContent).toContain("Unknown keys will be dropped: labels"));
    expect(callsTo("flow_save")).toHaveLength(0);
    await click(button("Continue", dialog()!));
    await waitFor(() => expect(callsTo("flow_save")).toHaveLength(1));
  });

  it("commits a focused field before saving", async () => {
    await mountWorkspace();
    await click(container.querySelector<HTMLElement>('.react-flow__node[data-id="nodes[0]"]')!);
    const nameInput = container.querySelector<HTMLInputElement>('.flow-workspace__side [aria-label="Name"]')!;
    nameInput.focus();
    await type(nameInput, "Typed");
    expect(useFlowEditorStore.getState().text).not.toContain("name: Typed");
    await act(async () => {
      nameInput.dispatchEvent(new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true, cancelable: true }));
    });
    await waitFor(() => expect(callsTo("flow_save")).toHaveLength(1));
    expect(String(callsTo("flow_save")[0].content)).toContain("name: Typed");
  });

  it("disables canvas and form edits while the YAML cannot be decoded", async () => {
    await mountWorkspace();
    await click(button("YAML"));
    const yaml = container.querySelector<HTMLTextAreaElement>(".test-yaml")!;
    await type(yaml, "nodes: [");
    await waitFor(() => expect(container.textContent).toContain("Fix the YAML to edit on the canvas."));
    expect(button("Add node").disabled).toBe(true);
    expect(container.querySelector<HTMLFieldSetElement>("fieldset.flow-workspace__attrs")!.disabled).toBe(true);
    // A late form edit is refused by the store: the typed text survives.
    useFlowEditorStore.getState().applyEdit((d) => ({ ...d, name: "Z" }));
    expect(useFlowEditorStore.getState().text).toBe("nodes: [");
  });

  it("asks before switching to another flow while dirty", async () => {
    const OTHER = ".mdium/flows/other.flow.yaml";
    routes.flow_load = (args) =>
      args.path === OTHER ? loadResult({ path: OTHER, flow: { ...demo, name: "Other" }, sha256: "h-other" }) : loadResult();
    await mountWorkspace();
    await editName("nodes[0]", "Run");

    showConfirm.mockImplementation(async () => false);
    await act(async () => useFlowViewStore.getState().setSelected(FOLDER, OTHER));
    await waitFor(() => expect(useFlowViewStore.getState().selected[FOLDER]).toBe(PATH));
    expect(showConfirm).toHaveBeenCalledWith("Discard unsaved changes?", { kind: "warning" });
    expect(useFlowEditorStore.getState().path).toBe(PATH);
    expect(useFlowEditorStore.getState().text).toContain("name: Run");
    expect(callsTo("flow_load").filter((a) => a.path === OTHER)).toHaveLength(0);

    showConfirm.mockImplementation(async () => true);
    await act(async () => useFlowViewStore.getState().setSelected(FOLDER, OTHER));
    await waitFor(() => expect(container.querySelector(".flow-workspace__name")?.textContent).toBe("Other"));
    expect(callsTo("flow_load").filter((a) => a.path === OTHER)).toHaveLength(1);
    expect(useFlowEditorStore.getState().dirty).toBe(false);
    expect(showConfirm).toHaveBeenCalledTimes(2);
  });

  it("asks before reload while dirty", async () => {
    await mountWorkspace();
    await act(async () => button("Reload").click());
    expect(showConfirm).not.toHaveBeenCalled();
    await waitFor(() => expect(callsTo("flow_load")).toHaveLength(2));

    await waitFor(() => expect(container.querySelectorAll(".react-flow__node").length).toBe(2));
    await editName("nodes[0]", "Run");
    showConfirm.mockImplementation(async () => false);
    await act(async () => button("Reload").click());
    expect(showConfirm).toHaveBeenCalledWith("Discard unsaved changes?", { kind: "warning" });
    expect(callsTo("flow_load")).toHaveLength(2);
    expect(useFlowEditorStore.getState().text).toContain("name: Run");

    showConfirm.mockImplementation(async () => true);
    await act(async () => button("Reload").click());
    await waitFor(() => expect(callsTo("flow_load")).toHaveLength(3));
    await waitFor(() => expect(useFlowEditorStore.getState().dirty).toBe(false));
    expect(useFlowEditorStore.getState().text).not.toContain("name: Run");
  });

  it("renders read-only when the file cannot be loaded", async () => {
    routes.flow_load = () => {
      throw { code: "FLOW_FILE_NOT_FOUND", message: "missing" };
    };
    useFlowViewStore.getState().setSelected(FOLDER, PATH);
    await act(async () => root.render(<FlowWorkspace />));
    await waitFor(() => expect(container.querySelector(".flow-workspace__readonly")).not.toBeNull());
    expect(button("Add node").disabled).toBe(true);
    expect(button("Save").disabled).toBe(true);
    await click(button("YAML"));
    expect(container.querySelector<HTMLTextAreaElement>(".test-yaml")!.readOnly).toBe(true);
  });

  it("adds a node from the palette and closes it on Escape", async () => {
    await mountWorkspace();
    await click(button("Add node"));
    expect(container.querySelector(".flow-palette")).not.toBeNull();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(container.querySelector(".flow-palette")).toBeNull();

    await click(button("Add node"));
    await click(button("Branch", container.querySelector(".flow-palette")!));
    expect(container.querySelector(".flow-palette")).toBeNull();
    const def = useFlowEditorStore.getState().def!;
    expect(def.nodes.map((n) => n.id)).toEqual(["run", "done", "branch"]);
    expect(useFlowEditorStore.getState().selection).toEqual({ kind: "node", path: "nodes[2]" });
    await waitFor(() => expect(container.querySelectorAll(".react-flow__node").length).toBe(3));
  });

  it("closes the palette on an outside click", async () => {
    await mountWorkspace();
    await click(button("Add node"));
    expect(container.querySelector(".flow-palette")).not.toBeNull();
    await act(async () => {
      container.querySelector(".flow-workspace__name")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(container.querySelector(".flow-palette")).toBeNull();
  });

  describe("new flow", () => {
    const existing: FlowSummary = {
      path: ".mdium/flows/my-flow.flow.yaml",
      kind: "entry",
      params: {},
      outputs: [],
      id: "my-flow",
      name: "Mine",
      errorCount: 0,
      warningCount: 0,
    };

    async function openDialog() {
      await act(async () =>
        root.render(
          <>
            <FlowPanel />
            <FlowWorkspace />
          </>,
        ),
      );
      await waitFor(() => expect(container.querySelector(".flow-panel__new")).not.toBeNull());
      await waitFor(() => expect(callsTo("flow_list").length).toBeGreaterThan(0));
      await click(container.querySelector<HTMLElement>(".flow-panel__new")!);
      await waitFor(() => expect(dialog()).not.toBeNull());
      expect(container.querySelector(".flow-panel__new")!.textContent).toBe("New flow");
    }

    it("creates a new entry flow", async () => {
      await openDialog();
      await type(dialog()!.querySelector('[aria-label="File name"]')!, "my-flow");
      expect(dialog()!.querySelector<HTMLInputElement>('[aria-label="Flow ID"]')!.value).toBe("my-flow");
      routes.flow_list = () => [existing];
      await click(button("Create", dialog()!));
      await waitFor(() => expect(callsTo("flow_save")).toHaveLength(1));
      const saved = callsTo("flow_save")[0];
      expect(saved).toMatchObject({ projectRoot: FOLDER, path: ".mdium/flows/my-flow.flow.yaml", expectedSha256: null });
      expect(String(saved.content)).toContain("id: my-flow");
      await waitFor(() => expect(useFlowViewStore.getState().selected[FOLDER]).toBe(".mdium/flows/my-flow.flow.yaml"));
      expect(dialog()).toBeNull();
      await waitFor(() => expect(callsTo("flow_list").length).toBeGreaterThan(1));
      await waitFor(() => expect(container.textContent).toContain("Mine"));
      expect(useFlowEditorStore.getState().dirty).toBe(false);
    });

    it("creates a part under lib/", async () => {
      await openDialog();
      await type(dialog()!.querySelector('[aria-label="File name"]')!, "helper");
      const location = dialog()!.querySelector<HTMLSelectElement>('[aria-label="Location"]')!;
      await act(async () => {
        setNativeValue(location, "part");
        location.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await type(dialog()!.querySelector('[aria-label="Display name"]')!, "Helper");
      await click(button("Create", dialog()!));
      await waitFor(() => expect(callsTo("flow_save")).toHaveLength(1));
      const saved = callsTo("flow_save")[0];
      expect(saved.path).toBe(".mdium/flows/lib/helper.flow.yaml");
      expect(String(saved.content)).toContain("name: Helper");
    });

    it("refuses an existing path", async () => {
      routes.flow_list = () => [existing];
      await openDialog();
      await type(dialog()!.querySelector('[aria-label="File name"]')!, "my-flow");
      expect(dialog()!.textContent).toContain("A flow file with that name already exists.");
      const create = button("Create", dialog()!);
      expect(create.disabled).toBe(true);
      await click(create);
      expect(callsTo("flow_save")).toHaveLength(0);
    });
  });
});
