# XMind Export Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `.xmind` the mindmap module's only native (editable) save format, replacing KityMinder `.km`, while keeping `.km` as a one-way import that auto-converts to `.xmind`.

**Architecture:** Add a `xmind-serializer.ts` that is the inverse of the existing `xmind-parser.ts`, plus a shared `xmind-structure.ts` layout↔structureClass map. The internal model (`layout.ts`, ReactFlow, themes) is untouched; `KityMinderJson` stays the boundary type. Save switches from `write_text_file` (string) to `writeFile` (bytes). The parser is extended to restore layout (structureClass) and theme (metadata).

**Tech Stack:** TypeScript, React, Vitest, JSZip, xml-js, @tauri-apps/plugin-fs.

**Spec:** `.superpowers/specs/2026-06-03-xmind-export-migration-design.md`

**Conventions:**
- Tests live in `src/features/mindmap/lib/__tests__/*.test.ts` (matches existing `__tests__` convention).
- Run a single test file: `npm test -- <path>`. Run all: `npm test`. Typecheck+build: `npm run build`.
- Commit after each task. Branch first (currently on `main`): `git checkout -b feat/xmind-export`.
- All user-facing strings via i18n (`t("mindmap.*")`); never hardcode (per CLAUDE.md).

---

## Task 0: Create working branch

- [ ] **Step 1: Branch**

```bash
git checkout -b feat/xmind-export
```

- [ ] **Step 2: Confirm clean baseline**

Run: `npm test`
Expected: existing suite passes (PASS). If pre-existing failures exist, note them; do not fix unrelated tests.

---

## Task 1: Layout ⇔ structureClass mapping (`xmind-structure.ts`)

**Files:**
- Create: `src/features/mindmap/lib/xmind-structure.ts`
- Test: `src/features/mindmap/lib/__tests__/xmind-structure.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/features/mindmap/lib/__tests__/xmind-structure.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { layoutToStructure, structureToLayout } from "../xmind-structure";

describe("layout <-> structureClass mapping", () => {
  const cases: Array<[string, string]> = [
    ["right", "org.xmind.ui.logic.right"],
    ["left", "org.xmind.ui.logic.left"],
    ["mind", "org.xmind.ui.map.unbalanced"],
    ["bottom", "org.xmind.ui.org-chart.down"],
    ["filetree", "org.xmind.ui.tree.right"],
  ];

  it.each(cases)("layout %s -> structureClass %s", (layout, structure) => {
    expect(layoutToStructure(layout)).toBe(structure);
  });

  it.each(cases)("structureClass %s -> layout %s (reverse)", (layout, structure) => {
    expect(structureToLayout(structure)).toBe(layout);
  });

  it("maps map.clockwise/unbalanced family to mind", () => {
    expect(structureToLayout("org.xmind.ui.map.clockwise")).toBe("mind");
    expect(structureToLayout("org.xmind.ui.map")).toBe("mind");
  });

  it("maps org-chart.up to bottom and tree.left to filetree", () => {
    expect(structureToLayout("org.xmind.ui.org-chart.up")).toBe("bottom");
    expect(structureToLayout("org.xmind.ui.tree.left")).toBe("filetree");
  });

  it("falls back to right for unknown / undefined", () => {
    expect(structureToLayout("org.xmind.ui.unknown.thing")).toBe("right");
    expect(structureToLayout(undefined)).toBe("right");
    expect(structureToLayout("")).toBe("right");
  });

  it("falls back to logic.right for unknown layout", () => {
    expect(layoutToStructure("nonsense")).toBe("org.xmind.ui.logic.right");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/features/mindmap/lib/__tests__/xmind-structure.test.ts`
Expected: FAIL — "Cannot find module '../xmind-structure'".

- [ ] **Step 3: Write minimal implementation**

Create `src/features/mindmap/lib/xmind-structure.ts`:

```ts
/**
 * Bidirectional mapping between mdium mindmap layouts and XMind structureClass
 * identifiers. Shared by the serializer (write) and parser (read) so layout
 * round-trips through .xmind and also renders correctly in XMind.
 */

/** mdium layout -> XMind structureClass */
const LAYOUT_TO_STRUCTURE: Record<string, string> = {
  right: "org.xmind.ui.logic.right",
  left: "org.xmind.ui.logic.left",
  mind: "org.xmind.ui.map.unbalanced",
  bottom: "org.xmind.ui.org-chart.down",
  filetree: "org.xmind.ui.tree.right",
};

export function layoutToStructure(layout: string): string {
  return LAYOUT_TO_STRUCTURE[layout] ?? "org.xmind.ui.logic.right";
}

/** XMind structureClass -> mdium layout (prefix-based, tolerant of variants) */
export function structureToLayout(structureClass: string | undefined): string {
  if (!structureClass) return "right";
  const s = structureClass;
  if (s.startsWith("org.xmind.ui.logic.left")) return "left";
  if (s.startsWith("org.xmind.ui.logic.right")) return "right";
  if (s.startsWith("org.xmind.ui.map")) return "mind";
  if (s.startsWith("org.xmind.ui.org-chart")) return "bottom";
  if (s.startsWith("org.xmind.ui.tree")) return "filetree";
  return "right";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/features/mindmap/lib/__tests__/xmind-structure.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/features/mindmap/lib/xmind-structure.ts src/features/mindmap/lib/__tests__/xmind-structure.test.ts
git commit -m "feat(mindmap): add layout<->structureClass mapping"
```

