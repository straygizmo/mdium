import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FlowDef, FlowIssue, FlowLoadResult } from "@/shared/types/flow";
import { setFlowTransport, type FlowTransport } from "../lib/transport";
import { addNode, defaultsFor, emptyFlow } from "../lib/editor-state";
import { commentLossDue, droppedUnknownKeys, useFlowEditorStore } from "../editor-store";

const ROOT = "C:\\proj";
const PATH = ".mdium/flows/a.flow.yaml";
const TEXT = "# c\nschemaVersion: 1\nid: f\nname: F\nnodes: []\n";

const def: FlowDef = { schemaVersion: 1, id: "f", name: "F", nodes: [] };

function result(over: Partial<FlowLoadResult> = {}): FlowLoadResult {
  return {
    path: PATH,
    format: "yaml",
    kind: "entry",
    flow: def,
    errors: [],
    warnings: [],
    content: TEXT,
    sha256: "h1",
    ...over,
  };
}

type Handler = (args: Record<string, unknown>) => unknown;

let calls: Array<[string, Record<string, unknown>]>;
let routes: Record<string, Handler>;

function install() {
  const transport: FlowTransport = {
    call: async <T,>(command: string, args: Record<string, unknown>) => {
      calls.push([command, args]);
      const handler = routes[command];
      if (!handler) throw new Error(`unrouted ${command}`);
      return (await handler(args)) as T;
    },
    subscribe: async () => () => {},
    artifactUrl: async () => "",
    watchFolder: async () => () => {},
  };
  setFlowTransport(transport);
}

const callsTo = (command: string) => calls.filter(([c]) => c === command);

beforeEach(() => {
  vi.useFakeTimers();
  calls = [];
  routes = {
    flow_load: () => result(),
    flow_validate: () => result(),
    flow_save: () => result({ sha256: "h2" }),
  };
  install();
  useFlowEditorStore.getState().close();
});

afterEach(() => {
  useFlowEditorStore.getState().close();
  setFlowTransport(null);
  vi.useRealTimers();
});

const store = () => useFlowEditorStore.getState();

