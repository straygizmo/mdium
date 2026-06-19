import { describe, it, expect, vi, beforeEach } from "vitest";
import { useTabStore } from "../tab-store";

describe("updateImageBlobUrl", () => {
  beforeEach(() => {
    // Reset tabs to a single image tab with a known blob url.
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
  });

  it("replaces the blob url, revokes the old one, and marks dirty", () => {
    const revoke = vi.fn();
    // jsdom is not enabled; provide URL.revokeObjectURL for the test.
    (globalThis as any).URL.revokeObjectURL = revoke;

    useTabStore.getState().updateImageBlobUrl("t1", "blob:new");

    const tab = useTabStore.getState().tabs.find((t) => t.id === "t1")!;
    expect(tab.imageBlobUrl).toBe("blob:new");
    expect(tab.dirty).toBe(true);
    expect(revoke).toHaveBeenCalledWith("blob:old");
  });

  it("does nothing for an unknown tab id", () => {
    expect(() => useTabStore.getState().updateImageBlobUrl("missing", "blob:x")).not.toThrow();
  });
});
