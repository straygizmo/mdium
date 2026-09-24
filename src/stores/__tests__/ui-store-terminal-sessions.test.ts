import { beforeEach, describe, expect, it } from "vitest";
import { useUiStore } from "../ui-store";

describe("terminal sessions in ui store", () => {
  beforeEach(() => {
    useUiStore.setState({
      bottomTerminalVisible: false,
      terminalSessions: [],
      activeTerminalSessionId: null,
      activeTerminalSessionIdsByFolder: {},
    });
  });

  it("initializes one standard terminal per folder and restores it on revisit", () => {
    const store = useUiStore.getState();
    store.initializeTerminalSessions("C:/workspace");
    store.initializeTerminalSessions("C:/other");

    const { terminalSessions, activeTerminalSessionId } = useUiStore.getState();
    expect(terminalSessions).toHaveLength(2);
    expect(terminalSessions[0]).toMatchObject({ kind: "terminal", folderPath: "C:/workspace" });
    expect(terminalSessions[1]).toMatchObject({ kind: "terminal", folderPath: "C:/other" });
    expect(activeTerminalSessionId).toBe(terminalSessions[1].id);

    store.initializeTerminalSessions("C:/workspace");
    expect(useUiStore.getState().activeTerminalSessionId).toBe(terminalSessions[0].id);
    expect(useUiStore.getState().terminalSessions).toHaveLength(2);
  });

  it("appends duplicate kinds as separate sessions and shows the view", () => {
    const store = useUiStore.getState();
    store.addTerminalSession("codex", "C:/first");
    store.addTerminalSession("codex", "C:/second");

    const { terminalSessions, activeTerminalSessionId, bottomTerminalVisible } = useUiStore.getState();
    expect(terminalSessions.map((s) => s.kind)).toEqual(["codex", "codex"]);
    expect(new Set(terminalSessions.map((s) => s.id)).size).toBe(2);
    expect(activeTerminalSessionId).toBe(terminalSessions[1].id);
    expect(bottomTerminalVisible).toBe(true);
  });

  it("selects the right neighbor, then the left neighbor, when the active session closes", () => {
    const store = useUiStore.getState();
    store.addTerminalSession("claude-code", "C:/workspace");
    store.addTerminalSession("codex", "C:/workspace");
    store.addTerminalSession("opencode", "C:/workspace");
    const sessions = useUiStore.getState().terminalSessions;

    store.setActiveTerminalSession(sessions[1].id);
    store.removeTerminalSession(sessions[1].id);
    expect(useUiStore.getState().terminalSessions.map((s) => s.kind)).toEqual(["claude-code", "opencode"]);
    expect(useUiStore.getState().activeTerminalSessionId).toBe(sessions[2].id);

    store.removeTerminalSession(sessions[2].id);
    expect(useUiStore.getState().activeTerminalSessionId).toBe(sessions[0].id);

    store.removeTerminalSession(sessions[0].id);
    expect(useUiStore.getState().activeTerminalSessionId).toBeNull();
  });

  it("keeps each folder's selected terminal when switching folders", () => {
    const store = useUiStore.getState();
    store.addTerminalSession("terminal", "C:/first");
    store.addTerminalSession("codex", "C:/first");
    store.addTerminalSession("terminal", "C:/second");
    const sessions = useUiStore.getState().terminalSessions;

    store.setActiveTerminalSession(sessions[0].id);
    store.initializeTerminalSessions("C:/second");
    store.initializeTerminalSessions("C:/first");
    expect(useUiStore.getState().activeTerminalSessionId).toBe(sessions[0].id);
  });

  it("prunes sessions of closed folders and returns their ids", () => {
    const store = useUiStore.getState();
    store.addTerminalSession("terminal", "C:/kept");
    store.addTerminalSession("codex", "C:/closed");
    store.addTerminalSession("terminal", "");
    const [kept, closed, noFolder] = useUiStore.getState().terminalSessions;

    const removed = store.pruneTerminalSessions(["C:/kept"]);

    expect(removed).toEqual([closed.id]);
    expect(useUiStore.getState().terminalSessions.map((s) => s.id)).toEqual([kept.id, noFolder.id]);
    expect(useUiStore.getState().activeTerminalSessionIdsByFolder["C:/closed"]).toBeUndefined();
    expect(store.pruneTerminalSessions(["C:/kept"])).toEqual([]);
  });
});
