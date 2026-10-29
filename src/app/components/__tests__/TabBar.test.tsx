// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import i18n from "@/shared/i18n";
import { useTabStore } from "@/stores/tab-store";
import { useFtpMirrorStore } from "@/stores/ftp-mirror-store";
import { FolderTabBar } from "../TabBar";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("FolderTabBar", () => {
  let root: ReturnType<typeof createRoot>;
  let container: HTMLDivElement;

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    container = document.createElement("div");
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    useTabStore.setState({ openFolderPaths: [], activeFolderPath: null });
    useFtpMirrorStore.setState({ mirrors: {} });
  });

  it("marks FTP mirror folders with an FTP badge instead of the folder icon", async () => {
    useTabStore.setState({ openFolderPaths: ["C:/local", "C:/mirror"], activeFolderPath: "C:/local" });
    useFtpMirrorStore.setState({ mirrors: { "C:/mirror": "ftp://example.com/docs" } });

    await act(async () => root.render(<FolderTabBar />));

    const tabs = container.querySelectorAll(".tab-bar__tab--folder");
    expect(tabs).toHaveLength(2);
    expect(tabs[0].querySelector(".tab-bar__folder-icon")).not.toBeNull();
    expect(tabs[0].querySelector(".tab-bar__ftp-badge")).toBeNull();
    expect(tabs[1].querySelector(".tab-bar__ftp-badge")?.textContent).toBe("FTP");
    expect(tabs[1].querySelector(".tab-bar__folder-icon")).toBeNull();
    expect(tabs[1].getAttribute("title")).toBe("FTP folder: ftp://example.com/docs\nC:/mirror");
  });
});