---

## Task 2: Extend parser to restore structureClass, theme, and image size

The parser already extracts text/note/href/markers/image/children. Extend it to:
1. set `template` from the root topic's `structureClass`,
2. set `theme` from `metadata.json` → `mdium.theme`,
3. read image size from `data.image.width/height` (fallback when no `xhtml:img`).

**Files:**
- Modify: `src/features/mindmap/lib/xmind-parser.ts`
- Test: `src/features/mindmap/lib/__tests__/xmind-parser-restore.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/features/mindmap/lib/__tests__/xmind-parser-restore.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/features/mindmap/lib/__tests__/xmind-parser-restore.test.ts`
Expected: FAIL — `template` is `"default"` and `theme` is `"fresh-blue"` regardless; image size assertion fails (returns 200/200).

- [ ] **Step 3a: Add image-size fallback in `convertNode`**

In `src/features/mindmap/lib/xmind-parser.ts`, find the image size block (currently):

```ts
  const imageSize = {
    width: imageAttr["svg:width"] ? Number(imageAttr["svg:width"]) : 200,
    height: imageAttr["svg:height"] ? Number(imageAttr["svg:height"]) : 200,
  };
```

Replace with (fall back to `data.image.width/height`):

```ts
  const imageSize = {
    width: imageAttr["svg:width"]
      ? Number(imageAttr["svg:width"])
      : image.width
        ? Number(image.width)
        : 200,
    height: imageAttr["svg:height"]
      ? Number(imageAttr["svg:height"])
      : image.height
        ? Number(image.height)
        : 200,
  };
```

Note: `image` is typed `Record<string, string>`; `image.width`/`image.height` read fine at runtime. If TypeScript complains, widen the local type at its declaration:

```ts
  const image = (data.image as Record<string, string | number>) || { src: "" };
```

and where `image.src` is used, keep `(image.src as string)`.

- [ ] **Step 3b: Build a `metadata.mdium` reader and restore layout/theme in `parseXmindFile`**

At the end of `parseXmindFile`, the function currently returns:

```ts
  const result: KityMinderJson = {
    template: "default",
    theme: "fresh-blue",
    root: convertNode(rootTopic, imgFiles),
  };

  return result;
```

Replace that block with:

```ts
  // Restore layout from the root topic's structureClass.
  const structureClass =
    (rootTopic.structureClass as string | undefined) ||
    ((rootTopic._attributes as Record<string, string> | undefined)?.["structure-class"]);
  const template = structureToLayout(structureClass);

  // Restore theme from metadata.json -> mdium.theme.
  let theme = "fresh-blue";
  const metaFile = files["metadata.json"];
  if (metaFile) {
    try {
      const meta = JSON.parse(await metaFile.async("string")) as {
        mdium?: { theme?: string };
      };
      if (meta?.mdium?.theme) theme = meta.mdium.theme;
    } catch {
      // ignore malformed metadata; keep default theme
    }
  }

  const result: KityMinderJson = {
    template,
    theme,
    root: convertNode(rootTopic, imgFiles),
  };

  return result;
```

Also add the import at the top of the file (after the existing imports):

```ts
import { structureToLayout } from "./xmind-structure";
```

Note: the `kityminder.json` early-return branch (lines ~144-148) is unchanged — those files already carry `template`/`theme` in their JSON.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/features/mindmap/lib/__tests__/xmind-parser-restore.test.ts`
Expected: PASS (all three cases).

- [ ] **Step 5: Commit**

```bash
git add src/features/mindmap/lib/xmind-parser.ts src/features/mindmap/lib/__tests__/xmind-parser-restore.test.ts
git commit -m "feat(mindmap): restore layout/theme/image-size when parsing .xmind"
```

---

## Task 3: Serializer core — content.json, metadata, manifests, scalar fields

Build `serializeToXmind` producing a valid `.xmind` ZIP with `content.json`,
`metadata.json`, `manifest.json`, `META-INF/manifest.xml`. Covers text, children,
note, hyperlink (+title), priority, progress, collapse, layout, theme. Images and
`content.xml` come in Tasks 4 and 5. Verified by round-trip through `parseXmindFile`.

**Files:**
- Create: `src/features/mindmap/lib/xmind-serializer.ts`
- Test: `src/features/mindmap/lib/__tests__/xmind-roundtrip.test.ts`

- [ ] **Step 1: Write the failing round-trip test**

Create `src/features/mindmap/lib/__tests__/xmind-roundtrip.test.ts`:

```ts
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
```

(The `content.xml` entry is written by `serializeToXmind` from Task 3 onward — Task 3
uses a stub builder that returns `<xmap-content/>`, Task 5 replaces it with the real
builder. So the `content.xml` presence assertion passes from Task 3. Its *contents*
are only validated in Task 5's dedicated test.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/features/mindmap/lib/__tests__/xmind-roundtrip.test.ts`
Expected: FAIL — "Cannot find module '../xmind-serializer'".

