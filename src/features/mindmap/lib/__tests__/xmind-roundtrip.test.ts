import { describe, it, expect } from "vitest";
import { serializeToXmind } from "../xmind-serializer";
import { parseXmindFile } from "../xmind-parser";
import type { KityMinderJson } from "../types";

async function roundTrip(json: KityMinderJson): Promise<KityMinderJson> {
  const bytes = await serializeToXmind(json);
  return parseXmindFile(bytes);
}

describe("serializeToXmind round-trip (scalar fields)", () => {
  it("round-trips a deep tree with all scalar fields", async () => {
    const json: KityMinderJson = {
      template: "mind",
      theme: "fresh-purple",
      root: {
        data: { text: "Central" },
        children: [
          {
            data: {
              text: "Branch A",
              note: "some **markdown** note",
              hyperlink: "https://example.com",
              hyperlinkTitle: "Example",
              priority: 3,
              expandState: "collapse",
            },
            children: [
              { data: { text: "Leaf A1", progress: 5 }, children: [] },
              { data: { text: "Leaf A2" }, children: [] },
            ],
          },
          { data: { text: "Branch B" }, children: [] },
        ],
      },
    };

    const out = await roundTrip(json);

    expect(out.template).toBe("mind");
    expect(out.theme).toBe("fresh-purple");
    expect(out.root.data.text).toBe("Central");
    expect(out.root.children).toHaveLength(2);

    const a = out.root.children[0];
    expect(a.data.text).toBe("Branch A");
    expect(a.data.note).toBe("some **markdown** note");
    expect(a.data.hyperlink).toBe("https://example.com");
    expect(a.data.hyperlinkTitle).toBe("Example");
    expect(a.data.priority).toBe(3);
    expect(a.data.expandState).toBe("collapse");
    expect(a.children[0].data.text).toBe("Leaf A1");
    expect(a.children[0].data.progress).toBe(5);
    expect(a.children[1].data.text).toBe("Leaf A2");
  });

  it.each(["right", "left", "mind", "bottom", "filetree"])(
    "round-trips layout %s",
    async (template) => {
      const json: KityMinderJson = {
        template,
        theme: "fresh-blue",
        root: { data: { text: "R" }, children: [{ data: { text: "C" }, children: [] }] },
      };
      const out = await roundTrip(json);
      expect(out.template).toBe(template);
    }
  );

  it("produces a ZIP containing the expected entries", async () => {
    const JSZip = (await import("jszip")).default;
    const json: KityMinderJson = {
      template: "right",
      theme: "fresh-blue",
      root: { data: { text: "R" }, children: [] },
    };
    const bytes = await serializeToXmind(json);
    const zip = await JSZip.loadAsync(bytes);
    expect(zip.file("content.json")).toBeTruthy();
    expect(zip.file("content.xml")).toBeTruthy();
    expect(zip.file("metadata.json")).toBeTruthy();
    expect(zip.file("manifest.json")).toBeTruthy();
    expect(zip.file("META-INF/manifest.xml")).toBeTruthy();
  });
});
