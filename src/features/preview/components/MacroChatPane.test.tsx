// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { listen } from "@tauri-apps/api/event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MacroChatPane } from "./MacroChatPane";
import { useMacroChatStore } from "@/stores/macro-chat-store";
import i18n from "@/shared/i18n";
import { useChatUIStore } from "@/features/opencode-config/hooks/useOpencodeChat";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn(), open: vi.fn() }));
vi.mock("@tauri-apps/plugin-fs", () => ({ readFile: vi.fn(), exists: vi.fn() }));

const doConnect = vi.fn().mockResolvedValue(undefined);
const doLoadSession = vi.fn().mockResolvedValue(undefined);
const doCreateNewSession = vi.fn().mockResolvedValue(undefined);
const waitForConnection = vi.fn().mockResolvedValue(undefined);
vi.mock("@/features/opencode-config/hooks/useOpencodeChat", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/opencode-config/hooks/useOpencodeChat")>();
  return {
    ...actual,
    doConnect: (...a: unknown[]) => doConnect(...a),
    doLoadSession: (...a: unknown[]) => doLoadSession(...a),
    doCreateNewSession: (...a: unknown[]) => doCreateNewSession(...a),
    waitForConnection: (...a: unknown[]) => waitForConnection(...a),
  };
});
// Props of the last rendered OpencodeChat, so tests can drive onBeforeSend.
let chatProps: { onBeforeSend?: () => Promise<boolean> } = {};
vi.mock("@/features/opencode-config/components/OpencodeChat", () => ({
  OpencodeChat: (props: { header: React.ReactNode; onBeforeSend?: () => Promise<boolean> }) => {
    chatProps = props;
    return <div data-testid="chat">{props.header}</div>;
  },
}));

const props = { filePath: "C:/project/book.xlsm", fileName: "book.xlsm", folderPath: "C:/project" };
const listOk = {
  xlsmPath: props.filePath,
  macrosDir: "C:/project/book_assets/macros",
  extracted: true,
  locked: false,
  modules: [
    { name: "Module1", moduleType: "standard", path: "C:/project/book_assets/macros/Module1.bas" },
    { name: "ThisWorkbook", moduleType: "document", path: null },
  ],
};

async function render(ui: React.ReactElement) {
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => root.render(ui));
  return { container, unmount: () => act(async () => root.unmount()) };
}