- [ ] **Step 3: Implement the serializer core**

Create `src/features/mindmap/lib/xmind-serializer.ts`:

```ts
/**
 * Serialize a KityMinderJson into a .xmind ZIP (inverse of xmind-parser.ts).
 * Emits content.json (XMind Zen), content.xml (XMind 8), metadata.json, and
 * manifests. Images are stored under resources/ (see addImage in Task 4).
 */
import JSZip from "jszip";
import type { KityMinderJson, KityMinderNode } from "./types";
import { layoutToStructure } from "./xmind-structure";
import { buildContentXml } from "./xmind-content-xml";

// Maps progress 1-9 to XMind task markers (index aligns with parser's TASK_MARKERS).
const TASK_MARKERS = [
  "start", "oct", "quarter", "3oct", "half", "5oct", "3quar", "7oct", "done", "pause",
];

let idCounter = 0;
/** Deterministic-enough id generator (Math.random is unavailable in some contexts). */
function nextId(): string {
  idCounter += 1;
  return `t${idCounter.toString(36)}${(idCounter * 2654435761 % 0xffffffff).toString(36)}`;
}

export interface SerializedTopic {
  id: string;
  title: string;
  structureClass?: string;
  notes?: { plain: { content: string } };
  href?: string;
  "xlink:title"?: string;
  markers?: Array<{ markerId: string }>;
  image?: { src: string; width: number; height: number };
  branch?: "folded";
  children?: { attached: SerializedTopic[] };
}

/** Build a content.json topic from a KityMinder node (recursive). */
export function buildTopic(node: KityMinderNode, isRoot: boolean, layout: string): SerializedTopic {
  const d = node.data;
  const topic: SerializedTopic = { id: nextId(), title: d.text ?? "" };

  if (isRoot) topic.structureClass = layoutToStructure(layout);
  if (d.note) topic.notes = { plain: { content: d.note } };
  if (d.hyperlink) {
    topic.href = d.hyperlink;
    if (d.hyperlinkTitle) topic["xlink:title"] = d.hyperlinkTitle;
  }

  const markers: Array<{ markerId: string }> = [];
  if (typeof d.priority === "number") markers.push({ markerId: `priority-${d.priority}` });
  if (typeof d.progress === "number") {
    const key = TASK_MARKERS[d.progress - 1];
    if (key) markers.push({ markerId: `task-${key}` });
  }
  if (markers.length) topic.markers = markers;

  if (d.expandState === "collapse") topic.branch = "folded";

  // image is attached in Task 4 (addImageToTopic).

  if (node.children && node.children.length > 0) {
    topic.children = {
      attached: node.children.map((c) => buildTopic(c, false, layout)),
    };
  }
  return topic;
}

function buildMetadata(json: KityMinderJson): string {
  return JSON.stringify({
    creator: { name: "mdium" },
    mdium: { theme: json.theme ?? "fresh-blue", layout: json.template ?? "right" },
  });
}

function buildZenManifest(extraEntries: string[]): string {
  const entries: Record<string, unknown> = {
    "content.json": {},
    "content.xml": {},
    "metadata.json": {},
  };
  for (const e of extraEntries) entries[e] = {};
  return JSON.stringify({ "file-entries": entries });
}

function buildXml8Manifest(extraEntries: string[]): string {
  const fileEntry = (path: string, media: string) =>
    `  <file-entry full-path="${path}" media-type="${media}"/>`;
  const lines = [
    '<?xml version="1.0" encoding="UTF-8" standalone="no"?>',
    '<manifest xmlns="urn:xmind:xmap:xmlns:manifest:1.0">',
    fileEntry("content.xml", "text/xml"),
    fileEntry("content.json", "application/json"),
    fileEntry("metadata.json", "application/json"),
    fileEntry("META-INF/", ""),
    fileEntry("META-INF/manifest.xml", "text/xml"),
    ...extraEntries.map((e) => fileEntry(e, "image/png")),
    "</manifest>",
  ];
  return lines.join("\n");
}

export async function serializeToXmind(json: KityMinderJson): Promise<Uint8Array> {
  idCounter = 0;
  const layout = json.template ?? "right";
  const sheetId = nextId();

  const rootTopic = buildTopic(json.root, true, layout);

  // Image extraction populates `resources` and rewrites topic.image (Task 4).
  const resources: Record<string, Uint8Array> = {};
  attachImages(json.root, rootTopic, resources);

  const content = [
    { id: sheetId, class: "sheet", title: "Sheet 1", rootTopic },
  ];

  const zip = new JSZip();
  zip.file("content.json", JSON.stringify(content));
  zip.file("content.xml", buildContentXml(content[0]));
  zip.file("metadata.json", buildMetadata(json));

  const resourcePaths: string[] = [];
  for (const [name, bytes] of Object.entries(resources)) {
    const path = `resources/${name}`;
    zip.file(path, bytes);
    resourcePaths.push(path);
  }

  zip.file("manifest.json", buildZenManifest(resourcePaths));
  zip.file("META-INF/manifest.xml", buildXml8Manifest(resourcePaths));

  return zip.generateAsync({ type: "uint8array" });
}

// Placeholder implemented in Task 4. For Task 3, define a no-op so the module
// compiles; Task 4 replaces this with real image extraction.
function attachImages(
  _node: KityMinderNode,
  _topic: SerializedTopic,
  _resources: Record<string, Uint8Array>,
): void {
  // no-op until Task 4
}
```

