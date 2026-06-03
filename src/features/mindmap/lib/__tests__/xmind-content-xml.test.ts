import { describe, it, expect } from "vitest";
import JSZip from "jszip";
import { serializeToXmind } from "../xmind-serializer";
import { parseXmindFile } from "../xmind-parser";
import { buildContentXml } from "../xmind-content-xml";
import type { KityMinderJson } from "../types";

describe("content.xml builder", () => {
  it("escapes special characters in titles", () => {
    const xml = buildContentXml({
      rootTopic: { id: "r", title: 'A & B <x> "q"', structureClass: "org.xmind.ui.logic.right" },
    });
    expect(xml).toContain("A &amp; B &lt;x&gt; &quot;q&quot;");
    expect(xml).toContain('structure-class="org.xmind.ui.logic.right"');
  });

  it("a content.xml-only .xmind parses back (>=2 children)", async () => {
    const json: KityMinderJson = {
      template: "right",
      theme: "fresh-blue",
      root: {
        data: { text: "Root" },
        children: [
          { data: { text: "C1" }, children: [] },
          { data: { text: "C2", note: "n2" }, children: [] },
        ],
      },
    };
    // Serialize, then strip content.json so the parser falls back to content.xml.
    const full = await serializeToXmind(json);
    const zip = await JSZip.loadAsync(full);
    zip.remove("content.json");
    const xmlOnly = await zip.generateAsync({ type: "uint8array" });

    const out = await parseXmindFile(xmlOnly);
    expect(out.root.data.text).toBe("Root");
    const texts = out.root.children.map((c) => c.data.text).sort();
    expect(texts).toEqual(["C1", "C2"]);
  });
});
