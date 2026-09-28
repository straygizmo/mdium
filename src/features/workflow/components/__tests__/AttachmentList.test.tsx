// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AttachmentMeta } from "@/shared/types/workflow";

vi.mock("../../lib/workflow-api", () => ({
  workflowApi: {
    listAttachments: vi.fn(),
    attachmentPath: vi.fn(),
  },
  subscribeWorkflowEvents: vi.fn(),
}));
vi.mock("@/stores/dialog-store", () => ({ showMessage: vi.fn() }));
const readFile = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/plugin-fs", () => ({ readFile }));
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import i18n from "@/shared/i18n";
import { showMessage } from "@/stores/dialog-store";
import { workflowApi } from "../../lib/workflow-api";
import { AttachmentList, attachmentDirectory, formatSize } from "../AttachmentList";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ROOT = "C:\\work\\app";
const api = vi.mocked(workflowApi);

function attachment(id: string, originalName: string, mime: string, size = 2048): AttachmentMeta {
  return {
    schemaVersion: 1,
    id,
    originalName,
    storedName: originalName,
    mime,
    size,
    sha256: "x",
    createdAt: "2026-09-01T00:00:00Z",
  };
}

describe("AttachmentList", () => {
  let root: ReturnType<typeof createRoot> | undefined;
  let container: HTMLDivElement;
  let createSpy: ReturnType<typeof vi.spyOn>;
  let revokeSpy: ReturnType<typeof vi.spyOn>;
  const created: string[] = [];

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    vi.clearAllMocks();
    created.length = 0;
    createSpy = vi.spyOn(URL, "createObjectURL").mockImplementation(() => {
      const url = `blob:thumb-${created.length}`;
      created.push(url);
      return url;
    });
    revokeSpy = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    api.attachmentPath.mockImplementation(async (_root, taskId, id) => `C:\\work\\app\\.mdium\\att\\${taskId}\\${id}.bin`);
    readFile.mockResolvedValue(new Uint8Array([1, 2, 3]));
    invoke.mockResolvedValue(undefined);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root?.unmount());
    container.remove();
    createSpy.mockRestore();
    revokeSpy.mockRestore();
  });

  async function render(rootTaskId = "t1", fromRoot = false) {
    await act(async () => root!.render(<AttachmentList root={ROOT} rootTaskId={rootTaskId} fromRootTask={fromRoot} />));
  }

  function items() {
    return [...container.querySelectorAll<HTMLElement>(".workflow-attachments__item")];
  }

  it("lists the attachments with size, type and image thumbnails, and revokes the URLs on unmount", async () => {
    api.listAttachments.mockResolvedValue([
      attachment("a1", "screen.png", "image/png", 3 * 1024 * 1024),
      attachment("a2", "notes.txt", "text/plain", 12),
    ]);
    await render();
    expect(api.listAttachments).toHaveBeenCalledWith(ROOT, "t1");
    const list = items();
    expect(list).toHaveLength(2);
    expect(list[0].textContent).toContain("screen.png");
    expect(list[0].textContent).toContain(formatSize(3 * 1024 * 1024));
    expect(list[0].textContent).toContain("image/png");
    expect(list[1].textContent).toContain(formatSize(12));
    // Only images get a thumbnail, read with the fs plugin into a blob URL.
    expect(api.attachmentPath).toHaveBeenCalledWith(ROOT, "t1", "a1");
    expect(readFile).toHaveBeenCalledWith("C:\\work\\app\\.mdium\\att\\t1\\a1.bin");
    expect(readFile).toHaveBeenCalledTimes(1);
    expect(list[0].querySelector("img")?.getAttribute("src")).toBe("blob:thumb-0");
    expect(list[1].querySelector("img")).toBeNull();

    await act(async () => root!.unmount());
    root = undefined;
    expect(revokeSpy).toHaveBeenCalledWith("blob:thumb-0");
  });

  it("revokes a thumbnail that finishes loading after unmount", async () => {
    let resolveBytes!: (v: Uint8Array) => void;
    readFile.mockReturnValue(new Promise((r) => (resolveBytes = r)));
    api.listAttachments.mockResolvedValue([attachment("a1", "screen.png", "image/png")]);
    await render();
    await act(async () => root!.unmount());
    root = undefined;
    await act(async () => resolveBytes(new Uint8Array([1])));
    expect(createSpy.mock.calls.length).toBe(revokeSpy.mock.calls.length);
  });

  it("renders nothing without attachments", async () => {
    api.listAttachments.mockResolvedValue([]);
    await render();
    expect(container.querySelector('[data-section="attachments"]')).toBeNull();
  });

  it("labels the root task's attachments on a child task", async () => {
    api.listAttachments.mockResolvedValue([attachment("a1", "notes.txt", "text/plain")]);
    await render("t1", true);
    expect(container.textContent).toContain(i18n.t("workflow:intake.attachments.rootTask"));
  });

  it("shows a load failure", async () => {
    api.listAttachments.mockRejectedValue({ code: "WORKFLOW_IO", message: "denied" });
    await render();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      i18n.t("workflow:intake.attachments.loadFailed"),
    );
  });

  it("opens the attachment's directory for show in folder", async () => {
    api.listAttachments.mockResolvedValue([attachment("a2", "notes.txt", "text/plain")]);
    await render();
    const button = container.querySelector<HTMLButtonElement>('button[data-action="showInFolder"]')!;
    expect(button.textContent).toBe(i18n.t("workflow:intake.attachments.showInFolder"));
    await act(async () => button.click());
    expect(api.attachmentPath).toHaveBeenCalledWith(ROOT, "t1", "a2");
    expect(invoke).toHaveBeenCalledWith("open_external_url", { url: "C:\\work\\app\\.mdium\\att\\t1" });
  });

  it("disables show in folder while it runs and reports failures", async () => {
    api.listAttachments.mockResolvedValue([attachment("a2", "notes.txt", "text/plain")]);
    let reject!: (e: unknown) => void;
    invoke.mockReturnValue(new Promise((_, r) => (reject = r)));
    await render();
    const button = container.querySelector<HTMLButtonElement>('button[data-action="showInFolder"]')!;
    await act(async () => button.click());
    expect(button.disabled).toBe(true);
    await act(async () => reject("Failed to open URL"));
    expect(button.disabled).toBe(false);
    expect(showMessage).toHaveBeenCalledWith(
      expect.stringContaining("Failed to open URL"),
      expect.objectContaining({ kind: "error" }),
    );
  });

  it("formats sizes with localized units", () => {
    expect(formatSize(12)).toBe(i18n.t("workflow:intake.attachments.sizeBytes", { size: "12" }));
    expect(formatSize(1536)).toBe(i18n.t("workflow:intake.attachments.sizeKB", { size: "1.5" }));
    expect(formatSize(3 * 1024 * 1024)).toBe(i18n.t("workflow:intake.attachments.sizeMB", { size: "3" }));
  });

  it("derives the directory of Windows and POSIX paths", () => {
    expect(attachmentDirectory("C:\\a\\b\\c.bin")).toBe("C:\\a\\b");
    expect(attachmentDirectory("/a/b/c.bin")).toBe("/a/b");
    expect(attachmentDirectory("c.bin")).toBeNull();
  });
});
