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
