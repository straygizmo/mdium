import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the Tauri invoke bridge and the global i18n instance so the helper can
// be exercised in a plain node test env without a real backend.
const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));
vi.mock("@/shared/i18n", () => ({
  default: { t: (key: string) => key },
}));

import { ensureCommand, NODE_INSTALL_URL } from "../ensureCommand";

const OPTS = {
  messageKey: "nodeNotFound",
  promptKey: "openInstallGuide",
  installUrl: NODE_INSTALL_URL,
};

const confirmMock = vi.fn();

describe("ensureCommand", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    confirmMock.mockReset();
    vi.stubGlobal("confirm", confirmMock);
  });

  it("returns true and does not prompt when the command exists", async () => {
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "check_command_exists" ? Promise.resolve(true) : Promise.resolve(),
    );
    confirmMock.mockReturnValue(false);

    const result = await ensureCommand("node", OPTS);

    expect(result).toBe(true);
    expect(confirmMock).not.toHaveBeenCalled();
    expect(invokeMock).toHaveBeenCalledWith("check_command_exists", { name: "node" });
  });

  it("opens the install guide when missing and the user confirms", async () => {
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "check_command_exists" ? Promise.resolve(false) : Promise.resolve(),
    );
    confirmMock.mockReturnValue(true);

    const result = await ensureCommand("node", OPTS);

    expect(result).toBe(false);
    expect(invokeMock).toHaveBeenCalledWith("open_external_url", { url: NODE_INSTALL_URL });
  });

  it("does not open the guide when missing and the user cancels", async () => {
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "check_command_exists" ? Promise.resolve(false) : Promise.resolve(),
    );
    confirmMock.mockReturnValue(false);

    const result = await ensureCommand("node", OPTS);

    expect(result).toBe(false);
    expect(invokeMock).not.toHaveBeenCalledWith("open_external_url", expect.anything());
  });

  it("treats a failing check as missing (safe side) and returns false", async () => {
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "check_command_exists"
        ? Promise.reject(new Error("boom"))
        : Promise.resolve(),
    );
    confirmMock.mockReturnValue(false);

    const result = await ensureCommand("node", OPTS);

    expect(result).toBe(false);
  });
});
