/**
 * .xmind file parser — browser port of vscode-mindmap/src/xmindparser
 * Converts .xmind (ZIP archive) to KityMinder JSON format.
 */
import JSZip from "jszip";
import { xml2json } from "xml-js";
import type { KityMinderJson, KityMinderNode, KityMinderNodeData } from "./types";

const TASK_MARKERS = ["start", "oct", "quarter", "3oct", "half", "5oct", "3quar", "7oct", "done", "pause"];

/** Fuzzy key match on object */
function objMatchingKey(obj: Record<string, unknown>, key: string): string | undefined {
  return Object.keys(obj).find((k) => k.indexOf(key) >= 0);
}

interface XmindMarker {
  _attributes?: { markerId?: string; "marker-id"?: string };
  markerId?: string;
  "marker-id"?: string;
}

/** Extract image info from ZIP entry */
async function getImageInfo(zip: JSZip, path: string): Promise<{ name: string; base64: string }> {
  const file = zip.file(path);
  if (!file) return { name: path, base64: "" };
  const data = await file.async("base64");
  const ext = (path.split(".").pop() || "png").toLowerCase();
  const base64 = `data:image/${ext};base64,${data}`;
  return { name: path.split("/").pop() || path, base64 };
}

/** Convert a single XMind topic node to KityMinder format */
function convertNode(
  data: Record<string, unknown>,
  imgFiles: Record<string, { base64: string }>
): KityMinderNode {
  const title = (data.title as string) || "";
  const notes = (data.notes as Record<string, Record<string, string>>) || { plain: { content: "" } };
  const markers = (data.markers as XmindMarker[]) || [];
  const markerRefs = (data["marker-refs"] as Record<string, XmindMarker | XmindMarker[]>) || {};
  const xmlInfo = data["xhtml:img"] as Record<string, Record<string, string>> | undefined;
  const image = (data.image as Record<string, string>) || { src: "" };

  // Resolve text
  const text = typeof title === "object"
    ? (title as Record<string, string>)[objMatchingKey(title as Record<string, unknown>, "text") || ""] || ""
    : title;

  // Resolve image
  const imageAttr = xmlInfo?._attributes || {};
  const src = imageAttr["xhtml:src"];
  const imageName = (src || image.src || "").split("/").pop() || "";
  const imageData = imgFiles[imageName];
  const imageBase = imageData?.base64;
  const imageSize = {
    width: imageAttr["svg:width"] ? Number(imageAttr["svg:width"]) : 200,
    height: imageAttr["svg:height"] ? Number(imageAttr["svg:height"]) : 200,
  };

  // Resolve markers (priority & progress)
  let priority: number | undefined;
  let progress: number | undefined;
  const markerList: XmindMarker[] = Array.isArray(markerRefs["marker-refs"])
    ? markerRefs["marker-refs"]
    : Array.isArray(markerRefs["marker-ref"])
      ? (markerRefs["marker-ref"] as unknown as XmindMarker[])
      : markers;

  if (Array.isArray(markerList)) {
    for (const m of markerList) {
      const attr = m._attributes || m;
      const markerId = (attr.markerId || attr["marker-id"] || "") as string;
      if (markerId.indexOf("priority") >= 0) {
        const num = Number(markerId.replace(/[^0-9]/g, ""));
        if (!isNaN(num)) priority = num;
      } else if (markerId.indexOf("task") >= 0) {
        const idx = TASK_MARKERS.findIndex((r) => markerId.split("-").pop() === r);
        if (idx >= 0) progress = idx + 1;
      }
    }
  }

  // Resolve children
  let children: KityMinderNode[] = [];
  const childrenData = data.children as Record<string, unknown> | unknown[] | undefined;
  if (childrenData) {
    const topics = (childrenData as Record<string, unknown>).topics as unknown;
    if (Array.isArray(topics)) {
      children = (topics as Record<string, unknown>[]).map((c) => convertNode(c, imgFiles));
    } else if (topics && typeof topics === "object") {
      const topic = (topics as Record<string, unknown>).topic;
      if (Array.isArray(topic)) {
        children = (topic as Record<string, unknown>[]).map((c) => convertNode(c, imgFiles));
      }
    } else if (Array.isArray(childrenData)) {
      children = (childrenData as Record<string, unknown>[]).map((c) => convertNode(c, imgFiles));
    }
  }
  // Also handle direct `children.attached` from newer XMind format
  if (children.length === 0 && childrenData) {
    const attached = (childrenData as Record<string, unknown>).attached;
    if (Array.isArray(attached)) {
      children = (attached as Record<string, unknown>[]).map((c) => {
        const topic = (c as Record<string, unknown>).topic;
        return convertNode((topic || c) as Record<string, unknown>, imgFiles);
      });
    }
  }

  // Resolve hyperlink
  const href = (data.href as string) ||
    (data._attributes as Record<string, string> | undefined)?.["xlink:href"] ||
    (data._attributes as Record<string, string> | undefined)?.href ||
    "";
  const hyperlinkTitle = (data["xlink:title"] as string) ||
    (data._attributes as Record<string, string> | undefined)?.["xlink:title"] ||
    "";

  const nodeData: KityMinderNodeData = { text };
  if (priority !== undefined) nodeData.priority = priority;
  if (progress !== undefined) nodeData.progress = progress;
  const noteContent = notes?.plain?.content || (notes?.plain as Record<string, string>)?._text;
  if (noteContent) nodeData.note = noteContent;
  if (href) {
    nodeData.hyperlink = href;
    if (hyperlinkTitle) nodeData.hyperlinkTitle = hyperlinkTitle;
  }
  if (imageBase) {
    nodeData.image = imageBase;
    nodeData.imageSize = imageSize;
  }

  return { data: nodeData, children };
}

