// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@/shared/i18n";
import { useChatUIStore } from "../hooks/useOpencodeChat";
import { useOpencodeUsageStore } from "@/stores/opencode-usage-store";
import { emptyTotals, type UsageTotals } from "@/stores/opencode-usage-core";
import { OpencodeUsagePopover } from "./OpencodeUsagePopover";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SESSION_ID = "session-1";

function setUsage(sessionId: string | null, totals = emptyTotals()) {
  useChatUIStore.setState({ currentSessionId: sessionId });
  useOpencodeUsageStore.setState({ days: {}, sessions: sessionId ? { [sessionId]: totals } : {}, messageContrib: {} });
}

describe("OpencodeUsagePopover", () => {
  let root: ReturnType<typeof createRoot> | undefined;
  let container: HTMLDivElement;

  beforeEach(() => {
    localStorage.removeItem("mdium-opencode-usage");
    setUsage(null);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root?.unmount());
    root = undefined;
    container.remove();
    setUsage(null);
    localStorage.removeItem("mdium-opencode-usage");
  });

  const render = () => act(async () => root?.render(<OpencodeUsagePopover />));

  it.each([
    ["no current session", null, emptyTotals()],
    ["zero cost", SESSION_ID, emptyTotals()],
    ["negative cost", SESSION_ID, { ...emptyTotals(), cost: -0.01 }],
    ["non-finite cost", SESSION_ID, { ...emptyTotals(), cost: Number.NaN }],
    ["tokens but zero cost", SESSION_ID, { ...emptyTotals(), input: 120, output: 45 }],
  ])("renders nothing for %s", async (_name, sessionId, totals) => {
    setUsage(sessionId, totals as UsageTotals);
    await render();
    expect(container.querySelector(".oc-chat__usage")).toBeNull();
    expect(container.textContent).toBe("");
  });

  it("shows only the formatted amount and opens the details popover", async () => {
    setUsage(SESSION_ID, { ...emptyTotals(), cost: 0.014, input: 120 });
    await render();

    const button = container.querySelector<HTMLButtonElement>(".oc-chat__usage-btn")!;
    expect(button.textContent).toBe("$0.014");
    expect(button.querySelector("svg")).toBeNull();
    expect(button.classList.contains("oc-chat__toolbar-btn")).toBe(false);
    expect(button.type).toBe("button");
    expect(button.getAttribute("aria-expanded")).toBe("false");

    await act(async () => button.click());
    expect(container.querySelector(".oc-chat__usage-popover")?.textContent).toContain("120");
    expect(button.getAttribute("aria-expanded")).toBe("true");

    await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
    expect(container.querySelector(".oc-chat__usage-popover")).toBeNull();
  });

  it("closes and stays closed when the cost becomes non-positive", async () => {
    setUsage(SESSION_ID, { ...emptyTotals(), cost: 0.014 });
    await render();
    await act(async () => container.querySelector<HTMLButtonElement>(".oc-chat__usage-btn")?.click());
    expect(container.querySelector(".oc-chat__usage-popover")).not.toBeNull();

    await act(async () => { useOpencodeUsageStore.setState({ sessions: { [SESSION_ID]: { ...emptyTotals(), output: 200 } } }); });
    expect(container.querySelector(".oc-chat__usage")).toBeNull();

    await act(async () => { useOpencodeUsageStore.setState({ sessions: { [SESSION_ID]: { ...emptyTotals(), cost: 0.014 } } }); });
    expect(container.querySelector(".oc-chat__usage-popover")).toBeNull();
    expect(container.querySelector(".oc-chat__usage-btn")?.getAttribute("aria-expanded")).toBe("false");
  });
});