describe("editor store", () => {
  it("open loads text, def, issues and the comment flag", async () => {
    await store().open(ROOT, PATH);
    const s = store();
    expect(s.text).toBe(TEXT);
    expect(s.def).toEqual(def);
    expect(s.savedSha256).toBe("h1");
    expect(s.commentWarningPending).toBe(true);
    expect(s.dirty).toBe(false);
    expect(s.kind).toBe("entry");
    expect(s.loadError).toBeNull();
  });

  it("drops a node selection that no longer matches after a text edit removed a node", async () => {
    const three: FlowDef = {
      ...def,
      nodes: ["a", "b", "c"].map((id) => ({ id, ...defaultsFor("approval") }) as FlowDef["nodes"][number]),
    };
    routes.flow_load = () => result({ flow: three });
    await store().open(ROOT, PATH);
    store().selectMany(["nodes[1]", "nodes[2]"]);
    expect(store().selectedMany).toEqual(["nodes[1]", "nodes[2]"]);
    // The text edit removes node "a": nodes[1] and nodes[2] now name other nodes.
    const removed = { ...three, nodes: three.nodes.slice(1) };
    routes.flow_validate = () => result({ flow: removed });
    store().setText("edited");
    await vi.advanceTimersByTimeAsync(300);
    expect(store().selectedMany).toEqual([]);
    expect(store().selection).toBeNull();
  });

  it("select keeps the multi-selection when the node is part of it", async () => {
    await store().open(ROOT, PATH);
    store().selectMany(["nodes[0]", "nodes[1]"]);
    store().select({ kind: "node", path: "nodes[1]" });
    expect(store().selectedMany).toEqual(["nodes[0]", "nodes[1]"]);
    expect(store().selection).toEqual({ kind: "node", path: "nodes[1]" });
    store().select({ kind: "node", path: "nodes[2]" });
    expect(store().selectedMany).toEqual(["nodes[2]"]);
    store().select(null);
    expect(store().selectedMany).toEqual([]);
  });

  it("keeps the node selection when a text edit leaves the selected nodes in place", async () => {
    const two: FlowDef = {
      ...def,
      nodes: ["a", "b"].map((id) => ({ id, ...defaultsFor("approval") }) as FlowDef["nodes"][number]),
    };
    routes.flow_load = () => result({ flow: two });
    await store().open(ROOT, PATH);
    store().selectMany(["nodes[0]", "nodes[1]"]);
    routes.flow_validate = () => result({ flow: { ...two, name: "Renamed" } });
    store().setText("edited");
    await vi.advanceTimersByTimeAsync(300);
    expect(store().selectedMany).toEqual(["nodes[0]", "nodes[1]"]);
  });

  it("setText debounces validation and keeps the last decoded flow while the text is unparsable", async () => {
    await store().open(ROOT, PATH);
    const parseError: FlowIssue = { code: "FLOW_PARSE_FAILED", path: "", params: { message: "x", line: 1, column: 8 } };
    routes.flow_validate = () => result({ flow: null, errors: [parseError] });
    store().setText("nodes: [");
    expect(store().dirty).toBe(true);
    vi.advanceTimersByTime(299);
    expect(callsTo("flow_validate")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(callsTo("flow_validate")).toHaveLength(1);
    expect(callsTo("flow_validate")[0][1]).toMatchObject({ projectRoot: ROOT, path: PATH, content: "nodes: [" });
    expect(store().def).toEqual(def);
    expect(store().errors).toEqual([parseError]);
    expect(store().validating).toBe(false);
  });

  it("applyEdit serializes the edit into the text and validates", async () => {
    await store().open(ROOT, PATH);
    const next: FlowDef = { ...def, nodes: [{ id: "new_node", ...defaultsFor("approval") } as FlowDef["nodes"][number]] };
    routes.flow_validate = () => result({ flow: next });
    store().applyEdit((d) => addNode(d, { id: "new_node", ...defaultsFor("approval") } as FlowDef["nodes"][number]));
    expect(store().text).toContain("- id: new_node");
    expect(store().dirty).toBe(true);
    await vi.advanceTimersByTimeAsync(300);
    expect(callsTo("flow_validate")).toHaveLength(1);
    expect(store().def).toEqual(next);
  });

  it("save sends the saved hash, clears dirty, and reports external changes", async () => {
    await store().open(ROOT, PATH);
    store().setText(TEXT + "# more\n");
    await expect(store().save({})).resolves.toBe("saved");
    expect(callsTo("flow_save")[0][1]).toMatchObject({ expectedSha256: "h1" });
    expect(store().savedSha256).toBe("h2");
    expect(store().dirty).toBe(false);

    routes.flow_save = () => {
      throw { code: "FLOW_FILE_CHANGED", message: "changed" };
    };
    store().setText(TEXT + "# again\n");
    await expect(store().save({})).resolves.toBe("changed-outside");
    expect(store().externalChange).toBe(true);

    routes.flow_load = () => result({ sha256: "h3" });
    routes.flow_save = () => result({ sha256: "h4" });
    calls = [];
    await expect(store().save({ overwrite: true })).resolves.toBe("saved");
    expect(calls.map(([c]) => c)).toEqual(["flow_load", "flow_save"]);
    expect(callsTo("flow_save")[0][1]).toMatchObject({ expectedSha256: "h3" });
    expect(store().savedSha256).toBe("h4");
  });

  it("a new file saves with a null hash", async () => {
    store().openNew(ROOT, ".mdium/flows/lib/n.flow.yaml", emptyFlow("n", "N"));
    expect(store().savedSha256).toBeNull();
    expect(store().dirty).toBe(true);
    expect(store().kind).toBe("part");
    expect(store().text).toContain("id: n");
    await expect(store().save({})).resolves.toBe("saved");
    expect(callsTo("flow_save")[0][1]).toMatchObject({ path: ".mdium/flows/lib/n.flow.yaml", expectedSha256: null });
  });

  it("stays read-only when the file could not be read", async () => {
    routes.flow_load = () =>
      result({ content: "", flow: null, errors: [{ code: "FLOW_PARSE_FAILED", path: "", params: {} }] });
    await store().open(ROOT, PATH);
    expect(store().loadError).toBe("FLOW_PARSE_FAILED");
    store().setText("x: 1");
    expect(store().text).toBe("");
    expect(store().dirty).toBe(false);
    await expect(store().save({})).resolves.toBe("error");
    expect(callsTo("flow_save")).toHaveLength(0);
  });

  it("stays read-only for a file that is too large", async () => {
    routes.flow_load = () =>
      result({ errors: [{ code: "FLOW_FILE_TOO_LARGE", path: "", params: { size: 9, limit: 1 } }] });
    await store().open(ROOT, PATH);
    expect(store().loadError).toBe("FLOW_FILE_TOO_LARGE");
    store().applyEdit((d) => ({ ...d, name: "Z" }));
    expect(store().dirty).toBe(false);
    await expect(store().save({})).resolves.toBe("error");
  });

  it("applyEdit without a decoded flow is a no-op", async () => {
    routes.flow_load = () => result({ flow: null, errors: [{ code: "FLOW_PARSE_FAILED", path: "", params: {} }] });
    await store().open(ROOT, PATH);
    store().applyEdit((d) => ({ ...d, name: "Z" }));
    expect(store().text).toBe(TEXT);
    expect(store().dirty).toBe(false);
  });

  it("reload drops edits and markExternalChange flags the file", async () => {
    await store().open(ROOT, PATH);
    store().setText("edited: true\n");
    store().markExternalChange();
    expect(store().externalChange).toBe(true);
    await store().reload();
    expect(store().text).toBe(TEXT);
    expect(store().dirty).toBe(false);
    expect(store().externalChange).toBe(false);
  });

  it("a validation in flight for older text never overwrites newer state", async () => {
    await store().open(ROOT, PATH);
    const resolvers: Array<(r: FlowLoadResult) => void> = [];
    routes.flow_validate = () => new Promise<FlowLoadResult>((res) => resolvers.push(res));
    store().setText("a");
    await vi.advanceTimersByTimeAsync(300);
    expect(resolvers).toHaveLength(1);
    store().setText("b");
    expect(store().validating).toBe(true);
    resolvers[0](result({ flow: { ...def, name: "A" } }));
    await vi.advanceTimersByTimeAsync(0);
    expect(store().def?.name).toBe("F");
    expect(store().validating).toBe(true);
    await vi.advanceTimersByTimeAsync(300);
    expect(resolvers).toHaveLength(2);
    resolvers[1](result({ flow: { ...def, name: "B" } }));
    await vi.advanceTimersByTimeAsync(0);
    expect(store().def?.name).toBe("B");
    expect(store().validating).toBe(false);
  });

  it("an edit to a .flow.json file keeps it JSON", async () => {
    const jsonPath = ".mdium/flows/a.flow.json";
    const jsonText = `${JSON.stringify(def, null, 2)}\n`;
    routes.flow_load = () => result({ path: jsonPath, format: "json", content: jsonText });
    routes.flow_validate = () => result({ path: jsonPath, format: "json", content: jsonText });
    await store().open(ROOT, jsonPath);
    store().applyEdit((d) => ({ ...d, name: "Renamed" }));
    expect(store().text.startsWith("{")).toBe(true);
    expect(JSON.parse(store().text)).toMatchObject({ schemaVersion: 1, id: "f", name: "Renamed", nodes: [] });
    await vi.advanceTimersByTimeAsync(300);
    const content = callsTo("flow_validate")[0][1].content as string;
    expect(content.startsWith("{")).toBe(true);
  });

  it("refuses a structural edit while the typed text is not decoded", async () => {
    await store().open(ROOT, PATH);
    expect(store().defCurrent).toBe(true);
    const parseError: FlowIssue = { code: "FLOW_PARSE_FAILED", path: "", params: { message: "x", line: 1, column: 1 } };
    routes.flow_validate = () => result({ flow: null, errors: [parseError] });
    store().setText("nodes: [");
    expect(store().defCurrent).toBe(false);
    // Inside the debounce window and after the failed decode alike.
    store().applyEdit((d) => ({ ...d, name: "Z" }));
    expect(store().text).toBe("nodes: [");
    await vi.advanceTimersByTimeAsync(300);
    expect(store().defCurrent).toBe(false);
    store().applyEdit((d) => ({ ...d, name: "Z" }));
    expect(store().text).toBe("nodes: [");
    // Once the text decodes again, edits apply.
    routes.flow_validate = () => result();
    store().setText(TEXT);
    await vi.advanceTimersByTimeAsync(300);
    expect(store().defCurrent).toBe(true);
    store().applyEdit((d) => ({ ...d, name: "Z" }));
    expect(store().text).toContain("name: Z");
  });

  it("a CRLF file stays CRLF after a structural edit", async () => {
    routes.flow_load = () => result({ content: TEXT.replace(/\n/g, "\r\n") });
    await store().open(ROOT, PATH);
    store().applyEdit((d) => ({ ...d, name: "Z", description: "two\nlines" }));
    expect(store().text).toContain("\r\n");
    expect(store().text.replace(/\r\n/g, "")).not.toContain("\n");
  });

  it("warns about comment loss only when the comments are actually gone", async () => {
    await store().open(ROOT, PATH);
    expect(commentLossDue(store())).toBe(false);
    store().setText(`${TEXT}# another\n`);
    expect(commentLossDue(store())).toBe(false);
    store().setText("schemaVersion: 1\nid: f\nname: F\nnodes: []\n");
    expect(commentLossDue(store())).toBe(true);
  });

  it("lists the unknown keys on disk that the text no longer has", async () => {
    const unknown: FlowIssue = { code: "FLOW_UNKNOWN_KEY", path: "labels", params: { key: "labels" } };
    routes.flow_load = () => result({ warnings: [unknown] });
    await store().open(ROOT, PATH);
    expect(droppedUnknownKeys(store())).toEqual([]);
    routes.flow_validate = () => result({ warnings: [] });
    store().applyEdit((d) => ({ ...d, name: "Z" }));
    await vi.advanceTimersByTimeAsync(300);
    expect(droppedUnknownKeys(store())).toEqual(["labels"]);
  });

  it("a file deleted outside raises the notice and overwrite re-creates it", async () => {
    await store().open(ROOT, PATH);
    routes.flow_load = () => {
      throw { code: "FLOW_FILE_NOT_FOUND", message: PATH };
    };
    await store().syncWithDisk();
    expect(store().externalChange).toBe(true);
    expect(store().externalDeleted).toBe(true);
    calls = [];
    await expect(store().save({ overwrite: true })).resolves.toBe("saved");
    expect(callsTo("flow_save")[0][1]).toMatchObject({ expectedSha256: null });
    expect(store().externalChange).toBe(false);
    expect(store().externalDeleted).toBe(false);
  });

  it("a plain save of a deleted file raises the deleted notice", async () => {
    await store().open(ROOT, PATH);
    store().setText(`${TEXT}# x\n`);
    routes.flow_save = () => {
      throw { code: "FLOW_FILE_NOT_FOUND", message: PATH };
    };
    await expect(store().save({})).resolves.toBe("changed-outside");
    expect(store().externalDeleted).toBe(true);
  });

  it("overwriting a file that became too large reports an error instead of looping", async () => {
    await store().open(ROOT, PATH);
    routes.flow_load = () =>
      result({ content: "", sha256: "e3b0", errors: [{ code: "FLOW_FILE_TOO_LARGE", path: "", params: {} }] });
    await expect(store().save({ overwrite: true })).resolves.toBe("error");
    expect(store().saveError).toBe("FLOW_FILE_TOO_LARGE");
    expect(callsTo("flow_save")).toHaveLength(0);
  });

  it("syncWithDisk reloads a clean editor whose file changed and flags a dirty one", async () => {
    await store().open(ROOT, PATH);
    routes.flow_load = () => result({ sha256: "h9", content: `${TEXT}# new\n` });
    await store().syncWithDisk();
    expect(store().savedSha256).toBe("h9");
    expect(store().text).toBe(`${TEXT}# new\n`);
    store().setText("edited: true\n");
    routes.flow_load = () => result({ sha256: "h10" });
    await store().syncWithDisk();
    expect(store().externalChange).toBe(true);
    expect(store().externalDeleted).toBe(false);
    expect(store().text).toBe("edited: true\n");
  });
});
