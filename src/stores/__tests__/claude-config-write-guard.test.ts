import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the app-wide error modal and the i18n instance the guard depends on.
const showMessage = vi.fn((_text: string, _opts?: { kind?: string }) => Promise.resolve());
vi.mock("@/stores/dialog-store", () => ({
  showMessage: (text: string, opts?: { kind?: string }) => showMessage(text, opts),
}));
vi.mock("@/shared/i18n", () => ({
  default: { t: (key: string) => key },
}));

import { guardWrite } from "../claude-config-write-guard";

beforeEach(() => {
  showMessage.mockClear();
});

describe("guardWrite", () => {
  it("returns the value and does not report on success", async () => {
    const result = await guardWrite(async () => 42);
    expect(result).toBe(42);
    expect(showMessage).not.toHaveBeenCalled();
  });

  it("reports an error modal once and re-throws on failure", async () => {
    const err = new Error("disk full");
    await expect(guardWrite(async () => { throw err; })).rejects.toBe(err);
    expect(showMessage).toHaveBeenCalledTimes(1);
    const [text, opts] = showMessage.mock.calls[0];
    expect(text).toContain("claude-config:saveFailed");
    expect(text).toContain("disk full");
    expect(opts).toEqual({ kind: "error" });
  });
});
