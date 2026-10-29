// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/shared/i18n";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => []),
}));

import { FtpConnectDialog } from "../FtpConnectDialog";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("FtpConnectDialog", () => {
  let root: ReturnType<typeof createRoot>;
  let container: HTMLDivElement;

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("stays open when clicking outside the dialog", async () => {
    const onClose = vi.fn();
    await act(async () =>
      root.render(<FtpConnectDialog open onClose={onClose} initialKey={null} onConnected={() => {}} />),
    );

    const overlay = container.querySelector(".ftp-dialog__overlay")!;
    await act(async () => {
      overlay.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      overlay.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onClose).not.toHaveBeenCalled();
    expect(container.querySelector(".ftp-dialog")).not.toBeNull();
  });

  it("still closes with Escape", async () => {
    const onClose = vi.fn();
    await act(async () =>
      root.render(<FtpConnectDialog open onClose={onClose} initialKey={null} onConnected={() => {}} />),
    );

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
