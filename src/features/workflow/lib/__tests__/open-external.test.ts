// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const showMessage = vi.hoisted(() => vi.fn());
vi.mock("@/stores/dialog-store", () => ({ showMessage }));

import i18n from "@/shared/i18n";
import { externalUrl, openExternal } from "../open-external";

describe("openExternal", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    vi.clearAllMocks();
  });

  it("opens a normalized http(s) URL in the external browser", async () => {
    invoke.mockResolvedValue(undefined);
    expect(await openExternal("HTTPS://Example.com/a", "workflow:intake.issue.openFailed")).toBe(true);
    expect(invoke).toHaveBeenCalledWith("open_external_url", { url: "https://example.com/a" });
    expect(showMessage).not.toHaveBeenCalled();
  });

  it("refuses other URLs and shows why under the given title", async () => {
    expect(await openExternal("file:///c:/x", "workflow:intake.issue.openFailed")).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
    expect(showMessage).toHaveBeenCalledWith("file:///c:/x", {
      title: i18n.t("workflow:intake.issue.openFailed"),
      kind: "error",
    });
  });

  it("shows a failure of the open command", async () => {
    invoke.mockRejectedValue({ code: "OPEN_FAILED", message: "no browser" });
    expect(await openExternal("https://example.com/", "workflow:intake.linkOpenFailed")).toBe(false);
    expect(showMessage).toHaveBeenCalledWith(expect.any(String), {
      title: i18n.t("workflow:intake.linkOpenFailed"),
      kind: "error",
    });
  });
});

describe("externalUrl", () => {
  it("accepts only absolute http(s) URLs", () => {
    expect(externalUrl("https://example.com/x")).toBe("https://example.com/x");
    expect(externalUrl("javascript:alert(1)")).toBeNull();
    expect(externalUrl("docs/a.md")).toBeNull();
  });
});