Because Task 3 references `buildContentXml` (Task 5) and `attachImages` (Task 4),
create minimal stand-ins now so the module compiles and Task 3 tests pass:

Create `src/features/mindmap/lib/xmind-content-xml.ts` (minimal stub; full impl in Task 5):

```ts
import type { SerializedTopic } from "./xmind-serializer";

/** Minimal placeholder; replaced with a full builder in Task 5. */
export function buildContentXml(_sheet: { rootTopic: SerializedTopic }): string {
  return '<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n<xmap-content/>';
}
```

`attachImages` is already defined as a no-op inside `xmind-serializer.ts` above.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/features/mindmap/lib/__tests__/xmind-roundtrip.test.ts`
Expected: PASS (with the `content.xml` presence line commented out per Step 1 note;
all scalar/layout assertions pass).

- [ ] **Step 5: Commit**

```bash
git add src/features/mindmap/lib/xmind-serializer.ts src/features/mindmap/lib/xmind-content-xml.ts src/features/mindmap/lib/__tests__/xmind-roundtrip.test.ts
git commit -m "feat(mindmap): serialize KityMinder to .xmind content.json (scalar fields)"
```

---

## Task 4: Serializer images — base64 ↔ resources/

Replace the `attachImages` no-op with real extraction: for each node with a valid
`data.image` (base64 data URL), decode the bytes into `resources/<id>.<ext>` and set
the topic's `image: { src, width, height }`. Invalid base64 is skipped (node kept as
text). Verified by round-trip.

**Files:**
- Modify: `src/features/mindmap/lib/xmind-serializer.ts`
- Test: `src/features/mindmap/lib/__tests__/xmind-image.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/features/mindmap/lib/__tests__/xmind-image.test.ts`:

```ts
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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/features/mindmap/lib/__tests__/xmind-image.test.ts`
Expected: FAIL — image is `undefined` after round-trip (no-op `attachImages`).

- [ ] **Step 3: Implement image extraction**

In `src/features/mindmap/lib/xmind-serializer.ts`, replace the no-op `attachImages`
with:

```ts
const DATA_URL_RE = /^data:image\/([a-zA-Z0-9.+-]+);base64,(.+)$/;

/** Decode a base64 string to bytes (no Buffer dependency). */
function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Walk node/topic in lockstep. For each node with a valid base64 image, write the
 * bytes into `resources` and set topic.image to reference resources/<id>.<ext>.
 * Invalid images are skipped (topic keeps no image).
 */
function attachImages(
  node: KityMinderNode,
  topic: SerializedTopic,
  resources: Record<string, Uint8Array>,
): void {
  const img = node.data.image;
  if (img) {
    const m = DATA_URL_RE.exec(img);
    if (m) {
      const ext = m[1] === "jpeg" ? "jpg" : m[1];
      const name = `${topic.id}.${ext}`;
      try {
        resources[name] = base64ToBytes(m[2]);
        const size = node.data.imageSize;
        topic.image = {
          src: `xap:resources/${name}`,
          width: size?.width ?? 200,
          height: size?.height ?? 200,
        };
      } catch {
        // invalid base64 -> skip image, keep node as text
        console.warn("[xmind-serializer] skipping invalid image on node:", node.data.text);
      }
    } else {
      console.warn("[xmind-serializer] skipping non-data-URL image on node:", node.data.text);
    }
  }

  const kids = node.children ?? [];
  const attached = topic.children?.attached ?? [];
  for (let i = 0; i < kids.length; i++) {
    if (attached[i]) attachImages(kids[i], attached[i], resources);
  }
}
```

(Remove the old no-op `attachImages` definition.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/features/mindmap/lib/__tests__/xmind-image.test.ts`
Expected: PASS (all three cases).

Also re-run the round-trip suite to ensure no regression:
Run: `npm test -- src/features/mindmap/lib/__tests__/xmind-roundtrip.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/features/mindmap/lib/xmind-serializer.ts src/features/mindmap/lib/__tests__/xmind-image.test.ts
git commit -m "feat(mindmap): embed/restore node images via resources/ in .xmind"
```

---

## Task 5: Serializer content.xml (XMind 8 interop)

Replace the `content.xml` stub with a real builder so the file is valid XMind 8 XML.
This is best-effort interop (mdium itself always reads `content.json`). Verified by:
(a) the ZIP entry assertion from Task 3, and (b) a parse of a content.xml-only ZIP
with ≥2 children (xml-js compact mode represents a single child as an object, which
the existing parser does not expand — documented limitation; tests use ≥2 children).