/**
 * Parse a .xmind file (ArrayBuffer / Uint8Array) into KityMinder JSON.
 */
export async function parseXmindFile(data: ArrayBuffer | Uint8Array): Promise<KityMinderJson> {
  const zip = await JSZip.loadAsync(data);
  const { files } = zip;

  // Check for kityminder.json (direct format)
  const kityminderFile = files["kityminder.json"];
  if (kityminderFile) {
    const content = await kityminderFile.async("string");
    return JSON.parse(content) as KityMinderJson;
  }

  // Find content.json or content.xml
  const contentJsonKey = objMatchingKey(files, "content.json");
  const contentXmlKey = objMatchingKey(files, "content.xml");
  const isJson = !!contentJsonKey;
  const fileKey = contentJsonKey || contentXmlKey;

  if (!fileKey || !files[fileKey]) {
    throw new Error("XMindファイルの解析に失敗しました: content.json/content.xml が見つかりません");
  }

  const fileContent = await files[fileKey].async("string");

  // Collect images
  const imgList = Object.keys(files).filter((k) => {
    const dir = k.split("/")[0];
    return dir === "attachments" || dir === "resources";
  });
  const imgInfos = await Promise.all(imgList.map((k) => getImageInfo(zip, k)));
  const imgFiles: Record<string, { base64: string }> = {};
  for (const info of imgInfos) {
    imgFiles[info.name] = { base64: info.base64 };
  }

  let rootTopic: Record<string, unknown>;
  if (!isJson) {
    // XML format
    const json = JSON.parse(xml2json(fileContent, { compact: true, spaces: 4 }));
    rootTopic = (json as Record<string, Record<string, Record<string, unknown>>>)["xmap-content"]?.sheet?.topic as Record<string, unknown>;
  } else {
    // JSON format
    const parsed = JSON.parse(fileContent);
    rootTopic = (Array.isArray(parsed) ? parsed[0] : parsed)?.rootTopic || {};
  }

  if (!rootTopic) {
    throw new Error("XMindファイルの解析に失敗しました: ルートトピックが見つかりません");
  }

  const result: KityMinderJson = {
    template: "default",
    theme: "fresh-blue",
    root: convertNode(rootTopic, imgFiles),
  };

  return result;
}
