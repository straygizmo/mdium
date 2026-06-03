import { describe, it, expect } from "vitest";
import { serializeToXmind } from "../xmind-serializer";
import { parseXmindFile } from "../xmind-parser";
import type { KityMinderJson } from "../types";

// 1x1 transparent PNG.
const PNG_B64 =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

describe("serializeToXmind image handling", () => {
  it("round-trips an embedded image with size", async () => {
    const json: KityMinderJson = {
      template: "right",
      theme: "fresh-blue",
      root: {
        data: { text: "R", image: PNG_B64, imageSize: { width: 120, height: 80 } },
        children: [],
      },
    };
    const out = await parseXmindFile(await serializeToXmind(json));
    expect(out.root.data.image).toBe(PNG_B64);
    expect(out.root.data.imageSize).toEqual({ width: 120, height: 80 });
  });

  it("skips an invalid base64 image but keeps the node text", async () => {
    const json: KityMinderJson = {
      template: "right",
      theme: "fresh-blue",
      root: { data: { text: "R", image: "not-a-data-url" }, children: [] },
    };
    const out = await parseXmindFile(await serializeToXmind(json));
    expect(out.root.data.text).toBe("R");
    expect(out.root.data.image).toBeUndefined();
  });

  it("stores image bytes under resources/", async () => {
    const JSZip = (await import("jszip")).default;
    const json: KityMinderJson = {
      template: "right",
      theme: "fresh-blue",
      root: { data: { text: "R", image: PNG_B64 }, children: [] },
    };
    const zip = await JSZip.loadAsync(await serializeToXmind(json));
    const resourceFiles = Object.keys(zip.files).filter((k) => k.startsWith("resources/"));
    expect(resourceFiles.length).toBe(1);
    expect(resourceFiles[0]).toMatch(/^resources\/.+\.png$/);
  });

  it("stores an svg+xml image with a .svg extension", async () => {
    const JSZip = (await import("jszip")).default;
    // Minimal valid base64 (content irrelevant for this test).
    const SVG_B64 = "data:image/svg+xml;base64,PHN2Zy8+";
    const json: KityMinderJson = {
      template: "right",
      theme: "fresh-blue",
      root: { data: { text: "R", image: SVG_B64 }, children: [] },
    };
    const zip = await JSZip.loadAsync(await serializeToXmind(json));
    const resourceFiles = Object.keys(zip.files).filter((k) => k.startsWith("resources/"));
    expect(resourceFiles.length).toBe(1);
    expect(resourceFiles[0]).toMatch(/^resources\/.+\.svg$/);
  });
});