**Files:**
- Modify: `src/features/mindmap/lib/xmind-content-xml.ts`
- Test: `src/features/mindmap/lib/__tests__/xmind-content-xml.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/features/mindmap/lib/__tests__/xmind-content-xml.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/features/mindmap/lib/__tests__/xmind-content-xml.test.ts`
Expected: FAIL — stub returns `<xmap-content/>`; title escaping and parse-back fail.

- [ ] **Step 3: Implement the content.xml builder**

Replace `src/features/mindmap/lib/xmind-content-xml.ts` with:

```ts
import type { SerializedTopic } from "./xmind-serializer";

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function topicXml(topic: SerializedTopic): string {
  const attrs: string[] = [`id="${escapeXml(topic.id)}"`];
  if (topic.structureClass) attrs.push(`structure-class="${escapeXml(topic.structureClass)}"`);
  if (topic.href) attrs.push(`xlink:href="${escapeXml(topic.href)}"`);
  if (topic["xlink:title"]) attrs.push(`xlink:title="${escapeXml(topic["xlink:title"])}"`);
  if (topic.branch) attrs.push(`branch="${topic.branch}"`);

  const parts: string[] = [`<topic ${attrs.join(" ")}>`];
  parts.push(`<title>${escapeXml(topic.title)}</title>`);

  if (topic.notes) {
    parts.push(`<notes><plain>${escapeXml(topic.notes.plain.content)}</plain></notes>`);
  }
  if (topic.markers && topic.markers.length) {
    const refs = topic.markers
      .map((m) => `<marker-ref marker-id="${escapeXml(m.markerId)}"/>`)
      .join("");
    parts.push(`<marker-refs>${refs}</marker-refs>`);
  }
  if (topic.image) {
    parts.push(
      `<xhtml:img xhtml:src="${escapeXml(topic.image.src)}" ` +
        `svg:width="${topic.image.width}" svg:height="${topic.image.height}"/>`,
    );
  }
  if (topic.children && topic.children.attached.length) {
    const kids = topic.children.attached.map(topicXml).join("");
    parts.push(`<children><topics type="attached">${kids}</topics></children>`);
  }
  parts.push(`</topic>`);
  return parts.join("");
}

export function buildContentXml(sheet: { id?: string; rootTopic: SerializedTopic }): string {
  const sheetId = sheet.id ? escapeXml(sheet.id) : "sheet1";
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n' +
    '<xmap-content xmlns="urn:xmind:xmap:xmlns:content:2.0" ' +
    'xmlns:svg="http://www.w3.org/2000/svg" ' +
    'xmlns:xhtml="http://www.w3.org/1999/xhtml" ' +
    'xmlns:xlink="http://www.w3.org/1999/xlink" version="2.0">' +
    `<sheet id="${sheetId}">` +
    topicXml(sheet.rootTopic) +
    `<title>Sheet 1</title>` +
    `</sheet>` +
    `</xmap-content>`
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/features/mindmap/lib/__tests__/xmind-content-xml.test.ts src/features/mindmap/lib/__tests__/xmind-roundtrip.test.ts`
Expected: PASS (both files).

- [ ] **Step 5: Commit**

```bash
git add src/features/mindmap/lib/xmind-content-xml.ts src/features/mindmap/lib/__tests__/xmind-content-xml.test.ts src/features/mindmap/lib/__tests__/xmind-roundtrip.test.ts
git commit -m "feat(mindmap): build XMind 8 content.xml for interop"
```

---

## Task 6: Constants — `.km` no longer editable; add import detection

`.xmind` is the only editable mindmap extension. Add a separate helper to detect
`.km` as an import source.

**Files:**
- Modify: `src/shared/lib/constants.ts`
- Test: `src/shared/lib/__tests__/constants.test.ts` (extend existing)

- [ ] **Step 1: Write the failing test**

Add to `src/shared/lib/__tests__/constants.test.ts` (import the new symbols at top):

```ts
import { getMindmapExt, getKityMinderImportExt, isCodeFile } from "../constants";

describe("mindmap extension detection after .xmind migration", () => {
  it("treats .xmind as the mindmap extension", () => {
    expect(getMindmapExt("a.xmind")).toBe(".xmind");
  });
  it("no longer treats .km as an editable mindmap extension", () => {
    expect(getMindmapExt("a.km")).toBeNull();
  });
  it("detects .km as a KityMinder import source", () => {
    expect(getKityMinderImportExt("a.km")).toBe(".km");
    expect(getKityMinderImportExt("a.xmind")).toBeNull();
  });
  it("does not treat .km or .xmind as code files", () => {
    expect(isCodeFile("a.xmind")).toBe(false);
    expect(isCodeFile("a.km")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/shared/lib/__tests__/constants.test.ts`
Expected: FAIL — `getKityMinderImportExt` undefined; `getMindmapExt("a.km")` returns `.km`.

- [ ] **Step 3: Implement**

In `src/shared/lib/constants.ts`:

Change line 2:

```ts
export const MINDMAP_EXTENSIONS = [".xmind"];
```

Add after `MINDMAP_EXTENSIONS`:

```ts
/** KityMinder JSON files, supported only as a one-way import (auto-converted to .xmind). */
export const KITYMINDER_IMPORT_EXTENSIONS = [".km"];
```

Add a helper next to `getMindmapExt`:

