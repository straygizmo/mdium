// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/shared/i18n";
import type { FlowDef, FlowNode, FlowSummary, Manifest, ProjectLoadResult } from "@/shared/types/flow";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({
  invoke,
  convertFileSrc: vi.fn((p: string, proto: string) => `${proto}://${p}`),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

import { NodePalette } from "../NodePalette";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ROOT = "C:\\proj";
const ENTRY = ".mdium/flows/main.flow.yaml";

const emptyDef: FlowDef = { schemaVersion: 1, id: "f", name: "F", nodes: [], edges: [] };

const manifest: Manifest = {
  module: "demo",
  stages: [
    {
      name: "demo.add",
      inputs: {
        a: { type: "number", required: true },
        b: { type: "number", required: false, default: 1 },
        // Optional without a default: left out of `with`.
        c: { type: "number", required: false },
      },
      outputs: {},
      artifacts: [],
    },
  ],
};

const project: ProjectLoadResult = {
  exists: true,
  path: ".mdium/project.yaml",
  sha256: "abc",
  project: {
    schemaVersion: 1,
    runtimes: { demo: { kind: "python", python: "python", module: "demo", cwd: "." } },
  } as unknown as ProjectLoadResult["project"],
  errors: [],
  warnings: [],
};

const parts: FlowSummary[] = [
  {
    path: ".mdium/flows/lib/per-doc.flow.yaml",
    kind: "part",
    id: "per-doc",
    name: "Per doc",
    params: {
      doc: { type: "path", required: true },
      // Optional without a default: left out of `params`; with a default: filled in.
      lang: { type: "string", required: false },
      depth: { type: "number", default: 2 },
    },
    outputs: ["summary"],
    errorCount: 0,
    warningCount: 0,
  },
];

function route(handlers: Record<string, (args: Record<string, unknown>) => unknown>) {
  invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
    const handler = handlers[command];
    if (!handler) throw { code: "FLOW_COMMAND_FAILED", message: `unexpected ${command}` };
    return handler(args);
  });
}

async function waitFor(check: () => void, timeoutMs = 3000) {
  const start = Date.now();
  for (;;) {
    try {
      check();
      return;
    } catch (err) {
      if (Date.now() - start > timeoutMs) throw err;
      await act(async () => {
        await new Promise((r) => setTimeout(r, 10));
      });
    }
  }
}

let host: HTMLDivElement;
let root: Root;

async function mount(props: Partial<React.ComponentProps<typeof NodePalette>> = {}) {
  const onAdd = vi.fn<(node: FlowNode) => void>();
  await act(async () => {
    root.render(
      <NodePalette
        projectRoot={ROOT}
        currentFile={ENTRY}
        def={emptyDef}
        parts={[]}
        project={null}
        onAdd={onAdd}
        onClose={() => {}}
        {...props}
      />,
    );
  });
  return onAdd;
}

function button(text: string): HTMLButtonElement {
  const found = Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.includes(text));
  if (!found) throw new Error(`no button "${text}" in: ${host.textContent}`);
  return found as HTMLButtonElement;
}

async function click(el: HTMLElement) {
  await act(async () => {
    el.click();
  });
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
  invoke.mockReset();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("NodePalette", () => {
  it("adds a command node with a unique id", async () => {
    const onAdd = await mount();
    await click(button("Command"));
    expect(onAdd).toHaveBeenCalledWith({ id: "command", kind: "command", run: [""], shell: false, protocol: "mdium-v1" });

    onAdd.mockClear();
    const taken: FlowDef = {
      ...emptyDef,
      nodes: [{ id: "command", kind: "command", run: ["x"], shell: false, protocol: "mdium-v1" }],
    };
    await mount({ def: taken, onAdd });
    await click(button("Command"));
    expect(onAdd).toHaveBeenCalledWith(expect.objectContaining({ id: "command_2", kind: "command" }));
  });

  it("lists python stages from the manifest and adds one with its inputs", async () => {
    route({ flow_runtime_describe: () => manifest });
    const onAdd = await mount({ project });
    await waitFor(() => expect(host.textContent).toContain("demo.add"));
    expect(invoke).toHaveBeenCalledWith("flow_runtime_describe", { projectRoot: ROOT, runtime: "demo", sha256: "abc" });
    await click(button("demo.add"));
    expect(onAdd).toHaveBeenCalledWith({
      id: "demo_add",
      kind: "python",
      runtime: "demo",
      entry: "demo.add",
      with: { a: "", b: 1 },
    });
  });

  it("adds a loop with a file body chosen from the parts", async () => {
    const onAdd = await mount({ parts });
    await click(button("Loop"));
    await click(button("per-doc"));
    expect(onAdd).toHaveBeenCalledWith({
      id: "loop",
      kind: "loop",
      mode: "foreach",
      items: "${{ params.items }}",
      maxIterations: 10,
      body: "lib/per-doc.flow.yaml",
      params: { doc: "", depth: 2 },
    });
  });

  it("references a part by its bare file name from inside lib/", async () => {
    const onAdd = await mount({ parts, currentFile: ".mdium/flows/lib/other.flow.yaml" });
    await click(button("Sub-flow"));
    await click(button("per-doc"));
    expect(onAdd).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "subflow", flow: "per-doc.flow.yaml", params: { doc: "", depth: 2 } }),
    );
  });

  it("shows a notice when the project has no python runtime", async () => {
    await mount({ project: null });
    expect(host.textContent).toContain("No python runtime in project.yaml.");
    await mount({ project: { ...project, project: { schemaVersion: 1, runtimes: {} } as unknown as ProjectLoadResult["project"] } });
    expect(host.textContent).toContain("No python runtime in project.yaml.");
  });

  it("keeps the other entries usable when a describe fails", async () => {
    route({
      flow_runtime_describe: () => {
        throw { code: "FLOW_COMMAND_FAILED", message: "boom" };
      },
    });
    const onAdd = await mount({ project });
    await waitFor(() => expect(host.querySelector(".flow-palette__error")).not.toBeNull());
    await click(button("Approval"));
    expect(onAdd).toHaveBeenCalledWith({ id: "approval", kind: "approval" });
  });
});
