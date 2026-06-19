import { describe, it, expect, vi, beforeEach } from "vitest";
import { useTabStore } from "../tab-store";

function seedImageTab() {
  useTabStore.setState({
    tabs: [
      {
        id: "t1",
        title: "img.png",
        filePath: "/img.png",
        content: "",
        dirty: false,
        imageFileType: ".png",
        imageBlobUrl: "blob:old",
      } as any,
    ],
  } as any);
}

describe("updateImageBlobUrl", () => {
  beforeEach(() => {
    seedImageTab();
  });

  it("replaces the blob url, keeps the old one alive (history), flags destructive edit, marks dirty", () => {
    const revoke = vi.fn();
    // jsdom is not enabled; provide URL.revokeObjectURL for the test.
    (globalThis as any).URL.revokeObjectURL = revoke;

    useTabStore.getState().updateImageBlobUrl("t1", "blob:new");

    const tab = useTabStore.getState().tabs.find((t) => t.id === "t1")!;
    expect(tab.imageBlobUrl).toBe("blob:new");
    expect(tab.dirty).toBe(true);
    // Crop/resize must not be auto-saved over the original file.
    expect((tab as any).imageDestructiveEditPending).toBe(true);
    // The superseded url is still referenced by undo snapshots, so it must NOT
    // be revoked yet; it is tracked for revocation at tab close.
    expect(revoke).not.toHaveBeenCalled();
    expect((tab as any).imageBlobUrlHistory).toEqual(["blob:old"]);
  });

  it("accumulates multiple superseded urls in history", () => {
    (globalThis as any).URL.revokeObjectURL = vi.fn();
    const store = useTabStore.getState();
    store.updateImageBlobUrl("t1", "blob:a");
    store.updateImageBlobUrl("t1", "blob:b");

    const tab = useTabStore.getState().tabs.find((t) => t.id === "t1")!;
    expect(tab.imageBlobUrl).toBe("blob:b");
    expect((tab as any).imageBlobUrlHistory).toEqual(["blob:old", "blob:a"]);
  });

  it("does nothing for an unknown tab id", () => {
    expect(() => useTabStore.getState().updateImageBlobUrl("missing", "blob:x")).not.toThrow();
  });
});

describe("markClean clears the destructive-edit flag", () => {
  beforeEach(() => {
    seedImageTab();
  });

  it("resets imageDestructiveEditPending so the tab is autosave-eligible again", () => {
    (globalThis as any).URL.revokeObjectURL = vi.fn();
    useTabStore.getState().updateImageBlobUrl("t1", "blob:new");
    useTabStore.getState().markClean("t1");

    const tab = useTabStore.getState().tabs.find((t) => t.id === "t1")!;
    expect(tab.dirty).toBe(false);
    expect((tab as any).imageDestructiveEditPending).toBe(false);
  });
});

describe("closeTab revokes current and historical blob urls", () => {
  beforeEach(() => {
    seedImageTab();
  });

  it("revokes the current url and every superseded url in history", () => {
    const revoke = vi.fn();
    (globalThis as any).URL.revokeObjectURL = revoke;
    const store = useTabStore.getState();
    store.updateImageBlobUrl("t1", "blob:a");
    store.updateImageBlobUrl("t1", "blob:b");

    useTabStore.getState().closeTab("t1");

    expect(revoke).toHaveBeenCalledWith("blob:b");
    expect(revoke).toHaveBeenCalledWith("blob:old");
    expect(revoke).toHaveBeenCalledWith("blob:a");
    expect(revoke).toHaveBeenCalledTimes(3);
  });
});