```ts
export function getKityMinderImportExt(filePath: string): string | null {
  const lower = filePath.toLowerCase();
  return KITYMINDER_IMPORT_EXTENSIONS.find((ext) => lower.endsWith(ext)) ?? null;
}
```

In `isCodeFile`, ensure `.km` is still excluded from code files. After the existing
`if (getMindmapExt(lower)) return false;` line, add:

```ts
  if (getKityMinderImportExt(lower)) return false;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/shared/lib/__tests__/constants.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/lib/constants.ts src/shared/lib/__tests__/constants.test.ts
git commit -m "feat(mindmap): make .xmind the only editable ext; .km becomes import-only"
```

---

## Task 7: i18n keys for save/import messages

**Files:**
- Modify: `src/shared/i18n/locales/en/editor.json`
- Modify: `src/shared/i18n/locales/ja/editor.json`

- [ ] **Step 1: Add keys (en)**

In `src/shared/i18n/locales/en/editor.json`, add inside the JSON object (near the
other `mindmap.*` keys):

```json
  "mindmap.failedToSave": "Failed to save file: {{error}}",
  "mindmap.kmConverted": "Converted KityMinder file to XMind format: {{file}}",
  "mindmap.kmImportFailed": "Failed to import KityMinder file: {{error}}",
```

- [ ] **Step 2: Add keys (ja)**

In `src/shared/i18n/locales/ja/editor.json`, add the matching keys:

```json
  "mindmap.failedToSave": "ファイルの保存に失敗しました: {{error}}",
  "mindmap.kmConverted": "KityMinderファイルをXMind形式に変換しました: {{file}}",
  "mindmap.kmImportFailed": "KityMinderファイルのインポートに失敗しました: {{error}}",
```

- [ ] **Step 3: Verify JSON validity**

Run: `npm run build`
Expected: TypeScript build succeeds (no JSON parse errors). (If build is slow, at
minimum run `node -e "require('./src/shared/i18n/locales/en/editor.json')"` is not
applicable to TS; rely on the editor/lint. A full `npm run build` happens in Task 11.)

- [ ] **Step 4: Commit**

```bash
git add src/shared/i18n/locales/en/editor.json src/shared/i18n/locales/ja/editor.json
git commit -m "feat(mindmap): add i18n for xmind save/import messages"
```

---

## Task 8: MindmapEditor — make `.xmind` editable; always parse as XMind

**Files:**
- Modify: `src/features/mindmap/components/MindmapEditor.tsx`

- [ ] **Step 1: Make the editor editable for `.xmind`**

At line ~253:

```ts
  const readOnly = fileType === ".xmind";
```

Replace with:

```ts
  // .xmind is now the editable native format.
  const readOnly = false;
```

(Leave the `readOnly` references intact — they are now always `false`, so editing is
enabled. This keeps the diff minimal and avoids touching every handler.)

- [ ] **Step 2: Always load via parseXmindFile**

At lines ~403-409:

```ts
        let jsonData: KityMinderJson;
        if (fileType === ".xmind") {
          jsonData = await parseXmindFile(fileData);
        } else {
          const text = new TextDecoder().decode(fileData);
          jsonData = JSON.parse(text) as KityMinderJson;
        }
```

Replace with:

```ts
        // All mindmap files are .xmind now (.km is converted before opening).
        const jsonData: KityMinderJson = await parseXmindFile(fileData);
```

- [ ] **Step 3: Typecheck the component**

Run: `npx tsc --noEmit`
Expected: no new type errors from this file. (`fileType` is still a declared prop and
remains used by the load effect dependency array; if `fileType` becomes unused and
lint fails the build, keep it referenced — it is still in the `useEffect` deps at
line ~447, so it remains used.)

- [ ] **Step 4: Commit**

```bash
git add src/features/mindmap/components/MindmapEditor.tsx
git commit -m "feat(mindmap): make .xmind editable and always parse as xmind"
```

---

## Task 9: App.tsx — save `.xmind` as binary at all three save sites

Switch mindmap saves from `JSON.stringify` + `write_text_file` to `serializeToXmind`
+ `writeFile`. Update the SaveAs filter to `xmind`.

**Files:**
- Modify: `src/app/App.tsx`

- [ ] **Step 1: Import the serializer and i18n**

Near the other mindmap imports (App.tsx:40):

```ts
import type { KityMinderJson } from "@/features/mindmap/lib/types";
```

Add:

```ts
import { serializeToXmind } from "@/features/mindmap/lib/xmind-serializer";
```

Ensure a translation function is available in App.tsx. If App already uses
`useTranslation` (search for `const { t }`), reuse it. If not, add at the top of the
component: `const { t } = useTranslation();` and `import { useTranslation } from "react-i18next";`. (Worker: check first; do not duplicate an existing `t`.)

- [ ] **Step 2: Rewrite `handleMindmapSave` (App.tsx ~509-521)**

Replace:

```ts
  const handleMindmapSave = useCallback(async (json: KityMinderJson) => {
    if (!activeTab?.filePath) return;
    try {
      const jsonStr = JSON.stringify(json, null, 2);
      await invoke("write_text_file", {
        path: activeTab.filePath,
        content: jsonStr,
      });
      markClean(activeTab.id);
    } catch (e) {
      console.error("Failed to save mindmap:", e);
    }
  }, [activeTab, markClean]);
```