describe("MacroChatPane", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    invoke.mockReset();
    doConnect.mockClear();
    doLoadSession.mockReset();
    // A successful load leaves the loaded id as the current session.
    doLoadSession.mockImplementation(async (id: string) => {
      useChatUIStore.setState({ currentSessionId: id });
    });
    doCreateNewSession.mockClear();
    waitForConnection.mockReset();
    waitForConnection.mockResolvedValue(undefined);
    chatProps = {};
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "list_vba_modules") return listOk;
      if (cmd === "check_workbook_lock") return { locked: false, reason: null };
      return null;
    });
    useMacroChatStore.setState({ sessionByWorkbook: {}, lockedByWorkbook: {} });
    useChatUIStore.setState({ currentSessionId: null });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("lists modules with kinds and marks extracted ones", async () => {
    const { container, unmount } = await render(<MacroChatPane {...props} />);
    const items = [...container.querySelectorAll(".macro-chat__module")].map((n) => n.textContent);
    expect(items[0]).toContain("Module1");
    expect(container.querySelectorAll(".macro-chat__module--extracted").length).toBe(1);
    await unmount();
  });

  it("creates a new session when the workbook has none, and records the id once sent", async () => {
    const { unmount } = await render(<MacroChatPane {...props} />);
    expect(doConnect).toHaveBeenCalledWith("C:/project");
    expect(doCreateNewSession).toHaveBeenCalledTimes(1);
    expect(doLoadSession).not.toHaveBeenCalled();
    await act(async () => useChatUIStore.setState({ currentSessionId: "ses_new" }));
    expect(useMacroChatStore.getState().getSession(props.filePath)).toBe("ses_new");
    await unmount();
  });

  it("loads the bound session when one exists", async () => {
    useMacroChatStore.getState().setSession(props.filePath, "ses_old");
    const { unmount } = await render(<MacroChatPane {...props} />);
    expect(doLoadSession).toHaveBeenCalledWith("ses_old");
    expect(doCreateNewSession).not.toHaveBeenCalled();
    await unmount();
  });

  it("falls back to a new session when the bound session does not load", async () => {
    useMacroChatStore.getState().setSession(props.filePath, "ses_gone");
    // doLoadSession resolves without error but leaves currentSessionId unchanged.
    doLoadSession.mockImplementationOnce(async () => {});
    const { unmount } = await render(<MacroChatPane {...props} />);
    expect(doLoadSession).toHaveBeenCalledWith("ses_gone");
    expect(doCreateNewSession).toHaveBeenCalledTimes(1);
    expect(useMacroChatStore.getState().getSession(props.filePath)).toBeNull();
    await unmount();
  });

  it("keeps the binding when the bound session loads", async () => {
    useMacroChatStore.getState().setSession(props.filePath, "ses_ok");
    const { unmount } = await render(<MacroChatPane {...props} />);
    expect(doCreateNewSession).not.toHaveBeenCalled();
    expect(useMacroChatStore.getState().getSession(props.filePath)).toBe("ses_ok");
    await unmount();
  });

  it("records the session started by new chat after a loaded bind", async () => {
    useMacroChatStore.getState().setSession(props.filePath, "ses_old");
    const { container, unmount } = await render(<MacroChatPane {...props} />);
    const btn = container.querySelector<HTMLButtonElement>(".macro-chat__new-chat")!;
    await act(async () => btn.click());
    await act(async () => useChatUIStore.setState({ currentSessionId: "ses_new" }));
    expect(useMacroChatStore.getState().getSession(props.filePath)).toBe("ses_new");
    await unmount();
  });

  it("does not bind a late-loading session of one workbook to another", async () => {
    const other = { filePath: "C:/project/other.xlsm", fileName: "other.xlsm", folderPath: "C:/project" };
    useMacroChatStore.getState().setSession(props.filePath, "ses_A");
    let resolveLoad!: () => void;
    doLoadSession.mockImplementationOnce(() => new Promise<void>((r) => { resolveLoad = r; }));
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => root.render(<MacroChatPane {...props} />));
    await act(async () => root.render(<MacroChatPane {...other} />));
    await act(async () => {
      resolveLoad();
      useChatUIStore.setState({ currentSessionId: "ses_A" });
    });
    expect(useMacroChatStore.getState().getSession(other.filePath)).toBeNull();
    expect(useMacroChatStore.getState().getSession(props.filePath)).toBe("ses_A");
    await act(async () => root.unmount());
  });

  it("removes the vba-pushed listener when it resolves after unmount", async () => {
    const unlisten = vi.fn();
    let resolveListen!: (fn: () => void) => void;
    vi.mocked(listen).mockImplementationOnce(() => new Promise((r) => { resolveListen = r; }));
    const { unmount } = await render(<MacroChatPane {...props} />);
    await unmount();
    expect(unlisten).not.toHaveBeenCalled();
    await act(async () => resolveListen(unlisten));
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("new chat button clears the binding and starts a fresh session", async () => {
    useMacroChatStore.getState().setSession(props.filePath, "ses_old");
    const { container, unmount } = await render(<MacroChatPane {...props} />);
    const btn = container.querySelector<HTMLButtonElement>(".macro-chat__new-chat")!;
    await act(async () => btn.click());
    expect(useMacroChatStore.getState().getSession(props.filePath)).toBeNull();
    expect(doCreateNewSession).toHaveBeenCalledTimes(1);
    await unmount();
  });

  it("shows the lock banner, re-checks every 5 seconds, and hides it when unlocked", async () => {
    let locked = true;
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "list_vba_modules") return { ...listOk, locked };
      if (cmd === "check_workbook_lock") return { locked, reason: locked ? "owner_file" : null };
      return null;
    });
    const { container, unmount } = await render(<MacroChatPane {...props} />);
    expect(container.querySelector(".macro-chat__lock")).not.toBeNull();
    expect(useMacroChatStore.getState().isLocked(props.filePath)).toBe(true);
    locked = false;
    await act(async () => { await vi.advanceTimersByTimeAsync(5100); });
    expect(container.querySelector(".macro-chat__lock")).toBeNull();
    expect(useMacroChatStore.getState().isLocked(props.filePath)).toBe(false);
    await unmount();
  });

  it("shows a hint instead of the chat when no folder is open", async () => {
    const { container, unmount } = await render(<MacroChatPane {...props} folderPath={null} />);
    expect(container.querySelector(".macro-chat__needs-folder")).not.toBeNull();
    expect(container.querySelector('[data-testid="chat"]')).toBeNull();
    expect(doConnect).not.toHaveBeenCalled();
    await unmount();
  });

  it("reports a workbook without macros instead of failing", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "list_vba_modules") throw new Error(JSON.stringify({ error: "no_vba_project", message: "No VBA macros" }));
      if (cmd === "check_workbook_lock") return { locked: false, reason: null };
      return null;
    });
    const { container, unmount } = await render(<MacroChatPane {...props} />);
    expect(container.querySelector(".macro-chat__no-macros")).not.toBeNull();
    expect(container.querySelectorAll(".macro-chat__module").length).toBe(0);
    await unmount();
  });

  it("waits for the connection before loading the bound session", async () => {
    useMacroChatStore.getState().setSession(props.filePath, "ses_old");
    let connect!: () => void;
    waitForConnection.mockImplementationOnce(() => new Promise<void>((r) => { connect = r; }));
    const { unmount } = await render(<MacroChatPane {...props} />);
    expect(waitForConnection).toHaveBeenCalledWith("C:/project", expect.any(AbortSignal));
    expect(doLoadSession).not.toHaveBeenCalled();
    expect(doCreateNewSession).not.toHaveBeenCalled();
    await act(async () => connect());
    expect(doLoadSession).toHaveBeenCalledWith("ses_old");
    expect(doCreateNewSession).not.toHaveBeenCalled();
    expect(useMacroChatStore.getState().getSession(props.filePath)).toBe("ses_old");
    await unmount();
  });

  it("stops waiting for the connection on unmount", async () => {
    waitForConnection.mockImplementationOnce(() => new Promise<void>(() => {}));
    const { unmount } = await render(<MacroChatPane {...props} />);
    const signal = waitForConnection.mock.calls[0][1] as AbortSignal;
    expect(signal.aborted).toBe(false);
    await unmount();
    expect(signal.aborted).toBe(true);
  });

  it("re-checks the lock before sending and blocks the send while locked", async () => {
    let locked = false;
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "list_vba_modules") return listOk;
      if (cmd === "check_workbook_lock") return { locked, reason: locked ? "write_denied" : null };
      return null;
    });
    const { container, unmount } = await render(<MacroChatPane {...props} />);
    expect(container.querySelector(".macro-chat__lock")).toBeNull();

    locked = true;
    let allowed: boolean | undefined;
    await act(async () => { allowed = await chatProps.onBeforeSend!(); });
    expect(allowed).toBe(false);
    expect(container.querySelector(".macro-chat__lock")).not.toBeNull();

    locked = false;
    await act(async () => { allowed = await chatProps.onBeforeSend!(); });
    expect(allowed).toBe(true);
    expect(container.querySelector(".macro-chat__lock")).toBeNull();
    await unmount();
  });

  it("shows translated module kinds", async () => {
    const { container, unmount } = await render(<MacroChatPane {...props} />);
    const kinds = [...container.querySelectorAll(".macro-chat__module small")].map((n) => n.textContent);
    const standard = i18n.t("macroChatModuleTypeStandard", { ns: "editor" });
    const document = i18n.t("macroChatModuleTypeDocument", { ns: "editor" });
    expect(standard).not.toBe("macroChatModuleTypeStandard");
    expect(kinds).toEqual([standard, document]);
    await unmount();
  });
});
