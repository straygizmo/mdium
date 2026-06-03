import { describe, it, expect } from "vitest";
import JSZip from "jszip";
import { parseXmindFile } from "../xmind-parser";

async function buildXmind(content: unknown, metadata?: unknown): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file("content.json", JSON.stringify(content));
  if (metadata) zip.file("metadata.json", JSON.stringify(metadata));
  return zip.generateAsync({ type: "uint8array" });
}

describe("parser restores layout/theme/image size", () => {
  it("restores template from structureClass and theme from metadata", async () => {
    const content = [
      {
        id: "sheet1",
        class: "sheet",
        title: "Sheet 1",
        rootTopic: {
          id: "r",
          title: "Root",
          structureClass: "org.xmind.ui.org-chart.down",
          children: { attached: [{ id: "c", title: "Child" }] },
        },
      },
    ];
    const metadata = { mdium: { theme: "fresh-green" } };
    const bytes = await buildXmind(content, metadata);

    const json = await parseXmindFile(bytes);
    expect(json.root.data.text).toBe("Root");
    expect(json.root.children[0].data.text).toBe("Child");
    expect(json.template).toBe("bottom");
    expect(json.theme).toBe("fresh-green");
  });

  it("defaults template=right and theme=fresh-blue when absent", async () => {
    const content = [{ rootTopic: { id: "r", title: "Root" } }];
    const bytes = await buildXmind(content);
    const json = await parseXmindFile(bytes);
    expect(json.template).toBe("right");
    expect(json.theme).toBe("fresh-blue");
  });

  it("reads image size from data.image.width/height", async () => {
    const content = [
      {
        rootTopic: {
          id: "r",
          title: "Root",
          image: { src: "xap:resources/pic.png", width: 321, height: 123 },
        },
      },
    ];
    const zip = new JSZip();
    zip.file("content.json", JSON.stringify(content));
    zip.file("resources/pic.png", "fakebytes");
    const bytes = await zip.generateAsync({ type: "uint8array" });

    const json = await parseXmindFile(bytes);
    expect(json.root.data.imageSize).toEqual({ width: 321, height: 123 });
  });
});