With:

```ts
  const handleMindmapSave = useCallback(async (json: KityMinderJson) => {
    if (!activeTab?.filePath) return;
    try {
      const bytes = await serializeToXmind(json);
      const { writeFile } = await import("@tauri-apps/plugin-fs");
      await writeFile(activeTab.filePath, bytes);
      markClean(activeTab.id);
    } catch (e) {
      console.error("Failed to save mindmap:", e);
    }
  }, [activeTab, markClean]);
```

- [ ] **Step 3: Update SaveAs filter and mindmap branch (App.tsx ~552-569)**

Replace the filter:

```ts
        filters: isMindmap
          ? [{ name: "Mindmap", extensions: ["km"] }]
```

With:

```ts
        filters: isMindmap
          ? [{ name: "XMind", extensions: ["xmind"] }]
```

Then replace the mindmap write branch in `handleSaveAs`:

```ts
      let text: string;
      if (isMindmap) {
        const json = mindmapEditorRef.current?.getJson();
        if (!json) return;
        text = JSON.stringify(json, null, 2);
      } else {
        text = activeTab.content;
      }

      await invoke("write_text_file", { path: selected, content: text });
```

With:

```ts
      if (isMindmap) {
        const json = mindmapEditorRef.current?.getJson();
        if (!json) return;
        const bytes = await serializeToXmind(json);
        const { writeFile } = await import("@tauri-apps/plugin-fs");
        await writeFile(selected, bytes);
      } else {
        await invoke("write_text_file", { path: selected, content: activeTab.content });
      }
```

- [ ] **Step 4: Update `handleSave` mindmap branch (App.tsx ~590-598)**

Replace:

```ts
      if (activeTab.mindmapFileType) {
        const json = mindmapEditorRef.current?.getJson();
        if (json) {
          const jsonStr = JSON.stringify(json, null, 2);
          await invoke("write_text_file", {
            path: activeTab.filePath,
            content: jsonStr,
          });
        }
      } else if (activeTab.imageFileType) {
```

With:

```ts
      if (activeTab.mindmapFileType) {
        const json = mindmapEditorRef.current?.getJson();
        if (json) {
          const bytes = await serializeToXmind(json);
          const { writeFile } = await import("@tauri-apps/plugin-fs");
          await writeFile(activeTab.filePath, bytes);
        }
      } else if (activeTab.imageFileType) {
```

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no new type errors.

- [ ] **Step 6: Commit**

```bash
git add src/app/App.tsx
git commit -m "feat(mindmap): save mindmaps as binary .xmind at all save sites"
```

---

## Task 10: App.tsx — `.km` import bridge (convert-and-open)

When a `.km` file is opened, parse the KityMinder JSON, serialize to `.xmind`, write a
sibling `.xmind`, and open it. Leave the `.km` on disk.

**Files:**
- Modify: `src/app/App.tsx`

- [ ] **Step 1: Import the import-detection helper**

Where App imports from constants (App.tsx:10):

```ts
import { getOfficeExt, getMindmapExt, getImageExt, getPdfExt, getCsvExt, isCodeFile } from "@/shared/lib/constants";
```

Add `getKityMinderImportExt`:

```ts
import { getOfficeExt, getMindmapExt, getKityMinderImportExt, getImageExt, getPdfExt, getCsvExt, isCodeFile } from "@/shared/lib/constants";
```

- [ ] **Step 2: Add a `.km` branch in `handleFileSelect`**

In `handleFileSelect` (App.tsx ~407), after `const mindmapExt = getMindmapExt(filePath);` add:

```ts
        const kmImportExt = getKityMinderImportExt(filePath);
```

Then, BEFORE the `} else if (mindmapExt) {` branch, insert a new branch that converts
`.km` and re-opens the produced `.xmind`. Add this block right after the `officeExt`
branch closes and before `} else if (mindmapExt) {`:

```ts
        } else if (kmImportExt) {
          // KityMinder JSON is import-only: convert to .xmind, then open that.
          try {
            const bytes = await invoke<number[]>("read_binary_file", { path: filePath });
            const text = new TextDecoder().decode(new Uint8Array(bytes));
            const json = JSON.parse(text) as KityMinderJson;
            if (!json.root) throw new Error("missing root");
            const xmindBytes = await serializeToXmind(json);
            const xmindPath = filePath.replace(/\.km$/i, ".xmind");
            const { writeFile } = await import("@tauri-apps/plugin-fs");
            await writeFile(xmindPath, xmindBytes);
            loadFileTree();
            // Re-enter with the produced .xmind path.
            await handleFileSelect(xmindPath);
            return;
          } catch (e) {
            console.error("Failed to import KityMinder file:", e);
            // Surface via existing notification mechanism if present; otherwise log.
          }
```

(Worker note: `handleFileSelect` is a `useCallback`. Recursive self-call requires the
function to be in scope. If the linter flags the recursive reference, extract the
`.km` conversion into a small helper `importKmAsXmind(filePath)` defined above
`handleFileSelect` that returns the new path, then call
`return handleFileSelect(await importKmAsXmind(filePath));`. Keep behavior identical.)

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no new type errors.

