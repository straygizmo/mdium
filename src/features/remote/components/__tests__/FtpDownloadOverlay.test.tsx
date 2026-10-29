// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/shared/i18n";

let resolveOpen: (root: string) => void = () => {};
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => new Promise<string>((resolve) => { resolveOpen = resolve; })),
}));

import { useFtpMirrorStore } from "@/stores/ftp-mirror-store";
import { FtpDownloadOverlay } from "../FtpDownloadOverlay";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("FtpDownloadOverlay", () => {
  let root: ReturnType<typeof createRoot>;
  let container: HTMLDivElement;

  beforeEach(async () => {
    await i18n.changeLanguage("ja");
    container = document.createElement("div");
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    useFtpMirrorStore.setState({ mirrors: {}, statuses: {}, opening: null });
    await i18n.changeLanguage("en");
  });

  it("shows the downloading message while a mirror is opened and hides it afterwards", async () => {
    await act(async () => root.render(<FtpDownloadOverlay />));
    expect(container.querySelector(".ftp-download-overlay")).toBeNull();

    let opened: Promise<string> = Promise.resolve("");
    await act(async () => {
      opened = useFtpMirrorStore.getState().open("ftp://example.com/docs");
    });
    const overlay = container.querySelector(".ftp-download-overlay");
    expect(overlay?.textContent).toContain("ローカルにダウンロード中です…");
    expect(overlay?.textContent).toContain("ftp://example.com/docs");

    await act(async () => {
      useFtpMirrorStore.setState({
        statuses: {
          "C:/m": {
            root: "C:/m", uri: "ftp://example.com/docs", syncing: true, lastSync: null, error: null,
            fileErrors: [], conflicts: [], pendingDeletes: [], progress: { done: 3, total: 10 },
          },
        },
      });
    });
    expect(container.querySelector(".ftp-download-overlay")?.textContent).toContain("3/10");

    await act(async () => {
      resolveOpen("C:/m");
      await opened;
    });
    expect(container.querySelector(".ftp-download-overlay")).toBeNull();
  });
});
