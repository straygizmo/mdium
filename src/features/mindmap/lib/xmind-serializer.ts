/**
 * Serialize a KityMinderJson into a .xmind ZIP (inverse of xmind-parser.ts).
 * Emits content.json (XMind Zen), content.xml (XMind 8), metadata.json, and
 * manifests. Images are stored under resources/ (see attachImages, added later).
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

  // image is attached later (attachImages).

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

  // Image extraction populates `resources` and rewrites topic.image (added later).
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

// Placeholder; real image extraction is added in a later task. Defined as a function
// declaration so it is hoisted above its use in serializeToXmind.
function attachImages(
  _node: KityMinderNode,
  _topic: SerializedTopic,
  _resources: Record<string, Uint8Array>,
): void {
  // no-op until images task
}