- [ ] **Step 4: Manual verification (documented; no unit test for IPC/UI)**

1. `npm run tauri dev`
2. Use the opencode command `convert-to-km-mindmap` (or hand-create a `.km` JSON file
   with a `{ root, theme, template }` shape).
3. Open the `.km` file in mdium.
4. Expected: a sibling `.xmind` appears in the tree and opens in the editor; the tree,
   layout, and theme match the `.km`.

- [ ] **Step 5: Commit**

```bash
git add src/app/App.tsx
git commit -m "feat(mindmap): convert .km to .xmind on open (import bridge)"
```

---

## Task 11: File-tree icon, LeftPanel label, and opencode command note

**Files:**
- Modify: `src/features/file-tree/components/FileTree.tsx`
- Modify: `src/features/file-tree/components/LeftPanel.tsx`
- Modify: `src/features/opencode-config/lib/builtin-commands.ts`

- [ ] **Step 1: Add a `.xmind` icon (FileTree.tsx ~54)**

Current:

```ts
  if (lower.endsWith(".km")) return "💡";
```

Replace with (cover `.xmind`, keep `.km` showing the same idea icon since it is an
importable mindmap source):

```ts
  if (lower.endsWith(".xmind")) return "💡";
  if (lower.endsWith(".km")) return "💡";
```

- [ ] **Step 2: Update LeftPanel reference (LeftPanel.tsx ~310)**

Inspect the context around line 310 (it lists `.km` among supported/preview
extensions). Replace the `.km` token with `.xmind` (or add `.xmind` alongside if the
list is a help/legend of openable types). Keep wording i18n-compliant — if it is a
hardcoded extension token in a list, just change `.km` → `.xmind`.

Run to locate: `npm test -- --reporter=dot` is not needed; open the file and edit the
single token at line ~310.

- [ ] **Step 3: Update the opencode command description/instructions**

In `src/features/opencode-config/lib/builtin-commands.ts`, update the
`convert-to-km-mindmap` entry. Keep generating `.km` JSON, but make the description
and instructions state the file is auto-converted by mdium.

Change the `description` (line ~159-160):

```ts
    description:
      "Convert Markdown into a KityMinder mindmap JSON (.km); mdium auto-converts it to .xmind on open",
```

In the `template` string, change instruction step 2 (line ~169) to add a note:

```
2. Determine the output path by replacing the file extension with \`.km\` (e.g. \`notes.md\` → \`notes.km\`). When this file is opened in mdium it is automatically converted to a \`.xmind\` file.
```

- [ ] **Step 4: Typecheck/build**

Run: `npx tsc --noEmit`
Expected: no new type errors.

- [ ] **Step 5: Commit**

```bash
git add src/features/file-tree/components/FileTree.tsx src/features/file-tree/components/LeftPanel.tsx src/features/opencode-config/lib/builtin-commands.ts
git commit -m "chore(mindmap): xmind icon, panel label, and opencode command note"
```

---

## Task 12: Full verification

- [ ] **Step 1: Run the whole test suite**

Run: `npm test`
Expected: PASS, including all new mindmap tests (structure, parser-restore, roundtrip,
image, content-xml, constants).

- [ ] **Step 2: Typecheck + production build**

Run: `npm run build`
Expected: `tsc` passes and `vite build` completes with no errors.

- [ ] **Step 3: Manual smoke test in the app**

Run: `npm run tauri dev`, then verify:
1. Create/open an `.xmind` mindmap; it is **editable** (add/edit/delete/drag nodes).
2. Set a non-default layout (e.g. bottom) and theme (e.g. fresh-green); save.
3. Close and reopen the file: layout and theme are preserved.
4. Add a node with a note, hyperlink (+title), priority, progress, an image, and a
   collapsed branch; save; reopen: all fields preserved.
5. Save As: the dialog offers `.xmind`; saving writes a valid file that reopens.
6. Open a `.km` file produced by `convert-to-km-mindmap`: a `.xmind` sibling is created
   and opens with matching content.
7. (Optional interop) Open the saved `.xmind` in the XMind app: topics, structure, and
   markers appear.

- [ ] **Step 4: Final commit (if any cleanup)**

```bash
git add -A
git commit -m "test(mindmap): verify .xmind migration end-to-end"
```

---

## Notes / Known Limitations (document in PR description)

- `content.xml` is best-effort XMind 8 interop; mdium always reads `content.json`.
  xml-js compact mode represents a single child topic as an object the existing parser
  does not expand, so a content.xml-only file with a single child may under-parse.
  This does not affect mdium round-trip (content.json is authoritative).
- Images are stored once under `resources/`. XMind 8 (historically `attachments/`) may
  not preview them; current XMind and mdium do.
- KityMinder `template`/`theme` have no native XMind equivalent for theme; layout maps
  to `structureClass`, theme is stored in `metadata.json` under the `mdium` key.
- "XMind" is used descriptively only; no logos/endorsement implied; compatibility is
  best-effort (no warranty).
