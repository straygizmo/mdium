import { describe, it, expect } from "vitest";
import { convertMdToVideoProject } from "../md-to-scenes";

const FAKE_PATH = "/project/slides/presentation.md";

describe("convertMdToVideoProject", () => {
  // 1. Splits scenes on <!-- pagebreak -->
  it("splits scenes on <!-- pagebreak -->", () => {
    const md = `# Scene One\n<!-- pagebreak -->\n# Scene Two`;
    const project = convertMdToVideoProject(md, FAKE_PATH);
    expect(project.scenes).toHaveLength(2);
    expect(project.scenes[0].id).toBe("scene-1");
    expect(project.scenes[1].id).toBe("scene-2");
  });

  // 1b. Case-insensitive pagebreak
  it("handles case-insensitive pagebreak", () => {
    const md = `# A\n<!-- PAGEBREAK -->\n# B`;
    const project = convertMdToVideoProject(md, FAKE_PATH);
    expect(project.scenes).toHaveLength(2);
  });

  // 2. Treats entire document as one scene when no pagebreak
  it("treats entire document as one scene when no pagebreak", () => {
    const md = `# Only Scene\n\nSome text here.`;
    const project = convertMdToVideoProject(md, FAKE_PATH);
    expect(project.scenes).toHaveLength(1);
    expect(project.scenes[0].id).toBe("scene-1");
  });

  // 3. Extracts title elements from headings
  it("extracts title elements from headings", () => {
    const md = `# Main Title\n## Subtitle\n### Sub-subtitle`;
    const project = convertMdToVideoProject(md, FAKE_PATH);
    const elements = project.scenes[0].elements;
    const titles = elements.filter((e) => e.type === "title") as import("../../types").TitleElement[];
    expect(titles).toHaveLength(3);
    expect(titles[0]).toMatchObject({ type: "title", text: "Main Title", level: 1, animation: "fade-in" });
    expect(titles[1]).toMatchObject({ type: "title", text: "Subtitle", level: 2, animation: "fade-in" });
    expect(titles[2]).toMatchObject({ type: "title", text: "Sub-subtitle", level: 3, animation: "fade-in" });
  });

  // 4. Extracts bullet list elements
  it("extracts bullet list elements from - items", () => {
    const md = `# Title\n- item one\n- item two\n- item three`;
    const project = convertMdToVideoProject(md, FAKE_PATH);
    const elements = project.scenes[0].elements;
    const lists = elements.filter((e) => e.type === "bullet-list") as import("../../types").BulletListElement[];
    expect(lists).toHaveLength(1);
    expect(lists[0]).toMatchObject({
      type: "bullet-list",
      items: ["item one", "item two", "item three"],
      animation: "sequential",
      delayPerItem: 30,
    });
  });

  it("extracts bullet list elements from * items", () => {
    const md = `* alpha\n* beta`;
    const project = convertMdToVideoProject(md, FAKE_PATH);
    const elements = project.scenes[0].elements;
    const lists = elements.filter((e) => e.type === "bullet-list") as import("../../types").BulletListElement[];
    expect(lists).toHaveLength(1);
    expect(lists[0].items).toEqual(["alpha", "beta"]);
  });

  // 5. Extracts image elements from markdown syntax
  it("extracts image elements from markdown syntax", () => {
    const md = `![alt text](./images/photo.png)`;
    const project = convertMdToVideoProject(md, FAKE_PATH);
    const elements = project.scenes[0].elements;
    const images = elements.filter((e) => e.type === "image") as import("../../types").ImageElement[];
    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({
      type: "image",
      alt: "alt text",
      position: "center",
      animation: "fade-in",
    });
    // Relative path resolved relative to filePath directory
    expect(images[0].src.replace(/\\/g, "/")).toContain("images/photo.png");
  });

  // 6. Extracts image elements from <img> tags
  it("extracts image elements from <img> tags", () => {
    const md = `<img src="./images/diagram.png">`;
    const project = convertMdToVideoProject(md, FAKE_PATH);
    const elements = project.scenes[0].elements;
    const images = elements.filter((e) => e.type === "image") as import("../../types").ImageElement[];
    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({
      type: "image",
      position: "center",
      animation: "fade-in",
    });
    expect(images[0].src.replace(/\\/g, "/")).toContain("images/diagram.png");
  });

  // 7. Extracts narration from HTML comments
  it("extracts narration from <!-- narration: ... --> comment", () => {
    const md = `# Hello\n<!-- narration: This is the narration text -->`;
    const project = convertMdToVideoProject(md, FAKE_PATH);
    expect(project.scenes[0].narration).toBe("This is the narration text");
  });

  // 8. Auto-generates narration from content when no comment
  it("auto-generates narration from title + bullets when no narration comment", () => {
    const md = `# My Title\n- Point one\n- Point two`;
    const project = convertMdToVideoProject(md, FAKE_PATH);
    const narration = project.scenes[0].narration;
    expect(narration).toContain("My Title");
    expect(narration).toContain("Point one");
    expect(narration).toContain("Point two");
  });

  // 9. Extracts table elements
  it("extracts table elements", () => {
    const md = `| Name | Age |\n|------|-----|\n| Alice | 30 |\n| Bob | 25 |`;
    const project = convertMdToVideoProject(md, FAKE_PATH);
    const elements = project.scenes[0].elements;
    const tables = elements.filter((e) => e.type === "table") as import("../../types").TableElement[];
    expect(tables).toHaveLength(1);
    expect(tables[0]).toMatchObject({
      type: "table",
      animation: "row-by-row",
    });
    expect(tables[0].headers).toEqual(["Name", "Age"]);
    expect(tables[0].rows).toHaveLength(2);
    expect(tables[0].rows[0]).toEqual(["Alice", "30"]);
    expect(tables[0].rows[1]).toEqual(["Bob", "25"]);
  });

  // 10. Extracts code block elements
  it("extracts code block elements", () => {
    const md = "```typescript\nconst x = 1;\n```";
    const project = convertMdToVideoProject(md, FAKE_PATH);
    const elements = project.scenes[0].elements;
    const codeBlocks = elements.filter((e) => e.type === "code-block") as import("../../types").CodeBlockElement[];
    expect(codeBlocks).toHaveLength(1);
    expect(codeBlocks[0]).toMatchObject({
      type: "code-block",
      language: "typescript",
      code: "const x = 1;",
      animation: "fade-in",
    });
  });

  // 11. Skips mermaid code blocks
  it("skips mermaid code blocks", () => {
    const md = "```mermaid\ngraph TD\nA-->B\n```";
    const project = convertMdToVideoProject(md, FAKE_PATH);
    const elements = project.scenes[0].elements;
    const codeBlocks = elements.filter((e) => e.type === "code-block");
    expect(codeBlocks).toHaveLength(0);
  });

  // 12. Extracts title from first heading for meta.title
  it("sets meta.title from first heading in first scene", () => {
    const md = `# My Presentation\n\nSome content.`;
    const project = convertMdToVideoProject(md, FAKE_PATH);
    expect(project.meta.title).toBe("My Presentation");
  });

  it("falls back to filename when no heading", () => {
    const md = `Just some text without a heading.`;
    const project = convertMdToVideoProject(md, FAKE_PATH);
    expect(project.meta.title).toBe("presentation");
  });

  // 13. Sets scene title from first heading in scene
  it("sets scene title from first heading in that scene", () => {
    const md = `# First Scene Title\nSome text\n<!-- pagebreak -->\n# Second Scene Title`;
    const project = convertMdToVideoProject(md, FAKE_PATH);
    expect(project.scenes[0].title).toBe("First Scene Title");
    expect(project.scenes[1].title).toBe("Second Scene Title");
  });

  // 14. Default captions enabled
  it("sets captions.enabled = true on all scenes", () => {
    const md = `# Scene\nContent here.`;
    const project = convertMdToVideoProject(md, FAKE_PATH);
    expect(project.scenes[0].captions).toEqual({ enabled: true });
  });

  // Extra: Skips empty lines, HTML comments (except narration), <div>, </div>, ---
  it("skips empty lines and non-narration HTML comments", () => {
    const md = `# Title\n\n<!-- some other comment -->\n<div>\n</div>\n---\n\nReal text.`;
    const project = convertMdToVideoProject(md, FAKE_PATH);
    const elements = project.scenes[0].elements;
    // Should have title + text element, no junk
    const types = elements.map((e) => e.type);
    expect(types).not.toContain("div");
    // Text element for "Real text." should be present
    const textEls = elements.filter((e) => e.type === "text") as import("../../types").TextElement[];
    expect(textEls.some((t) => t.content.includes("Real text."))).toBe(true);
  });

  // Image path resolution - absolute path stays absolute
  it("keeps absolute image paths unchanged", () => {
    const md = `![img](/absolute/path/image.png)`;
    const project = convertMdToVideoProject(md, FAKE_PATH);
    const images = project.scenes[0].elements.filter((e) => e.type === "image") as import("../../types").ImageElement[];
    expect(images[0].src).toBe("/absolute/path/image.png");
  });

  // Transition defaults
  it("sets default transition on each scene", () => {
    const md = `# Scene`;
    const project = convertMdToVideoProject(md, FAKE_PATH);
    expect(project.scenes[0].transition).toMatchObject({ type: "fade", durationInFrames: 15 });
  });
});
