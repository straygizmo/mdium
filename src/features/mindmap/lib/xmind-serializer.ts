/**
 * Serialize a KityMinderJson into a .xmind ZIP (inverse of xmind-parser.ts).
 * Emits content.json (XMind Zen), content.xml (XMind 8), metadata.json, and
 * manifests. Images are stored under resources/ (see attachImages).
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

  // image is attached by attachImages after buildTopic returns.

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

function mediaTypeForPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "png": return "image/png";
    case "jpg":
    case "jpeg": return "image/jpeg";
    case "gif": return "image/gif";
    case "webp": return "image/webp";
    case "svg": return "image/svg+xml";
    case "bmp": return "image/bmp";
    default: return "application/octet-stream";
  }
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
    ...extraEntries.map((e) => fileEntry(e, mediaTypeForPath(e))),
    "</manifest>",
  ];
  return lines.join("\n");
}

export async function serializeToXmind(json: KityMinderJson): Promise<Uint8Array> {
  idCounter = 0;
  const layout = json.template ?? "right";
  const sheetId = nextId();

  const rootTopic = buildTopic(json.root, true, layout);

  // Image extraction populates `resources` and rewrites topic.image.
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
  // JSZip implicitly creates a directory entry ("resources/") when adding nested files.
  // Remove it so zip.files only contains real file entries (test-verifiable and cleaner).
  if (resourcePaths.length > 0) {
    delete (zip.files as Record<string, unknown>)["resources/"];
  }

  zip.file("manifest.json", buildZenManifest(resourcePaths));
  zip.file("META-INF/manifest.xml", buildXml8Manifest(resourcePaths));

  return zip.generateAsync({ type: "uint8array" });
}

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
      const subtype = m[1].toLowerCase();
      const ext = subtype === "jpeg" ? "jpg" : subtype === "svg+xml" ? "svg" : subtype;
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
