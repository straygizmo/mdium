import type { SerializedTopic } from "./xmind-serializer";

/** Minimal placeholder; replaced with a full builder in a later task. */
export function buildContentXml(_sheet: { rootTopic: SerializedTopic }): string {
  return '<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n<xmap-content/>';
}
