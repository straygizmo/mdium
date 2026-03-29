// xlsx2md – vendored build
// https://github.com/igapyon/xlsx2md
// SPDX-License-Identifier: Apache-2.0
// AUTO-GENERATED – do not edit by hand

// ── module-registry ─────────────────────────────────────────────
/*
 * Copyright 2026 Toshiki Iga
 * SPDX-License-Identifier: Apache-2.0
 */
(() => {
    var _a;
    const registry = ((_a = globalThis).__xlsx2mdModuleRegistryStore ?? (_a.__xlsx2mdModuleRegistryStore = {}));
    function getModule(name) {
        return registry[name];
    }
    function requireModule(name, errorMessage) {
        const moduleValue = getModule(name);
        if (!moduleValue) {
            throw new Error(errorMessage);
        }
        return moduleValue;
    }
    function registerModule(name, moduleValue) {
        registry[name] = moduleValue;
        return moduleValue;
    }
    globalThis.__xlsx2mdModuleRegistry = {
        getModule,
        requireModule,
        registerModule
    };
})();

// ── module-registry-access ──────────────────────────────────────
/*
 * Copyright 2026 Toshiki Iga
 * SPDX-License-Identifier: Apache-2.0
 */
(() => {
    globalThis.getXlsx2mdModuleRegistry = function getXlsx2mdModuleRegistry() {
        const moduleRegistry = globalThis.__xlsx2mdModuleRegistry;
        if (!moduleRegistry) {
            throw new Error("xlsx2md module registry is not loaded");
        }
        return moduleRegistry;
    };
    globalThis.requireXlsx2mdRuntimeEnv = function requireXlsx2mdRuntimeEnv() {
        return globalThis.getXlsx2mdModuleRegistry().requireModule("runtimeEnv", "xlsx2md runtime env module is not loaded");
    };
    globalThis.requireXlsx2mdMarkdownNormalize = function requireXlsx2mdMarkdownNormalize() {
        return globalThis.getXlsx2mdModuleRegistry().requireModule("markdownNormalize", "xlsx2md markdown normalize module is not loaded");
    };
    globalThis.requireXlsx2mdZipIo = function requireXlsx2mdZipIo() {
        return globalThis.getXlsx2mdModuleRegistry().requireModule("zipIo", "xlsx2md zip io module is not loaded");
    };
    globalThis.requireXlsx2mdMarkdownEscape = function requireXlsx2mdMarkdownEscape() {
        return globalThis.getXlsx2mdModuleRegistry().requireModule("markdownEscape", "xlsx2md markdown escape module is not loaded");
    };
    globalThis.requireXlsx2mdMarkdownTableEscape = function requireXlsx2mdMarkdownTableEscape() {
        return globalThis.getXlsx2mdModuleRegistry().requireModule("markdownTableEscape", "xlsx2md markdown table escape module is not loaded");
    };
    globalThis.requireXlsx2mdRichTextPlainFormatterModule = function requireXlsx2mdRichTextPlainFormatterModule() {
        return globalThis.getXlsx2mdModuleRegistry().requireModule("richTextPlainFormatter", "xlsx2md rich text plain formatter module is not loaded");
    };
    globalThis.getXlsx2mdDrawingHelperModule = function getXlsx2mdDrawingHelperModule() {
        return globalThis.getXlsx2mdModuleRegistry().getModule("officeDrawing") || null;
    };
    globalThis.requireXlsx2mdNarrativeStructureModule = function requireXlsx2mdNarrativeStructureModule() {
        return globalThis.getXlsx2mdModuleRegistry().requireModule("narrativeStructure", "xlsx2md narrative structure module is not loaded");
    };
    globalThis.requireXlsx2mdRichTextParserModule = function requireXlsx2mdRichTextParserModule() {
        return globalThis.getXlsx2mdModuleRegistry().requireModule("richTextParser", "xlsx2md rich text parser module is not loaded");
    };
    globalThis.requireXlsx2mdRichTextGithubFormatterModule = function requireXlsx2mdRichTextGithubFormatterModule() {
        return globalThis.getXlsx2mdModuleRegistry().requireModule("richTextGithubFormatter", "xlsx2md rich text github formatter module is not loaded");
    };
    globalThis.requireXlsx2mdRichTextRendererModule = function requireXlsx2mdRichTextRendererModule() {
        return globalThis.getXlsx2mdModuleRegistry().requireModule("richTextRenderer", "xlsx2md rich text renderer module is not loaded");
    };
    globalThis.requireXlsx2mdTableDetectorModule = function requireXlsx2mdTableDetectorModule() {
        return globalThis.getXlsx2mdModuleRegistry().requireModule("tableDetector", "xlsx2md table detector module is not loaded");
    };
    globalThis.requireXlsx2mdMarkdownExportModule = function requireXlsx2mdMarkdownExportModule() {
        return globalThis.getXlsx2mdModuleRegistry().requireModule("markdownExport", "xlsx2md markdown export module is not loaded");
    };
    globalThis.requireXlsx2mdStylesParserModule = function requireXlsx2mdStylesParserModule() {
        return globalThis.getXlsx2mdModuleRegistry().requireModule("stylesParser", "xlsx2md styles parser module is not loaded");
    };
    globalThis.requireXlsx2mdSharedStringsModule = function requireXlsx2mdSharedStringsModule() {
        return globalThis.getXlsx2mdModuleRegistry().requireModule("sharedStrings", "xlsx2md shared strings module is not loaded");
    };
    globalThis.requireXlsx2mdWorksheetTablesModule = function requireXlsx2mdWorksheetTablesModule() {
        return globalThis.getXlsx2mdModuleRegistry().requireModule("worksheetTables", "xlsx2md worksheet tables module is not loaded");
    };
    globalThis.requireXlsx2mdCellFormatModule = function requireXlsx2mdCellFormatModule() {
        return globalThis.getXlsx2mdModuleRegistry().requireModule("cellFormat", "xlsx2md cell format module is not loaded");
    };
    globalThis.requireXlsx2mdXmlUtilsModule = function requireXlsx2mdXmlUtilsModule() {
        return globalThis.getXlsx2mdModuleRegistry().requireModule("xmlUtils", "xlsx2md xml utils module is not loaded");
    };
    globalThis.requireXlsx2mdAddressUtilsModule = function requireXlsx2mdAddressUtilsModule() {
        return globalThis.getXlsx2mdModuleRegistry().requireModule("addressUtils", "xlsx2md address utils module is not loaded");
    };
    globalThis.requireXlsx2mdRelsParserModule = function requireXlsx2mdRelsParserModule() {
        return globalThis.getXlsx2mdModuleRegistry().requireModule("relsParser", "xlsx2md rels parser module is not loaded");
    };
    globalThis.requireXlsx2mdFormulaReferenceUtilsModule = function requireXlsx2mdFormulaReferenceUtilsModule() {
        return globalThis.getXlsx2mdModuleRegistry().requireModule("formulaReferenceUtils", "xlsx2md formula reference utils module is not loaded");
    };
    globalThis.requireXlsx2mdSheetMarkdownModule = function requireXlsx2mdSheetMarkdownModule() {
        return globalThis.getXlsx2mdModuleRegistry().requireModule("sheetMarkdown", "xlsx2md sheet markdown module is not loaded");
    };
    globalThis.requireXlsx2mdFormulaEngineModule = function requireXlsx2mdFormulaEngineModule() {
        return globalThis.getXlsx2mdModuleRegistry().requireModule("formulaEngine", "xlsx2md formula engine module is not loaded");
    };
    globalThis.requireXlsx2mdSheetAssetsModule = function requireXlsx2mdSheetAssetsModule() {
        return globalThis.getXlsx2mdModuleRegistry().requireModule("sheetAssets", "xlsx2md sheet assets module is not loaded");
    };
    globalThis.requireXlsx2mdWorksheetParserModule = function requireXlsx2mdWorksheetParserModule() {
        return globalThis.getXlsx2mdModuleRegistry().requireModule("worksheetParser", "xlsx2md worksheet parser module is not loaded");
    };
    globalThis.requireXlsx2mdWorkbookLoaderModule = function requireXlsx2mdWorkbookLoaderModule() {
        return globalThis.getXlsx2mdModuleRegistry().requireModule("workbookLoader", "xlsx2md workbook loader module is not loaded");
    };
    globalThis.requireXlsx2mdFormulaResolverModule = function requireXlsx2mdFormulaResolverModule() {
        return globalThis.getXlsx2mdModuleRegistry().requireModule("formulaResolver", "xlsx2md formula resolver module is not loaded");
    };
    globalThis.requireXlsx2mdFormulaLegacyModule = function requireXlsx2mdFormulaLegacyModule() {
        return globalThis.getXlsx2mdModuleRegistry().requireModule("formulaLegacy", "xlsx2md formula legacy module is not loaded");
    };
    globalThis.requireXlsx2mdFormulaAstModule = function requireXlsx2mdFormulaAstModule() {
        return globalThis.getXlsx2mdModuleRegistry().requireModule("formulaAst", "xlsx2md formula ast module is not loaded");
    };
})();

// ── runtime-env ─────────────────────────────────────────────────
/*
 * Copyright 2026 Toshiki Iga
 * SPDX-License-Identifier: Apache-2.0
 */
(() => {
    const moduleRegistry = getXlsx2mdModuleRegistry();
    const ELEMENT_NODE = 1;
    const TEXT_NODE = 3;
    function createDomParser() {
        if (typeof DOMParser !== "function") {
            throw new Error("This environment does not provide DOMParser.");
        }
        return new DOMParser();
    }
    function xmlToDocument(xmlText) {
        return createDomParser().parseFromString(xmlText, "application/xml");
    }
    const runtimeEnvApi = {
        ELEMENT_NODE,
        TEXT_NODE,
        xmlToDocument
    };
    moduleRegistry.registerModule("runtimeEnv", runtimeEnvApi);
})();

// ── office-drawing ──────────────────────────────────────────────
/*
 * Copyright 2026 Toshiki Iga
 * SPDX-License-Identifier: Apache-2.0
 */
(() => {
    const moduleRegistry = getXlsx2mdModuleRegistry();
    const textEncoder = new TextEncoder();
    const runtimeEnv = requireXlsx2mdRuntimeEnv();
    function getDirectChildByLocalName(root, localName) {
        if (!root)
            return null;
        for (const node of Array.from(root.childNodes)) {
            if (node.nodeType === runtimeEnv.ELEMENT_NODE && node.localName === localName) {
                return node;
            }
        }
        return null;
    }
    function getElementsByLocalName(root, localName) {
        if (!root)
            return [];
        const elements = Array.from(root.getElementsByTagName("*"));
        return elements.filter((element) => element.localName === localName);
    }
    function getTextContent(node) {
        return (node?.textContent || "").replace(/\r\n/g, "\n");
    }
    function createSafeSheetAssetDir(sheetName) {
        return sheetName.replace(/[\\/:*?"<>|]+/g, "_").trim() || "Sheet";
    }
    function escapeXml(text) {
        return String(text || "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&apos;");
    }
    function emuToPx(emu, fallback) {
        if (!Number.isFinite(emu) || emu <= 0)
            return fallback;
        return Math.max(1, Math.round(emu / 9525));
    }
    function parseHexColor(root) {
        const srgb = getElementsByLocalName(root, "srgbClr")[0] || null;
        if (srgb?.getAttribute("val")) {
            return `#${String(srgb.getAttribute("val")).trim()}`;
        }
        const scheme = getElementsByLocalName(root, "schemeClr")[0] || null;
        const schemeVal = String(scheme?.getAttribute("val") || "").trim();
        const schemeMap = {
            accent1: "#4472C4",
            accent2: "#ED7D31",
            accent3: "#A5A5A5",
            accent4: "#FFC000",
            accent5: "#5B9BD5",
            accent6: "#70AD47",
            tx1: "#000000",
            tx2: "#44546A",
            lt1: "#FFFFFF",
            lt2: "#E7E6E6"
        };
        return schemeMap[schemeVal] || null;
    }
    function parseShapeText(shapeNode) {
        return getElementsByLocalName(shapeNode, "t")
            .map((node) => getTextContent(node).trim())
            .filter(Boolean)
            .join("\n")
            .trim();
    }
    function parseShapeKind(shapeNode) {
        if (!shapeNode)
            return null;
        if (shapeNode.localName === "cxnSp") {
            return "connector";
        }
        if (shapeNode.localName !== "sp") {
            return null;
        }
        const nvSpPr = getDirectChildByLocalName(shapeNode, "nvSpPr");
        const cNvSpPr = getDirectChildByLocalName(nvSpPr, "cNvSpPr");
        if (cNvSpPr?.getAttribute("txBox") === "1") {
            return "textbox";
        }
        const spPr = getDirectChildByLocalName(shapeNode, "spPr");
        const prstGeom = getDirectChildByLocalName(spPr, "prstGeom");
        if (String(prstGeom?.getAttribute("prst") || "").trim() === "rect") {
            return "rect";
        }
        return null;
    }
    function parseShapeDimensions(anchor, shapeNode) {
        const extNode = getDirectChildByLocalName(anchor, "ext")
            || getDirectChildByLocalName(getDirectChildByLocalName(getDirectChildByLocalName(shapeNode || anchor, "spPr"), "xfrm"), "ext");
        const widthEmu = Number(extNode?.getAttribute("cx") || "");
        const heightEmu = Number(extNode?.getAttribute("cy") || "");
        return {
            widthPx: emuToPx(widthEmu, 160),
            heightPx: emuToPx(heightEmu, 48)
        };
    }
    function renderRectLikeSvg(shapeNode, anchor, text, treatAsTextbox) {
        const { widthPx, heightPx } = parseShapeDimensions(anchor, shapeNode);
        const spPr = getDirectChildByLocalName(shapeNode, "spPr");
        const fillColor = parseHexColor(getDirectChildByLocalName(spPr, "solidFill")) || (treatAsTextbox ? "#FFFFFF" : "#F3F3F3");
        const lineNode = getDirectChildByLocalName(spPr, "ln");
        const strokeColor = parseHexColor(lineNode) || "#333333";
        const strokeWidth = Math.max(1, Math.round(Number(lineNode?.getAttribute("w") || "") / 9525) || 1);
        const safeText = escapeXml(text);
        const textMarkup = safeText
            ? `<text x="${Math.round(widthPx / 2)}" y="${Math.round(heightPx / 2)}" text-anchor="middle" dominant-baseline="middle" font-size="14" font-family="sans-serif" fill="#000000">${safeText}</text>`
            : "";
        return [
            `<svg xmlns="http://www.w3.org/2000/svg" width="${widthPx}" height="${heightPx}" viewBox="0 0 ${widthPx} ${heightPx}">`,
            `  <rect x="1" y="1" width="${Math.max(1, widthPx - 2)}" height="${Math.max(1, heightPx - 2)}" fill="${fillColor}" stroke="${strokeColor}" stroke-width="${strokeWidth}"/>`,
            textMarkup ? `  ${textMarkup}` : "",
            `</svg>`
        ].filter(Boolean).join("\n");
    }
    function renderConnectorSvg(shapeNode, anchor) {
        const { widthPx, heightPx } = parseShapeDimensions(anchor, shapeNode);
        const spPr = getDirectChildByLocalName(shapeNode, "spPr");
        const lineNode = getDirectChildByLocalName(spPr, "ln");
        const strokeColor = parseHexColor(lineNode) || "#333333";
        const strokeWidth = Math.max(1, Math.round(Number(lineNode?.getAttribute("w") || "") / 9525) || 1);
        const effectiveHeight = Math.max(heightPx, 24);
        const y = Math.round(effectiveHeight / 2);
        return [
            `<svg xmlns="http://www.w3.org/2000/svg" width="${widthPx}" height="${effectiveHeight}" viewBox="0 0 ${widthPx} ${effectiveHeight}">`,
            `  <defs>`,
            `    <marker id="arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto" markerUnits="strokeWidth">`,
            `      <path d="M0,0 L0,6 L9,3 z" fill="${strokeColor}"/>`,
            `    </marker>`,
            `  </defs>`,
            `  <line x1="2" y1="${y}" x2="${Math.max(2, widthPx - 4)}" y2="${y}" stroke="${strokeColor}" stroke-width="${strokeWidth}" marker-end="url(#arrow)"/>`,
            `</svg>`
        ].join("\n");
    }
    function renderShapeSvg(shapeNode, anchor, sheetName, shapeIndex) {
        const kind = parseShapeKind(shapeNode);
        if (!kind)
            return null;
        let svg = "";
        if (kind === "connector") {
            svg = renderConnectorSvg(shapeNode, anchor);
        }
        else {
            svg = renderRectLikeSvg(shapeNode, anchor, parseShapeText(shapeNode), kind === "textbox");
        }
        const safeDir = createSafeSheetAssetDir(sheetName);
        const filename = `shape_${String(shapeIndex).padStart(3, "0")}.svg`;
        return {
            filename,
            path: `assets/${safeDir}/${filename}`,
            data: textEncoder.encode(`${svg}\n`)
        };
    }
    const officeDrawingApi = {
        renderShapeSvg
    };
    moduleRegistry.registerModule("officeDrawing", officeDrawingApi);
})();

// ── zip-io ──────────────────────────────────────────────────────
/*
 * Copyright 2026 Toshiki Iga
 * SPDX-License-Identifier: Apache-2.0
 */
(() => {
    const moduleRegistry = getXlsx2mdModuleRegistry();
    const textDecoder = new TextDecoder("utf-8");
    const textEncoder = new TextEncoder();
    const crcTable = buildCrc32Table();
    const fixedZipEntryTimestamp = toDosDateTime(2025, 1, 1, 0, 0, 0);
    const utf8FileNameFlag = 0x0800;
    function buildCrc32Table() {
        const table = new Uint32Array(256);
        for (let i = 0; i < 256; i += 1) {
            let value = i;
            for (let bit = 0; bit < 8; bit += 1) {
                value = (value & 1) === 1 ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
            }
            table[i] = value >>> 0;
        }
        return table;
    }
    function crc32(bytes) {
        let crc = 0xffffffff;
        for (const byte of bytes) {
            crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
        }
        return (crc ^ 0xffffffff) >>> 0;
    }
    function decodeXmlText(bytes) {
        return textDecoder.decode(bytes);
    }
    function hasNonAsciiCharacters(value) {
        return /[^\x00-\x7f]/.test(value);
    }
    function toDosDateTime(year, month, day, hour, minute, second) {
        const clampedYear = Math.max(1980, Math.min(2107, year));
        const dosTime = ((hour & 0x1f) << 11) | ((minute & 0x3f) << 5) | (Math.floor(second / 2) & 0x1f);
        const dosDate = (((clampedYear - 1980) & 0x7f) << 9) | ((month & 0x0f) << 5) | (day & 0x1f);
        return {
            dosTime,
            dosDate
        };
    }
    function readUint16LE(view, offset) {
        return view.getUint16(offset, true);
    }
    function readUint32LE(view, offset) {
        return view.getUint32(offset, true);
    }
    async function inflateRaw(data) {
        if (typeof DecompressionStream === "function") {
            const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
            const buffer = await new Response(stream).arrayBuffer();
            return new Uint8Array(buffer);
        }
        throw new Error("This environment does not support ZIP deflate decompression.");
    }
    async function unzipEntries(arrayBuffer) {
        const view = new DataView(arrayBuffer);
        let eocdOffset = -1;
        for (let offset = view.byteLength - 22; offset >= Math.max(0, view.byteLength - 0x10000 - 22); offset -= 1) {
            if (readUint32LE(view, offset) === 0x06054b50) {
                eocdOffset = offset;
                break;
            }
        }
        if (eocdOffset < 0) {
            throw new Error("ZIP end-of-central-directory record was not found.");
        }
        const centralDirectorySize = readUint32LE(view, eocdOffset + 12);
        const centralDirectoryOffset = readUint32LE(view, eocdOffset + 16);
        const endOffset = centralDirectoryOffset + centralDirectorySize;
        const entries = [];
        let cursor = centralDirectoryOffset;
        while (cursor < endOffset) {
            if (readUint32LE(view, cursor) !== 0x02014b50) {
                throw new Error("ZIP central directory format is invalid.");
            }
            const compressionMethod = readUint16LE(view, cursor + 10);
            const compressedSize = readUint32LE(view, cursor + 20);
            const uncompressedSize = readUint32LE(view, cursor + 24);
            const fileNameLength = readUint16LE(view, cursor + 28);
            const extraFieldLength = readUint16LE(view, cursor + 30);
            const fileCommentLength = readUint16LE(view, cursor + 32);
            const localHeaderOffset = readUint32LE(view, cursor + 42);
            const fileNameBytes = new Uint8Array(arrayBuffer, cursor + 46, fileNameLength);
            const name = decodeXmlText(fileNameBytes);
            entries.push({
                name,
                compressionMethod,
                compressedSize,
                uncompressedSize,
                localHeaderOffset
            });
            cursor += 46 + fileNameLength + extraFieldLength + fileCommentLength;
        }
        const files = new Map();
        for (const entry of entries) {
            const localOffset = entry.localHeaderOffset;
            if (readUint32LE(view, localOffset) !== 0x04034b50) {
                throw new Error(`ZIP local header is invalid: ${entry.name}`);
            }
            const fileNameLength = readUint16LE(view, localOffset + 26);
            const extraFieldLength = readUint16LE(view, localOffset + 28);
            const dataOffset = localOffset + 30 + fileNameLength + extraFieldLength;
            const compressedData = new Uint8Array(arrayBuffer, dataOffset, entry.compressedSize);
            let fileData;
            if (entry.compressionMethod === 0) {
                fileData = new Uint8Array(compressedData);
            }
            else if (entry.compressionMethod === 8) {
                fileData = await inflateRaw(compressedData);
            }
            else {
                throw new Error(`Unsupported compression method: ${entry.name} (method=${entry.compressionMethod})`);
            }
            files.set(entry.name, fileData);
        }
        return files;
    }
    function createStoredZip(entries) {
        const localChunks = [];
        const centralChunks = [];
        let offset = 0;
        for (const entry of entries) {
            const nameBytes = textEncoder.encode(entry.name);
            const dataBytes = entry.data;
            const entryCrc32 = crc32(dataBytes);
            const generalPurposeBitFlag = hasNonAsciiCharacters(entry.name) ? utf8FileNameFlag : 0;
            const localHeader = new Uint8Array(30 + nameBytes.length);
            const localView = new DataView(localHeader.buffer);
            localView.setUint32(0, 0x04034b50, true);
            localView.setUint16(4, 20, true);
            localView.setUint16(6, generalPurposeBitFlag, true);
            localView.setUint16(8, 0, true);
            localView.setUint16(10, fixedZipEntryTimestamp.dosTime, true);
            localView.setUint16(12, fixedZipEntryTimestamp.dosDate, true);
            localView.setUint32(14, entryCrc32, true);
            localView.setUint32(18, dataBytes.length, true);
            localView.setUint32(22, dataBytes.length, true);
            localView.setUint16(26, nameBytes.length, true);
            localView.setUint16(28, 0, true);
            localHeader.set(nameBytes, 30);
            localChunks.push(localHeader, dataBytes);
            const centralHeader = new Uint8Array(46 + nameBytes.length);
            const centralView = new DataView(centralHeader.buffer);
            centralView.setUint32(0, 0x02014b50, true);
            centralView.setUint16(4, 20, true);
            centralView.setUint16(6, 20, true);
            centralView.setUint16(8, generalPurposeBitFlag, true);
            centralView.setUint16(10, 0, true);
            centralView.setUint16(12, fixedZipEntryTimestamp.dosTime, true);
            centralView.setUint16(14, fixedZipEntryTimestamp.dosDate, true);
            centralView.setUint32(16, entryCrc32, true);
            centralView.setUint32(20, dataBytes.length, true);
            centralView.setUint32(24, dataBytes.length, true);
            centralView.setUint16(28, nameBytes.length, true);
            centralView.setUint16(30, 0, true);
            centralView.setUint16(32, 0, true);
            centralView.setUint16(34, 0, true);
            centralView.setUint16(36, 0, true);
            centralView.setUint32(38, 0, true);
            centralView.setUint32(42, offset, true);
            centralHeader.set(nameBytes, 46);
            centralChunks.push(centralHeader);
            offset += localHeader.length + dataBytes.length;
        }
        const centralDirectoryStart = offset;
        const centralDirectorySize = centralChunks.reduce((sum, chunk) => sum + chunk.length, 0);
        const eocd = new Uint8Array(22);
        const eocdView = new DataView(eocd.buffer);
        eocdView.setUint32(0, 0x06054b50, true);
        eocdView.setUint16(4, 0, true);
        eocdView.setUint16(6, 0, true);
        eocdView.setUint16(8, entries.length, true);
        eocdView.setUint16(10, entries.length, true);
        eocdView.setUint32(12, centralDirectorySize, true);
        eocdView.setUint32(16, centralDirectoryStart, true);
        eocdView.setUint16(20, 0, true);
        const totalLength = localChunks.reduce((sum, chunk) => sum + chunk.length, 0) + centralDirectorySize + eocd.length;
        const output = new Uint8Array(totalLength);
        let cursor = 0;
        for (const chunk of localChunks) {
            output.set(chunk, cursor);
            cursor += chunk.length;
        }
        for (const chunk of centralChunks) {
            output.set(chunk, cursor);
            cursor += chunk.length;
        }
        output.set(eocd, cursor);
        return output;
    }
    const zipIoApi = {
        unzipEntries,
        createStoredZip,
        fixedZipEntryTimestamp
    };
    moduleRegistry.registerModule("zipIo", zipIoApi);
})();

// ── border-grid ─────────────────────────────────────────────────
/*
 * Copyright 2026 Toshiki Iga
 * SPDX-License-Identifier: Apache-2.0
 */
(() => {
    const moduleRegistry = getXlsx2mdModuleRegistry();
    function getCellAt(cellMap, row, col) {
        return cellMap.get(`${row}:${col}`);
    }
    function hasNormalizedBorderOnSide(cellMap, row, col, side) {
        const cell = getCellAt(cellMap, row, col);
        if (side === "top") {
            const above = getCellAt(cellMap, row - 1, col);
            return !!cell?.borders.top || !!above?.borders.bottom;
        }
        if (side === "bottom") {
            const below = getCellAt(cellMap, row + 1, col);
            return !!cell?.borders.bottom || !!below?.borders.top;
        }
        if (side === "left") {
            const left = getCellAt(cellMap, row, col - 1);
            return !!cell?.borders.left || !!left?.borders.right;
        }
        const right = getCellAt(cellMap, row, col + 1);
        return !!cell?.borders.right || !!right?.borders.left;
    }
    function hasAnyNormalizedBorder(cellMap, row, col) {
        return hasNormalizedBorderOnSide(cellMap, row, col, "top")
            || hasNormalizedBorderOnSide(cellMap, row, col, "bottom")
            || hasNormalizedBorderOnSide(cellMap, row, col, "left")
            || hasNormalizedBorderOnSide(cellMap, row, col, "right");
    }
    function collectTableEdgeStats(cellMap, row, startCol, endCol) {
        let nonEmptyCount = 0;
        let borderCount = 0;
        let rawBorderCount = 0;
        let topCount = 0;
        let bottomCount = 0;
        let maxTextLength = 0;
        for (let col = startCol; col <= endCol; col += 1) {
            const cell = getCellAt(cellMap, row, col);
            const text = String(cell?.outputValue || "").trim();
            if (text) {
                nonEmptyCount += 1;
                maxTextLength = Math.max(maxTextLength, text.length);
            }
            if (hasAnyNormalizedBorder(cellMap, row, col)) {
                borderCount += 1;
            }
            if (cell && (cell.borders.top || cell.borders.bottom || cell.borders.left || cell.borders.right)) {
                rawBorderCount += 1;
            }
            if (hasNormalizedBorderOnSide(cellMap, row, col, "top")) {
                topCount += 1;
            }
            if (hasNormalizedBorderOnSide(cellMap, row, col, "bottom")) {
                bottomCount += 1;
            }
        }
        return { nonEmptyCount, borderCount, rawBorderCount, topCount, bottomCount, maxTextLength };
    }
    function countNormalizedBorderedCells(cellMap, startRow, startCol, endRow, endCol) {
        let count = 0;
        for (let row = startRow; row <= endRow; row += 1) {
            for (let col = startCol; col <= endCol; col += 1) {
                if (hasAnyNormalizedBorder(cellMap, row, col)) {
                    count += 1;
                }
            }
        }
        return count;
    }
    const borderGridApi = {
        getCellAt,
        hasNormalizedBorderOnSide,
        hasAnyNormalizedBorder,
        collectTableEdgeStats,
        countNormalizedBorderedCells
    };
    moduleRegistry.registerModule("borderGrid", borderGridApi);
})();

// ── markdown-normalize ──────────────────────────────────────────
/*
 * Copyright 2026 Toshiki Iga
 * SPDX-License-Identifier: Apache-2.0
 */
(() => {
    const moduleRegistry = getXlsx2mdModuleRegistry();
    const MARKDOWN_UNSAFE_UNICODE_REGEX = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060-\u206F\uFEFF\uFDD0-\uFDEF\uFFFE\uFFFF]/g;
    function normalizeMarkdownText(text) {
        return String(text || "")
            .replace(MARKDOWN_UNSAFE_UNICODE_REGEX, " ")
            .replace(/\r\n?|\n/g, " ")
            .replace(/\t/g, " ");
    }
    function escapeMarkdownPipes(text) {
        return String(text || "").replace(/\|/g, "\\|");
    }
    function normalizeMarkdownTableCell(text) {
        return escapeMarkdownPipes(normalizeMarkdownText(text));
    }
    function normalizeMarkdownHeadingText(text) {
        return normalizeMarkdownText(text).replace(/^#+\s*/, "");
    }
    function normalizeMarkdownListItemText(text) {
        return normalizeMarkdownText(text).replace(/^([-*+]|\d+\.)\s+/, "");
    }
    const markdownNormalizeApi = {
        normalizeMarkdownText,
        escapeMarkdownPipes,
        normalizeMarkdownTableCell,
        normalizeMarkdownHeadingText,
        normalizeMarkdownListItemText
    };
    moduleRegistry.registerModule("markdownNormalize", markdownNormalizeApi);
})();

// ── markdown-escape ─────────────────────────────────────────────
/*
 * Copyright 2026 Toshiki Iga
 * SPDX-License-Identifier: Apache-2.0
 */
(() => {
    const moduleRegistry = getXlsx2mdModuleRegistry();
    function escapeMarkdownLineStart(text) {
        return String(text || "")
            .replace(/^(\s*)([#>])/u, "$1\\$2")
            .replace(/^(\s*)([-+*])(\s+)/u, "$1\\$2$3")
            .replace(/^(\s*)(\d+)\.(\s+)/u, "$1$2\\.$3");
    }
    function escapeMarkdownLiteralParts(text) {
        const source = String(text || "");
        const parts = [];
        let buffer = "";
        function pushTextBuffer() {
            if (!buffer)
                return;
            parts.push({ kind: "text", text: buffer, rawText: buffer });
            buffer = "";
        }
        function pushEscaped(textValue, rawText) {
            pushTextBuffer();
            if (!textValue)
                return;
            parts.push({ kind: "escaped", text: textValue, rawText });
        }
        for (let index = 0; index < source.length; index += 1) {
            const ch = source[index];
            const atLineStart = index === 0;
            const next = source[index + 1] || "";
            if (ch === "\\") {
                pushEscaped("\\\\", ch);
                continue;
            }
            if (ch === "&") {
                pushEscaped("&amp;", ch);
                continue;
            }
            if (ch === "<") {
                pushEscaped("&lt;", ch);
                continue;
            }
            if (ch === ">") {
                if (atLineStart) {
                    pushEscaped("&gt;", ch);
                    continue;
                }
                pushEscaped("&gt;", ch);
                continue;
            }
            if (/[`*_{}\[\]()!|~]/.test(ch)) {
                pushEscaped(`\\${ch}`, ch);
                continue;
            }
            if (atLineStart && /[#]/.test(ch)) {
                pushEscaped(`\\${ch}`, ch);
                continue;
            }
            if (atLineStart && /[-+*]/.test(ch) && /\s/u.test(next)) {
                pushEscaped(`\\${ch}`, ch);
                continue;
            }
            if (atLineStart && /\d/u.test(ch)) {
                let digitRun = ch;
                let cursor = index + 1;
                while (cursor < source.length && /\d/u.test(source[cursor])) {
                    digitRun += source[cursor];
                    cursor += 1;
                }
                if (source[cursor] === "." && /\s/u.test(source[cursor + 1] || "")) {
                    pushTextBuffer();
                    parts.push({ kind: "text", text: digitRun, rawText: digitRun });
                    parts.push({ kind: "escaped", text: "\\.", rawText: "." });
                    index = cursor;
                    continue;
                }
            }
            buffer += ch;
        }
        pushTextBuffer();
        return parts;
    }
    function escapeMarkdownLiteralText(text) {
        return String(text || "")
            .replace(/\r\n?/g, "\n")
            .split("\n")
            .map((line) => escapeMarkdownLiteralParts(line).map((part) => part.text).join(""))
            .join("\n");
    }
    const markdownEscapeApi = {
        escapeMarkdownLineStart,
        escapeMarkdownLiteralParts,
        escapeMarkdownLiteralText
    };
    moduleRegistry.registerModule("markdownEscape", markdownEscapeApi);
})();

// ── markdown-table-escape ───────────────────────────────────────
/*
 * Copyright 2026 Toshiki Iga
 * SPDX-License-Identifier: Apache-2.0
 */
(() => {
    const moduleRegistry = getXlsx2mdModuleRegistry();
    const markdownNormalizeHelper = requireXlsx2mdMarkdownNormalize();
    function escapeMarkdownTableCell(text) {
        return markdownNormalizeHelper.escapeMarkdownPipes(markdownNormalizeHelper.normalizeMarkdownText(text));
    }
    const markdownTableEscapeApi = {
        escapeMarkdownTableCell
    };
    moduleRegistry.registerModule("markdownTableEscape", markdownTableEscapeApi);
})();

// ── rich-text-parser ────────────────────────────────────────────
/*
 * Copyright 2026 Toshiki Iga
 * SPDX-License-Identifier: Apache-2.0
 */
(() => {
    const moduleRegistry = getXlsx2mdModuleRegistry();
    function createRichTextParserApi(deps = {}) {
        const markdownEscapeHelper = requireXlsx2mdMarkdownEscape();
        const normalizeInlineText = deps.normalizeMarkdownText || ((text) => String(text || "").replace(/\r\n?|\n/g, " ").replace(/\t/g, " "));
        function compactText(text) {
            return normalizeInlineText(markdownEscapeHelper.escapeMarkdownLiteralText(text)).replace(/\s+/g, " ").trim();
        }
        function splitRawTextWithLineBreaks(text) {
            const normalized = String(text || "")
                .replace(/\r\n?/g, "\n")
                .replace(/\t/g, " ");
            if (!normalized)
                return [];
            const parts = normalized.split("\n");
            const tokens = [];
            for (let index = 0; index < parts.length; index += 1) {
                if (parts[index]) {
                    tokens.push({
                        kind: "text",
                        rawText: parts[index]
                    });
                }
                if (index < parts.length - 1) {
                    tokens.push({ kind: "lineBreak" });
                }
            }
            return tokens;
        }
        function splitTextWithLineBreaks(text) {
            return splitRawTextWithLineBreaks(text).map((token) => {
                if (token.kind === "lineBreak")
                    return token;
                return {
                    kind: "text",
                    text: markdownEscapeHelper.escapeMarkdownLiteralText(token.rawText)
                };
            });
        }
        function createStyledTextToken(text, style) {
            return {
                kind: "styledText",
                parts: markdownEscapeHelper.escapeMarkdownLiteralParts(text),
                style
            };
        }
        function tokenizePlainCellText(text) {
            const compacted = compactText(text);
            if (!compacted)
                return [];
            return [{ kind: "text", text: compacted }];
        }
        function tokenizeGithubCellText(text, style) {
            const tokens = splitRawTextWithLineBreaks(text);
            if (!tokens.length)
                return [];
            return tokens.map((token) => {
                if (token.kind !== "text")
                    return token;
                return createStyledTextToken(token.rawText, style);
            });
        }
        function tokenizeGithubRichTextRuns(runs) {
            return runs.flatMap((run) => splitRawTextWithLineBreaks(run.text).map((token) => {
                if (token.kind !== "text")
                    return token;
                return createStyledTextToken(token.rawText, {
                    bold: run.bold,
                    italic: run.italic,
                    strike: run.strike,
                    underline: run.underline
                });
            }));
        }
        function tokenizeCellDisplayText(cell, formattingMode = "plain") {
            if (!cell)
                return [];
            if (formattingMode !== "github") {
                return tokenizePlainCellText(String(cell.outputValue || ""));
            }
            const displayValue = compactText(String(cell.outputValue || ""));
            if (cell.richTextRuns && displayValue === compactText(cell.richTextRuns.map((run) => run.text).join(""))) {
                return tokenizeGithubRichTextRuns(cell.richTextRuns);
            }
            return tokenizeGithubCellText(String(cell.outputValue || ""), cell.textStyle);
        }
        return {
            compactText,
            splitRawTextWithLineBreaks,
            splitTextWithLineBreaks,
            createStyledTextToken,
            tokenizePlainCellText,
            tokenizeGithubCellText,
            tokenizeGithubRichTextRuns,
            tokenizeCellDisplayText
        };
    }
    const richTextParserApi = {
        createRichTextParserApi
    };
    moduleRegistry.registerModule("richTextParser", richTextParserApi);
})();

// ── rich-text-plain-formatter ───────────────────────────────────
/*
 * Copyright 2026 Toshiki Iga
 * SPDX-License-Identifier: Apache-2.0
 */
(() => {
    const moduleRegistry = getXlsx2mdModuleRegistry();
    function createRichTextPlainFormatterApi() {
        function renderStyledTextPart(part) {
            if (part.kind === "escaped") {
                return part.text;
            }
            return part.text;
        }
        function renderStyledTextParts(parts) {
            return parts.map((part) => renderStyledTextPart(part)).join("");
        }
        function renderPlainTokens(tokens) {
            if (!tokens.length)
                return "";
            return tokens
                .map((token) => {
                if (token.kind === "lineBreak")
                    return " ";
                if (token.kind === "styledText")
                    return renderStyledTextParts(token.parts);
                return token.text;
            })
                .join("")
                .replace(/ {2,}/g, " ")
                .trim();
        }
        return {
            renderStyledTextPart,
            renderStyledTextParts,
            renderPlainTokens
        };
    }
    const richTextPlainFormatterApi = {
        createRichTextPlainFormatterApi
    };
    moduleRegistry.registerModule("richTextPlainFormatter", richTextPlainFormatterApi);
})();

// ── rich-text-github-formatter ──────────────────────────────────
/*
 * Copyright 2026 Toshiki Iga
 * SPDX-License-Identifier: Apache-2.0
 */
(() => {
    const moduleRegistry = getXlsx2mdModuleRegistry();
    function createRichTextGithubFormatterApi() {
        function applyTextStyle(text, style) {
            if (!text)
                return "";
            let result = text;
            if (style.underline)
                result = `<ins>${result}</ins>`;
            if (style.strike)
                result = `~~${result}~~`;
            if (style.italic)
                result = `*${result}*`;
            if (style.bold)
                result = `**${result}**`;
            return result;
        }
        function renderStyledTextPart(part) {
            if (part.kind === "escaped") {
                return part.text;
            }
            return part.text;
        }
        function renderStyledTextParts(parts) {
            return parts.map((part) => renderStyledTextPart(part)).join("");
        }
        function renderGithubTokens(tokens) {
            if (!tokens.length)
                return "";
            return tokens
                .map((token) => {
                if (token.kind === "lineBreak")
                    return "<br>";
                if (token.kind === "styledText")
                    return applyTextStyle(renderStyledTextParts(token.parts), token.style);
                return token.text;
            })
                .join("")
                .replace(/ {2,}/g, " ")
                .trim();
        }
        return {
            applyTextStyle,
            renderStyledTextPart,
            renderStyledTextParts,
            renderGithubTokens
        };
    }
    const richTextGithubFormatterApi = {
        createRichTextGithubFormatterApi
    };
    moduleRegistry.registerModule("richTextGithubFormatter", richTextGithubFormatterApi);
})();

// ── rich-text-renderer ──────────────────────────────────────────
/*
 * Copyright 2026 Toshiki Iga
 * SPDX-License-Identifier: Apache-2.0
 */
(() => {
    const moduleRegistry = getXlsx2mdModuleRegistry();
    function createRichTextRendererApi(deps = {}) {
        const richTextParser = requireXlsx2mdRichTextParserModule().createRichTextParserApi({
            normalizeMarkdownText: deps.normalizeMarkdownText
        });
        const plainFormatter = requireXlsx2mdRichTextPlainFormatterModule().createRichTextPlainFormatterApi();
        const githubFormatter = requireXlsx2mdRichTextGithubFormatterModule().createRichTextGithubFormatterApi();
        function normalizeGithubSegment(text) {
            return githubFormatter.renderGithubTokens(richTextParser.splitTextWithLineBreaks(text));
        }
        function normalizeGithubCellText(text) {
            return normalizeGithubSegment(text)
                .replace(/ {2,}/g, " ")
                .trim();
        }
        function renderTokens(tokens, formattingMode) {
            if (!tokens.length)
                return "";
            if (formattingMode !== "github") {
                return plainFormatter.renderPlainTokens(tokens);
            }
            return githubFormatter.renderGithubTokens(tokens);
        }
        function tokenizeCellDisplayText(cell, formattingMode = "plain") {
            return richTextParser.tokenizeCellDisplayText(cell, formattingMode);
        }
        function renderCellDisplayText(cell, formattingMode = "plain") {
            return renderTokens(tokenizeCellDisplayText(cell, formattingMode), formattingMode);
        }
        return {
            compactText: richTextParser.compactText,
            normalizeGithubSegment,
            normalizeGithubCellText,
            applyTextStyle: githubFormatter.applyTextStyle,
            renderStyledTextParts: plainFormatter.renderStyledTextParts,
            splitTextWithLineBreaks: richTextParser.splitTextWithLineBreaks,
            tokenizePlainCellText: richTextParser.tokenizePlainCellText,
            tokenizeGithubCellText: richTextParser.tokenizeGithubCellText,
            tokenizeGithubRichTextRuns: richTextParser.tokenizeGithubRichTextRuns,
            tokenizeCellDisplayText,
            renderPlainTokens: plainFormatter.renderPlainTokens,
            renderGithubTokens: githubFormatter.renderGithubTokens,
            renderTokens,
            renderCellDisplayText
        };
    }
    const richTextRendererApi = {
        createRichTextRendererApi
    };
    moduleRegistry.registerModule("richTextRenderer", richTextRendererApi);
})();

// ── narrative-structure ─────────────────────────────────────────
/*
 * Copyright 2026 Toshiki Iga
 * SPDX-License-Identifier: Apache-2.0
 */
(() => {
    const moduleRegistry = getXlsx2mdModuleRegistry();
    const markdownNormalizeHelper = requireXlsx2mdMarkdownNormalize();
    function renderNarrativeBlock(block) {
        if (!block.items || block.items.length === 0) {
            return block.lines.map((line) => markdownNormalizeHelper.normalizeMarkdownText(line)).join("\n");
        }
        const parts = [];
        let index = 0;
        while (index < block.items.length) {
            const current = block.items[index];
            const next = block.items[index + 1];
            if (current && next && next.startCol > current.startCol) {
                let childEnd = index + 1;
                while (childEnd < block.items.length && block.items[childEnd].startCol > current.startCol) {
                    childEnd += 1;
                }
                const childLines = block.items
                    .slice(index + 1, childEnd)
                    .map((item) => `- ${markdownNormalizeHelper.normalizeMarkdownListItemText(item.text)}`);
                parts.push(`### ${markdownNormalizeHelper.normalizeMarkdownHeadingText(current.text)}`);
                if (childLines.length > 0) {
                    parts.push(childLines.join("\n"));
                }
                index = childEnd;
                continue;
            }
            parts.push(markdownNormalizeHelper.normalizeMarkdownText(current.text));
            index += 1;
        }
        return parts.join("\n\n");
    }
    function isSectionHeadingNarrativeBlock(block) {
        if (!block || !block.items || block.items.length < 2) {
            return false;
        }
        return block.items[1].startCol > block.items[0].startCol;
    }
    const narrativeStructureApi = {
        renderNarrativeBlock,
        isSectionHeadingNarrativeBlock
    };
    moduleRegistry.registerModule("narrativeStructure", narrativeStructureApi);
})();

// ── table-detector ──────────────────────────────────────────────
/*
 * Copyright 2026 Toshiki Iga
 * SPDX-License-Identifier: Apache-2.0
 */
(() => {
    const moduleRegistry = getXlsx2mdModuleRegistry();
    const DEFAULT_TABLE_SCORE_WEIGHTS = {
        minGrid: 2,
        borderPresence: 3,
        densityHigh: 2,
        densityVeryHigh: 1,
        headerish: 2,
        mergeHeavyPenalty: -1,
        prosePenalty: -2,
        threshold: 4
    };
    const borderGridHelper = moduleRegistry?.getModule("borderGrid");
    if (!borderGridHelper) {
        throw new Error("xlsx2md border grid module is not loaded");
    }
    function collectTableSeedCells(sheet) {
        return sheet.cells.filter((cell) => {
            const hasValue = !!String(cell.outputValue || "").trim();
            const hasBorder = cell.borders.top || cell.borders.bottom || cell.borders.left || cell.borders.right;
            return hasValue || hasBorder;
        });
    }
    function collectBorderSeedCells(sheet) {
        return sheet.cells.filter((cell) => (cell.borders.top || cell.borders.bottom || cell.borders.left || cell.borders.right));
    }
    function areBorderAdjacent(current, next) {
        if (current.row === next.row && Math.abs(current.col - next.col) === 1) {
            return (current.borders.top && next.borders.top)
                || (current.borders.bottom && next.borders.bottom)
                || (current.col < next.col ? current.borders.right && next.borders.left : current.borders.left && next.borders.right);
        }
        if (current.col === next.col && Math.abs(current.row - next.row) === 1) {
            return (current.borders.left && next.borders.left)
                || (current.borders.right && next.borders.right)
                || (current.row < next.row ? current.borders.bottom && next.borders.top : current.borders.top && next.borders.bottom);
        }
        return false;
    }
    function collectConnectedComponents(seedCells, adjacencyMode = "grid") {
        const positionMap = new Map();
        for (const cell of seedCells) {
            positionMap.set(`${cell.row}:${cell.col}`, cell);
        }
        const visited = new Set();
        const components = [];
        for (const cell of seedCells) {
            const key = `${cell.row}:${cell.col}`;
            if (visited.has(key))
                continue;
            const queue = [cell];
            const component = [];
            visited.add(key);
            while (queue.length > 0) {
                const current = queue.shift();
                component.push(current);
                for (const [rowDelta, colDelta] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                    const nextKey = `${current.row + rowDelta}:${current.col + colDelta}`;
                    const nextCell = positionMap.get(nextKey);
                    if (!nextCell || visited.has(nextKey))
                        continue;
                    if (adjacencyMode === "border" && !areBorderAdjacent(current, nextCell))
                        continue;
                    visited.add(nextKey);
                    queue.push(nextCell);
                }
            }
            components.push(component);
        }
        return components;
    }
    function isWithinBounds(bounds, candidate) {
        return candidate.startRow >= bounds.startRow
            && candidate.startCol >= bounds.startCol
            && candidate.endRow <= bounds.endRow
            && candidate.endCol <= bounds.endCol;
    }
    function getBoundsArea(bounds) {
        return Math.max(1, (bounds.endRow - bounds.startRow + 1) * (bounds.endCol - bounds.startCol + 1));
    }
    function getCombinedCandidateArea(candidates) {
        return candidates.reduce((sum, candidate) => sum + getBoundsArea(candidate), 0);
    }
    function pruneRedundantCandidates(candidates) {
        return candidates.filter((candidate, candidateIndex) => {
            const candidateArea = getBoundsArea(candidate);
            const hasSingleDominatingContainedCandidate = candidates.some((other, otherIndex) => {
                if (candidateIndex === otherIndex)
                    return false;
                if (!isWithinBounds(candidate, other))
                    return false;
                const otherArea = getBoundsArea(other);
                if (otherArea < candidateArea * 0.4)
                    return false;
                return candidateArea > otherArea;
            });
            if (hasSingleDominatingContainedCandidate) {
                return false;
            }
            const containedCandidates = candidates.filter((other, otherIndex) => {
                if (candidateIndex === otherIndex)
                    return false;
                if (!isWithinBounds(candidate, other))
                    return false;
                return getBoundsArea(other) < candidateArea;
            });
            if (containedCandidates.length >= 2 && getCombinedCandidateArea(containedCandidates) >= candidateArea * 0.6) {
                return false;
            }
            return true;
        });
    }
    function detectTableCandidates(sheet, buildCellMap, scoreWeights = DEFAULT_TABLE_SCORE_WEIGHTS, tableDetectionMode = "balanced") {
        const cellMap = buildCellMap(sheet);
        const allSeedCells = collectTableSeedCells(sheet);
        const borderSeedCells = collectBorderSeedCells(sheet);
        const candidates = [];
        const candidateKeys = new Set();
        function maybePushCandidate(component, sourceKind = "border") {
            const rows = component.map((entry) => entry.row);
            const cols = component.map((entry) => entry.col);
            const startRow = Math.min(...rows);
            const endRow = Math.max(...rows);
            const startCol = Math.min(...cols);
            const endCol = Math.max(...cols);
            const area = Math.max(1, (endRow - startRow + 1) * (endCol - startCol + 1));
            const density = component.filter((entry) => entry.outputValue.trim()).length / area;
            const rowCount = endRow - startRow + 1;
            const colCount = endCol - startCol + 1;
            if (rowCount < 2 || colCount < 2) {
                return;
            }
            let score = 0;
            const reasons = [];
            const normalizedBorderedCellCount = borderGridHelper.countNormalizedBorderedCells(cellMap, startRow, startCol, endRow, endCol);
            if (rowCount >= 2 && colCount >= 2) {
                score += scoreWeights.minGrid;
                reasons.push(`At least 2x2 (+${scoreWeights.minGrid})`);
            }
            if (normalizedBorderedCellCount >= Math.max(2, Math.ceil(component.length * 0.3))) {
                score += scoreWeights.borderPresence;
                reasons.push(`Has borders (+${scoreWeights.borderPresence})`);
            }
            if (density >= 0.55) {
                score += scoreWeights.densityHigh;
                reasons.push(`High density (+${scoreWeights.densityHigh})`);
            }
            if (density >= 0.8) {
                score += scoreWeights.densityVeryHigh;
                reasons.push(`Very high density (+${scoreWeights.densityVeryHigh})`);
            }
            const firstRowCells = component.filter((entry) => entry.row === startRow).sort((a, b) => a.col - b.col);
            const headerishCount = firstRowCells.filter((entry) => {
                const value = entry.outputValue.trim();
                return value.length > 0 && value.length <= 24 && !/^\d+(?:\.\d+)?$/.test(value);
            }).length;
            if (headerishCount >= 2) {
                score += scoreWeights.headerish;
                reasons.push(`Header-like first row (+${scoreWeights.headerish})`);
            }
            const mergedArea = sheet.merges.filter((merge) => {
                return !(merge.endRow < startRow || merge.startRow > endRow || merge.endCol < startCol || merge.startCol > endCol);
            }).length;
            if (mergedArea >= Math.max(2, Math.ceil(area * 0.08))) {
                score += scoreWeights.mergeHeavyPenalty;
                reasons.push(`Many merged cells (${scoreWeights.mergeHeavyPenalty})`);
            }
            if (sourceKind === "border") {
                if (mergedArea >= 2 && density < 0.25 && headerishCount < 2) {
                    return;
                }
            }
            else if (mergedArea >= 2 && rowCount <= 6 && colCount >= 10 && density < 0.25) {
                return;
            }
            const nonEmptyCells = component.filter((entry) => entry.outputValue.trim());
            const avgTextLength = nonEmptyCells
                .reduce((sum, entry) => sum + entry.outputValue.trim().length, 0) / Math.max(1, nonEmptyCells.length);
            if (avgTextLength > 36 && density < 0.7) {
                score += scoreWeights.prosePenalty;
                reasons.push(`Mostly long prose (${scoreWeights.prosePenalty})`);
            }
            if (score >= scoreWeights.threshold) {
                const normalizedBounds = trimTableCandidateBounds(cellMap, {
                    startRow,
                    startCol,
                    endRow,
                    endCol
                });
                const key = `${normalizedBounds.startRow}:${normalizedBounds.startCol}:${normalizedBounds.endRow}:${normalizedBounds.endCol}`;
                if (candidateKeys.has(key)) {
                    return;
                }
                candidateKeys.add(key);
                candidates.push({
                    startRow: normalizedBounds.startRow,
                    startCol: normalizedBounds.startCol,
                    endRow: normalizedBounds.endRow,
                    endCol: normalizedBounds.endCol,
                    score,
                    reasonSummary: reasons
                });
            }
        }
        for (const component of collectConnectedComponents(borderSeedCells, tableDetectionMode === "border" ? "border" : "grid")) {
            maybePushCandidate(component, "border");
        }
        if (tableDetectionMode !== "border") {
            for (const component of collectConnectedComponents(allSeedCells)) {
                const rows = component.map((entry) => entry.row);
                const cols = component.map((entry) => entry.col);
                const bounds = {
                    startRow: Math.min(...rows),
                    startCol: Math.min(...cols),
                    endRow: Math.max(...rows),
                    endCol: Math.max(...cols)
                };
                const containingBorderCandidates = candidates.filter((candidate) => isWithinBounds(candidate, bounds));
                const fallbackArea = getBoundsArea(bounds);
                const shadowedByBorderCandidate = containingBorderCandidates.some((candidate) => (getBoundsArea(candidate) >= fallbackArea * 0.4));
                const shadowedByMultipleBorderCandidates = containingBorderCandidates.length >= 2
                    && getCombinedCandidateArea(containingBorderCandidates) >= fallbackArea * 0.6;
                if (shadowedByBorderCandidate || shadowedByMultipleBorderCandidates) {
                    continue;
                }
                maybePushCandidate(component, "fallback");
            }
        }
        return pruneRedundantCandidates(candidates).sort((left, right) => {
            if (left.startRow !== right.startRow)
                return left.startRow - right.startRow;
            return left.startCol - right.startCol;
        });
    }
    function trimTableCandidateBounds(cellMap, bounds) {
        let { startRow, startCol, endRow, endCol } = bounds;
        const minBorderedCells = Math.max(2, Math.ceil((endCol - startCol + 1) * 0.5));
        while (endRow - startRow + 1 >= 2) {
            const topStats = borderGridHelper.collectTableEdgeStats(cellMap, startRow, startCol, endCol);
            const nextStats = borderGridHelper.collectTableEdgeStats(cellMap, startRow + 1, startCol, endCol);
            const shouldTrimTop = (topStats.nonEmptyCount <= 2
                && topStats.rawBorderCount === 0
                && nextStats.borderCount >= minBorderedCells
                && nextStats.nonEmptyCount >= Math.max(2, Math.ceil((endCol - startCol + 1) * 0.5)));
            if (!shouldTrimTop) {
                break;
            }
            startRow += 1;
        }
        for (let row = startRow + 1; row <= endRow; row += 1) {
            const currentStats = borderGridHelper.collectTableEdgeStats(cellMap, row, startCol, endCol);
            const previousStats = borderGridHelper.collectTableEdgeStats(cellMap, row - 1, startCol, endCol);
            const shouldBreakAtCurrentRow = ((previousStats.borderCount >= minBorderedCells
                || previousStats.bottomCount >= minBorderedCells
                || currentStats.topCount >= minBorderedCells)
                && currentStats.rawBorderCount === 0
                && currentStats.nonEmptyCount <= 1);
            if (shouldBreakAtCurrentRow) {
                endRow = row - 1;
                break;
            }
        }
        while (endRow - startRow + 1 >= 2) {
            const bottomStats = borderGridHelper.collectTableEdgeStats(cellMap, endRow, startCol, endCol);
            const previousStats = borderGridHelper.collectTableEdgeStats(cellMap, endRow - 1, startCol, endCol);
            const shouldTrimBottom = ((previousStats.borderCount >= minBorderedCells
                || previousStats.bottomCount >= minBorderedCells
                || bottomStats.topCount >= minBorderedCells)
                && bottomStats.rawBorderCount === 0
                && bottomStats.nonEmptyCount <= 1) || (bottomStats.nonEmptyCount <= 1
                && bottomStats.rawBorderCount === 0
                && bottomStats.maxTextLength >= 12
                && previousStats.nonEmptyCount >= Math.max(2, Math.ceil((endCol - startCol + 1) * 0.5)));
            if (!shouldTrimBottom) {
                break;
            }
            endRow -= 1;
        }
        return { startRow, startCol, endRow, endCol };
    }
    function matrixFromCandidate(sheet, candidate, options, buildCellMap, formatCellForMarkdown) {
        const cellMap = buildCellMap(sheet);
        const rows = [];
        for (let row = candidate.startRow; row <= candidate.endRow; row += 1) {
            const currentRow = [];
            for (let col = candidate.startCol; col <= candidate.endCol; col += 1) {
                const cell = cellMap.get(`${row}:${col}`);
                let value = formatCellForMarkdown(cell, options);
                if (options.trimText !== false) {
                    value = value.trim();
                }
                currentRow.push(value);
            }
            rows.push(currentRow);
        }
        applyMergeTokens(rows, sheet.merges, candidate.startRow, candidate.startCol, candidate.endRow, candidate.endCol);
        let normalizedRows = rows;
        if (options.removeEmptyRows !== false) {
            normalizedRows = normalizedRows.filter((row) => row.some((cell) => isMeaningfulMarkdownCell(cell)));
        }
        if (options.removeEmptyColumns !== false && normalizedRows.length > 0) {
            const keepColumnFlags = normalizedRows[0].map((_, colIndex) => normalizedRows.some((row) => isMeaningfulMarkdownCell(row[colIndex])));
            normalizedRows = normalizedRows.map((row) => row.filter((_cell, colIndex) => keepColumnFlags[colIndex]));
        }
        return normalizedRows;
    }
    function isMeaningfulMarkdownCell(value) {
        const text = String(value || "").trim();
        if (!text)
            return false;
        return text !== "[MERGED←]" && text !== "[MERGED↑]";
    }
    function applyMergeTokens(matrix, merges, startRow, startCol, endRow, endCol) {
        for (const merge of merges) {
            if (merge.endRow < startRow || merge.startRow > endRow || merge.endCol < startCol || merge.startCol > endCol) {
                continue;
            }
            for (let row = merge.startRow; row <= merge.endRow; row += 1) {
                for (let col = merge.startCol; col <= merge.endCol; col += 1) {
                    if (row === merge.startRow && col === merge.startCol)
                        continue;
                    const matrixRow = row - startRow;
                    const matrixCol = col - startCol;
                    if (!matrix[matrixRow] || typeof matrix[matrixRow][matrixCol] === "undefined") {
                        continue;
                    }
                    matrix[matrixRow][matrixCol] = row === merge.startRow ? "[MERGED←]" : "[MERGED↑]";
                }
            }
        }
    }
    const tableDetectorApi = {
        collectTableSeedCells,
        collectBorderSeedCells,
        pruneRedundantCandidates,
        detectTableCandidates,
        trimTableCandidateBounds,
        matrixFromCandidate,
        isMeaningfulMarkdownCell,
        applyMergeTokens,
        defaultTableScoreWeights: DEFAULT_TABLE_SCORE_WEIGHTS
    };
    moduleRegistry.registerModule("tableDetector", tableDetectorApi);
})();

// ── markdown-export ─────────────────────────────────────────────
/*
 * Copyright 2026 Toshiki Iga
 * SPDX-License-Identifier: Apache-2.0
 */
(() => {
    const moduleRegistry = getXlsx2mdModuleRegistry();
    const textEncoder = new TextEncoder();
    const zipIoHelper = requireXlsx2mdZipIo();
    const markdownNormalizeHelper = requireXlsx2mdMarkdownNormalize();
    const markdownTableEscapeHelper = requireXlsx2mdMarkdownTableEscape();
    function normalizeMarkdownLineBreaks(text) {
        return markdownNormalizeHelper.normalizeMarkdownText(text);
    }
    function escapeMarkdownCell(text) {
        return markdownTableEscapeHelper.escapeMarkdownTableCell(text);
    }
    function renderMarkdownTable(rows, treatFirstRowAsHeader) {
        if (rows.length === 0) {
            return "";
        }
        const workingRows = rows.map((row) => row.map((cell) => escapeMarkdownCell(cell)));
        if (workingRows.length === 1 && treatFirstRowAsHeader) {
            workingRows.push(new Array(workingRows[0].length).fill(""));
        }
        const header = treatFirstRowAsHeader ? workingRows[0] : new Array(workingRows[0].length).fill("");
        const body = treatFirstRowAsHeader ? workingRows.slice(1) : workingRows;
        const lines = [
            `| ${header.join(" | ")} |`,
            `| ${header.map(() => "---").join(" | ")} |`
        ];
        for (const row of body) {
            lines.push(`| ${row.join(" | ")} |`);
        }
        return lines.join("\n");
    }
    function sanitizeFileNameSegment(value, fallback) {
        const normalized = String(value || "").normalize("NFKC");
        const sanitized = normalized
            .replace(/[\\/:*?"<>|]/g, "_")
            .replace(/\s+/g, "_")
            .replace(/[^\p{L}\p{N}._-]+/gu, "_")
            .replace(/_+/g, "_")
            .replace(/^[_ .-]+|[_ .-]+$/g, "");
        return sanitized || fallback;
    }
    function createOutputFileName(workbookName, sheetIndex, sheetName, outputMode = "display", formattingMode = "plain") {
        const bookBase = sanitizeFileNameSegment(workbookName.replace(/\.xlsx$/i, ""), "workbook");
        const safeSheetName = sanitizeFileNameSegment(sheetName, `Sheet${sheetIndex}`);
        const suffix = `${outputMode === "display" ? "" : `_${outputMode}`}${formattingMode === "plain" ? "" : `_${formattingMode}`}`;
        return `${bookBase}_${String(sheetIndex).padStart(3, "0")}_${safeSheetName}${suffix}.md`;
    }
    function createSummaryText(markdownFile) {
        const resolvedCount = markdownFile.summary.formulaDiagnostics.filter((item) => item.status === "resolved").length;
        const fallbackCount = markdownFile.summary.formulaDiagnostics.filter((item) => item.status === "fallback_formula").length;
        const unsupportedCount = markdownFile.summary.formulaDiagnostics.filter((item) => item.status === "unsupported_external").length;
        return [
            `Output file: ${markdownFile.fileName}`,
            `Output mode: ${markdownFile.summary.outputMode}`,
            `Formatting mode: ${markdownFile.summary.formattingMode}`,
            `Table detection mode: ${markdownFile.summary.tableDetectionMode}`,
            `Sections: ${markdownFile.summary.sections}`,
            `Tables: ${markdownFile.summary.tables}`,
            `Narrative blocks: ${markdownFile.summary.narrativeBlocks}`,
            `Merged ranges: ${markdownFile.summary.merges}`,
            `Images: ${markdownFile.summary.images}`,
            `Charts: ${markdownFile.summary.charts}`,
            `Analyzed cells: ${markdownFile.summary.cells}`,
            `Formula resolved: ${resolvedCount}`,
            `Formula fallback_formula: ${fallbackCount}`,
            `Formula unsupported_external: ${unsupportedCount}`,
            ...markdownFile.summary.tableScores.map((detail) => `Table candidate ${detail.range}: score ${detail.score} / ${detail.reasons.join(", ")}`)
        ].join("\n");
    }
    function createCombinedMarkdownExportFile(workbook, markdownFiles) {
        const outputMode = markdownFiles[0]?.summary.outputMode || "display";
        const formattingMode = markdownFiles[0]?.summary.formattingMode || "plain";
        const suffix = `${outputMode === "display" ? "" : `_${outputMode}`}${formattingMode === "plain" ? "" : `_${formattingMode}`}`;
        const fileName = `${String(workbook.name || "workbook").replace(/\.xlsx$/i, "")}${suffix}.md`;
        const content = markdownFiles
            .map((markdownFile) => `<!-- ${markdownFile.fileName.replace(/\.md$/i, "")} -->\n${markdownFile.markdown}`)
            .join("\n\n");
        return { fileName, content };
    }
    function createExportEntries(workbook, markdownFiles) {
        const entries = [];
        if (markdownFiles.length > 0) {
            const combined = createCombinedMarkdownExportFile(workbook, markdownFiles);
            entries.push({
                name: `output/${combined.fileName}`,
                data: textEncoder.encode(`${combined.content}\n`)
            });
        }
        for (const sheet of workbook.sheets) {
            for (const image of sheet.images) {
                entries.push({
                    name: `output/${image.path}`,
                    data: image.data
                });
            }
            for (const shape of sheet.shapes || []) {
                if (!shape.svgPath || !shape.svgData)
                    continue;
                entries.push({
                    name: `output/${shape.svgPath}`,
                    data: shape.svgData
                });
            }
        }
        return entries;
    }
    function createWorkbookExportArchive(workbook, markdownFiles) {
        return zipIoHelper.createStoredZip(createExportEntries(workbook, markdownFiles));
    }
    const markdownExportApi = {
        escapeMarkdownCell,
        renderMarkdownTable,
        sanitizeFileNameSegment,
        createOutputFileName,
        createSummaryText,
        createCombinedMarkdownExportFile,
        createExportEntries,
        createWorkbookExportArchive,
        normalizeMarkdownLineBreaks,
        textEncoder
    };
    moduleRegistry.registerModule("markdownExport", markdownExportApi);
})();

// ── sheet-markdown ──────────────────────────────────────────────
/*
 * Copyright 2026 Toshiki Iga
 * SPDX-License-Identifier: Apache-2.0
 */
(() => {
    const moduleRegistry = getXlsx2mdModuleRegistry();
    function createSheetMarkdownApi(deps) {
        const richTextRenderer = requireXlsx2mdRichTextRendererModule().createRichTextRendererApi({
            normalizeMarkdownText: deps.normalizeMarkdownText
        });
        function buildCellMap(sheet) {
            const map = new Map();
            for (const cell of sheet.cells) {
                map.set(`${cell.row}:${cell.col}`, cell);
            }
            return map;
        }
        function createSheetAnchorId(workbookName, sheetIndex, sheetName, options = {}) {
            return deps.createOutputFileName(workbookName, sheetIndex, sheetName, options.outputMode || "display", options.formattingMode || "plain").replace(/\.md$/i, "");
        }
        function parseInternalHyperlinkLocation(location, currentSheetName) {
            const normalized = String(location || "").trim().replace(/^#/, "");
            if (!normalized) {
                return { sheetName: currentSheetName, refText: "" };
            }
            const match = normalized.match(/^(?:'((?:[^']|'')+)'|([^!]+))!(.+)$/);
            if (match) {
                return {
                    sheetName: (match[1] || match[2] || currentSheetName).replace(/''/g, "'"),
                    refText: (match[3] || "").trim()
                };
            }
            return {
                sheetName: currentSheetName,
                refText: normalized
            };
        }
        function renderHyperlinkMarkdown(cell, text, workbook, sheet, options) {
            const hyperlink = cell.hyperlink;
            const label = String(text || "").trim();
            if (!hyperlink || !label)
                return text;
            if (hyperlink.kind === "external") {
                const href = String(hyperlink.target || "").trim();
                return href ? `[${label}](${href})` : label;
            }
            const currentSheetName = sheet?.name || "";
            const { sheetName, refText } = parseInternalHyperlinkLocation(hyperlink.location || hyperlink.target, currentSheetName);
            const traceText = [sheetName, refText].filter(Boolean).join("!");
            const targetSheet = workbook?.sheets.find((entry) => entry.name === sheetName) || null;
            if (!targetSheet || !workbook) {
                return traceText ? `${label} (${traceText})` : label;
            }
            const href = `#${createSheetAnchorId(workbook.name, targetSheet.index, targetSheet.name, options)}`;
            return traceText && traceText !== targetSheet.name
                ? `[${label}](${href}) (${traceText})`
                : `[${label}](${href})`;
        }
        function formatCellForMarkdown(cell, options, workbook = null, sheet = null) {
            if (!cell)
                return "";
            const mode = options.outputMode || "display";
            const formattingMode = options.formattingMode || "plain";
            const displayCell = formattingMode === "github" && cell.hyperlink
                ? {
                    ...cell,
                    textStyle: {
                        ...cell.textStyle,
                        underline: false
                    },
                    richTextRuns: cell.richTextRuns?.map((run) => ({
                        ...run,
                        underline: false
                    })) || null
                }
                : cell;
            const displayValue = richTextRenderer.compactText(String(cell.outputValue || ""));
            const rawValue = richTextRenderer.compactText(String(cell.rawValue || ""));
            const displayMarkdown = richTextRenderer.renderCellDisplayText(displayCell, formattingMode);
            if (mode === "raw") {
                return renderHyperlinkMarkdown(cell, rawValue || displayValue, workbook, sheet, options);
            }
            if (mode === "both") {
                if (rawValue && rawValue !== displayValue) {
                    if (displayMarkdown) {
                        return `${renderHyperlinkMarkdown(cell, displayMarkdown, workbook, sheet, options)} [raw=${rawValue}]`;
                    }
                    return `[raw=${rawValue}]`;
                }
                return renderHyperlinkMarkdown(cell, displayMarkdown || rawValue, workbook, sheet, options);
            }
            return renderHyperlinkMarkdown(cell, displayMarkdown, workbook, sheet, options);
        }
        function isCellInAnyTable(row, col, tables) {
            return tables.some((table) => row >= table.startRow && row <= table.endRow && col >= table.startCol && col <= table.endCol);
        }
        function splitNarrativeRowSegments(cells, options, workbook = null, sheet = null) {
            const segments = [];
            let current = null;
            for (const cell of cells) {
                const value = formatCellForMarkdown(cell, options, workbook, sheet).trim();
                if (!value)
                    continue;
                if (!current || cell.col - current.lastCol > 4) {
                    current = {
                        startCol: cell.col,
                        values: [value],
                        lastCol: cell.col
                    };
                    segments.push(current);
                }
                else {
                    current.values.push(value);
                    current.lastCol = cell.col;
                }
            }
            return segments.map((segment) => ({
                startCol: segment.startCol,
                values: segment.values
            }));
        }
        function extractNarrativeBlocks(workbook, sheet, tables, options = {}) {
            const rowMap = new Map();
            for (const cell of sheet.cells) {
                if (!cell.outputValue)
                    continue;
                if (isCellInAnyTable(cell.row, cell.col, tables))
                    continue;
                const entries = rowMap.get(cell.row) || [];
                entries.push(cell);
                rowMap.set(cell.row, entries);
            }
            const rowNumbers = Array.from(rowMap.keys()).sort((a, b) => a - b);
            const blocks = [];
            let current = null;
            let previousRow = -100;
            for (const rowNumber of rowNumbers) {
                const cells = (rowMap.get(rowNumber) || []).slice().sort((a, b) => a.col - b.col);
                const rowSegments = splitNarrativeRowSegments(cells, options, workbook, sheet);
                for (const segment of rowSegments) {
                    const rowText = segment.values.join(" ").trim();
                    if (!rowText)
                        continue;
                    const startCol = segment.startCol;
                    if (!current || rowNumber - previousRow > 1 || Math.abs(startCol - current.startCol) > 3) {
                        current = {
                            startRow: rowNumber,
                            startCol,
                            endRow: rowNumber,
                            lines: [rowText],
                            items: [{
                                    row: rowNumber,
                                    startCol,
                                    text: rowText,
                                    cellValues: segment.values
                                }]
                        };
                        blocks.push(current);
                    }
                    else {
                        current.lines.push(rowText);
                        current.endRow = rowNumber;
                        current.items.push({
                            row: rowNumber,
                            startCol,
                            text: rowText,
                            cellValues: segment.values
                        });
                    }
                    previousRow = rowNumber;
                }
            }
            return blocks;
        }
        function extractSectionBlocks(sheet, tables, narrativeBlocks) {
            const charts = sheet.charts || [];
            const anchors = [];
            for (const block of narrativeBlocks) {
                anchors.push({
                    startRow: block.startRow,
                    startCol: block.startCol,
                    endRow: block.endRow,
                    endCol: Math.max(block.startCol, ...block.items.map((item) => item.startCol))
                });
            }
            for (const table of tables) {
                anchors.push({
                    startRow: table.startRow,
                    startCol: table.startCol,
                    endRow: table.endRow,
                    endCol: table.endCol
                });
            }
            for (const image of sheet.images) {
                const anchor = deps.parseCellAddress(image.anchor);
                if (anchor.row > 0 && anchor.col > 0) {
                    anchors.push({ startRow: anchor.row, startCol: anchor.col, endRow: anchor.row, endCol: anchor.col });
                }
            }
            for (const chart of charts) {
                const anchor = deps.parseCellAddress(chart.anchor);
                if (anchor.row > 0 && anchor.col > 0) {
                    anchors.push({ startRow: anchor.row, startCol: anchor.col, endRow: anchor.row, endCol: anchor.col });
                }
            }
            if (anchors.length === 0) {
                return [];
            }
            anchors.sort((left, right) => {
                if (left.startRow !== right.startRow)
                    return left.startRow - right.startRow;
                return left.startCol - right.startCol;
            });
            const sections = [];
            let current = null;
            let previousEndRow = -100;
            const verticalGapThreshold = 4;
            for (const anchor of anchors) {
                const gap = anchor.startRow - previousEndRow;
                if (!current || gap > verticalGapThreshold) {
                    current = {
                        startRow: anchor.startRow,
                        startCol: anchor.startCol,
                        endRow: anchor.endRow,
                        endCol: anchor.endCol
                    };
                    sections.push(current);
                }
                else {
                    current.startRow = Math.min(current.startRow, anchor.startRow);
                    current.startCol = Math.min(current.startCol, anchor.startCol);
                    current.endRow = Math.max(current.endRow, anchor.endRow);
                    current.endCol = Math.max(current.endCol, anchor.endCol);
                }
                previousEndRow = Math.max(previousEndRow, anchor.endRow);
            }
            return sections;
        }
        function convertSheetToMarkdown(workbook, sheet, options = {}) {
            const charts = sheet.charts || [];
            const shapes = sheet.shapes || [];
            const shapeBlocks = deps.extractShapeBlocks(shapes, {
                defaultCellWidthEmu: deps.defaultCellWidthEmu,
                defaultCellHeightEmu: deps.defaultCellHeightEmu,
                shapeBlockGapXEmu: deps.shapeBlockGapXEmu,
                shapeBlockGapYEmu: deps.shapeBlockGapYEmu
            });
            const treatFirstRowAsHeader = options.treatFirstRowAsHeader !== false;
            const tableDetectionMode = options.tableDetectionMode || "balanced";
            const tables = deps.detectTableCandidates(sheet, buildCellMap, tableDetectionMode);
            const narrativeBlocks = extractNarrativeBlocks(workbook, sheet, tables, options);
            const sectionBlocks = extractSectionBlocks(sheet, tables, narrativeBlocks);
            const formulaDiagnostics = sheet.cells
                .filter((cell) => !!cell.formulaText && cell.resolutionStatus !== null)
                .map((cell) => ({
                address: cell.address,
                formulaText: cell.formulaText,
                status: cell.resolutionStatus,
                source: cell.resolutionSource,
                outputValue: cell.outputValue
            }));
            const sections = [];
            for (const block of narrativeBlocks) {
                sections.push({
                    sortRow: block.startRow,
                    sortCol: block.startCol,
                    markdown: `${deps.renderNarrativeBlock(block)}\n`,
                    kind: "narrative",
                    narrativeBlock: block
                });
            }
            const fileName = deps.createOutputFileName(workbook.name, sheet.index, sheet.name, options.outputMode || "display", options.formattingMode || "plain");
            const sheetAnchorId = createSheetAnchorId(workbook.name, sheet.index, sheet.name, options);
            let tableCounter = 1;
            for (const table of tables) {
                const rows = deps.matrixFromCandidate(sheet, table, options, buildCellMap, (cell, tableOptions) => formatCellForMarkdown(cell, tableOptions, workbook, sheet));
                if (rows.length === 0 || rows[0]?.length === 0)
                    continue;
                const tableMarkdown = deps.renderMarkdownTable(rows, treatFirstRowAsHeader);
                sections.push({
                    sortRow: table.startRow,
                    sortCol: table.startCol,
                    markdown: `### Table ${String(tableCounter).padStart(3, "0")} (${deps.formatRange(table.startRow, table.startCol, table.endRow, table.endCol)})\n\n${tableMarkdown}\n`,
                    kind: "table"
                });
                tableCounter += 1;
            }
            sections.sort((left, right) => {
                if (left.sortRow !== right.sortRow)
                    return left.sortRow - right.sortRow;
                return left.sortCol - right.sortCol;
            });
            const groupedSections = (sectionBlocks.length > 0 ? sectionBlocks : [{
                    startRow: -1,
                    startCol: -1,
                    endRow: Number.MAX_SAFE_INTEGER,
                    endCol: Number.MAX_SAFE_INTEGER
                }]).map((block) => ({
                block,
                entries: sections.filter((section) => section.sortRow >= block.startRow
                    && section.sortRow <= block.endRow
                    && section.sortCol >= block.startCol
                    && section.sortCol <= block.endCol)
            })).filter((group) => group.entries.length > 0);
            const body = groupedSections
                .map((group) => group.entries.map((section) => section.markdown.trimEnd()).join("\n\n").trim())
                .filter(Boolean)
                .join("\n\n---\n\n")
                .trim();
            const imageSection = sheet.images.length > 0
                ? [
                    "",
                    "## Images",
                    "",
                    ...sheet.images.map((image, index) => [
                        `### Image ${String(index + 1).padStart(3, "0")} (${image.anchor})`,
                        `- File: ${image.path}`,
                        "",
                        `![${image.filename}](${image.path})`
                    ].join("\n"))
                ].join("\n")
                : "";
            const chartSection = charts.length > 0
                ? [
                    "",
                    "## Charts",
                    "",
                    ...charts.map((chart, index) => {
                        const lines = [
                            `### Chart ${String(index + 1).padStart(3, "0")} (${chart.anchor})`,
                            `- Title: ${chart.title || "(none)"}`,
                            `- Type: ${chart.chartType}`
                        ];
                        if (chart.series.length > 0) {
                            lines.push("- Series:");
                            for (const series of chart.series) {
                                lines.push(`  - ${series.name}`);
                                if (series.axis === "secondary")
                                    lines.push("    - Axis: secondary");
                                if (series.categoriesRef)
                                    lines.push(`    - categories: ${series.categoriesRef}`);
                                if (series.valuesRef)
                                    lines.push(`    - values: ${series.valuesRef}`);
                            }
                        }
                        return lines.join("\n");
                    })
                ].join("\n")
                : "";
            const includeShapeDetails = options.includeShapeDetails !== false;
            const shapeSection = includeShapeDetails && shapes.length > 0
                ? [
                    "",
                    "## Shape Blocks",
                    "",
                    ...shapeBlocks.map((block, blockIndex) => [
                        `### Shape Block ${String(blockIndex + 1).padStart(3, "0")} (${deps.formatRange(block.startRow, block.startCol, block.endRow, block.endCol)})`,
                        `- Shapes: ${block.shapeIndexes.map((shapeIndex) => `Shape ${String(shapeIndex + 1).padStart(3, "0")}`).join(", ")}`,
                        `- anchorRange: ${deps.colToLetters(block.startCol)}${block.startRow}-${deps.colToLetters(block.endCol)}${block.endRow}`
                    ].join("\n")),
                    "",
                    "## Shapes",
                    "",
                    ...shapes.map((shape, index) => {
                        const lines = [
                            `### Shape ${String(index + 1).padStart(3, "0")} (${shape.anchor})`,
                            ...deps.renderHierarchicalRawEntries(shape.rawEntries)
                        ];
                        if (shape.svgPath) {
                            lines.push(`- SVG: ${shape.svgPath}`);
                            lines.push("");
                            lines.push(`![${shape.svgFilename || `shape_${String(index + 1).padStart(3, "0")}.svg`}](${shape.svgPath})`);
                        }
                        return lines.join("\n");
                    })
                ].join("\n")
                : "";
            const markdown = [
                `<a id="${sheetAnchorId}"></a>`,
                "",
                `# ${sheet.name}`,
                "",
                "## Source Information",
                `- Workbook: ${workbook.name}`,
                `- Sheet: ${sheet.name}`,
                "",
                "## Body",
                "",
                body || "_No extractable body content was found._",
                chartSection,
                shapeSection,
                imageSection
            ].join("\n");
            return {
                fileName,
                sheetName: sheet.name,
                markdown,
                summary: {
                    outputMode: options.outputMode || "display",
                    formattingMode: options.formattingMode || "plain",
                    tableDetectionMode,
                    sections: sectionBlocks.length,
                    tables: tables.length,
                    narrativeBlocks: narrativeBlocks.length,
                    merges: sheet.merges.length,
                    images: sheet.images.length,
                    charts: charts.length,
                    cells: sheet.cells.length,
                    tableScores: tables.map((table) => ({
                        range: deps.formatRange(table.startRow, table.startCol, table.endRow, table.endCol),
                        score: table.score,
                        reasons: [...table.reasonSummary]
                    })),
                    formulaDiagnostics
                }
            };
        }
        function convertWorkbookToMarkdownFiles(workbook, options = {}) {
            return workbook.sheets.map((sheet) => convertSheetToMarkdown(workbook, sheet, options));
        }
        return {
            buildCellMap,
            formatCellForMarkdown,
            isCellInAnyTable,
            splitNarrativeRowSegments,
            extractNarrativeBlocks,
            extractSectionBlocks,
            convertSheetToMarkdown,
            convertWorkbookToMarkdownFiles
        };
    }
    const sheetMarkdownApi = {
        createSheetMarkdownApi
    };
    moduleRegistry.registerModule("sheetMarkdown", sheetMarkdownApi);
})();

// ── styles-parser ───────────────────────────────────────────────
/*
 * Copyright 2026 Toshiki Iga
 * SPDX-License-Identifier: Apache-2.0
 */
(() => {
    const moduleRegistry = getXlsx2mdModuleRegistry();
    const EMPTY_BORDERS = {
        top: false,
        bottom: false,
        left: false,
        right: false
    };
    const EMPTY_TEXT_STYLE = {
        bold: false,
        italic: false,
        strike: false,
        underline: false
    };
    const runtimeEnv = requireXlsx2mdRuntimeEnv();
    const textDecoder = new TextDecoder("utf-8");
    const BUILTIN_FORMAT_CODES = {
        0: "General",
        1: "0",
        2: "0.00",
        3: "#,##0",
        4: "#,##0.00",
        9: "0%",
        10: "0.00%",
        11: "0.00E+00",
        12: "# ?/?",
        13: "# ??/??",
        14: "yyyy/m/d",
        15: "d-mmm-yy",
        16: "d-mmm",
        17: "mmm-yy",
        18: "h:mm AM/PM",
        19: "h:mm:ss AM/PM",
        20: "h:mm",
        21: "h:mm:ss",
        22: "m/d/yy h:mm",
        45: "mm:ss",
        46: "[h]:mm:ss",
        47: "mmss.0",
        49: "@",
        56: "m月d日"
    };
    function decodeXmlText(bytes) {
        return textDecoder.decode(bytes);
    }
    function xmlToDocument(xmlText) {
        return runtimeEnv.xmlToDocument(xmlText);
    }
    function hasBorderSide(side) {
        if (!side)
            return false;
        return side.hasAttribute("style") || side.children.length > 0;
    }
    function hasEnabledBooleanValue(node) {
        if (!node)
            return false;
        const value = (node.getAttribute("val") || "").trim().toLowerCase();
        return value !== "false" && value !== "0" && value !== "none";
    }
    function parseFontStyle(fontElement) {
        return {
            bold: hasEnabledBooleanValue(fontElement?.getElementsByTagName("b")[0]),
            italic: hasEnabledBooleanValue(fontElement?.getElementsByTagName("i")[0]),
            strike: hasEnabledBooleanValue(fontElement?.getElementsByTagName("strike")[0]),
            underline: hasEnabledBooleanValue(fontElement?.getElementsByTagName("u")[0])
        };
    }
    function parseCellStyles(files) {
        const stylesBytes = files.get("xl/styles.xml");
        if (!stylesBytes) {
            return [{
                    borders: EMPTY_BORDERS,
                    numFmtId: 0,
                    formatCode: "General",
                    textStyle: EMPTY_TEXT_STYLE
                }];
        }
        const doc = xmlToDocument(decodeXmlText(stylesBytes));
        const borderElements = Array.from(doc.getElementsByTagName("border"));
        const borders = borderElements.map((borderElement) => {
            const top = borderElement.getElementsByTagName("top")[0] || null;
            const bottom = borderElement.getElementsByTagName("bottom")[0] || null;
            const left = borderElement.getElementsByTagName("left")[0] || null;
            const right = borderElement.getElementsByTagName("right")[0] || null;
            return {
                top: hasBorderSide(top),
                bottom: hasBorderSide(bottom),
                left: hasBorderSide(left),
                right: hasBorderSide(right)
            };
        });
        const fontElements = Array.from(doc.getElementsByTagName("font"));
        const fontStyles = fontElements.map((fontElement) => parseFontStyle(fontElement));
        const numFmtMap = new Map();
        const numFmtParent = doc.getElementsByTagName("numFmts")[0];
        if (numFmtParent) {
            for (const numFmtElement of Array.from(numFmtParent.getElementsByTagName("numFmt"))) {
                const numFmtId = Number(numFmtElement.getAttribute("numFmtId") || 0);
                const formatCode = numFmtElement.getAttribute("formatCode") || "";
                if (!Number.isNaN(numFmtId) && formatCode) {
                    numFmtMap.set(numFmtId, formatCode);
                }
            }
        }
        const xfsParent = doc.getElementsByTagName("cellXfs")[0];
        if (!xfsParent) {
            return [{
                    borders: borders[0] || EMPTY_BORDERS,
                    numFmtId: 0,
                    formatCode: "General",
                    textStyle: fontStyles[0] || EMPTY_TEXT_STYLE
                }];
        }
        const xfElements = Array.from(xfsParent.getElementsByTagName("xf"));
        const styles = xfElements.map((xfElement) => {
            const borderId = Number(xfElement.getAttribute("borderId") || 0);
            const numFmtId = Number(xfElement.getAttribute("numFmtId") || 0);
            const fontId = Number(xfElement.getAttribute("fontId") || 0);
            return {
                borders: borders[borderId] || EMPTY_BORDERS,
                numFmtId,
                formatCode: numFmtMap.get(numFmtId) || BUILTIN_FORMAT_CODES[numFmtId] || "General",
                textStyle: fontStyles[fontId] || EMPTY_TEXT_STYLE
            };
        });
        return styles.length > 0 ? styles : [{
                borders: EMPTY_BORDERS,
                numFmtId: 0,
                formatCode: "General",
                textStyle: EMPTY_TEXT_STYLE
            }];
    }
    const stylesParserApi = {
        EMPTY_BORDERS,
        EMPTY_TEXT_STYLE,
        BUILTIN_FORMAT_CODES,
        hasBorderSide,
        parseFontStyle,
        parseCellStyles
    };
    moduleRegistry.registerModule("stylesParser", stylesParserApi);
})();

// ── shared-strings ──────────────────────────────────────────────
/*
 * Copyright 2026 Toshiki Iga
 * SPDX-License-Identifier: Apache-2.0
 */
(() => {
    const moduleRegistry = getXlsx2mdModuleRegistry();
    const textDecoder = new TextDecoder("utf-8");
    const runtimeEnv = requireXlsx2mdRuntimeEnv();
    function decodeXmlText(bytes) {
        return textDecoder.decode(bytes);
    }
    function xmlToDocument(xmlText) {
        return runtimeEnv.xmlToDocument(xmlText);
    }
    function getTextContent(node) {
        return (node?.textContent || "").replace(/\r\n/g, "\n");
    }
    function hasEnabledBooleanValue(node) {
        if (!node)
            return false;
        const value = (node.getAttribute("val") || "").trim().toLowerCase();
        return value !== "false" && value !== "0" && value !== "none";
    }
    function parseRichTextRuns(item) {
        const runElements = Array.from(item.childNodes).filter((node) => (node.nodeType === runtimeEnv.ELEMENT_NODE && node.localName === "r"));
        if (runElements.length === 0) {
            return null;
        }
        const runs = [];
        for (const runElement of runElements) {
            const text = Array.from(runElement.getElementsByTagName("t")).map((node) => getTextContent(node)).join("");
            if (!text)
                continue;
            const properties = runElement.getElementsByTagName("rPr")[0] || null;
            const run = {
                text,
                bold: hasEnabledBooleanValue(properties?.getElementsByTagName("b")[0]),
                italic: hasEnabledBooleanValue(properties?.getElementsByTagName("i")[0]),
                strike: hasEnabledBooleanValue(properties?.getElementsByTagName("strike")[0]),
                underline: hasEnabledBooleanValue(properties?.getElementsByTagName("u")[0])
            };
            const previous = runs[runs.length - 1];
            if (previous
                && previous.bold === run.bold
                && previous.italic === run.italic
                && previous.strike === run.strike
                && previous.underline === run.underline) {
                previous.text += run.text;
            }
            else {
                runs.push(run);
            }
        }
        return runs.length > 0 && runs.some((run) => run.bold || run.italic || run.strike || run.underline) ? runs : null;
    }
    function parseSharedStringEntry(item) {
        const runs = parseRichTextRuns(item);
        if (runs) {
            return {
                text: runs.map((run) => run.text).join(""),
                runs
            };
        }
        const parts = [];
        const walk = (node) => {
            if (node.nodeType === runtimeEnv.ELEMENT_NODE) {
                const element = node;
                if (element.localName === "rPh" || element.localName === "phoneticPr") {
                    return;
                }
                if (element.localName === "t") {
                    parts.push(getTextContent(element));
                    return;
                }
            }
            for (const child of Array.from(node.childNodes)) {
                walk(child);
            }
        };
        walk(item);
        return {
            text: parts.join(""),
            runs: null
        };
    }
    function parseSharedStrings(files) {
        const sharedStringsBytes = files.get("xl/sharedStrings.xml");
        if (!sharedStringsBytes) {
            return [];
        }
        const doc = xmlToDocument(decodeXmlText(sharedStringsBytes));
        const items = Array.from(doc.getElementsByTagName("si"));
        return items.map((item) => parseSharedStringEntry(item));
    }
    const sharedStringsApi = {
        parseSharedStringEntry,
        parseSharedStrings
    };
    moduleRegistry.registerModule("sharedStrings", sharedStringsApi);
})();

// ── address-utils ───────────────────────────────────────────────
/*
 * Copyright 2026 Toshiki Iga
 * SPDX-License-Identifier: Apache-2.0
 */
(() => {
    const moduleRegistry = getXlsx2mdModuleRegistry();
    function colToLetters(col) {
        let current = col;
        let result = "";
        while (current > 0) {
            const remainder = (current - 1) % 26;
            result = String.fromCharCode(65 + remainder) + result;
            current = Math.floor((current - 1) / 26);
        }
        return result;
    }
    function lettersToCol(letters) {
        let result = 0;
        for (const ch of String(letters || "").toUpperCase()) {
            result = result * 26 + (ch.charCodeAt(0) - 64);
        }
        return result;
    }
    function parseCellAddress(address) {
        const normalized = String(address || "").trim().replace(/\$/g, "");
        const match = normalized.match(/^([A-Z]+)(\d+)$/i);
        if (!match) {
            return { row: 0, col: 0 };
        }
        return {
            col: lettersToCol(match[1]),
            row: Number(match[2])
        };
    }
    function normalizeFormulaAddress(address) {
        return String(address || "").trim().replace(/\$/g, "").toUpperCase();
    }
    function formatRange(startRow, startCol, endRow, endCol) {
        return `${colToLetters(startCol)}${startRow}-${colToLetters(endCol)}${endRow}`;
    }
    function parseRangeRef(ref) {
        const parts = String(ref || "").split(":");
        const start = parseCellAddress(parts[0] || "");
        const end = parseCellAddress(parts[1] || parts[0] || "");
        return {
            startRow: start.row,
            startCol: start.col,
            endRow: end.row,
            endCol: end.col,
            ref
        };
    }
    function parseRangeAddress(rawRange) {
        const match = String(rawRange || "").trim().match(/^(\$?[A-Z]+\$?\d+):(\$?[A-Z]+\$?\d+)$/i);
        if (!match)
            return null;
        return {
            start: normalizeFormulaAddress(match[1]),
            end: normalizeFormulaAddress(match[2])
        };
    }
    const addressUtilsApi = {
        colToLetters,
        lettersToCol,
        parseCellAddress,
        normalizeFormulaAddress,
        formatRange,
        parseRangeRef,
        parseRangeAddress
    };
    moduleRegistry.registerModule("addressUtils", addressUtilsApi);
})();

// ── rels-parser ─────────────────────────────────────────────────
/*
 * Copyright 2026 Toshiki Iga
 * SPDX-License-Identifier: Apache-2.0
 */
(() => {
    const moduleRegistry = getXlsx2mdModuleRegistry();
    function createRelsParserApi(deps) {
        function normalizeRelationshipTarget(baseFilePath, targetPath, targetMode = "") {
            if ((targetMode || "").toLowerCase() === "external") {
                return targetPath;
            }
            return normalizeZipPath(baseFilePath, targetPath);
        }
        function normalizeZipPath(baseFilePath, targetPath) {
            const baseDirParts = baseFilePath.split("/").slice(0, -1);
            const inputParts = targetPath.split("/");
            const parts = targetPath.startsWith("/") ? [] : baseDirParts;
            for (const part of inputParts) {
                if (!part || part === ".")
                    continue;
                if (part === "..") {
                    parts.pop();
                }
                else {
                    parts.push(part);
                }
            }
            return parts.join("/");
        }
        function parseRelationshipEntries(files, relsPath, sourcePath) {
            const relBytes = files.get(relsPath);
            const relations = new Map();
            if (!relBytes) {
                return relations;
            }
            const doc = deps.xmlToDocument(deps.decodeXmlText(relBytes));
            const nodes = Array.from(doc.getElementsByTagName("Relationship"));
            for (const node of nodes) {
                const id = node.getAttribute("Id") || "";
                const target = node.getAttribute("Target") || "";
                if (!id || !target)
                    continue;
                const targetMode = node.getAttribute("TargetMode") || "";
                relations.set(id, {
                    target: normalizeRelationshipTarget(sourcePath, target, targetMode),
                    targetMode,
                    type: node.getAttribute("Type") || ""
                });
            }
            return relations;
        }
        function parseRelationships(files, relsPath, sourcePath) {
            const relations = new Map();
            const entries = parseRelationshipEntries(files, relsPath, sourcePath);
            for (const [id, entry] of entries.entries()) {
                relations.set(id, entry.target);
            }
            return relations;
        }
        function buildRelsPath(sourcePath) {
            const parts = sourcePath.split("/");
            const fileName = parts.pop() || "";
            const dir = parts.join("/");
            return `${dir}/_rels/${fileName}.rels`;
        }
        return {
            normalizeRelationshipTarget,
            normalizeZipPath,
            parseRelationshipEntries,
            parseRelationships,
            buildRelsPath
        };
    }
    const relsParserApi = {
        createRelsParserApi
    };
    moduleRegistry.registerModule("relsParser", relsParserApi);
})();

// ── worksheet-tables ────────────────────────────────────────────
/*
 * Copyright 2026 Toshiki Iga
 * SPDX-License-Identifier: Apache-2.0
 */
(() => {
    const moduleRegistry = getXlsx2mdModuleRegistry();
    const textDecoder = new TextDecoder("utf-8");
    const runtimeEnv = requireXlsx2mdRuntimeEnv();
    function decodeXmlText(bytes) {
        return textDecoder.decode(bytes);
    }
    function xmlToDocument(xmlText) {
        return runtimeEnv.xmlToDocument(xmlText);
    }
    function getElementsByLocalName(root, localName) {
        const elements = Array.from(root.getElementsByTagName("*"));
        return elements.filter((element) => element.localName === localName);
    }
    function normalizeZipPath(baseFilePath, targetPath) {
        const baseDirParts = baseFilePath.split("/").slice(0, -1);
        const inputParts = targetPath.split("/");
        const parts = targetPath.startsWith("/") ? [] : baseDirParts;
        for (const part of inputParts) {
            if (!part || part === ".")
                continue;
            if (part === "..") {
                parts.pop();
            }
            else {
                parts.push(part);
            }
        }
        return parts.join("/");
    }
    function parseRelationships(files, relsPath, sourcePath) {
        const relBytes = files.get(relsPath);
        const relations = new Map();
        if (!relBytes) {
            return relations;
        }
        const doc = xmlToDocument(decodeXmlText(relBytes));
        const nodes = Array.from(doc.getElementsByTagName("Relationship"));
        for (const node of nodes) {
            const id = node.getAttribute("Id") || "";
            const target = node.getAttribute("Target") || "";
            if (!id || !target)
                continue;
            relations.set(id, normalizeZipPath(sourcePath, target));
        }
        return relations;
    }
    function buildRelsPath(sourcePath) {
        const parts = sourcePath.split("/");
        const fileName = parts.pop() || "";
        const dir = parts.join("/");
        return `${dir}/_rels/${fileName}.rels`;
    }
    function normalizeFormulaAddress(address) {
        return String(address || "").trim().replace(/\$/g, "").toUpperCase();
    }
    function parseRangeAddress(rawRange) {
        const match = String(rawRange || "").trim().match(/^(\$?[A-Z]+\$?\d+):(\$?[A-Z]+\$?\d+)$/i);
        if (!match)
            return null;
        return {
            start: normalizeFormulaAddress(match[1]),
            end: normalizeFormulaAddress(match[2])
        };
    }
    function normalizeStructuredTableKey(value) {
        return String(value || "").normalize("NFKC").trim().toUpperCase();
    }
    function parseWorksheetTables(files, worksheetDoc, sheetName, sheetPath) {
        const sheetRels = parseRelationships(files, buildRelsPath(sheetPath), sheetPath);
        const tablePartElements = getElementsByLocalName(worksheetDoc, "tablePart");
        const tables = [];
        for (const tablePartElement of tablePartElements) {
            const relId = tablePartElement.getAttribute("r:id") || tablePartElement.getAttribute("id") || "";
            if (!relId)
                continue;
            const tablePath = sheetRels.get(relId) || "";
            if (!tablePath)
                continue;
            const tableBytes = files.get(tablePath);
            if (!tableBytes)
                continue;
            const tableDoc = xmlToDocument(decodeXmlText(tableBytes));
            const tableElement = getElementsByLocalName(tableDoc, "table")[0] || null;
            if (!tableElement)
                continue;
            const ref = tableElement.getAttribute("ref") || "";
            const range = parseRangeAddress(ref);
            if (!range)
                continue;
            const columns = getElementsByLocalName(tableElement, "tableColumn")
                .map((columnElement) => String(columnElement.getAttribute("name") || "").trim())
                .filter(Boolean);
            tables.push({
                sheetName,
                name: tableElement.getAttribute("name") || "",
                displayName: tableElement.getAttribute("displayName") || tableElement.getAttribute("name") || "",
                start: range.start,
                end: range.end,
                columns,
                headerRowCount: Number(tableElement.getAttribute("headerRowCount") || 1) || 1,
                totalsRowCount: Number(tableElement.getAttribute("totalsRowCount") || 0) || 0
            });
        }
        return tables;
    }
    const worksheetTablesApi = {
        normalizeStructuredTableKey,
        parseWorksheetTables
    };
    moduleRegistry.registerModule("worksheetTables", worksheetTablesApi);
})();

// ── cell-format ─────────────────────────────────────────────────
/*
 * Copyright 2026 Toshiki Iga
 * SPDX-License-Identifier: Apache-2.0
 */
(() => {
    const moduleRegistry = getXlsx2mdModuleRegistry();
    function isDateFormatCode(formatCode) {
        const normalized = String(formatCode || "")
            .toLowerCase()
            .replace(/\[[^\]]*]/g, "")
            .replace(/"[^"]*"/g, "")
            .replace(/\\./g, "");
        if (!normalized)
            return false;
        if (normalized.includes("general"))
            return false;
        return /[ymdhs]/.test(normalized);
    }
    function normalizeNumericFormatCode(formatCode) {
        return String(formatCode || "")
            .trim()
            .replace(/\[[^\]]*]/g, "")
            .replace(/"([^"]*)"/g, "$1")
            .replace(/\\(.)/g, "$1")
            .replace(/_.?/g, "")
            .replace(/\*/g, "");
    }
    function excelSerialToIsoText(serial) {
        if (!Number.isFinite(serial))
            return String(serial);
        const wholeDays = Math.floor(serial);
        const fractional = serial - wholeDays;
        const utcDays = wholeDays > 59 ? wholeDays - 1 : wholeDays;
        const baseUtcMs = Date.UTC(1899, 11, 31);
        const msPerDay = 24 * 60 * 60 * 1000;
        const date = new Date(baseUtcMs + utcDays * msPerDay + Math.round(fractional * msPerDay));
        const yyyy = String(date.getUTCFullYear()).padStart(4, "0");
        const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
        const dd = String(date.getUTCDate()).padStart(2, "0");
        const hh = String(date.getUTCHours()).padStart(2, "0");
        const mi = String(date.getUTCMinutes()).padStart(2, "0");
        const ss = String(date.getUTCSeconds()).padStart(2, "0");
        if (hh === "00" && mi === "00" && ss === "00") {
            return `${yyyy}-${mm}-${dd}`;
        }
        return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
    }
    function excelSerialToDateParts(serial) {
        if (!Number.isFinite(serial))
            return null;
        const wholeDays = Math.floor(serial);
        const fractional = serial - wholeDays;
        const excelEpochOffsetDays = 25569;
        const msPerDay = 24 * 60 * 60 * 1000;
        const utcDays = wholeDays - excelEpochOffsetDays;
        const baseUtcMs = Date.UTC(1970, 0, 1);
        const date = new Date(baseUtcMs + utcDays * msPerDay + Math.round(fractional * msPerDay));
        return {
            year: date.getUTCFullYear(),
            month: date.getUTCMonth() + 1,
            day: date.getUTCDate(),
            hour: date.getUTCHours(),
            minute: date.getUTCMinutes(),
            second: date.getUTCSeconds(),
            yyyy: String(date.getUTCFullYear()).padStart(4, "0"),
            mm: String(date.getUTCMonth() + 1).padStart(2, "0"),
            dd: String(date.getUTCDate()).padStart(2, "0"),
            hh: String(date.getUTCHours()).padStart(2, "0"),
            mi: String(date.getUTCMinutes()).padStart(2, "0"),
            ss: String(date.getUTCSeconds()).padStart(2, "0")
        };
    }
    function formatTextFunctionValue(value, formatText) {
        const format = String(formatText || "").trim();
        if (!format)
            return null;
        const numericValue = Number(value);
        const normalized = format.toLowerCase();
        if (!Number.isNaN(numericValue)) {
            if (/(^|[^a-z])yyyy/.test(normalized) || normalized.includes("hh:") || normalized.includes("mm/") || normalized.includes("mm-")) {
                const parts = excelSerialToDateParts(numericValue);
                if (!parts)
                    return null;
                if (normalized === "yyyy-mm-dd")
                    return `${parts.yyyy}-${parts.mm}-${parts.dd}`;
                if (normalized === "yyyy/mm/dd")
                    return `${parts.yyyy}/${parts.mm}/${parts.dd}`;
                if (normalized === "hh:mm:ss")
                    return `${parts.hh}:${parts.mi}:${parts.ss}`;
                if (normalized === "yyyy-mm-dd hh:mm:ss")
                    return `${parts.yyyy}-${parts.mm}-${parts.dd} ${parts.hh}:${parts.mi}:${parts.ss}`;
            }
            if (/^0(?:\.0+)?$/.test(format)) {
                const decimalPlaces = (format.split(".")[1] || "").length;
                return numericValue.toFixed(decimalPlaces);
            }
            if (/^#,##0(?:\.0+)?$/.test(format)) {
                const decimalPlaces = (format.split(".")[1] || "").length;
                return numericValue.toLocaleString("en-US", {
                    minimumFractionDigits: decimalPlaces,
                    maximumFractionDigits: decimalPlaces,
                    useGrouping: true
                });
            }
        }
        return null;
    }
    function formatNumberByPattern(value, pattern) {
        const normalizedPattern = pattern.trim();
        const decimalPlaces = (normalizedPattern.split(".")[1] || "").replace(/[^0#]/g, "").length;
        const useGrouping = normalizedPattern.includes(",");
        return value.toLocaleString("en-US", {
            minimumFractionDigits: decimalPlaces,
            maximumFractionDigits: decimalPlaces,
            useGrouping
        });
    }
    function formatDateByPattern(parts, formatCode) {
        const normalized = normalizeNumericFormatCode(formatCode).toLowerCase();
        if (normalized === "yyyy/m/d") {
            return `${parts.year}/${parts.month}/${parts.day}`;
        }
        if (normalized === "m月d日") {
            return `${parts.month}月${parts.day}日`;
        }
        if (normalized === "yyyy-mm-dd") {
            return `${parts.yyyy}-${parts.mm}-${parts.dd}`;
        }
        if (normalized === "yyyy/mm/dd") {
            return `${parts.year}/${parts.month}/${parts.day}`;
        }
        if (normalized === "hh:mm:ss") {
            return `${parts.hh}:${parts.mi}:${parts.ss}`;
        }
        if (normalized.includes("ggge年m月d日")) {
            if (parts.year >= 2019) {
                const reiwaYear = parts.year - 2018;
                return `令和${reiwaYear}年${parts.month}月${parts.day}日`;
            }
            if (parts.year >= 1989) {
                const heiseiYear = parts.year - 1988;
                return `平成${heiseiYear}年${parts.month}月${parts.day}日`;
            }
            return `${parts.year}年${parts.month}月${parts.day}日`;
        }
        return null;
    }
    function formatFractionPattern(value) {
        if (!Number.isFinite(value))
            return null;
        const tolerance = 1e-9;
        for (let denominator = 1; denominator <= 100; denominator += 1) {
            const numerator = Math.round(value * denominator);
            if (Math.abs(value - (numerator / denominator)) < tolerance) {
                return `${numerator}/${denominator}`;
            }
        }
        return null;
    }
    function formatDbNum3Pattern(rawValue) {
        return rawValue.split("").join(" ");
    }
    function splitFormatSections(formatCode) {
        const sections = [];
        let current = "";
        let inQuotes = false;
        for (let index = 0; index < formatCode.length; index += 1) {
            const char = formatCode[index];
            if (char === "\"") {
                inQuotes = !inQuotes;
                current += char;
                continue;
            }
            if (char === ";" && !inQuotes) {
                sections.push(current);
                current = "";
                continue;
            }
            current += char;
        }
        sections.push(current);
        return sections;
    }
    function formatZeroSection(section) {
        const normalizedSection = String(section || "");
        if (!normalizedSection)
            return null;
        const compact = normalizedSection.replace(/_.|\\.|[*?]/g, "").trim();
        const hasDashLiteral = /"-"|(^|[^a-z0-9])-($|[^a-z0-9])/i.test(compact);
        if (!hasDashLiteral)
            return null;
        if (compact.includes("¥"))
            return "¥ -";
        if (compact.includes("$"))
            return "$ -";
        return "-";
    }
    function formatCellDisplayValue(rawValue, cellStyle) {
        if (rawValue === "")
            return null;
        const numericValue = Number(rawValue);
        const formatCode = normalizeNumericFormatCode(cellStyle.formatCode);
        const normalized = formatCode.toLowerCase();
        const formatSections = splitFormatSections(formatCode);
        if (!Number.isNaN(numericValue) && isDateFormatCode(formatCode)) {
            const parts = excelSerialToDateParts(numericValue);
            if (!parts)
                return null;
            const directFormatted = formatDateByPattern(parts, formatCode);
            if (directFormatted !== null) {
                return directFormatted;
            }
            const hasDate = /y/.test(normalized)
                || /d/.test(normalized)
                || /(^|[^a-z])m(?:\/|-)/.test(normalized)
                || /(?:\/|-)m(?:[^a-z]|$)/.test(normalized);
            const hasTime = /h/.test(normalized) || /s/.test(normalized) || normalized.includes(":") || normalized.includes("am/pm");
            if (hasDate && hasTime) {
                return `${parts.yyyy}-${parts.mm}-${parts.dd} ${parts.hh}:${parts.mi}:${parts.ss}`;
            }
            if (hasTime && !hasDate) {
                return `${parts.hh}:${parts.mi}:${parts.ss}`;
            }
            return `${parts.yyyy}-${parts.mm}-${parts.dd}`;
        }
        if (Number.isNaN(numericValue)) {
            return null;
        }
        if (numericValue === 0 && formatSections[2]) {
            const zeroText = formatZeroSection(formatSections[2]);
            if (zeroText) {
                return zeroText;
            }
        }
        if (normalized.includes("%")) {
            const percentPattern = normalized.split(";")[0] || normalized;
            const decimalPlaces = (percentPattern.split(".")[1] || "").replace(/[^0#]/g, "").length;
            return `${(numericValue * 100).toFixed(decimalPlaces)}%`;
        }
        if (cellStyle.numFmtId === 186 || /dbnum3/i.test(formatCode)) {
            return formatDbNum3Pattern(rawValue);
        }
        if (cellStyle.numFmtId === 42) {
            return `¥ ${formatNumberByPattern(numericValue, "#,##0").replace(/^-/, "")}`;
        }
        if (/[#0][^;]*e\+0+/i.test(formatCode)) {
            const scientificPattern = formatCode.split(";")[0] || formatCode;
            const decimalPartMatch = scientificPattern.match(/\.([0#]+)e\+/i);
            const decimalPlaces = (decimalPartMatch?.[1] || "").length;
            const exponentDigits = (scientificPattern.match(/e\+([0#]+)/i)?.[1] || "").length;
            const [mantissa, exponentPart] = numericValue.toExponential(decimalPlaces).split("e");
            const exponent = Number(exponentPart || 0);
            const sign = exponent >= 0 ? "+" : "-";
            const paddedExponent = String(Math.abs(exponent)).padStart(exponentDigits, "0");
            return `${mantissa}E${sign}${paddedExponent}`;
        }
        if (normalized.includes("?/?")) {
            return formatFractionPattern(numericValue);
        }
        if (/^[^;]*[#0,]+(?:\.[#0]+)?/.test(formatCode)) {
            const primaryPattern = (formatCode.split(";")[0] || formatCode).trim();
            if (primaryPattern.includes("¥")) {
                const numericText = formatNumberByPattern(numericValue, primaryPattern.replace(/[^#0,.\-]/g, ""));
                const withCurrency = primaryPattern.includes("*") ? `¥ ${numericText.replace(/^-/, "")}` : `¥${numericText.replace(/^-/, "")}`;
                return `${numericValue < 0 ? "-" : ""}${withCurrency}`;
            }
            return formatNumberByPattern(numericValue, primaryPattern.replace(/[^#0,.\-]/g, ""));
        }
        return null;
    }
    function applyResolvedFormulaValue(cell, resolvedValue, resolutionSource = "legacy_resolver") {
        const rawValue = String(resolvedValue || "");
        const formattedValue = formatCellDisplayValue(rawValue, {
            borders: cell.borders,
            numFmtId: cell.numFmtId,
            formatCode: cell.formatCode
        });
        cell.rawValue = rawValue;
        cell.outputValue = formattedValue ?? rawValue;
        cell.resolutionStatus = "resolved";
        cell.resolutionSource = resolutionSource;
    }
    function parseDateLikeParts(value) {
        const trimmed = String(value || "").trim();
        const numericValue = Number(trimmed);
        if (!Number.isNaN(numericValue)) {
            return excelSerialToDateParts(numericValue);
        }
        const isoMatch = trimmed.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/);
        if (isoMatch) {
            return {
                yyyy: isoMatch[1],
                mm: isoMatch[2].padStart(2, "0"),
                dd: isoMatch[3].padStart(2, "0"),
                hh: (isoMatch[4] || "00").padStart(2, "0"),
                mi: (isoMatch[5] || "00").padStart(2, "0"),
                ss: (isoMatch[6] || "00").padStart(2, "0")
            };
        }
        const japaneseMatch = trimmed.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日(?:\s*(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/);
        if (japaneseMatch) {
            return {
                yyyy: japaneseMatch[1],
                mm: japaneseMatch[2].padStart(2, "0"),
                dd: japaneseMatch[3].padStart(2, "0"),
                hh: (japaneseMatch[4] || "00").padStart(2, "0"),
                mi: (japaneseMatch[5] || "00").padStart(2, "0"),
                ss: (japaneseMatch[6] || "00").padStart(2, "0")
            };
        }
        const japaneseYearMonthMatch = trimmed.match(/^(\d{4})年(\d{1,2})月$/);
        if (japaneseYearMonthMatch) {
            return {
                yyyy: japaneseYearMonthMatch[1],
                mm: japaneseYearMonthMatch[2].padStart(2, "0"),
                dd: "01",
                hh: "00",
                mi: "00",
                ss: "00"
            };
        }
        const japaneseMonthDayMatch = trimmed.match(/^(\d{1,2})月(\d{1,2})日$/);
        if (japaneseMonthDayMatch) {
            return {
                yyyy: "2000",
                mm: japaneseMonthDayMatch[1].padStart(2, "0"),
                dd: japaneseMonthDayMatch[2].padStart(2, "0"),
                hh: "00",
                mi: "00",
                ss: "00"
            };
        }
        const isoYearMonthMatch = trimmed.match(/^(\d{4})[-/](\d{1,2})$/);
        if (isoYearMonthMatch) {
            return {
                yyyy: isoYearMonthMatch[1],
                mm: isoYearMonthMatch[2].padStart(2, "0"),
                dd: "01",
                hh: "00",
                mi: "00",
                ss: "00"
            };
        }
        return null;
    }
    function datePartsToExcelSerial(year, month, day, hour = 0, minute = 0, second = 0) {
        if (![year, month, day, hour, minute, second].every(Number.isFinite))
            return null;
        const baseUtcMs = Date.UTC(1899, 11, 31);
        const targetUtcMs = Date.UTC(year, month - 1, day, hour, minute, second);
        const msPerDay = 24 * 60 * 60 * 1000;
        let serial = (targetUtcMs - baseUtcMs) / msPerDay;
        if (serial >= 60) {
            serial += 1;
        }
        return serial;
    }
    function parseValueFunctionText(value) {
        const trimmed = String(value || "").trim();
        if (!trimmed)
            return null;
        const numericValue = Number(trimmed.replace(/,/g, ""));
        if (!Number.isNaN(numericValue)) {
            return numericValue;
        }
        const parts = parseDateLikeParts(trimmed);
        if (!parts)
            return null;
        return datePartsToExcelSerial(Number(parts.yyyy), Number(parts.mm), Number(parts.dd), Number(parts.hh), Number(parts.mi), Number(parts.ss));
    }
    const cellFormatApi = {
        isDateFormatCode,
        normalizeNumericFormatCode,
        excelSerialToIsoText,
        excelSerialToDateParts,
        formatTextFunctionValue,
        formatNumberByPattern,
        formatDateByPattern,
        formatFractionPattern,
        formatDbNum3Pattern,
        splitFormatSections,
        formatZeroSection,
        formatCellDisplayValue,
        applyResolvedFormulaValue,
        parseDateLikeParts,
        datePartsToExcelSerial,
        parseValueFunctionText
    };
    moduleRegistry.registerModule("cellFormat", cellFormatApi);
})();

// ── xml-utils ───────────────────────────────────────────────────
/*
 * Copyright 2026 Toshiki Iga
 * SPDX-License-Identifier: Apache-2.0
 */
(() => {
    const moduleRegistry = getXlsx2mdModuleRegistry();
    const textDecoder = new TextDecoder("utf-8");
    const runtimeEnv = requireXlsx2mdRuntimeEnv();
    function xmlToDocument(xmlText) {
        return runtimeEnv.xmlToDocument(xmlText);
    }
    function getElementsByLocalName(root, localName) {
        const elements = Array.from(root.getElementsByTagName("*"));
        return elements.filter((element) => element.localName === localName);
    }
    function getFirstChildByLocalName(root, localName) {
        return getElementsByLocalName(root, localName)[0] || null;
    }
    function getDirectChildByLocalName(root, localName) {
        if (!root)
            return null;
        for (const node of Array.from(root.childNodes)) {
            if (node.nodeType === runtimeEnv.ELEMENT_NODE && node.localName === localName) {
                return node;
            }
        }
        return null;
    }
    function decodeXmlText(bytes) {
        return textDecoder.decode(bytes);
    }
    function getTextContent(node) {
        return (node?.textContent || "").replace(/\r\n/g, "\n");
    }
    const xmlUtilsApi = {
        xmlToDocument,
        getElementsByLocalName,
        getFirstChildByLocalName,
        getDirectChildByLocalName,
        decodeXmlText,
        getTextContent
    };
    moduleRegistry.registerModule("xmlUtils", xmlUtilsApi);
})();

// ── sheet-assets ────────────────────────────────────────────────
/*
 * Copyright 2026 Toshiki Iga
 * SPDX-License-Identifier: Apache-2.0
 */
(() => {
    const moduleRegistry = getXlsx2mdModuleRegistry();
    const runtimeEnv = moduleRegistry?.getModule("runtimeEnv");
    if (!runtimeEnv) {
        throw new Error("xlsx2md runtime env module is not loaded");
    }
    function createSafeSheetAssetDir(sheetName) {
        return sheetName.replace(/[\\/:*?"<>|]+/g, "_").trim() || "Sheet";
    }
    function getImageExtension(mediaPath) {
        const match = mediaPath.match(/\.([a-z0-9]+)$/i);
        return match ? match[1].toLowerCase() : "bin";
    }
    function parseDrawingImages(files, sheetName, sheetPath, deps) {
        const sheetRels = deps.parseRelationships(files, deps.buildRelsPath(sheetPath), sheetPath);
        const imageAssets = [];
        let imageCounter = 1;
        for (const drawingPath of sheetRels.values()) {
            if (!/\/drawings\/.+\.xml$/i.test(drawingPath))
                continue;
            const drawingBytes = files.get(drawingPath);
            if (!drawingBytes)
                continue;
            const drawingDoc = deps.xmlToDocument(deps.decodeXmlText(drawingBytes));
            const drawingRels = deps.parseRelationships(files, deps.buildRelsPath(drawingPath), drawingPath);
            const anchors = deps.getElementsByLocalName(drawingDoc, "oneCellAnchor").concat(deps.getElementsByLocalName(drawingDoc, "twoCellAnchor"));
            for (const anchor of anchors) {
                const from = deps.getFirstChildByLocalName(anchor, "from");
                const colNode = deps.getFirstChildByLocalName(from || anchor, "col");
                const rowNode = deps.getFirstChildByLocalName(from || anchor, "row");
                const col = Number(deps.getTextContent(colNode)) + 1;
                const row = Number(deps.getTextContent(rowNode)) + 1;
                if (!Number.isFinite(col) || !Number.isFinite(row) || col <= 0 || row <= 0) {
                    continue;
                }
                const blip = deps.getElementsByLocalName(anchor, "blip")[0] || null;
                const embedId = blip?.getAttribute("r:embed") || blip?.getAttribute("embed") || "";
                const mediaPath = drawingRels.get(embedId) || "";
                if (!mediaPath)
                    continue;
                const mediaBytes = files.get(mediaPath);
                if (!mediaBytes)
                    continue;
                const extension = getImageExtension(mediaPath);
                const safeDir = createSafeSheetAssetDir(sheetName);
                const filename = `image_${String(imageCounter).padStart(3, "0")}.${extension}`;
                imageAssets.push({
                    sheetName,
                    filename,
                    path: `assets/${safeDir}/${filename}`,
                    anchor: `${deps.colToLetters(col)}${row}`,
                    data: new Uint8Array(mediaBytes),
                    mediaPath
                });
                imageCounter += 1;
            }
        }
        return imageAssets;
    }
    function parseChartType(chartDoc, deps) {
        const typeMap = [
            { localName: "barChart", label: "Bar Chart" },
            { localName: "lineChart", label: "Line Chart" },
            { localName: "pieChart", label: "Pie Chart" },
            { localName: "doughnutChart", label: "Doughnut Chart" },
            { localName: "areaChart", label: "Area Chart" },
            { localName: "scatterChart", label: "Scatter Chart" },
            { localName: "radarChart", label: "Radar Chart" },
            { localName: "bubbleChart", label: "Bubble Chart" }
        ];
        const matched = typeMap
            .filter((entry) => deps.getElementsByLocalName(chartDoc, entry.localName).length > 0)
            .map((entry) => entry.label);
        if (matched.length === 0)
            return "Chart";
        if (matched.length === 1)
            return matched[0];
        return `${matched.join(" + ")} (Combined)`;
    }
    function parseChartTitle(chartDoc, deps) {
        const richText = deps.getElementsByLocalName(chartDoc, "t")
            .map((node) => deps.getTextContent(node))
            .filter(Boolean);
        if (richText.length > 0) {
            return richText.join("").trim();
        }
        return "";
    }
    function parseChartSeries(chartDoc, deps) {
        const plotArea = deps.getFirstChildByLocalName(chartDoc, "plotArea") || chartDoc.documentElement;
        const axisPositionById = new Map();
        for (const axisNode of deps.getElementsByLocalName(plotArea, "valAx")) {
            const axisIdNode = deps.getFirstChildByLocalName(axisNode, "axId");
            const axisPosNode = deps.getFirstChildByLocalName(axisNode, "axPos");
            const axisId = axisIdNode?.getAttribute("val") || deps.getTextContent(axisIdNode);
            const axisPos = axisPosNode?.getAttribute("val") || deps.getTextContent(axisPosNode);
            if (axisId) {
                axisPositionById.set(axisId, axisPos || "");
            }
        }
        const chartContainerNames = [
            "barChart",
            "lineChart",
            "pieChart",
            "doughnutChart",
            "areaChart",
            "scatterChart",
            "radarChart",
            "bubbleChart"
        ];
        const series = [];
        for (const localName of chartContainerNames) {
            for (const chartNode of deps.getElementsByLocalName(plotArea, localName)) {
                const axisIds = deps.getElementsByLocalName(chartNode, "axId")
                    .map((node) => node.getAttribute("val") || deps.getTextContent(node))
                    .filter(Boolean);
                const isSecondary = axisIds.some((axisId) => axisPositionById.get(axisId) === "r");
                for (const seriesNode of deps.getElementsByLocalName(chartNode, "ser")) {
                    const txNode = deps.getFirstChildByLocalName(seriesNode, "tx") || seriesNode;
                    const nameRef = deps.getFirstChildByLocalName(txNode, "f");
                    const nameValue = deps.getFirstChildByLocalName(txNode, "v");
                    const nameText = deps.getElementsByLocalName(txNode, "t")
                        .map((node) => deps.getTextContent(node))
                        .join("")
                        .trim();
                    const catRef = deps.getFirstChildByLocalName(deps.getFirstChildByLocalName(deps.getFirstChildByLocalName(seriesNode, "cat") || seriesNode, "strRef") || seriesNode, "f")
                        || deps.getFirstChildByLocalName(deps.getFirstChildByLocalName(deps.getFirstChildByLocalName(seriesNode, "cat") || seriesNode, "numRef") || seriesNode, "f");
                    const valRef = deps.getFirstChildByLocalName(deps.getFirstChildByLocalName(seriesNode, "val") || seriesNode, "f")
                        || deps.getFirstChildByLocalName(deps.getFirstChildByLocalName(deps.getFirstChildByLocalName(seriesNode, "val") || seriesNode, "numRef") || seriesNode, "f");
                    series.push({
                        name: nameText || deps.getTextContent(nameValue) || deps.getTextContent(nameRef) || "Series",
                        categoriesRef: deps.getTextContent(catRef),
                        valuesRef: deps.getTextContent(valRef),
                        axis: isSecondary ? "secondary" : "primary"
                    });
                }
            }
        }
        return series;
    }
    function parseDrawingCharts(files, sheetName, sheetPath, deps) {
        const sheetRels = deps.parseRelationships(files, deps.buildRelsPath(sheetPath), sheetPath);
        const charts = [];
        for (const drawingPath of sheetRels.values()) {
            if (!/\/drawings\/.+\.xml$/i.test(drawingPath))
                continue;
            const drawingBytes = files.get(drawingPath);
            if (!drawingBytes)
                continue;
            const drawingDoc = deps.xmlToDocument(deps.decodeXmlText(drawingBytes));
            const drawingRels = deps.parseRelationships(files, deps.buildRelsPath(drawingPath), drawingPath);
            const anchors = deps.getElementsByLocalName(drawingDoc, "oneCellAnchor").concat(deps.getElementsByLocalName(drawingDoc, "twoCellAnchor"));
            for (const anchor of anchors) {
                const from = deps.getFirstChildByLocalName(anchor, "from");
                const colNode = deps.getFirstChildByLocalName(from || anchor, "col");
                const rowNode = deps.getFirstChildByLocalName(from || anchor, "row");
                const col = Number(deps.getTextContent(colNode)) + 1;
                const row = Number(deps.getTextContent(rowNode)) + 1;
                if (!Number.isFinite(col) || !Number.isFinite(row) || col <= 0 || row <= 0) {
                    continue;
                }
                const chartNode = deps.getFirstChildByLocalName(anchor, "graphicFrame");
                const chartRef = deps.getElementsByLocalName(chartNode || anchor, "chart")[0] || null;
                const relId = chartRef?.getAttribute("r:id") || chartRef?.getAttribute("id") || "";
                const chartPath = drawingRels.get(relId) || "";
                if (!chartPath)
                    continue;
                const chartBytes = files.get(chartPath);
                if (!chartBytes)
                    continue;
                const chartDoc = deps.xmlToDocument(deps.decodeXmlText(chartBytes));
                charts.push({
                    sheetName,
                    anchor: `${deps.colToLetters(col)}${row}`,
                    chartPath,
                    title: parseChartTitle(chartDoc, deps),
                    chartType: parseChartType(chartDoc, deps),
                    series: parseChartSeries(chartDoc, deps)
                });
            }
        }
        return charts;
    }
    function parseShapeKind(shapeNode, deps) {
        if (!shapeNode)
            return "Shape";
        if (shapeNode.localName === "cxnSp") {
            const geomNode = deps.getFirstChildByLocalName(deps.getFirstChildByLocalName(shapeNode, "spPr") || shapeNode, "prstGeom");
            const prst = String(geomNode?.getAttribute("prst") || "").trim();
            if (prst === "straightConnector1") {
                return "Straight Arrow Connector";
            }
            return prst ? `Connector (${prst})` : "Connector";
        }
        if (shapeNode.localName !== "sp") {
            return "Shape";
        }
        const nvSpPr = deps.getFirstChildByLocalName(shapeNode, "nvSpPr");
        const cNvSpPr = deps.getFirstChildByLocalName(nvSpPr || shapeNode, "cNvSpPr");
        if (cNvSpPr?.getAttribute("txBox") === "1") {
            return "Text Box";
        }
        const geomNode = deps.getFirstChildByLocalName(deps.getFirstChildByLocalName(shapeNode, "spPr") || shapeNode, "prstGeom");
        const prst = String(geomNode?.getAttribute("prst") || "").trim();
        if (prst === "rect") {
            return "Rectangle";
        }
        return prst ? `Shape (${prst})` : "Shape";
    }
    function parseShapeText(shapeNode, deps) {
        if (!shapeNode)
            return "";
        return deps.getElementsByLocalName(shapeNode, "t")
            .map((node) => deps.getTextContent(node))
            .filter(Boolean)
            .join("")
            .trim();
    }
    function parseShapeExt(anchor, shapeNode, deps) {
        const extNode = deps.getDirectChildByLocalName(anchor, "ext")
            || deps.getDirectChildByLocalName(deps.getDirectChildByLocalName(deps.getDirectChildByLocalName(shapeNode || anchor, "spPr") || shapeNode || anchor, "xfrm"), "ext");
        const widthEmu = Number(extNode?.getAttribute("cx") || "");
        const heightEmu = Number(extNode?.getAttribute("cy") || "");
        return {
            widthEmu: Number.isFinite(widthEmu) ? widthEmu : null,
            heightEmu: Number.isFinite(heightEmu) ? heightEmu : null
        };
    }
    function flattenXmlNodeEntries(node, deps, path = "", entries = []) {
        if (!node)
            return entries;
        const nodeName = node.tagName || node.nodeName || node.localName || "node";
        const currentPath = path ? `${path}/${nodeName}` : nodeName;
        for (const attribute of Array.from(node.attributes)) {
            entries.push({
                key: `${currentPath}@${attribute.name}`,
                value: attribute.value
            });
        }
        const directText = Array.from(node.childNodes)
            .filter((child) => child.nodeType === runtimeEnv.TEXT_NODE)
            .map((child) => (child.textContent || "").trim())
            .filter(Boolean)
            .join(" ");
        if (directText) {
            entries.push({
                key: `${currentPath}#text`,
                value: directText
            });
        }
        for (const child of Array.from(node.childNodes)) {
            if (child.nodeType === runtimeEnv.ELEMENT_NODE) {
                flattenXmlNodeEntries(child, deps, currentPath, entries);
            }
        }
        return entries;
    }
    function parseShapeRawEntries(anchor, deps) {
        const entries = [];
        return flattenXmlNodeEntries(anchor, deps, "", entries);
    }
    function renderHierarchicalRawEntries(entries) {
        const root = {
            children: new Map(),
            value: null
        };
        for (const entry of entries) {
            const parts = entry.key.split("/").filter(Boolean);
            let current = root;
            for (const part of parts) {
                if (!current.children.has(part)) {
                    current.children.set(part, {
                        children: new Map(),
                        value: null
                    });
                }
                current = current.children.get(part);
            }
            current.value = entry.value;
        }
        const lines = [];
        function visit(node, depth) {
            for (const [key, child] of node.children.entries()) {
                const indent = " ".repeat(depth * 4);
                if (child.value !== null) {
                    lines.push(`${indent}- \`${key}\`: \`${child.value}\``);
                }
                else {
                    lines.push(`${indent}- \`${key}\``);
                }
                visit(child, depth + 1);
            }
        }
        visit(root, 0);
        return lines;
    }
    function parseAnchorInt(anchor, parentName, childName, deps) {
        if (!anchor)
            return null;
        const parent = deps.getFirstChildByLocalName(anchor, parentName);
        const child = deps.getFirstChildByLocalName(parent || anchor, childName);
        const value = Number(deps.getTextContent(child));
        return Number.isFinite(value) ? value : null;
    }
    function parseShapeBoundingBox(anchor, shapeNode, widthEmu, heightEmu, deps) {
        const fromCol = parseAnchorInt(anchor, "from", "col", deps) || 0;
        const fromRow = parseAnchorInt(anchor, "from", "row", deps) || 0;
        const fromColOff = parseAnchorInt(anchor, "from", "colOff", deps) || 0;
        const fromRowOff = parseAnchorInt(anchor, "from", "rowOff", deps) || 0;
        const toCol = parseAnchorInt(anchor, "to", "col", deps);
        const toRow = parseAnchorInt(anchor, "to", "row", deps);
        const toColOff = parseAnchorInt(anchor, "to", "colOff", deps) || 0;
        const toRowOff = parseAnchorInt(anchor, "to", "rowOff", deps) || 0;
        const left = fromCol * deps.defaultCellWidthEmu + fromColOff;
        const top = fromRow * deps.defaultCellHeightEmu + fromRowOff;
        if (toCol !== null && toRow !== null) {
            return {
                left,
                top,
                right: toCol * deps.defaultCellWidthEmu + toColOff,
                bottom: toRow * deps.defaultCellHeightEmu + toRowOff
            };
        }
        const ext = parseShapeExt(anchor, shapeNode, deps);
        return {
            left,
            top,
            right: left + Math.max(1, ext.widthEmu || widthEmu || deps.defaultCellWidthEmu),
            bottom: top + Math.max(1, ext.heightEmu || heightEmu || deps.defaultCellHeightEmu)
        };
    }
    function bboxGap(a, b) {
        const dx = a.right < b.left
            ? b.left - a.right
            : b.right < a.left
                ? a.left - b.right
                : 0;
        const dy = a.bottom < b.top
            ? b.top - a.bottom
            : b.bottom < a.top
                ? a.top - b.bottom
                : 0;
        return { dx, dy };
    }
    function extractShapeBlocks(shapes, deps) {
        if (shapes.length === 0)
            return [];
        const visited = new Array(shapes.length).fill(false);
        const blocks = [];
        for (let i = 0; i < shapes.length; i += 1) {
            if (visited[i])
                continue;
            const queue = [i];
            visited[i] = true;
            const shapeIndexes = [];
            while (queue.length > 0) {
                const currentIndex = queue.shift();
                shapeIndexes.push(currentIndex);
                const current = shapes[currentIndex];
                for (let j = 0; j < shapes.length; j += 1) {
                    if (visited[j])
                        continue;
                    const other = shapes[j];
                    const { dx, dy } = bboxGap(current.bbox, other.bbox);
                    if (dx <= deps.shapeBlockGapXEmu && dy <= deps.shapeBlockGapYEmu) {
                        visited[j] = true;
                        queue.push(j);
                    }
                }
            }
            let minLeft = Number.POSITIVE_INFINITY;
            let minTop = Number.POSITIVE_INFINITY;
            let maxRight = 0;
            let maxBottom = 0;
            for (const index of shapeIndexes) {
                const bbox = shapes[index].bbox;
                minLeft = Math.min(minLeft, bbox.left);
                minTop = Math.min(minTop, bbox.top);
                maxRight = Math.max(maxRight, bbox.right);
                maxBottom = Math.max(maxBottom, bbox.bottom);
            }
            blocks.push({
                startCol: Math.floor(minLeft / deps.defaultCellWidthEmu) + 1,
                startRow: Math.floor(minTop / deps.defaultCellHeightEmu) + 1,
                endCol: Math.floor(maxRight / deps.defaultCellWidthEmu) + 1,
                endRow: Math.floor(maxBottom / deps.defaultCellHeightEmu) + 1,
                shapeIndexes: shapeIndexes.sort((a, b) => a - b)
            });
        }
        return blocks.sort((a, b) => (a.startRow - b.startRow) || (a.startCol - b.startCol));
    }
    function parseDrawingShapes(files, sheetName, sheetPath, deps) {
        const sheetRels = deps.parseRelationships(files, deps.buildRelsPath(sheetPath), sheetPath);
        const shapes = [];
        let shapeCounter = 1;
        for (const drawingPath of sheetRels.values()) {
            if (!/\/drawings\/.+\.xml$/i.test(drawingPath))
                continue;
            const drawingBytes = files.get(drawingPath);
            if (!drawingBytes)
                continue;
            const drawingDoc = deps.xmlToDocument(deps.decodeXmlText(drawingBytes));
            const anchors = deps.getElementsByLocalName(drawingDoc, "oneCellAnchor").concat(deps.getElementsByLocalName(drawingDoc, "twoCellAnchor"));
            for (const anchor of anchors) {
                const from = deps.getFirstChildByLocalName(anchor, "from");
                const colNode = deps.getFirstChildByLocalName(from || anchor, "col");
                const rowNode = deps.getFirstChildByLocalName(from || anchor, "row");
                const col = Number(deps.getTextContent(colNode)) + 1;
                const row = Number(deps.getTextContent(rowNode)) + 1;
                if (!Number.isFinite(col) || !Number.isFinite(row) || col <= 0 || row <= 0) {
                    continue;
                }
                if (deps.getElementsByLocalName(anchor, "blip").length > 0)
                    continue;
                if (deps.getElementsByLocalName(anchor, "chart").length > 0)
                    continue;
                const shapeNode = deps.getFirstChildByLocalName(anchor, "sp") || deps.getFirstChildByLocalName(anchor, "cxnSp");
                if (!shapeNode)
                    continue;
                const cNvPr = deps.getFirstChildByLocalName(deps.getFirstChildByLocalName(shapeNode, shapeNode.localName === "sp" ? "nvSpPr" : "nvCxnSpPr") || shapeNode, "cNvPr");
                const { widthEmu, heightEmu } = parseShapeExt(anchor, shapeNode, deps);
                const svgAsset = deps.drawingHelper?.renderShapeSvg?.(shapeNode, anchor, sheetName, shapeCounter) || null;
                shapes.push({
                    sheetName,
                    anchor: `${deps.colToLetters(col)}${row}`,
                    name: String(cNvPr?.getAttribute("name") || "").trim() || "Shape",
                    kind: parseShapeKind(shapeNode, deps),
                    text: parseShapeText(shapeNode, deps),
                    widthEmu,
                    heightEmu,
                    elementName: `xdr:${shapeNode.localName}`,
                    anchorElementName: anchor.tagName || anchor.nodeName || anchor.localName || "anchor",
                    rawEntries: parseShapeRawEntries(anchor, deps),
                    bbox: parseShapeBoundingBox(anchor, shapeNode, widthEmu, heightEmu, deps),
                    svgFilename: svgAsset?.filename || null,
                    svgPath: svgAsset?.path || null,
                    svgData: svgAsset?.data || null
                });
                shapeCounter += 1;
            }
        }
        return shapes;
    }
    const sheetAssetsApi = {
        createSafeSheetAssetDir,
        parseDrawingImages,
        parseDrawingCharts,
        parseDrawingShapes,
        extractShapeBlocks,
        renderHierarchicalRawEntries
    };
    moduleRegistry.registerModule("sheetAssets", sheetAssetsApi);
})();

// ── worksheet-parser ────────────────────────────────────────────
/*
 * Copyright 2026 Toshiki Iga
 * SPDX-License-Identifier: Apache-2.0
 */
(() => {
    const moduleRegistry = getXlsx2mdModuleRegistry();
    function expandRangeAddresses(ref, deps) {
        const range = deps.parseRangeRef(ref);
        const addresses = [];
        for (let row = Math.max(1, range.startRow); row <= Math.max(range.startRow, range.endRow); row += 1) {
            for (let col = Math.max(1, range.startCol); col <= Math.max(range.startCol, range.endCol); col += 1) {
                addresses.push(`${deps.colToLetters(col)}${row}`);
            }
        }
        return addresses;
    }
    function parseWorksheetHyperlinks(files, worksheetDoc, sheetPath, deps) {
        const hyperlinks = new Map();
        const relsPath = deps.buildRelsPath(sheetPath);
        const relEntries = deps.parseRelationshipEntries(files, relsPath, sheetPath);
        const hyperlinkNodes = Array.from(worksheetDoc.getElementsByTagName("hyperlink"));
        for (const node of hyperlinkNodes) {
            const ref = (node.getAttribute("ref") || "").trim();
            if (!ref)
                continue;
            const relId = (node.getAttribute("r:id") || node.getAttribute("id") || "").trim();
            const relEntry = relId ? relEntries.get(relId) : null;
            const display = (node.getAttribute("display") || "").trim();
            const tooltip = (node.getAttribute("tooltip") || "").trim();
            const location = (node.getAttribute("location") || "").trim().replace(/^#/, "");
            const rawTarget = relEntry?.target?.trim() || "";
            const kind = relEntry?.targetMode.toLowerCase() === "external"
                ? "external"
                : location
                    ? "internal"
                    : rawTarget.startsWith("#")
                        ? "internal"
                        : rawTarget
                            ? "external"
                            : null;
            if (!kind)
                continue;
            const target = kind === "internal"
                ? (location || rawTarget.replace(/^#/, ""))
                : rawTarget;
            if (!target)
                continue;
            const hyperlink = {
                kind,
                target,
                location: location || (kind === "internal" ? target : ""),
                tooltip,
                display
            };
            for (const address of expandRangeAddresses(ref, deps)) {
                hyperlinks.set(address, hyperlink);
            }
        }
        return hyperlinks;
    }
    function hasEnabledBooleanValue(node) {
        if (!node)
            return false;
        const value = (node.getAttribute("val") || "").trim().toLowerCase();
        return value !== "false" && value !== "0" && value !== "none";
    }
    function mergeTextStyle(base, override) {
        return {
            bold: base.bold || override.bold,
            italic: base.italic || override.italic,
            strike: base.strike || override.strike,
            underline: base.underline || override.underline
        };
    }
    function hasTextStyle(style) {
        return style.bold || style.italic || style.strike || style.underline;
    }
    function parseRichTextStyle(runProperties) {
        return {
            bold: hasEnabledBooleanValue(runProperties?.getElementsByTagName("b")[0]),
            italic: hasEnabledBooleanValue(runProperties?.getElementsByTagName("i")[0]),
            strike: hasEnabledBooleanValue(runProperties?.getElementsByTagName("strike")[0]),
            underline: hasEnabledBooleanValue(runProperties?.getElementsByTagName("u")[0])
        };
    }
    function mergeAdjacentRuns(runs) {
        const merged = [];
        for (const run of runs) {
            if (!run.text)
                continue;
            const previous = merged[merged.length - 1];
            if (previous
                && previous.bold === run.bold
                && previous.italic === run.italic
                && previous.strike === run.strike
                && previous.underline === run.underline) {
                previous.text += run.text;
            }
            else {
                merged.push({ ...run });
            }
        }
        return merged.length > 0 && merged.some((run) => hasTextStyle(run)) ? merged : null;
    }
    function createStyledRuns(text, style) {
        if (!text || !hasTextStyle(style)) {
            return null;
        }
        return [{
                text,
                ...style
            }];
    }
    function parseInlineRichTextRuns(cellElement, cellStyle, deps) {
        const inlineStringElement = cellElement.getElementsByTagName("is")[0] || null;
        if (!inlineStringElement) {
            return null;
        }
        const runElements = Array.from(inlineStringElement.childNodes).filter((node) => (node.nodeType === Node.ELEMENT_NODE && node.localName === "r"));
        if (runElements.length === 0) {
            return null;
        }
        return mergeAdjacentRuns(runElements.map((runElement) => ({
            text: Array.from(runElement.getElementsByTagName("t")).map((node) => deps.getTextContent(node)).join(""),
            ...mergeTextStyle(cellStyle, parseRichTextStyle(runElement.getElementsByTagName("rPr")[0] || null))
        })));
    }
    function extractCellOutputValue(cellElement, sharedStrings, cellStyle, deps, formulaOverride = "") {
        const type = (cellElement.getAttribute("t") || "").trim();
        const valueNode = cellElement.getElementsByTagName("v")[0] || null;
        const valueText = deps.getTextContent(valueNode);
        const formulaText = formulaOverride || deps.getTextContent(cellElement.getElementsByTagName("f")[0]);
        const cachedValueState = !formulaText
            ? null
            : !valueNode
                ? "absent"
                : valueText === ""
                    ? "present_empty"
                    : "present_nonempty";
        if (formulaText) {
            const normalizedFormula = formulaText.startsWith("=") ? formulaText : `=${formulaText}`;
            if (/\[[^\]]+\.xlsx\]/i.test(normalizedFormula)) {
                return {
                    valueType: type || "formula",
                    rawValue: valueText || normalizedFormula,
                    outputValue: normalizedFormula,
                    formulaText: normalizedFormula,
                    resolutionStatus: "unsupported_external",
                    resolutionSource: "external_unsupported",
                    cachedValueState,
                    richTextRuns: null
                };
            }
            if (valueNode) {
                const formattedValue = deps.formatCellDisplayValue(valueText, cellStyle);
                return {
                    valueType: type || "formula",
                    rawValue: valueText,
                    outputValue: formattedValue ?? valueText,
                    formulaText: normalizedFormula,
                    resolutionStatus: "resolved",
                    resolutionSource: "cached_value",
                    cachedValueState,
                    richTextRuns: null
                };
            }
            return {
                valueType: type || "formula",
                rawValue: normalizedFormula,
                outputValue: normalizedFormula,
                formulaText: normalizedFormula,
                resolutionStatus: "fallback_formula",
                resolutionSource: "formula_text",
                cachedValueState,
                richTextRuns: null
            };
        }
        if (type === "s") {
            const sharedIndex = Number(valueText || 0);
            const sharedEntry = sharedStrings[sharedIndex] || { text: "", runs: null };
            return {
                valueType: type,
                rawValue: valueText,
                outputValue: sharedEntry.text,
                formulaText: "",
                resolutionStatus: null,
                resolutionSource: null,
                cachedValueState: null,
                richTextRuns: sharedEntry.runs
                    ? mergeAdjacentRuns(sharedEntry.runs.map((run) => ({
                        text: run.text,
                        ...mergeTextStyle(cellStyle.textStyle, run)
                    })))
                    : createStyledRuns(sharedEntry.text, cellStyle.textStyle)
            };
        }
        if (type === "inlineStr") {
            const inlineText = Array.from(cellElement.getElementsByTagName("t")).map((node) => deps.getTextContent(node)).join("");
            return {
                valueType: type,
                rawValue: inlineText,
                outputValue: inlineText,
                formulaText: "",
                resolutionStatus: null,
                resolutionSource: null,
                cachedValueState: null,
                richTextRuns: parseInlineRichTextRuns(cellElement, cellStyle.textStyle, deps) || createStyledRuns(inlineText, cellStyle.textStyle)
            };
        }
        if (type === "b") {
            return {
                valueType: type,
                rawValue: valueText,
                outputValue: valueText === "1" ? "TRUE" : "FALSE",
                formulaText: "",
                resolutionStatus: null,
                resolutionSource: null,
                cachedValueState: null,
                richTextRuns: createStyledRuns(valueText === "1" ? "TRUE" : "FALSE", cellStyle.textStyle)
            };
        }
        if (type === "str" || type === "e") {
            return {
                valueType: type,
                rawValue: valueText,
                outputValue: valueText,
                formulaText: "",
                resolutionStatus: null,
                resolutionSource: null,
                cachedValueState: null,
                richTextRuns: createStyledRuns(valueText, cellStyle.textStyle)
            };
        }
        if (valueText) {
            const formattedValue = deps.formatCellDisplayValue(valueText, cellStyle);
            if (formattedValue !== null) {
                return {
                    valueType: type,
                    rawValue: valueText,
                    outputValue: formattedValue,
                    formulaText: "",
                    resolutionStatus: null,
                    resolutionSource: null,
                    cachedValueState: null,
                    richTextRuns: createStyledRuns(formattedValue, cellStyle.textStyle)
                };
            }
        }
        return {
            valueType: type,
            rawValue: valueText,
            outputValue: valueText,
            formulaText: "",
            resolutionStatus: null,
            resolutionSource: null,
            cachedValueState: null,
            richTextRuns: createStyledRuns(valueText, cellStyle.textStyle)
        };
    }
    function shiftReferenceAddress(addressText, rowOffset, colOffset, deps) {
        const match = String(addressText || "").match(/^(\$?)([A-Z]+)(\$?)(\d+)$/i);
        if (!match)
            return addressText;
        const colAbsolute = match[1] === "$";
        const rowAbsolute = match[3] === "$";
        const baseCol = deps.lettersToCol(match[2]);
        const baseRow = Number(match[4]);
        const shiftedCol = colAbsolute ? baseCol : baseCol + colOffset;
        const shiftedRow = rowAbsolute ? baseRow : baseRow + rowOffset;
        const safeCol = Math.max(1, shiftedCol);
        const safeRow = Math.max(1, shiftedRow);
        return `${colAbsolute ? "$" : ""}${deps.colToLetters(safeCol)}${rowAbsolute ? "$" : ""}${safeRow}`;
    }
    function translateSharedFormula(baseFormulaText, baseAddress, targetAddress, deps) {
        const basePos = deps.parseCellAddress(baseAddress);
        const targetPos = deps.parseCellAddress(targetAddress);
        if (!basePos.row || !basePos.col || !targetPos.row || !targetPos.col) {
            return baseFormulaText;
        }
        const rowOffset = targetPos.row - basePos.row;
        const colOffset = targetPos.col - basePos.col;
        const normalized = String(baseFormulaText || "").replace(/^=/, "");
        const translated = normalized.replace(/(?:'((?:[^']|'')+)'|([A-Za-z0-9_ ]+))!(\$?[A-Z]+\$?\d+)|(\$?[A-Z]+\$?\d+)/g, (full, quotedSheet, plainSheet, qualifiedAddress, localAddress) => {
            const address = qualifiedAddress || localAddress;
            if (!address)
                return full;
            const shifted = shiftReferenceAddress(address, rowOffset, colOffset, deps);
            if (qualifiedAddress) {
                const sheetPrefix = quotedSheet ? `'${quotedSheet}'` : plainSheet;
                return `${sheetPrefix}!${shifted}`;
            }
            return shifted;
        });
        return translated.startsWith("=") ? translated : `=${translated}`;
    }
    function parseWorksheet(files, sheetName, sheetPath, sheetIndex, sharedStrings, cellStyles, deps) {
        const bytes = files.get(sheetPath);
        if (!bytes) {
            throw new Error(`Sheet XML not found: ${sheetPath}`);
        }
        const doc = deps.xmlToDocument(deps.decodeXmlText(bytes));
        const sharedFormulaMap = new Map();
        const hyperlinks = parseWorksheetHyperlinks(files, doc, sheetPath, deps);
        const cells = Array.from(doc.getElementsByTagName("c")).map((cellElement) => {
            const address = cellElement.getAttribute("r") || "";
            const position = deps.parseCellAddress(address);
            const styleIndex = Number(cellElement.getAttribute("s") || 0);
            const cellStyle = cellStyles[styleIndex] || {
                borders: deps.EMPTY_BORDERS,
                numFmtId: 0,
                formatCode: "General",
                textStyle: {
                    bold: false,
                    italic: false,
                    strike: false,
                    underline: false
                }
            };
            let formulaOverride = "";
            const formulaElement = cellElement.getElementsByTagName("f")[0] || null;
            const formulaType = formulaElement?.getAttribute("t") || "";
            const spillRef = formulaElement?.getAttribute("ref") || "";
            const sharedIndex = formulaElement?.getAttribute("si") || "";
            const formulaText = deps.getTextContent(formulaElement);
            if (formulaType === "shared" && sharedIndex) {
                if (formulaText) {
                    const normalizedFormula = formulaText.startsWith("=") ? formulaText : `=${formulaText}`;
                    sharedFormulaMap.set(sharedIndex, { address, formulaText: normalizedFormula });
                    formulaOverride = normalizedFormula;
                }
                else {
                    const sharedBase = sharedFormulaMap.get(sharedIndex);
                    if (sharedBase) {
                        formulaOverride = translateSharedFormula(sharedBase.formulaText, sharedBase.address, address, deps);
                    }
                }
            }
            const output = extractCellOutputValue(cellElement, sharedStrings, cellStyle, deps, formulaOverride);
            return {
                address,
                row: position.row,
                col: position.col,
                valueType: output.valueType,
                rawValue: output.rawValue,
                outputValue: output.outputValue,
                formulaText: output.formulaText,
                resolutionStatus: output.resolutionStatus,
                resolutionSource: output.resolutionSource,
                cachedValueState: output.cachedValueState,
                styleIndex,
                borders: cellStyle.borders,
                numFmtId: cellStyle.numFmtId,
                formatCode: cellStyle.formatCode,
                textStyle: cellStyle.textStyle,
                richTextRuns: output.richTextRuns,
                formulaType,
                spillRef,
                hyperlink: hyperlinks.get(address) || null
            };
        });
        const merges = Array.from(doc.getElementsByTagName("mergeCell")).map((mergeElement) => deps.parseRangeRef(mergeElement.getAttribute("ref") || ""));
        const tables = deps.parseWorksheetTables(files, doc, sheetName, sheetPath);
        const assetDeps = deps.buildAssetDeps();
        const images = deps.parseDrawingImages(files, sheetName, sheetPath, assetDeps);
        const charts = deps.parseDrawingCharts(files, sheetName, sheetPath, assetDeps);
        const shapes = deps.parseDrawingShapes(files, sheetName, sheetPath, assetDeps);
        let maxRow = 0;
        let maxCol = 0;
        for (const cell of cells) {
            if (cell.row > maxRow)
                maxRow = cell.row;
            if (cell.col > maxCol)
                maxCol = cell.col;
        }
        for (const merge of merges) {
            if (merge.endRow > maxRow)
                maxRow = merge.endRow;
            if (merge.endCol > maxCol)
                maxCol = merge.endCol;
        }
        return {
            name: sheetName,
            index: sheetIndex,
            path: sheetPath,
            cells,
            merges,
            tables,
            images,
            charts,
            shapes,
            maxRow,
            maxCol
        };
    }
    const worksheetParserApi = {
        extractCellOutputValue,
        expandRangeAddresses,
        parseWorksheetHyperlinks,
        shiftReferenceAddress,
        translateSharedFormula,
        parseWorksheet
    };
    moduleRegistry.registerModule("worksheetParser", worksheetParserApi);
})();

// ── workbook-loader ─────────────────────────────────────────────
/*
 * Copyright 2026 Toshiki Iga
 * SPDX-License-Identifier: Apache-2.0
 */
(() => {
    const moduleRegistry = getXlsx2mdModuleRegistry();
    function parseDefinedNames(workbookDoc, sheetNames, getTextContent) {
        const result = [];
        const definedNameElements = Array.from(workbookDoc.getElementsByTagName("definedName"));
        for (const element of definedNameElements) {
            const name = element.getAttribute("name") || "";
            if (!name || name.startsWith("_xlnm."))
                continue;
            const formulaText = getTextContent(element).trim();
            if (!formulaText)
                continue;
            const localSheetIdText = element.getAttribute("localSheetId");
            const localSheetId = localSheetIdText == null || localSheetIdText === "" ? Number.NaN : Number(localSheetIdText);
            result.push({
                name,
                formulaText: formulaText.startsWith("=") ? formulaText : `=${formulaText}`,
                localSheetName: Number.isNaN(localSheetId) ? null : (sheetNames[localSheetId] || null)
            });
        }
        return result;
    }
    async function parseWorkbook(arrayBuffer, workbookName, deps) {
        const files = await deps.unzipEntries(arrayBuffer);
        const workbookBytes = files.get("xl/workbook.xml");
        if (!workbookBytes) {
            throw new Error("xl/workbook.xml was not found.");
        }
        const sharedStrings = deps.parseSharedStrings(files);
        const cellStyles = deps.parseCellStyles(files);
        const rels = deps.parseRelationships(files, "xl/_rels/workbook.xml.rels", "xl/workbook.xml");
        const workbookDoc = deps.xmlToDocument(deps.decodeXmlText(workbookBytes));
        const sheetNodes = Array.from(workbookDoc.getElementsByTagName("sheet"));
        const sheetNames = sheetNodes.map((sheetNode, index) => sheetNode.getAttribute("name") || `Sheet${index + 1}`);
        const definedNames = parseDefinedNames(workbookDoc, sheetNames, deps.getTextContent);
        const sheets = sheetNodes.map((sheetNode, index) => {
            const name = sheetNode.getAttribute("name") || `Sheet${index + 1}`;
            const relId = sheetNode.getAttribute("r:id") || "";
            const sheetPath = rels.get(relId) || "";
            return deps.parseWorksheet(files, name, sheetPath, index + 1, sharedStrings, cellStyles);
        });
        const workbook = {
            name: workbookName,
            sheets,
            sharedStrings,
            definedNames
        };
        deps.postProcessWorkbook?.(workbook);
        return workbook;
    }
    const workbookLoaderApi = {
        parseDefinedNames,
        parseWorkbook
    };
    moduleRegistry.registerModule("workbookLoader", workbookLoaderApi);
})();

// ── formula-reference-utils ─────────────────────────────────────
/*
 * Copyright 2026 Toshiki Iga
 * SPDX-License-Identifier: Apache-2.0
 */
(() => {
    const moduleRegistry = getXlsx2mdModuleRegistry();
    function createFormulaReferenceUtilsApi(deps) {
        function parseSimpleFormulaReference(formulaText, currentSheetName) {
            const normalizedFormula = String(formulaText || "").trim().replace(/^=/, "");
            const quotedSheetMatch = normalizedFormula.match(/^'((?:[^']|'')+)'!(\$?[A-Z]+\$?\d+)$/i);
            if (quotedSheetMatch) {
                return {
                    sheetName: quotedSheetMatch[1].replace(/''/g, "'"),
                    address: deps.normalizeFormulaAddress(quotedSheetMatch[2])
                };
            }
            const sheetMatch = normalizedFormula.match(/^([^'=][^!]*)!(\$?[A-Z]+\$?\d+)$/i);
            if (sheetMatch) {
                return {
                    sheetName: sheetMatch[1],
                    address: deps.normalizeFormulaAddress(sheetMatch[2])
                };
            }
            const localMatch = normalizedFormula.match(/^(\$?[A-Z]+\$?\d+)$/i);
            if (localMatch) {
                return {
                    sheetName: currentSheetName,
                    address: deps.normalizeFormulaAddress(localMatch[1])
                };
            }
            return null;
        }
        function normalizeFormulaSheetName(rawName) {
            return String(rawName || "").replace(/^'/, "").replace(/'$/, "").replace(/''/g, "'");
        }
        function normalizeDefinedNameKey(name) {
            return String(name || "").trim().toUpperCase();
        }
        function parseSheetScopedDefinedNameReference(expression, currentSheetName) {
            const normalizedExpression = String(expression || "").trim();
            const quotedSheetMatch = normalizedExpression.match(/^'((?:[^']|'')+)'!([A-Za-z_][A-Za-z0-9_.]*)$/);
            if (quotedSheetMatch) {
                return {
                    sheetName: normalizeFormulaSheetName(quotedSheetMatch[1].replace(/''/g, "'")),
                    name: quotedSheetMatch[2]
                };
            }
            const sheetMatch = normalizedExpression.match(/^([^'=][^!]*)!([A-Za-z_][A-Za-z0-9_.]*)$/);
            if (!sheetMatch) {
                return null;
            }
            if (/^\$?[A-Z]+\$?\d+$/i.test(sheetMatch[2])) {
                return null;
            }
            return {
                sheetName: normalizeFormulaSheetName(sheetMatch[1] || currentSheetName),
                name: sheetMatch[2]
            };
        }
        return {
            parseSimpleFormulaReference,
            parseSheetScopedDefinedNameReference,
            normalizeFormulaSheetName,
            normalizeDefinedNameKey
        };
    }
    const formulaReferenceUtilsApi = {
        createFormulaReferenceUtilsApi
    };
    moduleRegistry.registerModule("formulaReferenceUtils", formulaReferenceUtilsApi);
})();

// ── formula-engine ──────────────────────────────────────────────
/*
 * Copyright 2026 Toshiki Iga
 * SPDX-License-Identifier: Apache-2.0
 */
(() => {
    const moduleRegistry = getXlsx2mdModuleRegistry();
    function createFormulaEngineApi(deps) {
        function tryResolveFormulaExpressionDetailed(formulaText, currentSheetName, resolveCellValue, resolveRangeValues, resolveRangeEntries, currentAddress) {
            const normalized = String(formulaText || "").trim().replace(/^=/, "");
            if (!normalized)
                return null;
            const directDefinedNameValue = deps.getDefinedNameScalarValue()?.(currentSheetName, normalized) || null;
            if (directDefinedNameValue != null) {
                return {
                    value: directDefinedNameValue,
                    source: "legacy_resolver"
                };
            }
            const astResolved = deps.tryResolveFormulaExpressionWithAst(normalized, currentSheetName, resolveCellValue, resolveRangeEntries, currentAddress);
            if (astResolved != null) {
                return {
                    value: astResolved,
                    source: "ast_evaluator"
                };
            }
            const legacyResolved = deps.tryResolveFormulaExpressionLegacy(normalized, currentSheetName, resolveCellValue, resolveRangeValues, resolveRangeEntries);
            if (legacyResolved == null) {
                return null;
            }
            return {
                value: legacyResolved,
                source: "legacy_resolver"
            };
        }
        function tryResolveFormulaExpression(formulaText, currentSheetName, resolveCellValue, resolveRangeValues, resolveRangeEntries, currentAddress) {
            return tryResolveFormulaExpressionDetailed(formulaText, currentSheetName, resolveCellValue, resolveRangeValues, resolveRangeEntries, currentAddress)?.value ?? null;
        }
        return {
            tryResolveFormulaExpressionDetailed,
            tryResolveFormulaExpression
        };
    }
    const formulaEngineApi = {
        createFormulaEngineApi
    };
    moduleRegistry.registerModule("formulaEngine", formulaEngineApi);
})();

// ── formula-legacy ──────────────────────────────────────────────
/*
 * Copyright 2026 Toshiki Iga
 * SPDX-License-Identifier: Apache-2.0
 */
(() => {
    const moduleRegistry = getXlsx2mdModuleRegistry();
    function createFormulaLegacyApi(deps) {
        function tryResolveFormulaExpressionLegacy(normalized, currentSheetName, resolveCellValue, resolveRangeValues, resolveRangeEntries) {
            const ifResult = tryResolveIfFunction(normalized, currentSheetName, resolveCellValue, resolveRangeValues, resolveRangeEntries);
            if (ifResult != null)
                return ifResult;
            const ifErrorResult = tryResolveIfErrorFunction(normalized, currentSheetName, resolveCellValue, resolveRangeValues, resolveRangeEntries);
            if (ifErrorResult != null)
                return ifErrorResult;
            const logicalResult = tryResolveLogicalFunction(normalized, currentSheetName, resolveCellValue, resolveRangeValues, resolveRangeEntries);
            if (logicalResult != null)
                return logicalResult;
            const concatResult = tryResolveConcatenationExpression(normalized, currentSheetName, resolveCellValue, resolveRangeValues, resolveRangeEntries);
            if (concatResult != null)
                return concatResult;
            const numericFunctionResult = tryResolveNumericFunction(normalized, currentSheetName, resolveCellValue, resolveRangeValues, resolveRangeEntries);
            if (numericFunctionResult != null)
                return numericFunctionResult;
            const datePartFunctionResult = tryResolveDatePartFunction(normalized, currentSheetName, resolveCellValue, resolveRangeValues, resolveRangeEntries);
            if (datePartFunctionResult != null)
                return datePartFunctionResult;
            const predicateFunctionResult = tryResolvePredicateFunction(normalized, currentSheetName, resolveCellValue, resolveRangeValues, resolveRangeEntries);
            if (predicateFunctionResult != null)
                return predicateFunctionResult;
            const chooseFunctionResult = tryResolveChooseFunction(normalized, currentSheetName, resolveCellValue, resolveRangeValues, resolveRangeEntries);
            if (chooseFunctionResult != null)
                return chooseFunctionResult;
            const textFunctionResult = tryResolveTextFunction(normalized, currentSheetName, resolveCellValue, resolveRangeValues, resolveRangeEntries);
            if (textFunctionResult != null)
                return textFunctionResult;
            const lookupFunctionResult = tryResolveLookupFunction(normalized, currentSheetName, resolveCellValue);
            if (lookupFunctionResult != null)
                return lookupFunctionResult;
            const stringFunctionResult = tryResolveStringFunction(normalized, currentSheetName, resolveCellValue, resolveRangeValues, resolveRangeEntries);
            if (stringFunctionResult != null)
                return stringFunctionResult;
            const conditionalAggregateResult = tryResolveConditionalAggregateFunction(normalized, currentSheetName, resolveCellValue);
            if (conditionalAggregateResult != null)
                return conditionalAggregateResult;
            const aggregateResult = tryResolveAggregateFunction(normalized, currentSheetName, resolveRangeValues, resolveRangeEntries);
            if (aggregateResult != null)
                return aggregateResult;
            const comparisonResult = tryResolveComparisonExpression(normalized, currentSheetName, resolveCellValue, resolveRangeValues, resolveRangeEntries);
            if (comparisonResult != null)
                return comparisonResult;
            if (/:/.test(normalized)) {
                return null;
            }
            const replacedRefs = normalized.replace(/(?:'((?:[^']|'')+)'|([A-Za-z0-9_ ]+))!(\$?[A-Z]+\$?\d+)|(\$?[A-Z]+\$?\d+)/g, (_full, quotedSheet, plainSheet, qualifiedAddress, localAddress) => {
                const sheetName = qualifiedAddress
                    ? deps.normalizeFormulaSheetName(quotedSheet || plainSheet || currentSheetName)
                    : currentSheetName;
                const address = deps.normalizeFormulaAddress(qualifiedAddress || localAddress || "");
                const rawValue = resolveCellValue(sheetName, address);
                const numericValue = Number(rawValue);
                if (rawValue === "" || Number.isNaN(numericValue)) {
                    throw new Error("__FORMULA_UNRESOLVED__");
                }
                return String(numericValue);
            });
            const replaced = replaceNumericDefinedNames(replacedRefs, currentSheetName);
            const replacedFunctions = replaceEmbeddedNumericFunctions(replaced, currentSheetName, resolveCellValue, resolveRangeValues, resolveRangeEntries);
            if (!/^[0-9+\-*/().\s]+$/.test(replacedFunctions)) {
                return null;
            }
            try {
                const value = evaluateArithmeticExpression(replacedFunctions);
                if (!Number.isFinite(value)) {
                    return null;
                }
                const rounded = Math.abs(value - Math.round(value)) < 1e-10 ? Math.round(value) : value;
                return String(rounded);
            }
            catch (error) {
                if (error instanceof Error && error.message === "__FORMULA_UNRESOLVED__") {
                    return null;
                }
                return null;
            }
        }
        function tryResolveIfFunction(normalizedFormula, currentSheetName, resolveCellValue, resolveRangeValues, resolveRangeEntries) {
            const call = parseWholeFunctionCall(normalizedFormula, ["IF"]);
            if (!call)
                return null;
            const args = splitFormulaArguments(call.argsText.trim());
            if (args.length !== 3)
                return null;
            const condition = evaluateFormulaCondition(args[0], currentSheetName, resolveCellValue, resolveRangeValues, resolveRangeEntries);
            if (condition == null)
                return null;
            return resolveScalarFormulaValue(condition ? args[1] : args[2], currentSheetName, resolveCellValue, resolveRangeValues, resolveRangeEntries);
        }
        function tryResolveIfErrorFunction(normalizedFormula, currentSheetName, resolveCellValue, resolveRangeValues, resolveRangeEntries) {
            const call = parseWholeFunctionCall(normalizedFormula, ["IFERROR"]);
            if (!call)
                return null;
            const args = splitFormulaArguments(call.argsText.trim());
            if (args.length !== 2)
                return null;
            const primary = resolveScalarFormulaValue(args[0], currentSheetName, resolveCellValue, resolveRangeValues, resolveRangeEntries);
            if (primary != null && !/^#(?:[A-Z]+\/[A-Z]+|[A-Z]+[!?]?)/i.test(primary.trim())) {
                return primary;
            }
            return resolveScalarFormulaValue(args[1], currentSheetName, resolveCellValue, resolveRangeValues, resolveRangeEntries);
        }
        function tryResolveLogicalFunction(normalizedFormula, currentSheetName, resolveCellValue, resolveRangeValues, resolveRangeEntries) {
            const call = parseWholeFunctionCall(normalizedFormula, ["AND", "OR", "NOT"]);
            if (!call)
                return null;
            const functionName = call.name;
            const args = splitFormulaArguments(call.argsText.trim());
            if (functionName === "NOT") {
                if (args.length !== 1)
                    return null;
                const value = evaluateFormulaCondition(args[0], currentSheetName, resolveCellValue, resolveRangeValues, resolveRangeEntries);
                if (value == null)
                    return null;
                return value ? "FALSE" : "TRUE";
            }
            if (args.length === 0)
                return null;
            const evaluations = args.map((arg) => evaluateFormulaCondition(arg, currentSheetName, resolveCellValue, resolveRangeValues, resolveRangeEntries));
            if (functionName === "AND") {
                if (evaluations.some((value) => value === false))
                    return "FALSE";
                if (evaluations.some((value) => value == null))
                    return null;
                return evaluations.every(Boolean) ? "TRUE" : "FALSE";
            }
            if (functionName === "OR") {
                if (evaluations.some((value) => value === true))
                    return "TRUE";
                if (evaluations.some((value) => value == null))
                    return null;
                return evaluations.some(Boolean) ? "TRUE" : "FALSE";
            }
            return null;
        }
        function tryResolveTextFunction(normalizedFormula, currentSheetName, resolveCellValue, resolveRangeValues, resolveRangeEntries) {
            const call = parseWholeFunctionCall(normalizedFormula, ["TEXT"]);
            if (!call)
                return null;
            const args = splitFormulaArguments(call.argsText.trim());
            if (args.length !== 2)
                return null;
            const value = resolveScalarFormulaValue(args[0], currentSheetName, resolveCellValue, resolveRangeValues, resolveRangeEntries);
            const formatText = resolveScalarFormulaValue(args[1], currentSheetName, resolveCellValue, resolveRangeValues, resolveRangeEntries);
            if (value == null || formatText == null)
                return null;
            return deps.cellFormat.formatTextFunctionValue(value, formatText);
        }
        function tryResolveLookupFunction(normalizedFormula, currentSheetName, resolveCellValue) {
            const xlookupCall = parseWholeFunctionCall(normalizedFormula, ["XLOOKUP"]);
            if (xlookupCall) {
                const args = splitFormulaArguments(xlookupCall.argsText.trim());
                if (args.length < 3 || args.length > 6)
                    return null;
                const lookupValue = resolveScalarFormulaValue(args[0], currentSheetName, resolveCellValue);
                const lookupRange = parseQualifiedRangeReference(args[1], currentSheetName);
                const returnRange = parseQualifiedRangeReference(args[2], currentSheetName);
                if (lookupValue == null || !lookupRange || !returnRange)
                    return null;
                const lookupCells = collectRangeCells(lookupRange, resolveCellValue);
                const returnCells = collectRangeCells(returnRange, resolveCellValue);
                if (lookupCells.length === 0 || lookupCells.length !== returnCells.length)
                    return null;
                if (args.length >= 5) {
                    const matchMode = resolveScalarFormulaValue(args[4], currentSheetName, resolveCellValue);
                    if (matchMode == null || !["0", ""].includes(matchMode.trim()))
                        return null;
                }
                if (args.length >= 6) {
                    const searchMode = resolveScalarFormulaValue(args[5], currentSheetName, resolveCellValue);
                    if (searchMode == null || !["1", ""].includes(searchMode.trim()))
                        return null;
                }
                for (let index = 0; index < lookupCells.length; index += 1) {
                    const value = lookupCells[index];
                    if (value === lookupValue || (!Number.isNaN(Number(value)) && !Number.isNaN(Number(lookupValue)) && Number(value) === Number(lookupValue))) {
                        return returnCells[index] ?? "";
                    }
                }
                if (args.length >= 4) {
                    return resolveScalarFormulaValue(args[3], currentSheetName, resolveCellValue);
                }
                return null;
            }
            const matchCall = parseWholeFunctionCall(normalizedFormula, ["MATCH"]);
            if (matchCall) {
                const args = splitFormulaArguments(matchCall.argsText.trim());
                if (args.length < 2 || args.length > 3)
                    return null;
                const lookupValue = resolveScalarFormulaValue(args[0], currentSheetName, resolveCellValue);
                const rangeRef = parseQualifiedRangeReference(args[1], currentSheetName);
                if (lookupValue == null || !rangeRef)
                    return null;
                if (args.length === 3) {
                    const matchType = resolveScalarFormulaValue(args[2], currentSheetName, resolveCellValue);
                    if (matchType == null || !["0", ""].includes(matchType.trim()))
                        return null;
                }
                const cells = collectRangeCells(rangeRef, resolveCellValue);
                if (cells.length === 0)
                    return null;
                for (let index = 0; index < cells.length; index += 1) {
                    const value = cells[index];
                    if (value === lookupValue || (!Number.isNaN(Number(value)) && !Number.isNaN(Number(lookupValue)) && Number(value) === Number(lookupValue))) {
                        return String(index + 1);
                    }
                }
                return null;
            }
            const indexCall = parseWholeFunctionCall(normalizedFormula, ["INDEX"]);
            if (indexCall) {
                const args = splitFormulaArguments(indexCall.argsText.trim());
                if (args.length < 2 || args.length > 3)
                    return null;
                const rangeRef = parseQualifiedRangeReference(args[0], currentSheetName);
                const rowIndex = Number(resolveScalarFormulaValue(args[1], currentSheetName, resolveCellValue));
                const colIndex = args.length === 3
                    ? Number(resolveScalarFormulaValue(args[2], currentSheetName, resolveCellValue))
                    : 1;
                if (!rangeRef || Number.isNaN(rowIndex) || Number.isNaN(colIndex) || rowIndex < 1 || colIndex < 1)
                    return null;
                const start = deps.parseCellAddress(rangeRef.start);
                const end = deps.parseCellAddress(rangeRef.end);
                if (!start.row || !start.col || !end.row || !end.col)
                    return null;
                const startRow = Math.min(start.row, end.row);
                const endRow = Math.max(start.row, end.row);
                const startCol = Math.min(start.col, end.col);
                const endCol = Math.max(start.col, end.col);
                const targetRow = startRow + Math.trunc(rowIndex) - 1;
                const targetCol = startCol + Math.trunc(colIndex) - 1;
                if (targetRow > endRow || targetCol > endCol)
                    return null;
                return resolveCellValue(rangeRef.sheetName, `${deps.colToLetters(targetCol)}${targetRow}`);
            }
            const hlookupCall = parseWholeFunctionCall(normalizedFormula, ["HLOOKUP"]);
            if (hlookupCall) {
                const args = splitFormulaArguments(hlookupCall.argsText.trim());
                if (args.length < 3 || args.length > 4)
                    return null;
                const lookupValue = resolveScalarFormulaValue(args[0], currentSheetName, resolveCellValue);
                const rangeRef = parseQualifiedRangeReference(args[1], currentSheetName);
                const rowIndex = Number(resolveScalarFormulaValue(args[2], currentSheetName, resolveCellValue));
                if (lookupValue == null || !rangeRef || Number.isNaN(rowIndex) || rowIndex < 1)
                    return null;
                if (args.length === 4) {
                    const rangeLookup = resolveScalarFormulaValue(args[3], currentSheetName, resolveCellValue);
                    if (rangeLookup == null)
                        return null;
                    const normalizedLookup = rangeLookup.trim().toUpperCase();
                    if (!(normalizedLookup === "FALSE" || normalizedLookup === "0" || normalizedLookup === ""))
                        return null;
                }
                const start = deps.parseCellAddress(rangeRef.start);
                const end = deps.parseCellAddress(rangeRef.end);
                if (!start.row || !start.col || !end.row || !end.col)
                    return null;
                const startRow = Math.min(start.row, end.row);
                const endRow = Math.max(start.row, end.row);
                const startCol = Math.min(start.col, end.col);
                const endCol = Math.max(start.col, end.col);
                const targetRow = startRow + Math.trunc(rowIndex) - 1;
                if (targetRow > endRow)
                    return null;
                for (let col = startCol; col <= endCol; col += 1) {
                    const keyValue = resolveCellValue(rangeRef.sheetName, `${deps.colToLetters(col)}${startRow}`);
                    if (keyValue === "")
                        continue;
                    if (keyValue === lookupValue || (!Number.isNaN(Number(keyValue)) && !Number.isNaN(Number(lookupValue)) && Number(keyValue) === Number(lookupValue))) {
                        return resolveCellValue(rangeRef.sheetName, `${deps.colToLetters(col)}${targetRow}`);
                    }
                }
                return null;
            }
            const call = parseWholeFunctionCall(normalizedFormula, ["VLOOKUP"]);
            if (!call)
                return null;
            const args = splitFormulaArguments(call.argsText.trim());
            if (args.length < 3 || args.length > 4)
                return null;
            const lookupValue = resolveScalarFormulaValue(args[0], currentSheetName, resolveCellValue);
            const rangeRef = parseQualifiedRangeReference(args[1], currentSheetName);
            const columnIndex = Number(resolveScalarFormulaValue(args[2], currentSheetName, resolveCellValue));
            if (lookupValue == null || !rangeRef || Number.isNaN(columnIndex) || columnIndex < 1)
                return null;
            if (args.length === 4) {
                const rangeLookup = resolveScalarFormulaValue(args[3], currentSheetName, resolveCellValue);
                if (rangeLookup == null)
                    return null;
                const normalizedLookup = rangeLookup.trim().toUpperCase();
                if (!(normalizedLookup === "FALSE" || normalizedLookup === "0" || normalizedLookup === ""))
                    return null;
            }
            const start = deps.parseCellAddress(rangeRef.start);
            const end = deps.parseCellAddress(rangeRef.end);
            if (!start.row || !start.col || !end.row || !end.col)
                return null;
            const startRow = Math.min(start.row, end.row);
            const endRow = Math.max(start.row, end.row);
            const startCol = Math.min(start.col, end.col);
            const endCol = Math.max(start.col, end.col);
            const targetCol = startCol + Math.trunc(columnIndex) - 1;
            if (targetCol > endCol)
                return null;
            for (let row = startRow; row <= endRow; row += 1) {
                const keyValue = resolveCellValue(rangeRef.sheetName, `${deps.colToLetters(startCol)}${row}`);
                if (keyValue === "")
                    continue;
                if (keyValue === lookupValue || (!Number.isNaN(Number(keyValue)) && !Number.isNaN(Number(lookupValue)) && Number(keyValue) === Number(lookupValue))) {
                    return resolveCellValue(rangeRef.sheetName, `${deps.colToLetters(targetCol)}${row}`);
                }
            }
            return null;
        }
        function tryResolveDatePartFunction(normalizedFormula, currentSheetName, resolveCellValue, resolveRangeValues, resolveRangeEntries) {
            const call = parseWholeFunctionCall(normalizedFormula, ["YEAR", "MONTH", "DAY", "WEEKDAY"]);
            if (!call)
                return null;
            const fnName = call.name;
            const args = splitFormulaArguments(call.argsText.trim());
            if ((fnName === "WEEKDAY" && (args.length < 1 || args.length > 2)) || (fnName !== "WEEKDAY" && args.length !== 1)) {
                return null;
            }
            const value = resolveScalarFormulaValue(args[0], currentSheetName, resolveCellValue, resolveRangeValues, resolveRangeEntries);
            if (value == null)
                return null;
            const parts = deps.cellFormat.parseDateLikeParts(value);
            if (!parts)
                return null;
            if (fnName === "YEAR")
                return String(Number(parts.yyyy));
            if (fnName === "MONTH")
                return String(Number(parts.mm));
            if (fnName === "DAY")
                return String(Number(parts.dd));
            const returnType = args.length === 2
                ? resolveNumericFormulaArgument(args[1], currentSheetName, resolveCellValue, resolveRangeValues, resolveRangeEntries)
                : 1;
            if (returnType == null)
                return null;
            const weekday = new Date(Date.UTC(Number(parts.yyyy), Number(parts.mm) - 1, Number(parts.dd))).getUTCDay();
            return Math.trunc(returnType) === 2
                ? String(weekday === 0 ? 7 : weekday)
                : String(weekday + 1);
        }
        function tryResolvePredicateFunction(normalizedFormula, currentSheetName, resolveCellValue, resolveRangeValues, resolveRangeEntries) {
            const call = parseWholeFunctionCall(normalizedFormula, ["ISBLANK", "ISNUMBER", "ISTEXT", "ISERROR", "ISNA"]);
            if (!call)
                return null;
            const fnName = call.name;
            const args = splitFormulaArguments(call.argsText.trim());
            if (args.length !== 1)
                return null;
            if (fnName === "ISBLANK") {
                const simpleRef = deps.parseSimpleFormulaReference(`=${args[0].trim()}`, currentSheetName);
                if (simpleRef) {
                    const value = resolveCellValue(simpleRef.sheetName, simpleRef.address);
                    return value.trim() === "" ? "TRUE" : "FALSE";
                }
                const value = resolveScalarFormulaValue(args[0], currentSheetName, resolveCellValue, resolveRangeValues, resolveRangeEntries);
                return value == null || value.trim() === "" ? "TRUE" : "FALSE";
            }
            const value = resolveScalarFormulaValue(args[0], currentSheetName, resolveCellValue, resolveRangeValues, resolveRangeEntries);
            if (fnName === "ISERROR") {
                if (value == null)
                    return "TRUE";
                return /^#(?:[A-Z]+\/[A-Z]+|[A-Z]+[!?]?)/i.test(value.trim()) ? "TRUE" : "FALSE";
            }
            if (fnName === "ISNA") {
                if (/^\s*VLOOKUP\(/i.test(args[0]))
                    return value == null ? "TRUE" : "FALSE";
                if (value == null)
                    return "FALSE";
                return /^#N\/A$/i.test(value.trim()) ? "TRUE" : "FALSE";
            }
            if (value == null)
                return "FALSE";
            if (fnName === "ISNUMBER") {
                if (value.trim() === "")
                    return "FALSE";
                return !Number.isNaN(Number(value)) ? "TRUE" : "FALSE";
            }
            if (fnName === "ISTEXT") {
                const normalized = value.trim().toUpperCase();
                if (normalized === "" || normalized === "TRUE" || normalized === "FALSE")
                    return "FALSE";
                return Number.isNaN(Number(value)) ? "TRUE" : "FALSE";
            }
            return null;
        }
        function tryResolveChooseFunction(normalizedFormula, currentSheetName, resolveCellValue, resolveRangeValues, resolveRangeEntries) {
            const call = parseWholeFunctionCall(normalizedFormula, ["CHOOSE"]);
            if (!call)
                return null;
            const args = splitFormulaArguments(call.argsText.trim());
            if (args.length < 2)
                return null;
            const indexValue = resolveNumericFormulaArgument(args[0], currentSheetName, resolveCellValue, resolveRangeValues, resolveRangeEntries);
            if (indexValue == null)
                return null;
            const index = Math.trunc(indexValue);
            if (index < 1 || index >= args.length)
                return null;
            return resolveScalarFormulaValue(args[index], currentSheetName, resolveCellValue, resolveRangeValues, resolveRangeEntries);
        }
        function tryResolveConcatenationExpression(normalizedFormula, currentSheetName, resolveCellValue, resolveRangeValues, resolveRangeEntries) {
            const segments = splitConcatenationExpression(normalizedFormula);
            if (!segments || segments.length < 2)
                return null;
            const values = [];
            for (const segment of segments) {
                const resolved = resolveScalarFormulaValue(segment, currentSheetName, resolveCellValue, resolveRangeValues, resolveRangeEntries);
                if (resolved == null)
                    return null;
                values.push(resolved);
            }
            return values.join("");
        }
        function evaluateFormulaCondition(expression, currentSheetName, resolveCellValue, resolveRangeValues, resolveRangeEntries) {
            const logical = tryResolveLogicalFunction(expression.trim(), currentSheetName, resolveCellValue, resolveRangeValues, resolveRangeEntries);
            if (logical != null)
                return logical === "TRUE";
            const comparison = tryResolveComparisonExpression(expression, currentSheetName, resolveCellValue, resolveRangeValues, resolveRangeEntries);
            if (comparison != null)
                return comparison === "TRUE";
            const scalar = resolveScalarFormulaValue(expression, currentSheetName, resolveCellValue, resolveRangeValues, resolveRangeEntries);
            if (scalar == null)
                return null;
            const normalized = scalar.trim().toUpperCase();
            if (normalized === "TRUE")
                return true;
            if (normalized === "FALSE")
                return false;
            const numeric = Number(scalar);
            return Number.isNaN(numeric) ? scalar.trim() !== "" : numeric !== 0;
        }
        function tryResolveComparisonExpression(normalizedFormula, currentSheetName, resolveCellValue, resolveRangeValues, resolveRangeEntries) {
            const comparison = splitComparisonExpression(normalizedFormula);
            if (!comparison)
                return null;
            const left = resolveScalarFormulaValue(comparison.left, currentSheetName, resolveCellValue, resolveRangeValues, resolveRangeEntries);
            const right = resolveScalarFormulaValue(comparison.right, currentSheetName, resolveCellValue, resolveRangeValues, resolveRangeEntries);
            if (left == null || right == null)
                return null;
            const leftNum = Number(left);
            const rightNum = Number(right);
            const numericComparable = !Number.isNaN(leftNum) && !Number.isNaN(rightNum);
            let result = false;
            if (comparison.operator === "=") {
                result = numericComparable ? leftNum === rightNum : left === right;
            }
            else if (comparison.operator === "<>") {
                result = numericComparable ? leftNum !== rightNum : left !== right;
            }
            else if (!numericComparable) {
                return null;
            }
            else if (comparison.operator === ">") {
                result = leftNum > rightNum;
            }
            else if (comparison.operator === "<") {
                result = leftNum < rightNum;
            }
            else if (comparison.operator === ">=") {
                result = leftNum >= rightNum;
            }
            else if (comparison.operator === "<=") {
                result = leftNum <= rightNum;
            }
            return result ? "TRUE" : "FALSE";
        }
        function splitComparisonExpression(expression) {
            const operators = ["<=", ">=", "<>", "=", ">", "<"];
            let depth = 0;
            let inSingleQuote = false;
            let inDoubleQuote = false;
            for (let i = 0; i < expression.length; i += 1) {
                const ch = expression[i];
                if (ch === "'" && !inDoubleQuote) {
                    inSingleQuote = !inSingleQuote;
                    continue;
                }
                if (ch === "\"" && !inSingleQuote) {
                    inDoubleQuote = !inDoubleQuote;
                    continue;
                }
                if (inSingleQuote || inDoubleQuote)
                    continue;
                if (ch === "(") {
                    depth += 1;
                    continue;
                }
                if (ch === ")") {
                    depth = Math.max(0, depth - 1);
                    continue;
                }
                if (depth !== 0)
                    continue;
                for (const operator of operators) {
                    if (expression.slice(i, i + operator.length) === operator) {
                        return {
                            left: expression.slice(0, i).trim(),
                            operator,
                            right: expression.slice(i + operator.length).trim()
                        };
                    }
                }
            }
            return null;
        }
        function findTopLevelOperatorIndex(expression, operator) {
            const target = String(operator || "");
            if (!target)
                return -1;
            let depth = 0;
            let inSingleQuote = false;
            let inDoubleQuote = false;
            for (let i = 0; i <= expression.length - target.length; i += 1) {
                const ch = expression[i];
                if (ch === "'" && !inDoubleQuote) {
                    inSingleQuote = !inSingleQuote;
                    continue;
                }
                if (ch === "\"" && !inSingleQuote) {
                    inDoubleQuote = !inDoubleQuote;
                    continue;
                }
                if (inSingleQuote || inDoubleQuote)
                    continue;
                if (ch === "(") {
                    depth += 1;
                    continue;
                }
                if (ch === ")") {
                    depth = Math.max(0, depth - 1);
                    continue;
                }
                if (depth === 0 && expression.slice(i, i + target.length) === target) {
                    return i;
                }
            }
            return -1;
        }
        function splitConcatenationExpression(expression) {
            const parts = [];
            let start = 0;
            let depth = 0;
            let inSingleQuote = false;
            let inDoubleQuote = false;
            for (let i = 0; i < expression.length; i += 1) {
                const ch = expression[i];
                if (ch === "'" && !inDoubleQuote) {
                    inSingleQuote = !inSingleQuote;
                    continue;
                }
                if (ch === "\"" && !inSingleQuote) {
                    inDoubleQuote = !inDoubleQuote;
                    continue;
                }
                if (inSingleQuote || inDoubleQuote)
                    continue;
                if (ch === "(") {
                    depth += 1;
                    continue;
                }
                if (ch === ")") {
                    depth = Math.max(0, depth - 1);
                    continue;
                }
                if (depth === 0 && ch === "&") {
                    parts.push(expression.slice(start, i).trim());
                    start = i + 1;
                }
            }
            if (parts.length === 0)
                return null;
            parts.push(expression.slice(start).trim());
            return parts.every(Boolean) ? parts : null;
        }
        function parseWholeFunctionCall(expression, allowedNames) {
            const trimmed = String(expression || "").trim();
            const nameMatch = trimmed.match(/^([A-Z][A-Z0-9]*)\(/i);
            if (!nameMatch)
                return null;
            const name = nameMatch[1].toUpperCase();
            if (!allowedNames.includes(name))
                return null;
            let depth = 0;
            let inSingleQuote = false;
            let inDoubleQuote = false;
            for (let i = name.length; i < trimmed.length; i += 1) {
                const ch = trimmed[i];
                if (ch === "'" && !inDoubleQuote) {
                    inSingleQuote = !inSingleQuote;
                    continue;
                }
                if (ch === "\"" && !inSingleQuote) {
                    inDoubleQuote = !inDoubleQuote;
                    continue;
                }
                if (inSingleQuote || inDoubleQuote)
                    continue;
                if (ch === "(") {
                    depth += 1;
                    continue;
                }
                if (ch !== ")")
                    continue;
                depth -= 1;
                if (depth > 0)
                    continue;
                if (depth < 0 || i !== trimmed.length - 1)
                    return null;
                return {
                    name,
                    argsText: trimmed.slice(name.length + 1, i)
                };
            }
            return null;
        }
        function replaceNumericDefinedNames(expression, currentSheetName) {
            let result = "";
            let i = 0;
            let inSingleQuote = false;
            let inDoubleQuote = false;
            while (i < expression.length) {
                const ch = expression[i];
                if (ch === "'" && !inDoubleQuote) {
                    inSingleQuote = !inSingleQuote;
                    result += ch;
                    i += 1;
                    continue;
                }
                if (ch === "\"" && !inSingleQuote) {
                    inDoubleQuote = !inDoubleQuote;
                    result += ch;
                    i += 1;
                    continue;
                }
                if (inSingleQuote || inDoubleQuote) {
                    result += ch;
                    i += 1;
                    continue;
                }
                if (!/[\p{L}_]/u.test(ch)) {
                    result += ch;
                    i += 1;
                    continue;
                }
                const start = i;
                i += 1;
                while (i < expression.length && /[\p{L}\p{N}_.]/u.test(expression[i])) {
                    i += 1;
                }
                const token = expression.slice(start, i);
                if ((expression[i] || "") === "(") {
                    result += token;
                    continue;
                }
                const scalar = deps.getDefinedNameScalarValue()?.(currentSheetName, token) || null;
                if (scalar != null) {
                    const numeric = Number(scalar);
                    if (!Number.isNaN(numeric)) {
                        result += String(numeric);
                        continue;
                    }
                }
                result += token;
            }
            return result;
        }
        function replaceEmbeddedNumericFunctions(expression, currentSheetName, resolveCellValue, resolveRangeValues, resolveRangeEntries) {
            let current = expression;
            let changed = true;
            while (changed) {
                changed = false;
                current = current.replace(/[A-Z][A-Z0-9]*\([^()]*\)/gi, (segment) => {
                    const resolved = tryResolveNumericFunction(segment, currentSheetName, resolveCellValue, resolveRangeValues, resolveRangeEntries)
                        ?? tryResolveDatePartFunction(segment, currentSheetName, resolveCellValue, resolveRangeValues, resolveRangeEntries)
                        ?? tryResolveAggregateFunction(segment, currentSheetName, resolveRangeValues, resolveRangeEntries)
                        ?? tryResolveConditionalAggregateFunction(segment, currentSheetName, resolveCellValue)
                        ?? tryResolveLookupFunction(segment, currentSheetName, resolveCellValue);
                    if (resolved == null)
                        return segment;
                    const numericValue = Number(resolved);
                    if (Number.isNaN(numericValue))
                        return segment;
                    changed = true;
                    return String(numericValue);
                });
            }
            return current;
        }
        function resolveScalarFormulaValue(expression, currentSheetName, resolveCellValue, resolveRangeValues, resolveRangeEntries) {
            const trimmed = String(expression || "").trim();
            if (!trimmed)
                return null;
            const quotedString = trimmed.match(/^"(.*)"$/);
            if (quotedString) {
                return quotedString[1].replace(/""/g, "\"");
            }
            const numeric = Number(trimmed);
            if (!Number.isNaN(numeric)) {
                return String(numeric);
            }
            const simpleRef = deps.parseSimpleFormulaReference(`=${trimmed}`, currentSheetName);
            if (simpleRef) {
                return resolveCellValue(simpleRef.sheetName, simpleRef.address);
            }
            const scopedDefinedNameRef = deps.parseSheetScopedDefinedNameReference(trimmed, currentSheetName);
            if (scopedDefinedNameRef) {
                const scopedValue = deps.getDefinedNameScalarValue()?.(scopedDefinedNameRef.sheetName, scopedDefinedNameRef.name) || null;
                if (scopedValue != null)
                    return scopedValue;
            }
            const definedNameValue = deps.getDefinedNameScalarValue()?.(currentSheetName, trimmed) || null;
            if (definedNameValue != null)
                return definedNameValue;
            if (/^(TRUE|FALSE)$/i.test(trimmed)) {
                return trimmed.toUpperCase();
            }
            return deps.tryResolveFormulaExpression(`=${trimmed}`, currentSheetName, resolveCellValue, resolveRangeValues, resolveRangeEntries);
        }
        function tryResolveAggregateFunction(normalizedFormula, currentSheetName, resolveRangeValues, resolveRangeEntries) {
            if (!resolveRangeValues || !resolveRangeEntries)
                return null;
            const call = parseWholeFunctionCall(normalizedFormula, ["SUM", "AVERAGE", "MIN", "MAX", "COUNT", "COUNTA"]);
            if (!call)
                return null;
            const fnName = call.name;
            const args = splitFormulaArguments(call.argsText.trim());
            if (args.length === 0)
                return null;
            const resolvedArgs = args.map((arg) => resolveAggregateArgument(arg, currentSheetName, resolveRangeValues, resolveRangeEntries));
            if (resolvedArgs.some((entry) => entry == null))
                return null;
            const values = resolvedArgs.flatMap((entry) => entry?.numericValues || []);
            const valueCount = resolvedArgs.reduce((sum, entry) => sum + (entry?.valueCount || 0), 0);
            if ((fnName !== "COUNTA" && values.length === 0) || valueCount === 0)
                return null;
            if (fnName === "SUM")
                return String(values.reduce((sum, value) => sum + value, 0));
            if (fnName === "AVERAGE")
                return String(values.reduce((sum, value) => sum + value, 0) / values.length);
            if (fnName === "MIN")
                return String(Math.min(...values));
            if (fnName === "MAX")
                return String(Math.max(...values));
            if (fnName === "COUNT")
                return String(values.length);
            if (fnName === "COUNTA")
                return String(valueCount);
            return null;
        }
        function tryResolveConditionalAggregateFunction(normalizedFormula, currentSheetName, resolveCellValue) {
            const averageifsCall = parseWholeFunctionCall(normalizedFormula, ["AVERAGEIFS"]);
            if (averageifsCall) {
                const args = splitFormulaArguments(averageifsCall.argsText.trim());
                if (args.length < 3 || args.length % 2 === 0)
                    return null;
                const averageRange = parseQualifiedRangeReference(args[0], currentSheetName);
                if (!averageRange)
                    return null;
                const averageCells = collectRangeCells(averageRange, resolveCellValue);
                if (averageCells.length === 0)
                    return null;
                const rangeCriteriaPairs = [];
                for (let index = 1; index < args.length; index += 2) {
                    const rangeRef = parseQualifiedRangeReference(args[index], currentSheetName);
                    const criteria = resolveScalarFormulaValue(args[index + 1], currentSheetName, resolveCellValue);
                    if (!rangeRef || criteria == null)
                        return null;
                    const cells = collectRangeCells(rangeRef, resolveCellValue);
                    if (cells.length !== averageCells.length)
                        return null;
                    rangeCriteriaPairs.push({ cells, criteria });
                }
                let sum = 0;
                let count = 0;
                for (let i = 0; i < averageCells.length; i += 1) {
                    if (!rangeCriteriaPairs.every((entry) => matchesCountIfCriteria(entry.cells[i], entry.criteria)))
                        continue;
                    const numeric = Number(averageCells[i]);
                    if (!Number.isNaN(numeric)) {
                        sum += numeric;
                        count += 1;
                    }
                }
                return count > 0 ? String(sum / count) : null;
            }
            const sumifsCall = parseWholeFunctionCall(normalizedFormula, ["SUMIFS"]);
            if (sumifsCall) {
                const args = splitFormulaArguments(sumifsCall.argsText.trim());
                if (args.length < 3 || args.length % 2 === 0)
                    return null;
                const sumRange = parseQualifiedRangeReference(args[0], currentSheetName);
                if (!sumRange)
                    return null;
                const sumCells = collectRangeCells(sumRange, resolveCellValue);
                if (sumCells.length === 0)
                    return null;
                const rangeCriteriaPairs = [];
                for (let index = 1; index < args.length; index += 2) {
                    const rangeRef = parseQualifiedRangeReference(args[index], currentSheetName);
                    const criteria = resolveScalarFormulaValue(args[index + 1], currentSheetName, resolveCellValue);
                    if (!rangeRef || criteria == null)
                        return null;
                    const cells = collectRangeCells(rangeRef, resolveCellValue);
                    if (cells.length !== sumCells.length)
                        return null;
                    rangeCriteriaPairs.push({ cells, criteria });
                }
                let sum = 0;
                for (let i = 0; i < sumCells.length; i += 1) {
                    if (!rangeCriteriaPairs.every((entry) => matchesCountIfCriteria(entry.cells[i], entry.criteria)))
                        continue;
                    const numeric = Number(sumCells[i]);
                    if (!Number.isNaN(numeric)) {
                        sum += numeric;
                    }
                }
                return String(sum);
            }
            const countifsCall = parseWholeFunctionCall(normalizedFormula, ["COUNTIFS"]);
            if (countifsCall) {
                const args = splitFormulaArguments(countifsCall.argsText.trim());
                if (args.length < 2 || args.length % 2 !== 0)
                    return null;
                const rangeCriteriaPairs = [];
                for (let index = 0; index < args.length; index += 2) {
                    const rangeRef = parseQualifiedRangeReference(args[index], currentSheetName);
                    const criteria = resolveScalarFormulaValue(args[index + 1], currentSheetName, resolveCellValue);
                    if (!rangeRef || criteria == null)
                        return null;
                    const cells = collectRangeCells(rangeRef, resolveCellValue);
                    if (cells.length === 0)
                        return null;
                    rangeCriteriaPairs.push({ cells, criteria });
                }
                const length = rangeCriteriaPairs[0].cells.length;
                if (rangeCriteriaPairs.some((entry) => entry.cells.length !== length))
                    return null;
                let count = 0;
                for (let i = 0; i < length; i += 1) {
                    if (rangeCriteriaPairs.every((entry) => matchesCountIfCriteria(entry.cells[i], entry.criteria))) {
                        count += 1;
                    }
                }
                return String(count);
            }
            const call = parseWholeFunctionCall(normalizedFormula, ["COUNTIF", "SUMIF", "AVERAGEIF"]);
            if (!call)
                return null;
            const fnName = call.name;
            const args = splitFormulaArguments(call.argsText.trim());
            if ((fnName === "COUNTIF" && args.length !== 2) || ((fnName === "SUMIF" || fnName === "AVERAGEIF") && args.length !== 2 && args.length !== 3)) {
                return null;
            }
            const criteriaRange = parseQualifiedRangeReference(args[0], currentSheetName);
            if (!criteriaRange)
                return null;
            const criteria = resolveScalarFormulaValue(args[1], currentSheetName, resolveCellValue);
            if (criteria == null)
                return null;
            const criteriaCells = collectRangeCells(criteriaRange, resolveCellValue);
            if (criteriaCells.length === 0)
                return null;
            const sumRange = fnName === "COUNTIF"
                ? criteriaRange
                : parseQualifiedRangeReference(args[2] || args[0], currentSheetName);
            if (!sumRange)
                return null;
            const sumCells = collectRangeCells(sumRange, resolveCellValue);
            if (sumCells.length !== criteriaCells.length)
                return null;
            let count = 0;
            let sum = 0;
            for (let i = 0; i < criteriaCells.length; i += 1) {
                if (!matchesCountIfCriteria(criteriaCells[i], criteria))
                    continue;
                count += 1;
                const numeric = Number(sumCells[i]);
                if (!Number.isNaN(numeric)) {
                    sum += numeric;
                }
            }
            if (fnName === "COUNTIF")
                return String(count);
            if (fnName === "SUMIF")
                return String(sum);
            return count > 0 ? String(sum / count) : null;
        }
        function tryResolveNumericFunction(normalizedFormula, currentSheetName, resolveCellValue, resolveRangeValues, resolveRangeEntries) {
            const call = parseWholeFunctionCall(normalizedFormula, ["ROUND", "ROUNDUP", "ROUNDDOWN", "INT", "DATE", "VALUE", "DATEVALUE", "ROW", "COLUMN", "EOMONTH"]);
            if (!call)
                return null;
            const fnName = call.name;
            const args = splitFormulaArguments(call.argsText.trim());
            if (fnName === "ROW" || fnName === "COLUMN") {
                if (args.length !== 1)
                    return null;
                const rangeRef = parseQualifiedRangeReference(args[0], currentSheetName);
                if (rangeRef) {
                    const start = deps.parseCellAddress(rangeRef.start);
                    if (!start.row || !start.col)
                        return null;
                    return String(fnName === "ROW" ? start.row : start.col);
                }
                const simpleRef = deps.parseSimpleFormulaReference(`=${args[0]}`, currentSheetName);
                if (!simpleRef)
                    return null;
                const parsed = deps.parseCellAddress(simpleRef.address);
                if (!parsed.row || !parsed.col)
                    return null;
                return String(fnName === "ROW" ? parsed.row : parsed.col);
            }
            if (fnName === "VALUE" || fnName === "DATEVALUE") {
                if (args.length !== 1)
                    return null;
                const source = resolveScalarFormulaValue(args[0], currentSheetName, resolveCellValue, resolveRangeValues, resolveRangeEntries);
                if (source == null)
                    return null;
                const parsed = deps.cellFormat.parseValueFunctionText(source);
                return parsed == null ? null : String(parsed);
            }
            if (fnName === "DATE") {
                if (args.length !== 3)
                    return null;
                const year = resolveNumericFormulaArgument(args[0], currentSheetName, resolveCellValue, resolveRangeValues, resolveRangeEntries);
                const month = resolveNumericFormulaArgument(args[1], currentSheetName, resolveCellValue, resolveRangeValues, resolveRangeEntries);
                const day = resolveNumericFormulaArgument(args[2], currentSheetName, resolveCellValue, resolveRangeValues, resolveRangeEntries);
                if (year == null || month == null || day == null)
                    return null;
                const serial = deps.cellFormat.datePartsToExcelSerial(Math.trunc(year), Math.trunc(month), Math.trunc(day));
                return serial == null ? null : String(serial);
            }
            if (fnName === "EOMONTH") {
                if (args.length !== 2)
                    return null;
                const startValue = resolveScalarFormulaValue(args[0], currentSheetName, resolveCellValue, resolveRangeValues, resolveRangeEntries);
                const monthOffset = resolveNumericFormulaArgument(args[1], currentSheetName, resolveCellValue, resolveRangeValues, resolveRangeEntries);
                if (startValue == null || monthOffset == null)
                    return null;
                const parts = deps.cellFormat.parseDateLikeParts(startValue);
                if (!parts)
                    return null;
                const baseYear = Number(parts.yyyy);
                const baseMonthIndex = Number(parts.mm) - 1 + Math.trunc(monthOffset);
                const targetYear = baseYear + Math.floor(baseMonthIndex / 12);
                const targetMonth = ((baseMonthIndex % 12) + 12) % 12 + 1;
                const serial = deps.cellFormat.datePartsToExcelSerial(targetYear, targetMonth + 1, 0);
                return serial == null ? null : String(serial);
            }
            if (fnName === "INT") {
                if (args.length !== 1)
                    return null;
                const value = resolveNumericFormulaArgument(args[0], currentSheetName, resolveCellValue, resolveRangeValues, resolveRangeEntries);
                if (value == null)
                    return null;
                return String(Math.floor(value));
            }
            if (args.length !== 2)
                return null;
            const value = resolveNumericFormulaArgument(args[0], currentSheetName, resolveCellValue, resolveRangeValues, resolveRangeEntries);
            const digits = resolveNumericFormulaArgument(args[1], currentSheetName, resolveCellValue, resolveRangeValues, resolveRangeEntries);
            if (value == null || digits == null)
                return null;
            const roundedDigits = Math.trunc(digits);
            const factor = 10 ** roundedDigits;
            if (!Number.isFinite(factor) || factor === 0)
                return null;
            if (fnName === "ROUND")
                return String(Math.round(value * factor) / factor);
            if (fnName === "ROUNDUP") {
                const scaled = value * factor;
                return String((scaled >= 0 ? Math.ceil(scaled) : Math.floor(scaled)) / factor);
            }
            if (fnName === "ROUNDDOWN") {
                const scaled = value * factor;
                return String((scaled >= 0 ? Math.floor(scaled) : Math.ceil(scaled)) / factor);
            }
            return null;
        }
        function tryResolveStringFunction(normalizedFormula, currentSheetName, resolveCellValue, resolveRangeValues, resolveRangeEntries) {
            const call = parseWholeFunctionCall(normalizedFormula, ["LEFT", "RIGHT", "MID", "LEN", "TRIM", "SUBSTITUTE", "REPLACE", "REPT"]);
            if (!call)
                return null;
            const fnName = call.name;
            const args = splitFormulaArguments(call.argsText.trim());
            if (fnName === "LEN" || fnName === "TRIM") {
                if (args.length !== 1)
                    return null;
                const source = resolveScalarFormulaValue(args[0], currentSheetName, resolveCellValue, resolveRangeValues, resolveRangeEntries);
                if (source == null)
                    return null;
                return fnName === "LEN" ? String(source.length) : source.trim().replace(/\s+/g, " ");
            }
            if (fnName === "LEFT" || fnName === "RIGHT") {
                if (args.length < 1 || args.length > 2)
                    return null;
                const source = resolveScalarFormulaValue(args[0], currentSheetName, resolveCellValue, resolveRangeValues, resolveRangeEntries);
                if (source == null)
                    return null;
                const count = args.length === 2
                    ? resolveNumericFormulaArgument(args[1], currentSheetName, resolveCellValue, resolveRangeValues, resolveRangeEntries)
                    : 1;
                if (count == null)
                    return null;
                const length = Math.max(0, Math.trunc(count));
                return fnName === "LEFT" ? source.slice(0, length) : source.slice(Math.max(0, source.length - length));
            }
            if (fnName === "MID") {
                if (args.length !== 3)
                    return null;
                const source = resolveScalarFormulaValue(args[0], currentSheetName, resolveCellValue, resolveRangeValues, resolveRangeEntries);
                const start = resolveNumericFormulaArgument(args[1], currentSheetName, resolveCellValue, resolveRangeValues, resolveRangeEntries);
                const count = resolveNumericFormulaArgument(args[2], currentSheetName, resolveCellValue, resolveRangeValues, resolveRangeEntries);
                if (source == null || start == null || count == null)
                    return null;
                const startIndex = Math.max(0, Math.trunc(start) - 1);
                const length = Math.max(0, Math.trunc(count));
                return source.slice(startIndex, startIndex + length);
            }
            if (fnName === "SUBSTITUTE") {
                if (args.length < 3 || args.length > 4)
                    return null;
                const source = resolveScalarFormulaValue(args[0], currentSheetName, resolveCellValue, resolveRangeValues, resolveRangeEntries);
                const oldText = resolveScalarFormulaValue(args[1], currentSheetName, resolveCellValue, resolveRangeValues, resolveRangeEntries);
                const newText = resolveScalarFormulaValue(args[2], currentSheetName, resolveCellValue, resolveRangeValues, resolveRangeEntries);
                if (source == null || oldText == null || newText == null || oldText === "")
                    return null;
                if (args.length === 3)
                    return source.split(oldText).join(newText);
                const instanceNum = resolveNumericFormulaArgument(args[3], currentSheetName, resolveCellValue, resolveRangeValues, resolveRangeEntries);
                if (instanceNum == null)
                    return null;
                const targetIndex = Math.trunc(instanceNum);
                if (targetIndex <= 0)
                    return source;
                let occurrence = 0;
                let cursor = 0;
                let result = "";
                while (cursor < source.length) {
                    const found = source.indexOf(oldText, cursor);
                    if (found === -1) {
                        result += source.slice(cursor);
                        break;
                    }
                    occurrence += 1;
                    result += source.slice(cursor, found);
                    if (occurrence === targetIndex) {
                        result += newText;
                        result += source.slice(found + oldText.length);
                        return result;
                    }
                    result += oldText;
                    cursor = found + oldText.length;
                }
                return result || source;
            }
            if (fnName === "REPLACE") {
                if (args.length !== 4)
                    return null;
                const source = resolveScalarFormulaValue(args[0], currentSheetName, resolveCellValue, resolveRangeValues, resolveRangeEntries);
                const start = resolveNumericFormulaArgument(args[1], currentSheetName, resolveCellValue, resolveRangeValues, resolveRangeEntries);
                const count = resolveNumericFormulaArgument(args[2], currentSheetName, resolveCellValue, resolveRangeValues, resolveRangeEntries);
                const replacement = resolveScalarFormulaValue(args[3], currentSheetName, resolveCellValue, resolveRangeValues, resolveRangeEntries);
                if (source == null || start == null || count == null || replacement == null)
                    return null;
                const startIndex = Math.max(0, Math.trunc(start) - 1);
                const length = Math.max(0, Math.trunc(count));
                return source.slice(0, startIndex) + replacement + source.slice(startIndex + length);
            }
            if (fnName === "REPT") {
                if (args.length !== 2)
                    return null;
                const source = resolveScalarFormulaValue(args[0], currentSheetName, resolveCellValue, resolveRangeValues, resolveRangeEntries);
                const countValue = resolveScalarFormulaValue(args[1], currentSheetName, resolveCellValue, resolveRangeValues, resolveRangeEntries);
                if (source == null)
                    return null;
                const normalizedCount = countValue == null
                    ? (() => {
                        const evaluatedCondition = evaluateFormulaCondition(args[1], currentSheetName, resolveCellValue, resolveRangeValues, resolveRangeEntries);
                        if (evaluatedCondition == null)
                            return null;
                        return evaluatedCondition ? "TRUE" : "FALSE";
                    })()
                    : countValue.trim().toUpperCase();
                if (normalizedCount == null)
                    return null;
                const count = normalizedCount === "TRUE"
                    ? 1
                    : normalizedCount === "FALSE"
                        ? 0
                        : Number(countValue);
                if (!Number.isFinite(count))
                    return null;
                return source.repeat(Math.max(0, Math.trunc(count)));
            }
            return null;
        }
        function splitFormulaArguments(argText) {
            const args = [];
            let current = "";
            let depth = 0;
            let inSingleQuote = false;
            let inDoubleQuote = false;
            for (let i = 0; i < argText.length; i += 1) {
                const ch = argText[i];
                if (ch === "'" && !inDoubleQuote) {
                    inSingleQuote = !inSingleQuote;
                    current += ch;
                    continue;
                }
                if (ch === "\"" && !inSingleQuote) {
                    inDoubleQuote = !inDoubleQuote;
                    current += ch;
                    continue;
                }
                if (!inSingleQuote && !inDoubleQuote) {
                    if (ch === "(") {
                        depth += 1;
                    }
                    else if (ch === ")") {
                        depth = Math.max(0, depth - 1);
                    }
                    else if (ch === "," && depth === 0) {
                        args.push(current.trim());
                        current = "";
                        continue;
                    }
                }
                current += ch;
            }
            if (current.trim())
                args.push(current.trim());
            return args;
        }
        function resolveAggregateArgument(argText, currentSheetName, resolveRangeValues, resolveRangeEntries) {
            const rangeRef = parseQualifiedRangeReference(argText, currentSheetName);
            if (rangeRef) {
                const rangeEntries = resolveRangeEntries(rangeRef.sheetName, `${rangeRef.start}:${rangeRef.end}`);
                return {
                    numericValues: rangeEntries.numericValues,
                    valueCount: rangeEntries.rawValues.filter((value) => String(value || "").trim() !== "").length
                };
            }
            const numericLiteral = Number(argText);
            if (!Number.isNaN(numericLiteral)) {
                return { numericValues: [numericLiteral], valueCount: 1 };
            }
            const cellRef = deps.parseSimpleFormulaReference(`=${argText}`, currentSheetName);
            if (!cellRef)
                return null;
            const values = resolveRangeValues(cellRef.sheetName, `${cellRef.address}:${cellRef.address}`);
            const entryCount = resolveRangeEntries(cellRef.sheetName, `${cellRef.address}:${cellRef.address}`).rawValues
                .filter((value) => String(value || "").trim() !== "").length;
            return { numericValues: values, valueCount: entryCount };
        }
        function resolveNumericFormulaArgument(expression, currentSheetName, resolveCellValue, resolveRangeValues, resolveRangeEntries) {
            const scalar = resolveScalarFormulaValue(expression, currentSheetName, resolveCellValue, resolveRangeValues, resolveRangeEntries);
            if (scalar == null)
                return null;
            const numeric = Number(scalar);
            return Number.isNaN(numeric) ? null : numeric;
        }
        function collectRangeCells(rangeRef, resolveCellValue) {
            const start = deps.parseCellAddress(rangeRef.start);
            const end = deps.parseCellAddress(rangeRef.end);
            if (!start.row || !start.col || !end.row || !end.col)
                return [];
            const startRow = Math.min(start.row, end.row);
            const endRow = Math.max(start.row, end.row);
            const startCol = Math.min(start.col, end.col);
            const endCol = Math.max(start.col, end.col);
            const values = [];
            for (let row = startRow; row <= endRow; row += 1) {
                for (let col = startCol; col <= endCol; col += 1) {
                    values.push(resolveCellValue(rangeRef.sheetName, `${deps.colToLetters(col)}${row}`));
                }
            }
            return values;
        }
        function matchesCountIfCriteria(value, criteria) {
            const trimmedCriteria = String(criteria || "").trim();
            const operatorMatch = trimmedCriteria.match(/^(<=|>=|<>|=|<|>)(.*)$/);
            const operator = operatorMatch ? operatorMatch[1] : "=";
            const operandText = operatorMatch ? operatorMatch[2].trim() : trimmedCriteria;
            const leftNum = Number(value);
            const rightNum = Number(operandText);
            const numericComparable = !Number.isNaN(leftNum) && !Number.isNaN(rightNum);
            if (operator === "=")
                return numericComparable ? leftNum === rightNum : value === operandText;
            if (operator === "<>")
                return numericComparable ? leftNum !== rightNum : value !== operandText;
            if (!numericComparable)
                return false;
            if (operator === ">")
                return leftNum > rightNum;
            if (operator === "<")
                return leftNum < rightNum;
            if (operator === ">=")
                return leftNum >= rightNum;
            if (operator === "<=")
                return leftNum <= rightNum;
            return false;
        }
        function parseQualifiedRangeReference(argText, currentSheetName) {
            const qualifiedRangeMatch = argText.match(/^(?:'((?:[^']|'')+)'|([^'=][^!]*))!(\$?[A-Z]+\$?\d+:\$?[A-Z]+\$?\d+)$/i);
            const localRangeMatch = argText.match(/^(\$?[A-Z]+\$?\d+:\$?[A-Z]+\$?\d+)$/i);
            if (!qualifiedRangeMatch && !localRangeMatch) {
                const scopedDefinedName = deps.parseSheetScopedDefinedNameReference(String(argText || "").trim(), currentSheetName);
                if (scopedDefinedName) {
                    const scopedRange = deps.getDefinedNameRangeRef()?.(scopedDefinedName.sheetName, scopedDefinedName.name) || null;
                    if (scopedRange)
                        return scopedRange;
                }
                const structuredRange = deps.getStructuredRangeRef()?.(currentSheetName, String(argText || "").trim()) || null;
                if (structuredRange)
                    return structuredRange;
                const definedRange = deps.getDefinedNameRangeRef()?.(currentSheetName, String(argText || "").trim()) || null;
                if (definedRange)
                    return definedRange;
                return null;
            }
            const sheetName = qualifiedRangeMatch
                ? deps.normalizeFormulaSheetName(qualifiedRangeMatch[1] || qualifiedRangeMatch[2] || currentSheetName)
                : currentSheetName;
            const rangeText = String(qualifiedRangeMatch ? qualifiedRangeMatch[3] : localRangeMatch?.[1] || "");
            const range = deps.parseRangeAddress(rangeText);
            if (!range)
                return null;
            return { sheetName, start: range.start, end: range.end };
        }
        function evaluateArithmeticExpression(expression) {
            const tokens = tokenizeArithmeticExpression(expression);
            let index = 0;
            function parseExpression() {
                let value = parseTerm();
                while (tokens[index] === "+" || tokens[index] === "-") {
                    const operator = tokens[index];
                    index += 1;
                    const right = parseTerm();
                    value = operator === "+" ? value + right : value - right;
                }
                return value;
            }
            function parseTerm() {
                let value = parseFactor();
                while (tokens[index] === "*" || tokens[index] === "/") {
                    const operator = tokens[index];
                    index += 1;
                    const right = parseFactor();
                    value = operator === "*" ? value * right : value / right;
                }
                return value;
            }
            function parseFactor() {
                const token = tokens[index];
                if (token === "+") {
                    index += 1;
                    return parseFactor();
                }
                if (token === "-") {
                    index += 1;
                    return -parseFactor();
                }
                if (token === "(") {
                    index += 1;
                    const value = parseExpression();
                    if (tokens[index] !== ")")
                        throw new Error("Unbalanced parentheses");
                    index += 1;
                    return value;
                }
                if (token == null)
                    throw new Error("Unexpected end of expression");
                index += 1;
                const numericValue = Number(token);
                if (Number.isNaN(numericValue))
                    throw new Error("Invalid token");
                return numericValue;
            }
            const result = parseExpression();
            if (index !== tokens.length)
                throw new Error("Unexpected trailing tokens");
            return result;
        }
        function tokenizeArithmeticExpression(expression) {
            const tokens = [];
            let index = 0;
            while (index < expression.length) {
                const ch = expression[index];
                if (/\s/.test(ch)) {
                    index += 1;
                    continue;
                }
                if (/[+\-*/()]/.test(ch)) {
                    tokens.push(ch);
                    index += 1;
                    continue;
                }
                const numberMatch = expression.slice(index).match(/^\d+(?:\.\d+)?/);
                if (!numberMatch)
                    throw new Error("Invalid arithmetic expression");
                tokens.push(numberMatch[0]);
                index += numberMatch[0].length;
            }
            return tokens;
        }
        return {
            tryResolveFormulaExpressionLegacy,
            findTopLevelOperatorIndex,
            parseWholeFunctionCall,
            splitFormulaArguments,
            parseQualifiedRangeReference,
            resolveScalarFormulaValue
        };
    }
    const formulaLegacyApi = {
        createFormulaLegacyApi
    };
    moduleRegistry.registerModule("formulaLegacy", formulaLegacyApi);
})();

// ── formula-ast ─────────────────────────────────────────────────
/*
 * Copyright 2026 Toshiki Iga
 * SPDX-License-Identifier: Apache-2.0
 */
(() => {
    const moduleRegistry = getXlsx2mdModuleRegistry();
    function createFormulaAstApi(deps) {
        function tryResolveFormulaExpressionWithAst(expression, currentSheetName, resolveCellValue, resolveDefinedNameScalarValue, resolveDefinedNameRangeRef, resolveStructuredRangeRef, resolveSpillRange, resolveRangeEntries, currentAddress) {
            const formulaApi = moduleRegistry.getModule("formulaRuntime");
            if (!formulaApi?.parseFormula || !formulaApi?.evaluateFormulaAst) {
                return null;
            }
            try {
                const ast = formulaApi.parseFormula(`=${expression}`);
                const evaluated = formulaApi.evaluateFormulaAst(ast, {
                    resolveCell(ref, sheet) {
                        return coerceFormulaAstScalar(resolveCellValue(sheet || currentSheetName, deps.normalizeFormulaAddress(ref)));
                    },
                    resolveName(name) {
                        const scopedRef = deps.parseSheetScopedDefinedNameReference(name, currentSheetName);
                        if (scopedRef) {
                            const scopedValue = resolveDefinedNameScalarValue?.(scopedRef.sheetName, scopedRef.name) ?? null;
                            if (scopedValue != null) {
                                return coerceFormulaAstScalar(scopedValue);
                            }
                        }
                        const scalarValue = resolveDefinedNameScalarValue?.(currentSheetName, name) ?? null;
                        if (scalarValue != null) {
                            return coerceFormulaAstScalar(scalarValue);
                        }
                        const rangeRef = resolveDefinedNameRangeRef?.(currentSheetName, name) ?? null;
                        if (rangeRef && resolveRangeEntries) {
                            return createFormulaAstRangeMatrix(rangeRef.sheetName, rangeRef.start, rangeRef.end, resolveRangeEntries);
                        }
                        return null;
                    },
                    resolveScopedName(sheet, name) {
                        const scopedValue = resolveDefinedNameScalarValue?.(sheet, name) ?? null;
                        if (scopedValue != null) {
                            return coerceFormulaAstScalar(scopedValue);
                        }
                        const rangeRef = resolveDefinedNameRangeRef?.(sheet, name) ?? null;
                        if (rangeRef && resolveRangeEntries) {
                            return createFormulaAstRangeMatrix(rangeRef.sheetName, rangeRef.start, rangeRef.end, resolveRangeEntries);
                        }
                        return null;
                    },
                    resolveStructuredRef(table, column) {
                        const rangeRef = resolveStructuredRangeRef?.(currentSheetName, `${table}[${column}]`) ?? null;
                        if (!rangeRef || !resolveRangeEntries) {
                            return null;
                        }
                        return createFormulaAstRangeMatrix(rangeRef.sheetName, rangeRef.start, rangeRef.end, resolveRangeEntries);
                    },
                    resolveRange(startRef, endRef, sheet) {
                        if (!resolveRangeEntries) {
                            return [];
                        }
                        return createFormulaAstRangeMatrix(sheet || currentSheetName, deps.normalizeFormulaAddress(startRef), deps.normalizeFormulaAddress(endRef), resolveRangeEntries);
                    },
                    resolveSpill(ref, sheet) {
                        if (!resolveRangeEntries) {
                            return [];
                        }
                        const spillRange = resolveSpillRange(sheet || currentSheetName, ref);
                        if (!spillRange) {
                            return [];
                        }
                        return createFormulaAstRangeMatrix(spillRange.sheetName, spillRange.start, spillRange.end, resolveRangeEntries);
                    },
                    currentCellRef: currentAddress ? deps.normalizeFormulaAddress(currentAddress) : undefined
                });
                return serializeFormulaAstResult(evaluated);
            }
            catch (_error) {
                return null;
            }
        }
        function coerceFormulaAstScalar(value) {
            const trimmed = String(value || "").trim();
            if (!trimmed) {
                return "";
            }
            if (trimmed === "TRUE") {
                return true;
            }
            if (trimmed === "FALSE") {
                return false;
            }
            const numeric = Number(trimmed.replace(/,/g, ""));
            if (!Number.isNaN(numeric)) {
                return numeric;
            }
            return trimmed;
        }
        function createFormulaAstRangeMatrix(sheetName, startAddress, endAddress, resolveRangeEntries) {
            const range = deps.parseRangeAddress(`${deps.normalizeFormulaAddress(startAddress)}:${deps.normalizeFormulaAddress(endAddress)}`);
            if (!range) {
                return [];
            }
            const start = deps.parseCellAddress(range.start);
            const end = deps.parseCellAddress(range.end);
            if (!start.row || !start.col || !end.row || !end.col) {
                return [];
            }
            const startRow = Math.min(start.row, end.row);
            const endRow = Math.max(start.row, end.row);
            const startCol = Math.min(start.col, end.col);
            const endCol = Math.max(start.col, end.col);
            const entries = resolveRangeEntries(sheetName, `${range.start}:${range.end}`).rawValues;
            const matrix = [];
            let index = 0;
            for (let row = startRow; row <= endRow; row += 1) {
                const rowValues = [];
                for (let col = startCol; col <= endCol; col += 1) {
                    rowValues.push(coerceFormulaAstScalar(entries[index] || ""));
                    index += 1;
                }
                matrix.push(rowValues);
            }
            return matrix;
        }
        function serializeFormulaAstResult(value) {
            if (value == null) {
                return null;
            }
            if (Array.isArray(value)) {
                return null;
            }
            if (typeof value === "boolean") {
                return value ? "TRUE" : "FALSE";
            }
            return String(value);
        }
        return {
            tryResolveFormulaExpressionWithAst,
            coerceFormulaAstScalar,
            createFormulaAstRangeMatrix,
            serializeFormulaAstResult
        };
    }
    const formulaAstApi = {
        createFormulaAstApi
    };
    moduleRegistry.registerModule("formulaAst", formulaAstApi);
})();

// ── formula-resolver ────────────────────────────────────────────
/*
 * Copyright 2026 Toshiki Iga
 * SPDX-License-Identifier: Apache-2.0
 */
(() => {
    const moduleRegistry = getXlsx2mdModuleRegistry();
    function buildFormulaResolver(workbook, deps) {
        const sheetMap = new Map();
        const cellMaps = new Map();
        const tableMap = new Map();
        for (const sheet of workbook.sheets) {
            sheetMap.set(sheet.name, sheet);
            const cellMap = new Map();
            for (const cell of sheet.cells) {
                cellMap.set(cell.address.toUpperCase(), cell);
            }
            cellMaps.set(sheet.name, cellMap);
            for (const table of sheet.tables) {
                if (table.name) {
                    tableMap.set(deps.normalizeStructuredTableKey(table.name), table);
                }
                if (table.displayName) {
                    tableMap.set(deps.normalizeStructuredTableKey(table.displayName), table);
                }
            }
        }
        const resolvingKeys = new Set();
        const definedNameMap = new Map();
        for (const entry of workbook.definedNames) {
            const key = entry.localSheetName
                ? `${deps.normalizeFormulaSheetName(entry.localSheetName)}::${deps.normalizeDefinedNameKey(entry.name)}`
                : `::${deps.normalizeDefinedNameKey(entry.name)}`;
            definedNameMap.set(key, entry.formulaText);
        }
        function lookupDefinedNameFormula(sheetName, name) {
            const normalizedName = deps.normalizeDefinedNameKey(name);
            return definedNameMap.get(`${deps.normalizeFormulaSheetName(sheetName)}::${normalizedName}`)
                || definedNameMap.get(`::${normalizedName}`)
                || null;
        }
        function resolveCellValue(sheetName, address) {
            const sheet = sheetMap.get(sheetName);
            if (!sheet)
                return "#REF!";
            const cell = cellMaps.get(sheetName)?.get(address.toUpperCase()) || null;
            if (!cell)
                return "";
            const key = `${sheetName}!${address.toUpperCase()}`;
            if (resolvingKeys.has(key)) {
                return "";
            }
            if (cell.formulaText && (!cell.outputValue || cell.resolutionStatus !== "resolved")) {
                resolvingKeys.add(key);
                try {
                    try {
                        const result = deps.tryResolveFormulaExpressionDetailed(cell.formulaText, sheetName, resolveCellValue, undefined, undefined, cell.address);
                        if (result?.value != null) {
                            deps.applyResolvedFormulaValue(cell, result.value, result.source || "legacy_resolver");
                        }
                    }
                    catch (error) {
                        if (!(error instanceof Error) || error.message !== "__FORMULA_UNRESOLVED__") {
                            throw error;
                        }
                    }
                }
                finally {
                    resolvingKeys.delete(key);
                }
            }
            if (cell.formulaText) {
                if (cell.resolutionStatus === "resolved") {
                    const rawValue = String(cell.rawValue || "");
                    const outputValue = String(cell.outputValue || "");
                    if (rawValue && rawValue !== cell.formulaText) {
                        return rawValue;
                    }
                    return outputValue || rawValue;
                }
                const rawValue = String(cell.rawValue || "");
                const outputValue = String(cell.outputValue || "");
                if (rawValue && rawValue !== cell.formulaText) {
                    return rawValue;
                }
                if (outputValue && outputValue !== cell.formulaText) {
                    return outputValue;
                }
                return "";
            }
            if (["s", "inlineStr", "str", "e", "b"].includes(cell.valueType)) {
                return String(cell.outputValue || cell.rawValue || "");
            }
            return String(cell.rawValue || cell.outputValue || "");
        }
        function resolveRangeEntries(sheetName, rangeText) {
            const range = deps.parseRangeAddress(rangeText);
            if (!range) {
                return { rawValues: [], numericValues: [] };
            }
            const start = deps.parseCellAddress(range.start);
            const end = deps.parseCellAddress(range.end);
            if (!start.row || !start.col || !end.row || !end.col) {
                return { rawValues: [], numericValues: [] };
            }
            const startRow = Math.min(start.row, end.row);
            const endRow = Math.max(start.row, end.row);
            const startCol = Math.min(start.col, end.col);
            const endCol = Math.max(start.col, end.col);
            const rawValues = [];
            const numericValues = [];
            for (let row = startRow; row <= endRow; row += 1) {
                for (let col = startCol; col <= endCol; col += 1) {
                    const rawValue = resolveCellValue(sheetName, `${deps.colToLetters(col)}${row}`);
                    rawValues.push(rawValue);
                    if (String(rawValue || "").trim() === "")
                        continue;
                    const numericValue = Number(rawValue);
                    if (!Number.isNaN(numericValue)) {
                        numericValues.push(numericValue);
                    }
                }
            }
            return { rawValues, numericValues };
        }
        function resolveDefinedNameValue(sheetName, name) {
            const formulaText = lookupDefinedNameFormula(sheetName, name);
            if (!formulaText)
                return null;
            const directRef = deps.parseSimpleFormulaReference(formulaText, sheetName);
            if (directRef) {
                const value = resolveCellValue(directRef.sheetName, directRef.address);
                return value === "" ? null : value;
            }
            const scalar = deps.resolveScalarFormulaValue(formulaText.replace(/^=/, ""), sheetName, resolveCellValue);
            return scalar == null || scalar === "" ? null : scalar;
        }
        function resolveDefinedNameRange(sheetName, name) {
            const formulaText = lookupDefinedNameFormula(sheetName, name);
            if (!formulaText)
                return null;
            const normalized = formulaText.replace(/^=/, "").trim();
            const directRange = deps.parseQualifiedRangeReference(normalized, sheetName);
            if (directRange) {
                return directRange;
            }
            const separatorIndex = deps.findTopLevelOperatorIndex(normalized, ":");
            if (separatorIndex <= 0)
                return null;
            const leftText = normalized.slice(0, separatorIndex).trim();
            const rightText = normalized.slice(separatorIndex + 1).trim();
            const startRef = deps.parseSimpleFormulaReference(`=${leftText}`, sheetName);
            const indexCall = deps.parseWholeFunctionCall(rightText, ["INDEX"]);
            if (!startRef || !indexCall)
                return null;
            const args = deps.splitFormulaArguments(indexCall.argsText.trim());
            if (args.length < 2 || args.length > 3)
                return null;
            const rangeRef = deps.parseQualifiedRangeReference(args[0], sheetName);
            const rowIndex = Number(deps.resolveScalarFormulaValue(args[1], sheetName, resolveCellValue, (targetSheetName, rangeText) => resolveRangeEntries(targetSheetName, rangeText).numericValues, resolveRangeEntries));
            const colIndex = args.length === 3
                ? Number(deps.resolveScalarFormulaValue(args[2], sheetName, resolveCellValue, (targetSheetName, rangeText) => resolveRangeEntries(targetSheetName, rangeText).numericValues, resolveRangeEntries))
                : 1;
            if (!rangeRef || Number.isNaN(rowIndex) || Number.isNaN(colIndex) || rowIndex < 1 || colIndex < 1)
                return null;
            const rangeStart = deps.parseCellAddress(rangeRef.start);
            const rangeEnd = deps.parseCellAddress(rangeRef.end);
            if (!rangeStart.row || !rangeStart.col || !rangeEnd.row || !rangeEnd.col)
                return null;
            const startRow = Math.min(rangeStart.row, rangeEnd.row);
            const endRow = Math.max(rangeStart.row, rangeEnd.row);
            const startCol = Math.min(rangeStart.col, rangeEnd.col);
            const endCol = Math.max(rangeStart.col, rangeEnd.col);
            const targetRow = startRow + Math.trunc(rowIndex) - 1;
            const targetCol = startCol + Math.trunc(colIndex) - 1;
            if (targetRow > endRow || targetCol > endCol)
                return null;
            return {
                sheetName: startRef.sheetName,
                start: startRef.address,
                end: `${deps.colToLetters(targetCol)}${targetRow}`
            };
        }
        function resolveStructuredRange(sheetName, text) {
            const match = String(text || "").trim().match(/^(.+?)\[([^\]]+)\]$/);
            if (!match)
                return null;
            const tableKey = deps.normalizeStructuredTableKey(match[1].replace(/^'(.*)'$/, "$1"));
            const columnKey = deps.normalizeStructuredTableKey(match[2]);
            if (!tableKey || !columnKey || columnKey.startsWith("#") || columnKey.startsWith("@"))
                return null;
            const table = tableMap.get(tableKey);
            if (!table)
                return null;
            const columnIndex = table.columns.findIndex((columnName) => deps.normalizeStructuredTableKey(columnName) === columnKey);
            if (columnIndex < 0)
                return null;
            const startAddress = deps.parseCellAddress(table.start);
            const endAddress = deps.parseCellAddress(table.end);
            if (!startAddress.row || !startAddress.col || !endAddress.row || !endAddress.col)
                return null;
            const firstDataRow = Math.min(startAddress.row, endAddress.row) + Math.max(0, table.headerRowCount);
            const lastDataRow = Math.max(startAddress.row, endAddress.row) - Math.max(0, table.totalsRowCount);
            if (firstDataRow > lastDataRow)
                return null;
            const col = Math.min(startAddress.col, endAddress.col) + columnIndex;
            const colLetters = deps.colToLetters(col);
            return {
                sheetName: table.sheetName || sheetName,
                start: `${colLetters}${firstDataRow}`,
                end: `${colLetters}${lastDataRow}`
            };
        }
        return {
            resolveCellValue,
            resolveRangeValues: (sheetName, rangeText) => resolveRangeEntries(sheetName, rangeText).numericValues,
            resolveRangeEntries,
            resolveDefinedNameValue,
            resolveDefinedNameRange,
            resolveStructuredRange
        };
    }
    function resolveSimpleFormulaReferences(workbook, deps) {
        const resolver = buildFormulaResolver(workbook, deps);
        deps.setDefinedNameResolvers?.(resolver.resolveDefinedNameValue, resolver.resolveDefinedNameRange, resolver.resolveStructuredRange);
        try {
            for (let pass = 0; pass < 8; pass += 1) {
                let resolvedInPass = 0;
                for (const sheet of workbook.sheets) {
                    for (const cell of sheet.cells) {
                        if (!cell.formulaText)
                            continue;
                        if (cell.resolutionStatus === "unsupported_external")
                            continue;
                        if (cell.resolutionStatus === "resolved")
                            continue;
                        const reference = deps.parseSimpleFormulaReference(cell.formulaText, sheet.name);
                        if (reference) {
                            const targetValue = String(resolver.resolveCellValue(reference.sheetName, reference.address) || "").trim();
                            if (targetValue) {
                                deps.applyResolvedFormulaValue(cell, targetValue, "legacy_resolver");
                                resolvedInPass += 1;
                                continue;
                            }
                        }
                        let evaluated = null;
                        let evaluatedSource = null;
                        try {
                            const result = deps.tryResolveFormulaExpressionDetailed(cell.formulaText, sheet.name, resolver.resolveCellValue, resolver.resolveRangeValues, resolver.resolveRangeEntries, cell.address);
                            evaluated = result?.value ?? null;
                            evaluatedSource = result?.source ?? null;
                        }
                        catch (error) {
                            if (!(error instanceof Error) || error.message !== "__FORMULA_UNRESOLVED__") {
                                throw error;
                            }
                        }
                        if (evaluated != null) {
                            deps.applyResolvedFormulaValue(cell, evaluated, evaluatedSource || "legacy_resolver");
                            resolvedInPass += 1;
                        }
                    }
                }
                if (resolvedInPass === 0)
                    break;
            }
        }
        finally {
            deps.setDefinedNameResolvers?.(null, null, null);
        }
    }
    const formulaResolverApi = {
        buildFormulaResolver,
        resolveSimpleFormulaReferences
    };
    moduleRegistry.registerModule("formulaResolver", formulaResolverApi);
})();

// ── formula/tokenizer ───────────────────────────────────────────
/*
 * Copyright 2026 Toshiki Iga
 * SPDX-License-Identifier: Apache-2.0
 */
(function initXlsx2mdFormulaTokenizer(global) {
    const moduleRegistry = getXlsx2mdModuleRegistry();
    const api = moduleRegistry.getModule("formulaRuntime") || {};
    const CELL_REF_RE = /^\$?[A-Za-z]{1,3}\$?\d+$/;
    const IDENTIFIER_START_RE = /[\p{L}_\\$]/u;
    const IDENTIFIER_PART_RE = /[\p{L}\p{N}_.\\$?]/u;
    function tokenizeFormula(input) {
        const source = normalizeFormulaInput(input);
        const tokens = [];
        let index = 0;
        while (index < source.length) {
            const char = source[index];
            if (/\s/.test(char)) {
                const whitespaceStart = index;
                while (index < source.length && /\s/.test(source[index])) {
                    index += 1;
                }
                const previousToken = tokens[tokens.length - 1] ?? null;
                const nextChar = source[index] ?? "";
                if (shouldEmitIntersectionOperator(previousToken, nextChar)) {
                    tokens.push({
                        type: "operator",
                        value: " ",
                        start: whitespaceStart,
                        end: index
                    });
                }
                continue;
            }
            const start = index;
            if (char === "\"") {
                const parsed = readStringLiteral(source, index);
                tokens.push({
                    type: "string",
                    value: parsed.value,
                    start,
                    end: parsed.end
                });
                index = parsed.end;
                continue;
            }
            if (char === "'") {
                const parsed = readQuotedIdentifier(source, index);
                tokens.push({
                    type: "quoted_identifier",
                    value: parsed.value,
                    start,
                    end: parsed.end
                });
                index = parsed.end;
                continue;
            }
            if (char === "#") {
                if (shouldReadErrorLiteral(source, index)) {
                    const parsed = readErrorLiteral(source, index);
                    tokens.push({
                        type: "error",
                        value: parsed.value,
                        start,
                        end: parsed.end
                    });
                    index = parsed.end;
                    continue;
                }
                tokens.push({
                    type: "operator",
                    value: "#",
                    start,
                    end: start + 1
                });
                index += 1;
                continue;
            }
            if (/[0-9.]/.test(char)) {
                const parsed = readNumberLiteral(source, index);
                if (parsed) {
                    tokens.push({
                        type: "number",
                        value: parsed.value,
                        start,
                        end: parsed.end
                    });
                    index = parsed.end;
                    continue;
                }
            }
            if ("(),;:{}![]".includes(char)) {
                tokens.push({
                    type: punctuationTypeFor(char),
                    value: char,
                    start,
                    end: start + 1
                });
                index += 1;
                continue;
            }
            const operator = readOperator(source, index);
            if (operator) {
                tokens.push({
                    type: "operator",
                    value: operator,
                    start,
                    end: start + operator.length
                });
                index += operator.length;
                continue;
            }
            if (isIdentifierStart(char)) {
                const parsed = readIdentifierLike(source, index);
                const upperValue = parsed.value.toUpperCase();
                tokens.push({
                    type: upperValue === "TRUE" || upperValue === "FALSE"
                        ? "boolean"
                        : isCellReference(parsed.value)
                            ? "cell"
                            : "identifier",
                    value: parsed.value,
                    start,
                    end: parsed.end
                });
                index = parsed.end;
                continue;
            }
            throw new Error(`Unexpected formula token at ${index}: ${char}`);
        }
        return tokens;
    }
    function normalizeFormulaInput(input) {
        return input.startsWith("=") ? input.slice(1) : input;
    }
    function readStringLiteral(source, start) {
        let index = start + 1;
        let value = "";
        while (index < source.length) {
            const char = source[index];
            if (char === "\"") {
                if (source[index + 1] === "\"") {
                    value += "\"";
                    index += 2;
                    continue;
                }
                return { value, end: index + 1 };
            }
            value += char;
            index += 1;
        }
        throw new Error(`Unterminated string literal at ${start}`);
    }
    function readQuotedIdentifier(source, start) {
        let index = start + 1;
        let value = "";
        while (index < source.length) {
            const char = source[index];
            if (char === "'") {
                if (source[index + 1] === "'") {
                    value += "'";
                    index += 2;
                    continue;
                }
                return { value, end: index + 1 };
            }
            value += char;
            index += 1;
        }
        throw new Error(`Unterminated quoted identifier at ${start}`);
    }
    function readErrorLiteral(source, start) {
        let index = start + 1;
        while (index < source.length && /[A-Za-z0-9/!?#]/.test(source[index])) {
            index += 1;
        }
        return { value: source.slice(start, index), end: index };
    }
    function readNumberLiteral(source, start) {
        const slice = source.slice(start);
        const match = slice.match(/^(?:\d+\.\d*|\.\d+|\d+)(?:[Ee][+\-]?\d+)?/);
        if (!match) {
            return null;
        }
        return {
            value: match[0],
            end: start + match[0].length
        };
    }
    function punctuationTypeFor(char) {
        switch (char) {
            case "(":
                return "lparen";
            case ")":
                return "rparen";
            case "{":
                return "lbrace";
            case "}":
                return "rbrace";
            case ",":
                return "comma";
            case ";":
                return "semicolon";
            case ":":
                return "colon";
            case "!":
                return "bang";
            case "[":
                return "lbracket";
            case "]":
                return "rbracket";
            default:
                throw new Error(`Unknown punctuation: ${char}`);
        }
    }
    function readOperator(source, start) {
        const twoChar = source.slice(start, start + 2);
        if (twoChar === "<>" || twoChar === "<=" || twoChar === ">=") {
            return twoChar;
        }
        const oneChar = source[start];
        return "+-*/&=<>%#".includes(oneChar) ? oneChar : null;
    }
    function shouldReadErrorLiteral(source, start) {
        return /^#(?:N\/A|REF!|VALUE!|NULL!|NUM!|NAME\?|DIV\/0!|CALC!|SPILL!|GETTING_DATA)/i.test(source.slice(start));
    }
    function shouldEmitIntersectionOperator(previousToken, nextChar) {
        if (!previousToken) {
            return false;
        }
        const leftTokenTypes = new Set([
            "cell",
            "identifier",
            "quoted_identifier",
            "rparen",
            "rbracket",
            "rbrace"
        ]);
        if (!leftTokenTypes.has(previousToken.type)) {
            return false;
        }
        return nextChar === "'" || nextChar === "(" || isIdentifierStart(nextChar);
    }
    function isIdentifierStart(char) {
        return IDENTIFIER_START_RE.test(char);
    }
    function isIdentifierPart(char) {
        return IDENTIFIER_PART_RE.test(char);
    }
    function readIdentifierLike(source, start) {
        let index = start;
        while (index < source.length && isIdentifierPart(source[index])) {
            index += 1;
        }
        return {
            value: source.slice(start, index),
            end: index
        };
    }
    function isCellReference(value) {
        return CELL_REF_RE.test(value);
    }
    api.tokenizeFormula = tokenizeFormula;
    api.normalizeFormulaInput = normalizeFormulaInput;
    api.isCellReference = isCellReference;
    moduleRegistry.registerModule("formulaRuntime", api);
})(globalThis);

// ── formula/parser ──────────────────────────────────────────────
/*
 * Copyright 2026 Toshiki Iga
 * SPDX-License-Identifier: Apache-2.0
 */
(function initXlsx2mdFormulaParser(global) {
    const moduleRegistry = getXlsx2mdModuleRegistry();
    const api = moduleRegistry.getModule("formulaRuntime");
    if (!api) {
        throw new Error("xlsx2md formula runtime module is not loaded");
    }
    function parseFormula(input) {
        const tokens = api.tokenizeFormula(input);
        const state = { tokens, index: 0 };
        const ast = parseComparison(state);
        if (peek(state)) {
            throw new Error(`Unexpected trailing token: ${peek(state)?.value}`);
        }
        return ast;
    }
    function parseComparison(state) {
        let left = parseConcat(state);
        while (matchOperator(state, ["=", "<>", "<", "<=", ">", ">="])) {
            const operator = consume(state).value;
            const right = parseConcat(state);
            left = { type: "binary_op", operator, left, right };
        }
        return left;
    }
    function parseConcat(state) {
        let left = parseAdditive(state);
        while (matchOperator(state, ["&"])) {
            const operator = consume(state).value;
            const right = parseAdditive(state);
            left = { type: "binary_op", operator, left, right };
        }
        return left;
    }
    function parseAdditive(state) {
        let left = parseMultiplicative(state);
        while (matchOperator(state, ["+", "-"])) {
            const operator = consume(state).value;
            const right = parseMultiplicative(state);
            left = { type: "binary_op", operator, left, right };
        }
        return left;
    }
    function parseMultiplicative(state) {
        let left = parseIntersection(state);
        while (matchOperator(state, ["*", "/"])) {
            const operator = consume(state).value;
            const right = parseIntersection(state);
            left = { type: "binary_op", operator, left, right };
        }
        return left;
    }
    function parseIntersection(state) {
        let left = parseUnary(state);
        while (matchOperator(state, [" "])) {
            const operator = consume(state).value;
            const right = parseUnary(state);
            left = { type: "binary_op", operator, left, right };
        }
        return left;
    }
    function parseUnary(state) {
        if (matchOperator(state, ["+", "-"])) {
            const operator = consume(state).value;
            return {
                type: "unary_op",
                operator,
                operand: parseUnary(state)
            };
        }
        return parsePostfix(state);
    }
    function parsePostfix(state) {
        let node = parsePrimary(state);
        while (matchOperator(state, ["%", "#"])) {
            const operator = consume(state).value;
            node = {
                type: "postfix_op",
                operator,
                operand: node
            };
        }
        return node;
    }
    function parsePrimary(state) {
        const token = peek(state);
        if (!token) {
            throw new Error("Unexpected end of formula");
        }
        if (token.type === "number") {
            consume(state);
            return {
                type: "number",
                value: Number(token.value),
                raw: token.value
            };
        }
        if (token.type === "string") {
            consume(state);
            return {
                type: "string",
                value: token.value
            };
        }
        if (token.type === "boolean") {
            consume(state);
            return {
                type: "boolean",
                value: token.value.toUpperCase() === "TRUE",
                raw: token.value
            };
        }
        if (token.type === "error") {
            consume(state);
            return {
                type: "error",
                value: token.value
            };
        }
        if (token.type === "lbrace") {
            return parseArrayConstant(state);
        }
        if (token.type === "lparen") {
            consume(state);
            const expression = parseComparison(state);
            expect(state, "rparen");
            return expression;
        }
        if (token.type === "identifier" || token.type === "cell" || token.type === "quoted_identifier") {
            return parseReferenceLike(state);
        }
        throw new Error(`Unexpected token in formula: ${token.value}`);
    }
    function parseReferenceLike(state) {
        const first = consume(state);
        if (first.type === "identifier" && peek(state)?.type === "lparen") {
            return parseFunctionCall(state, first.value);
        }
        if ((first.type === "identifier" || first.type === "quoted_identifier") && peek(state)?.type === "lbracket") {
            return parseStructuredReference(state, first.value);
        }
        if (peek(state)?.type === "bang") {
            consume(state);
            const next = consume(state);
            if (!next || (next.type !== "cell" && next.type !== "identifier")) {
                throw new Error(`Expected reference after !, got ${next?.value ?? "EOF"}`);
            }
            let node = next.type === "cell"
                ? { type: "cell", ref: next.value, sheet: first.value }
                : { type: "scoped_name", sheet: first.value, name: next.value };
            if (peek(state)?.type === "colon") {
                consume(state);
                const end = parseRangeEndpoint(state, first.value);
                node = { type: "range", start: node, end };
            }
            return node;
        }
        if (first.type === "cell") {
            const cellNode = { type: "cell", ref: first.value, sheet: null };
            if (peek(state)?.type === "colon") {
                consume(state);
                const end = parseRangeEndpoint(state, null);
                return { type: "range", start: cellNode, end };
            }
            return cellNode;
        }
        return { type: "name", name: first.value };
    }
    function parseStructuredReference(state, tableName) {
        expect(state, "lbracket");
        if (matchAndConsume(state, "lbracket")) {
            const qualifier = readStructuredReferenceSegment(state);
            expect(state, "rbracket");
            expect(state, "comma");
            expect(state, "lbracket");
            const column = readStructuredReferenceSegment(state);
            expect(state, "rbracket");
            expect(state, "rbracket");
            return {
                type: "structured_ref",
                table: tableName,
                qualifier,
                column
            };
        }
        const column = readStructuredReferenceSegment(state);
        expect(state, "rbracket");
        return {
            type: "structured_ref",
            table: tableName,
            column
        };
    }
    function readStructuredReferenceSegment(state) {
        let text = "";
        while (peek(state) && peek(state)?.type !== "rbracket") {
            const token = consume(state);
            if (!token || !["identifier", "quoted_identifier", "cell", "error", "number", "boolean", "operator"].includes(token.type)) {
                throw new Error(`Expected structured reference column, got ${token?.value ?? "EOF"}`);
            }
            if (token.type === "operator" && token.value !== "#" && token.value !== " ") {
                throw new Error(`Expected structured reference column, got ${token.value}`);
            }
            text += token.value;
        }
        if (!text.length) {
            throw new Error("Expected structured reference column, got EOF");
        }
        return text.startsWith("#")
            ? `#${text.slice(1).replace(/\s+/g, " ").trim()}`
            : text;
    }
    function parseFunctionCall(state, name) {
        expect(state, "lparen");
        const args = [];
        if (peek(state)?.type !== "rparen") {
            do {
                args.push(parseComparison(state));
            } while (matchAndConsume(state, "comma"));
        }
        expect(state, "rparen");
        return {
            type: "function_call",
            name,
            args
        };
    }
    function parseArrayConstant(state) {
        expect(state, "lbrace");
        const rows = [];
        if (peek(state)?.type !== "rbrace") {
            while (true) {
                const row = [];
                row.push(parseComparison(state));
                while (matchAndConsume(state, "comma")) {
                    row.push(parseComparison(state));
                }
                rows.push(row);
                if (!matchAndConsume(state, "semicolon")) {
                    break;
                }
            }
        }
        expect(state, "rbrace");
        return {
            type: "array_constant",
            rows
        };
    }
    function parseRangeEndpoint(state, defaultSheet) {
        const token = consume(state);
        if (!token || (token.type !== "cell" && token.type !== "identifier")) {
            throw new Error(`Expected range endpoint, got ${token?.value ?? "EOF"}`);
        }
        if (token.type === "cell") {
            return {
                type: "cell",
                ref: token.value,
                sheet: defaultSheet
            };
        }
        return {
            type: defaultSheet ? "scoped_name" : "name",
            ...(defaultSheet
                ? { sheet: defaultSheet, name: token.value }
                : { name: token.value })
        };
    }
    function peek(state) {
        return state.tokens[state.index] ?? null;
    }
    function consume(state) {
        const token = state.tokens[state.index] ?? null;
        if (token) {
            state.index += 1;
        }
        return token;
    }
    function expect(state, type) {
        const token = consume(state);
        if (!token || token.type !== type) {
            throw new Error(`Expected ${type}, got ${token?.type ?? "EOF"}`);
        }
        return token;
    }
    function matchOperator(state, operators) {
        const token = peek(state);
        return token?.type === "operator" && operators.includes(token.value);
    }
    function matchAndConsume(state, type) {
        if (peek(state)?.type === type) {
            consume(state);
            return true;
        }
        return false;
    }
    api.parseFormula = parseFormula;
    moduleRegistry.registerModule("formulaRuntime", api);
})(globalThis);

// ── formula/evaluator ───────────────────────────────────────────
/*
 * Copyright 2026 Toshiki Iga
 * SPDX-License-Identifier: Apache-2.0
 */
(function initXlsx2mdFormulaEvaluator(global) {
    const moduleRegistry = getXlsx2mdModuleRegistry();
    const api = moduleRegistry.getModule("formulaRuntime");
    if (!api) {
        throw new Error("xlsx2md formula runtime module is not loaded");
    }
    function evaluateFormulaAst(ast, context = {}) {
        switch (ast.type) {
            case "number":
                return ast.value;
            case "string":
                return ast.value;
            case "boolean":
                return ast.value;
            case "error":
                return ast.value;
            case "array_constant":
                return ast.rows.map((row) => row.map((item) => evaluateFormulaAst(item, context)));
            case "cell":
                return context.resolveCell ? context.resolveCell(ast.ref, ast.sheet) : null;
            case "name":
                return context.resolveName ? context.resolveName(ast.name) : null;
            case "scoped_name":
                if (context.resolveScopedName) {
                    return context.resolveScopedName(ast.sheet, ast.name);
                }
                return context.resolveName ? context.resolveName(`${ast.sheet}!${ast.name}`) : null;
            case "range":
                return evaluateRangeAst(ast, context);
            case "structured_ref":
                if (ast.qualifier) {
                    return null;
                }
                return context.resolveStructuredRef ? context.resolveStructuredRef(ast.table, ast.column) : null;
            case "unary_op":
                return evaluateUnaryOp(ast.operator, evaluateFormulaAst(ast.operand, context));
            case "postfix_op":
                if (ast.operator === "#" && ast.operand.type === "cell") {
                    return context.resolveSpill ? context.resolveSpill(ast.operand.ref, ast.operand.sheet) : null;
                }
                return evaluatePostfixOp(ast.operator, evaluateFormulaAst(ast.operand, context));
            case "binary_op":
                if (ast.operator === " ") {
                    return evaluateIntersectionAst(ast, context);
                }
                return evaluateBinaryOp(ast.operator, evaluateFormulaAst(ast.left, context), evaluateFormulaAst(ast.right, context));
            case "function_call":
                return evaluateFunctionCall(ast.name, ast.args, context);
            default:
                throw new Error(`Unsupported AST node: ${ast.type}`);
        }
    }
    function evaluateRangeAst(ast, context) {
        if (ast.start.type === "cell" && ast.end.type === "cell") {
            const sheet = ast.start.sheet ?? ast.end.sheet ?? null;
            if (context.resolveRange) {
                return context.resolveRange(ast.start.ref, ast.end.ref, sheet);
            }
            return [
                evaluateFormulaAst(ast.start, context),
                evaluateFormulaAst(ast.end, context)
            ];
        }
        return [
            evaluateFormulaAst(ast.start, context),
            evaluateFormulaAst(ast.end, context)
        ];
    }
    function evaluateIntersectionAst(ast, context) {
        const leftArea = toCellArea(ast.left);
        const rightArea = toCellArea(ast.right);
        if (!leftArea || !rightArea) {
            throw new Error("Unsupported intersection operands");
        }
        const leftSheet = leftArea.sheet ?? rightArea.sheet ?? null;
        const rightSheet = rightArea.sheet ?? leftArea.sheet ?? null;
        if (leftSheet !== rightSheet) {
            return "#NULL!";
        }
        const startRow = Math.max(leftArea.startRow, rightArea.startRow);
        const endRow = Math.min(leftArea.endRow, rightArea.endRow);
        const startCol = Math.max(leftArea.startCol, rightArea.startCol);
        const endCol = Math.min(leftArea.endCol, rightArea.endCol);
        if (startRow > endRow || startCol > endCol) {
            return "#NULL!";
        }
        const startRef = `${colToLetters(startCol)}${startRow}`;
        const endRef = `${colToLetters(endCol)}${endRow}`;
        if (context.resolveRange) {
            return context.resolveRange(startRef, endRef, leftSheet);
        }
        return [[`${startRef}:${endRef}`]];
    }
    function evaluateUnaryOp(operator, operand) {
        const numericValue = toNumber(operand);
        if (operator === "+") {
            return numericValue;
        }
        if (operator === "-") {
            return -numericValue;
        }
        throw new Error(`Unsupported unary operator: ${operator}`);
    }
    function evaluatePostfixOp(operator, operand) {
        if (operator === "%") {
            return toNumber(operand) / 100;
        }
        throw new Error(`Unsupported postfix operator: ${operator}`);
    }
    function evaluateBinaryOp(operator, left, right) {
        switch (operator) {
            case "+":
                return toNumber(left) + toNumber(right);
            case "-":
                return toNumber(left) - toNumber(right);
            case "*":
                return toNumber(left) * toNumber(right);
            case "/":
                return toNumber(left) / toNumber(right);
            case "&":
                return `${toText(left)}${toText(right)}`;
            case "=":
                return looselyEquals(left, right);
            case "<>":
                return !looselyEquals(left, right);
            case "<":
                return compareValues(left, right) < 0;
            case "<=":
                return compareValues(left, right) <= 0;
            case ">":
                return compareValues(left, right) > 0;
            case ">=":
                return compareValues(left, right) >= 0;
            default:
                throw new Error(`Unsupported binary operator: ${operator}`);
        }
    }
    function toCellArea(node) {
        if (node.type === "cell") {
            const position = parseCellRef(node.ref);
            if (!position) {
                return null;
            }
            return {
                sheet: node.sheet,
                startRow: position.row,
                endRow: position.row,
                startCol: position.col,
                endCol: position.col
            };
        }
        if (node.type === "range" && node.start.type === "cell" && node.end.type === "cell") {
            const start = parseCellRef(node.start.ref);
            const end = parseCellRef(node.end.ref);
            if (!start || !end) {
                return null;
            }
            return {
                sheet: node.start.sheet ?? node.end.sheet ?? null,
                startRow: Math.min(start.row, end.row),
                endRow: Math.max(start.row, end.row),
                startCol: Math.min(start.col, end.col),
                endCol: Math.max(start.col, end.col)
            };
        }
        return null;
    }
    function parseCellRef(ref) {
        const match = String(ref).toUpperCase().match(/^\$?([A-Z]{1,3})\$?(\d+)$/);
        if (!match) {
            return null;
        }
        return {
            col: lettersToCol(match[1]),
            row: Number(match[2])
        };
    }
    function lettersToCol(letters) {
        let value = 0;
        for (const char of letters) {
            value = value * 26 + (char.charCodeAt(0) - 64);
        }
        return value;
    }
    function colToLetters(column) {
        let current = column;
        let result = "";
        while (current > 0) {
            const remainder = (current - 1) % 26;
            result = String.fromCharCode(65 + remainder) + result;
            current = Math.floor((current - 1) / 26);
        }
        return result;
    }
    function evaluateFunctionCall(name, args, context) {
        const upperName = name.toUpperCase();
        switch (upperName) {
            case "IF":
                return evaluateIf(args, context);
            case "IFERROR":
                return evaluateIfError(args, context);
            case "AND":
                return evaluateAnd(args, context);
            case "OR":
                return evaluateOr(args, context);
            case "NOT":
                return evaluateNot(args, context);
            case "DATE":
                return evaluateDate(args, context);
            case "VALUE":
                return evaluateValue(args, context);
            case "ROUND":
                return evaluateRound(args, context, "round");
            case "ROUNDUP":
                return evaluateRound(args, context, "up");
            case "ROUNDDOWN":
                return evaluateRound(args, context, "down");
            case "INT":
                return evaluateInt(args, context);
            case "ABS":
                return evaluateAbs(args, context);
            case "SUM":
                return evaluateSum(args, context);
            case "SUMPRODUCT":
                return evaluateSumProduct(args, context);
            case "REPT":
                return evaluateRept(args, context);
            case "SUBSTITUTE":
                return evaluateSubstitute(args, context);
            case "MATCH":
                return evaluateMatch(args, context);
            case "INDEX":
                return evaluateIndex(args, context);
            case "VLOOKUP":
                return evaluateVLookup(args, context);
            case "HLOOKUP":
                return evaluateHLookup(args, context);
            case "XLOOKUP":
                return evaluateXLookup(args, context);
            case "TEXT":
                return evaluateText(args, context);
            case "TODAY":
                return evaluateToday(context);
            case "WEEKDAY":
                return evaluateWeekday(args, context);
            case "DATEVALUE":
                return evaluateDateValue(args, context);
            case "LEN":
                return evaluateLen(args, context);
            case "LOWER":
                return evaluateLower(args, context);
            case "FIND":
                return evaluateFind(args, context, false);
            case "SEARCH":
                return evaluateFind(args, context, true);
            case "LEFT":
                return evaluateLeft(args, context);
            case "RIGHT":
                return evaluateRight(args, context);
            case "MID":
                return evaluateMid(args, context);
            case "TRIM":
                return evaluateTrim(args, context);
            case "REPLACE":
                return evaluateReplace(args, context);
            case "DAY":
                return evaluateDay(args, context);
            case "MONTH":
                return evaluateMonth(args, context);
            case "YEAR":
                return evaluateYear(args, context);
            case "SUBTOTAL":
                return evaluateSubtotal(args, context);
            case "UPPER":
                return evaluateUpper(args, context);
            case "CONCATENATE":
                return evaluateConcatenate(args, context);
            case "ISBLANK":
                return evaluateIsBlank(args, context);
            case "ISNUMBER":
                return evaluateIsNumber(args, context);
            case "ISTEXT":
                return evaluateIsText(args, context);
            case "ISERROR":
                return evaluateIsError(args, context);
            case "ISNA":
                return evaluateIsNa(args, context);
            case "NA":
                return evaluateNa();
            case "MIN":
                return evaluateMin(args, context);
            case "MAX":
                return evaluateMax(args, context);
            case "AVERAGE":
                return evaluateAverage(args, context);
            case "COLUMN":
                return evaluateColumn(args, context);
            case "ROW":
                return evaluateRow(args, context);
            case "EDATE":
                return evaluateEDate(args, context);
            case "EOMONTH":
                return evaluateEoMonth(args, context);
            case "COUNTIF":
                return evaluateCountIf(args, context);
            case "COUNTIFS":
                return evaluateCountIfs(args, context);
            case "COUNT":
                return evaluateCount(args, context);
            case "COUNTA":
                return evaluateCountA(args, context);
            case "SUMIF":
                return evaluateSumIf(args, context);
            case "SUMIFS":
                return evaluateSumIfs(args, context);
            case "AVERAGEIF":
                return evaluateAverageIf(args, context);
            case "AVERAGEIFS":
                return evaluateAverageIfs(args, context);
            default:
                throw new Error(`Unsupported formula function: ${name}`);
        }
    }
    function evaluateIf(args, context) {
        const condition = toBoolean(evaluateFormulaAst(args[0], context));
        if (condition) {
            return args[1] ? evaluateFormulaAst(args[1], context) : true;
        }
        return args[2] ? evaluateFormulaAst(args[2], context) : false;
    }
    function evaluateIfError(args, context) {
        const primary = evaluateFormulaAst(args[0], context);
        if (isFormulaError(primary)) {
            return args[1] ? evaluateFormulaAst(args[1], context) : "";
        }
        return primary;
    }
    function evaluateAnd(args, context) {
        return args.every((arg) => toBoolean(evaluateFormulaAst(arg, context)));
    }
    function evaluateOr(args, context) {
        return args.some((arg) => toBoolean(evaluateFormulaAst(arg, context)));
    }
    function evaluateNot(args, context) {
        return !toBoolean(evaluateFormulaAst(args[0], context));
    }
    function evaluateDate(args, context) {
        const year = toNumber(evaluateFormulaAst(args[0], context));
        const month = toNumber(evaluateFormulaAst(args[1], context));
        const day = toNumber(evaluateFormulaAst(args[2], context));
        return excelSerialFromDate(year, month, day);
    }
    function evaluateValue(args, context) {
        const rawValue = evaluateFormulaAst(args[0], context);
        if (typeof rawValue === "number") {
            return rawValue;
        }
        const text = toText(rawValue).trim();
        if (!text) {
            return 0;
        }
        const dateValue = parseDateLikeString(text);
        if (dateValue !== null) {
            return dateValue;
        }
        const normalized = text.replace(/,/g, "");
        const parsed = Number(normalized);
        if (!Number.isNaN(parsed)) {
            return parsed;
        }
        throw new Error(`Unsupported VALUE input: ${text}`);
    }
    function evaluateRound(args, context, mode) {
        const value = toNumber(evaluateFormulaAst(args[0], context));
        const digits = args[1] ? Math.trunc(toNumber(evaluateFormulaAst(args[1], context))) : 0;
        const factor = Math.pow(10, digits);
        const scaled = value * factor;
        if (mode === "round") {
            return Math.round(scaled) / factor;
        }
        if (mode === "up") {
            return (scaled >= 0 ? Math.ceil(scaled) : Math.floor(scaled)) / factor;
        }
        return (scaled >= 0 ? Math.floor(scaled) : Math.ceil(scaled)) / factor;
    }
    function evaluateInt(args, context) {
        return Math.floor(toNumber(evaluateFormulaAst(args[0], context)));
    }
    function evaluateAbs(args, context) {
        return Math.abs(toNumber(evaluateFormulaAst(args[0], context)));
    }
    function evaluateSum(args, context) {
        return args
            .flatMap((arg) => flattenValues(evaluateFormulaAst(arg, context)))
            .reduce((sum, value) => sum + toNumber(value), 0);
    }
    function evaluateSumProduct(args, context) {
        const vectors = args.map((arg) => flattenValues(evaluateFormulaAst(arg, context)));
        if (!vectors.length) {
            return 0;
        }
        const lengths = vectors.map((vector) => vector.length);
        const maxLength = Math.max(...lengths);
        const normalized = vectors.map((vector) => {
            if (vector.length === maxLength) {
                return vector;
            }
            if (vector.length === 1) {
                return Array.from({ length: maxLength }, () => vector[0]);
            }
            throw new Error("SUMPRODUCT arguments must have the same length");
        });
        let total = 0;
        for (let index = 0; index < maxLength; index += 1) {
            let product = 1;
            for (const vector of normalized) {
                product *= toNumber(vector[index] ?? 0);
            }
            total += product;
        }
        return total;
    }
    function evaluateRept(args, context) {
        const text = toText(evaluateFormulaAst(args[0], context));
        const countValue = evaluateFormulaAst(args[1], context);
        const count = Math.max(0, Math.floor(toNumber(countValue)));
        return text.repeat(count);
    }
    function evaluateSubstitute(args, context) {
        const text = toText(evaluateFormulaAst(args[0], context));
        const oldText = toText(evaluateFormulaAst(args[1], context));
        const newText = toText(evaluateFormulaAst(args[2], context));
        const instanceNum = args[3] ? Math.floor(toNumber(evaluateFormulaAst(args[3], context))) : null;
        if (!oldText) {
            return text;
        }
        if (!instanceNum || instanceNum < 1) {
            return text.split(oldText).join(newText);
        }
        let occurrence = 0;
        let searchIndex = 0;
        let result = "";
        while (true) {
            const foundIndex = text.indexOf(oldText, searchIndex);
            if (foundIndex === -1) {
                result += text.slice(searchIndex);
                break;
            }
            occurrence += 1;
            result += text.slice(searchIndex, foundIndex);
            if (occurrence === instanceNum) {
                result += newText;
            }
            else {
                result += oldText;
            }
            searchIndex = foundIndex + oldText.length;
        }
        return result;
    }
    function evaluateMatch(args, context) {
        const lookupValue = evaluateFormulaAst(args[0], context);
        const lookupArray = flattenValues(evaluateFormulaAst(args[1], context));
        for (let index = 0; index < lookupArray.length; index += 1) {
            if (looselyEquals(lookupArray[index], lookupValue)) {
                return index + 1;
            }
        }
        return "#N/A";
    }
    function evaluateIndex(args, context) {
        const source = evaluateFormulaAst(args[0], context);
        const rowNumber = args[1] ? Math.max(1, Math.floor(toNumber(evaluateFormulaAst(args[1], context)))) : 1;
        const columnNumber = args[2] ? Math.max(1, Math.floor(toNumber(evaluateFormulaAst(args[2], context)))) : 1;
        if (!Array.isArray(source)) {
            return source;
        }
        if (source.length > 0 && Array.isArray(source[0])) {
            const row = source[rowNumber - 1] ?? [];
            return row[columnNumber - 1] ?? null;
        }
        if (columnNumber === 1) {
            return source[rowNumber - 1] ?? null;
        }
        return source[columnNumber - 1] ?? null;
    }
    function evaluateVLookup(args, context) {
        const lookupValue = evaluateFormulaAst(args[0], context);
        const table = normalizeToMatrix(evaluateFormulaAst(args[1], context));
        const columnNumber = Math.max(1, Math.floor(toNumber(evaluateFormulaAst(args[2], context))));
        const approximate = args[3] ? toBoolean(evaluateFormulaAst(args[3], context)) : true;
        if (approximate) {
            let matchedRow = null;
            for (const row of table) {
                if (looselyEquals(row[0], lookupValue)) {
                    return row[columnNumber - 1] ?? "#N/A";
                }
                if (compareValues(row[0], lookupValue) <= 0) {
                    matchedRow = row;
                }
            }
            return matchedRow ? matchedRow[columnNumber - 1] ?? "#N/A" : "#N/A";
        }
        for (const row of table) {
            if (looselyEquals(row[0], lookupValue)) {
                return row[columnNumber - 1] ?? "#N/A";
            }
        }
        return "#N/A";
    }
    function evaluateHLookup(args, context) {
        const lookupValue = evaluateFormulaAst(args[0], context);
        const table = normalizeToMatrix(evaluateFormulaAst(args[1], context));
        const rowNumber = Math.max(1, Math.floor(toNumber(evaluateFormulaAst(args[2], context))));
        const approximate = args[3] ? toBoolean(evaluateFormulaAst(args[3], context)) : true;
        const headerRow = table[0] ?? [];
        const targetRow = table[rowNumber - 1] ?? [];
        if (approximate) {
            let matchedIndex = -1;
            for (let index = 0; index < headerRow.length; index += 1) {
                if (looselyEquals(headerRow[index], lookupValue)) {
                    return targetRow[index] ?? "#N/A";
                }
                if (compareValues(headerRow[index], lookupValue) <= 0) {
                    matchedIndex = index;
                }
            }
            return matchedIndex >= 0 ? targetRow[matchedIndex] ?? "#N/A" : "#N/A";
        }
        for (let index = 0; index < headerRow.length; index += 1) {
            if (looselyEquals(headerRow[index], lookupValue)) {
                return targetRow[index] ?? "#N/A";
            }
        }
        return "#N/A";
    }
    function evaluateXLookup(args, context) {
        const lookupValue = evaluateFormulaAst(args[0], context);
        const lookupArray = flattenValues(evaluateFormulaAst(args[1], context));
        const returnArray = flattenValues(evaluateFormulaAst(args[2], context));
        const notFoundValue = args[3] ? evaluateFormulaAst(args[3], context) : "#N/A";
        const matchMode = args[4] ? Math.trunc(toNumber(evaluateFormulaAst(args[4], context))) : 0;
        const searchMode = args[5] ? Math.trunc(toNumber(evaluateFormulaAst(args[5], context))) : 1;
        if (searchMode === 2 || searchMode === -2) {
            const matchedIndex = findXLookupBinaryIndex(lookupArray, lookupValue, matchMode, searchMode);
            return matchedIndex >= 0 ? returnArray[matchedIndex] ?? notFoundValue : notFoundValue;
        }
        const indices = searchMode === -1
            ? Array.from({ length: lookupArray.length }, (_, index) => lookupArray.length - 1 - index)
            : Array.from({ length: lookupArray.length }, (_, index) => index);
        for (const index of indices) {
            if (looselyEquals(lookupArray[index], lookupValue)) {
                return returnArray[index] ?? notFoundValue;
            }
        }
        if (matchMode === 2) {
            const matcher = createExcelWildcardMatcher(lookupValue);
            if (!matcher) {
                return notFoundValue;
            }
            for (const index of indices) {
                if (matcher(toText(lookupArray[index]))) {
                    return returnArray[index] ?? notFoundValue;
                }
            }
            return notFoundValue;
        }
        if (matchMode === -1) {
            let matchedIndex = -1;
            for (const index of indices) {
                if (compareValues(lookupArray[index], lookupValue) <= 0) {
                    matchedIndex = index;
                    if (searchMode === -1) {
                        break;
                    }
                }
            }
            return matchedIndex >= 0 ? returnArray[matchedIndex] ?? notFoundValue : notFoundValue;
        }
        if (matchMode === 1) {
            let matchedIndex = -1;
            for (const index of indices) {
                if (compareValues(lookupArray[index], lookupValue) >= 0) {
                    matchedIndex = index;
                    break;
                }
            }
            return matchedIndex >= 0 ? returnArray[matchedIndex] ?? notFoundValue : notFoundValue;
        }
        return notFoundValue;
    }
    function findXLookupBinaryIndex(lookupArray, lookupValue, matchMode, searchMode) {
        const descending = searchMode === -2;
        let low = 0;
        let high = lookupArray.length - 1;
        let fallbackIndex = -1;
        while (low <= high) {
            const mid = Math.floor((low + high) / 2);
            const compare = compareValues(lookupArray[mid], lookupValue);
            if (looselyEquals(lookupArray[mid], lookupValue)) {
                return mid;
            }
            if (matchMode === -1) {
                if (compare <= 0 && (fallbackIndex < 0 || compareValues(lookupArray[mid], lookupArray[fallbackIndex]) > 0)) {
                    fallbackIndex = mid;
                }
            }
            else if (matchMode === 1) {
                if (compare >= 0 && (fallbackIndex < 0 || compareValues(lookupArray[mid], lookupArray[fallbackIndex]) < 0)) {
                    fallbackIndex = mid;
                }
            }
            if ((!descending && compare < 0) || (descending && compare > 0)) {
                low = mid + 1;
            }
            else {
                high = mid - 1;
            }
        }
        return fallbackIndex;
    }
    function evaluateText(args, context) {
        const value = evaluateFormulaAst(args[0], context);
        const format = toText(evaluateFormulaAst(args[1], context)).toLowerCase();
        if (format === "0000") {
            const number = Math.floor(Math.abs(toNumber(value)));
            const sign = toNumber(value) < 0 ? "-" : "";
            return `${sign}${String(number).padStart(4, "0")}`;
        }
        if (format === "0" || format === "0.0" || format === "0.00") {
            const digits = format.includes(".") ? format.split(".")[1].length : 0;
            return toNumber(value).toFixed(digits);
        }
        if (format === "#,##0" || format === "#,##0.00") {
            const digits = format.includes(".") ? format.split(".")[1].length : 0;
            return toNumber(value).toLocaleString("en-US", {
                minimumFractionDigits: digits,
                maximumFractionDigits: digits
            });
        }
        if (format === "yyyy/mm/dd" || format === "yyyy-mm-dd") {
            const parts = excelSerialToDateParts(toNumber(value));
            const separator = format.includes("/") ? "/" : "-";
            return `${parts.year}${separator}${parts.month}${separator}${parts.day}`;
        }
        return toText(value);
    }
    function createExcelWildcardMatcher(patternValue) {
        const pattern = toText(patternValue);
        if (!pattern) {
            return null;
        }
        let regexText = "^";
        for (let index = 0; index < pattern.length; index += 1) {
            const char = pattern[index];
            if (char === "~" && index + 1 < pattern.length) {
                regexText += escapeRegExp(pattern[index + 1]);
                index += 1;
                continue;
            }
            if (char === "*") {
                regexText += ".*";
                continue;
            }
            if (char === "?") {
                regexText += ".";
                continue;
            }
            regexText += escapeRegExp(char);
        }
        regexText += "$";
        const regex = new RegExp(regexText, "i");
        return (value) => regex.test(String(value ?? ""));
    }
    function escapeRegExp(value) {
        return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
    function evaluateToday(context) {
        const now = context.currentDate ?? new Date();
        return excelSerialFromDate(now.getUTCFullYear(), now.getUTCMonth() + 1, now.getUTCDate());
    }
    function evaluateWeekday(args, context) {
        const serial = toNumber(evaluateFormulaAst(args[0], context));
        const returnType = args[1] ? Math.max(1, Math.floor(toNumber(evaluateFormulaAst(args[1], context)))) : 1;
        const excelEpoch = Date.UTC(1899, 11, 30);
        const utcDate = new Date(excelEpoch + Math.floor(serial) * 86400000);
        const jsDay = utcDate.getUTCDay(); // 0=Sun..6=Sat
        switch (returnType) {
            case 1:
                return jsDay + 1;
            case 2:
                return jsDay === 0 ? 7 : jsDay;
            case 3:
                return jsDay === 0 ? 6 : jsDay - 1;
            default:
                return jsDay + 1;
        }
    }
    function evaluateDateValue(args, context) {
        const text = toText(evaluateFormulaAst(args[0], context)).trim();
        const dateValue = parseDateLikeString(text);
        if (dateValue === null) {
            throw new Error(`Unsupported DATEVALUE input: ${text}`);
        }
        return dateValue;
    }
    function evaluateLen(args, context) {
        return toText(evaluateFormulaAst(args[0], context)).length;
    }
    function evaluateLower(args, context) {
        return toText(evaluateFormulaAst(args[0], context)).toLowerCase();
    }
    function evaluateFind(args, context, ignoreCase) {
        const findTextRaw = toText(evaluateFormulaAst(args[0], context));
        const withinTextRaw = toText(evaluateFormulaAst(args[1], context));
        const start = args[2] ? Math.max(1, Math.floor(toNumber(evaluateFormulaAst(args[2], context)))) : 1;
        const findText = ignoreCase ? findTextRaw.toLowerCase() : findTextRaw;
        const withinText = ignoreCase ? withinTextRaw.toLowerCase() : withinTextRaw;
        const index = withinText.indexOf(findText, start - 1);
        return index === -1 ? "#VALUE!" : index + 1;
    }
    function evaluateLeft(args, context) {
        const text = toText(evaluateFormulaAst(args[0], context));
        const count = args[1] ? Math.max(0, Math.floor(toNumber(evaluateFormulaAst(args[1], context)))) : 1;
        return text.slice(0, count);
    }
    function evaluateRight(args, context) {
        const text = toText(evaluateFormulaAst(args[0], context));
        const count = args[1] ? Math.max(0, Math.floor(toNumber(evaluateFormulaAst(args[1], context)))) : 1;
        return count === 0 ? "" : text.slice(-count);
    }
    function evaluateMid(args, context) {
        const text = toText(evaluateFormulaAst(args[0], context));
        const start = Math.max(1, Math.floor(toNumber(evaluateFormulaAst(args[1], context))));
        const count = Math.max(0, Math.floor(toNumber(evaluateFormulaAst(args[2], context))));
        return text.slice(start - 1, start - 1 + count);
    }
    function evaluateTrim(args, context) {
        const text = toText(evaluateFormulaAst(args[0], context));
        return text.trim().replace(/\s+/g, " ");
    }
    function evaluateReplace(args, context) {
        const text = toText(evaluateFormulaAst(args[0], context));
        const start = Math.max(1, Math.floor(toNumber(evaluateFormulaAst(args[1], context))));
        const count = Math.max(0, Math.floor(toNumber(evaluateFormulaAst(args[2], context))));
        const newText = toText(evaluateFormulaAst(args[3], context));
        const prefix = text.slice(0, start - 1);
        const suffix = text.slice(start - 1 + count);
        return `${prefix}${newText}${suffix}`;
    }
    function evaluateDay(args, context) {
        const serial = coerceDateSerial(evaluateFormulaAst(args[0], context));
        return excelSerialToDateParts(serial).day;
    }
    function evaluateMonth(args, context) {
        const serial = coerceDateSerial(evaluateFormulaAst(args[0], context));
        return excelSerialToDateParts(serial).month;
    }
    function evaluateYear(args, context) {
        const serial = coerceDateSerial(evaluateFormulaAst(args[0], context));
        return excelSerialToDateParts(serial).year;
    }
    function evaluateSubtotal(args, context) {
        const functionNum = Math.floor(toNumber(evaluateFormulaAst(args[0], context)));
        const values = args.slice(1).flatMap((arg) => flattenValues(evaluateFormulaAst(arg, context)));
        switch (functionNum) {
            case 1:
            case 101:
                return values.length ? values.reduce((sum, value) => sum + toNumber(value), 0) / values.length : "#DIV/0!";
            case 4:
            case 104:
                return values.reduce((max, value) => Math.max(max, toNumber(value)), Number.NEGATIVE_INFINITY);
            case 5:
            case 105:
                return values.reduce((min, value) => Math.min(min, toNumber(value)), Number.POSITIVE_INFINITY);
            case 9:
            case 109:
                return values.reduce((sum, value) => sum + toNumber(value), 0);
            default:
                throw new Error(`Unsupported SUBTOTAL function_num: ${functionNum}`);
        }
    }
    function evaluateUpper(args, context) {
        return toText(evaluateFormulaAst(args[0], context)).toUpperCase();
    }
    function evaluateConcatenate(args, context) {
        return args.map((arg) => toText(evaluateFormulaAst(arg, context))).join("");
    }
    function evaluateIsBlank(args, context) {
        const value = evaluateFormulaAst(args[0], context);
        return value === null || value === undefined || value === "";
    }
    function evaluateIsNumber(args, context) {
        const value = evaluateFormulaAst(args[0], context);
        if (typeof value === "number") {
            return true;
        }
        if (typeof value === "string") {
            if (!value.trim()) {
                return false;
            }
            const parsed = Number(value.replace(/,/g, ""));
            return !Number.isNaN(parsed);
        }
        return false;
    }
    function evaluateIsText(args, context) {
        const value = evaluateFormulaAst(args[0], context);
        return typeof value === "string";
    }
    function evaluateIsError(args, context) {
        return isFormulaError(evaluateFormulaAst(args[0], context));
    }
    function evaluateIsNa(args, context) {
        return evaluateFormulaAst(args[0], context) === "#N/A";
    }
    function evaluateNa() {
        return "#N/A";
    }
    function evaluateMin(args, context) {
        const values = args.flatMap((arg) => flattenValues(evaluateFormulaAst(arg, context))).map((value) => toNumber(value));
        return values.length ? Math.min(...values) : 0;
    }
    function evaluateMax(args, context) {
        const values = args.flatMap((arg) => flattenValues(evaluateFormulaAst(arg, context))).map((value) => toNumber(value));
        return values.length ? Math.max(...values) : 0;
    }
    function evaluateAverage(args, context) {
        const values = args.flatMap((arg) => flattenValues(evaluateFormulaAst(arg, context))).map((value) => toNumber(value));
        if (!values.length) {
            return "#DIV/0!";
        }
        return values.reduce((sum, value) => sum + value, 0) / values.length;
    }
    function evaluateColumn(args, context) {
        if (!args.length) {
            if (context.currentCellRef) {
                return columnNumberFromRef(context.currentCellRef);
            }
            throw new Error("COLUMN without explicit reference is not supported");
        }
        const node = args[0];
        if (node.type === "cell") {
            return columnNumberFromRef(node.ref);
        }
        if (node.type === "range" && node.start.type === "cell") {
            return columnNumberFromRef(node.start.ref);
        }
        const value = evaluateFormulaAst(node, context);
        if (typeof value === "string" && /\$?[A-Za-z]{1,3}\$?\d+/.test(value)) {
            return columnNumberFromRef(value);
        }
        throw new Error("Unsupported COLUMN argument");
    }
    function evaluateRow(args, context) {
        if (!args.length) {
            if (context.currentCellRef) {
                return rowNumberFromRef(context.currentCellRef);
            }
            throw new Error("ROW without explicit reference is not supported");
        }
        const node = args[0];
        if (node.type === "cell") {
            return rowNumberFromRef(node.ref);
        }
        if (node.type === "range" && node.start.type === "cell") {
            return rowNumberFromRef(node.start.ref);
        }
        const value = evaluateFormulaAst(node, context);
        if (typeof value === "string" && /\$?[A-Za-z]{1,3}\$?\d+/.test(value)) {
            return rowNumberFromRef(value);
        }
        throw new Error("Unsupported ROW argument");
    }
    function evaluateEDate(args, context) {
        const startSerial = coerceDateSerial(evaluateFormulaAst(args[0], context));
        const months = Math.trunc(toNumber(evaluateFormulaAst(args[1], context)));
        const parts = excelSerialToDateParts(startSerial);
        const jsDate = new Date(Date.UTC(parts.year, parts.month - 1 + months, parts.day));
        return excelSerialFromDate(jsDate.getUTCFullYear(), jsDate.getUTCMonth() + 1, jsDate.getUTCDate());
    }
    function evaluateEoMonth(args, context) {
        const startSerial = coerceDateSerial(evaluateFormulaAst(args[0], context));
        const months = Math.trunc(toNumber(evaluateFormulaAst(args[1], context)));
        const parts = excelSerialToDateParts(startSerial);
        const jsDate = new Date(Date.UTC(parts.year, parts.month + months, 0));
        return excelSerialFromDate(jsDate.getUTCFullYear(), jsDate.getUTCMonth() + 1, jsDate.getUTCDate());
    }
    function evaluateCountIf(args, context) {
        const values = flattenValues(evaluateFormulaAst(args[0], context));
        const criteria = toText(evaluateFormulaAst(args[1], context));
        return values.filter((value) => matchesCriteria(value, criteria)).length;
    }
    function evaluateCount(args, context) {
        return args
            .flatMap((arg) => flattenValues(evaluateFormulaAst(arg, context)))
            .filter((value) => isCountableNumber(value))
            .length;
    }
    function evaluateCountA(args, context) {
        return args
            .flatMap((arg) => flattenValues(evaluateFormulaAst(arg, context)))
            .filter((value) => value !== null && value !== undefined && String(value) !== "")
            .length;
    }
    function evaluateSumIf(args, context) {
        const criteriaValues = flattenValues(evaluateFormulaAst(args[0], context));
        const criteria = toText(evaluateFormulaAst(args[1], context));
        const sumValues = args[2]
            ? flattenValues(evaluateFormulaAst(args[2], context))
            : criteriaValues;
        let total = 0;
        for (let index = 0; index < criteriaValues.length; index += 1) {
            if (matchesCriteria(criteriaValues[index], criteria)) {
                total += toNumber(sumValues[index] ?? 0);
            }
        }
        return total;
    }
    function evaluateCountIfs(args, context) {
        const criteriaPairs = [];
        for (let index = 0; index + 1 < args.length; index += 2) {
            criteriaPairs.push({
                values: flattenValues(evaluateFormulaAst(args[index], context)),
                criteria: toText(evaluateFormulaAst(args[index + 1], context))
            });
        }
        const maxLength = criteriaPairs.reduce((max, pair) => Math.max(max, pair.values.length), 0);
        let count = 0;
        for (let index = 0; index < maxLength; index += 1) {
            const matched = criteriaPairs.every((pair) => matchesCriteria(pair.values[index], pair.criteria));
            if (matched) {
                count += 1;
            }
        }
        return count;
    }
    function evaluateSumIfs(args, context) {
        const sumValues = flattenValues(evaluateFormulaAst(args[0], context));
        const criteriaPairs = [];
        for (let index = 1; index + 1 < args.length; index += 2) {
            criteriaPairs.push({
                values: flattenValues(evaluateFormulaAst(args[index], context)),
                criteria: toText(evaluateFormulaAst(args[index + 1], context))
            });
        }
        let total = 0;
        for (let index = 0; index < sumValues.length; index += 1) {
            const matched = criteriaPairs.every((pair) => matchesCriteria(pair.values[index], pair.criteria));
            if (matched) {
                total += toNumber(sumValues[index] ?? 0);
            }
        }
        return total;
    }
    function evaluateAverageIf(args, context) {
        const criteriaValues = flattenValues(evaluateFormulaAst(args[0], context));
        const criteria = toText(evaluateFormulaAst(args[1], context));
        const averageValues = args[2]
            ? flattenValues(evaluateFormulaAst(args[2], context))
            : criteriaValues;
        let total = 0;
        let count = 0;
        for (let index = 0; index < criteriaValues.length; index += 1) {
            if (matchesCriteria(criteriaValues[index], criteria)) {
                total += toNumber(averageValues[index] ?? 0);
                count += 1;
            }
        }
        return count === 0 ? "#DIV/0!" : total / count;
    }
    function evaluateAverageIfs(args, context) {
        const averageValues = flattenValues(evaluateFormulaAst(args[0], context));
        const criteriaPairs = [];
        for (let index = 1; index + 1 < args.length; index += 2) {
            criteriaPairs.push({
                values: flattenValues(evaluateFormulaAst(args[index], context)),
                criteria: toText(evaluateFormulaAst(args[index + 1], context))
            });
        }
        let total = 0;
        let count = 0;
        for (let index = 0; index < averageValues.length; index += 1) {
            const matched = criteriaPairs.every((pair) => matchesCriteria(pair.values[index], pair.criteria));
            if (matched) {
                total += toNumber(averageValues[index] ?? 0);
                count += 1;
            }
        }
        return count === 0 ? "#DIV/0!" : total / count;
    }
    function excelSerialFromDate(year, month, day) {
        const utcDate = Date.UTC(year, month - 1, day);
        const excelEpoch = Date.UTC(1899, 11, 30);
        return Math.floor((utcDate - excelEpoch) / 86400000);
    }
    function excelSerialToDateParts(serial) {
        const excelEpoch = Date.UTC(1899, 11, 30);
        const utcDate = new Date(excelEpoch + Math.floor(serial) * 86400000);
        return {
            year: utcDate.getUTCFullYear(),
            month: utcDate.getUTCMonth() + 1,
            day: utcDate.getUTCDate()
        };
    }
    function parseDateLikeString(value) {
        const normalized = value.replace(/[年\/.-]/g, "/").replace(/月/g, "/").replace(/日/g, "");
        const match = normalized.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
        if (!match) {
            return null;
        }
        return excelSerialFromDate(Number(match[1]), Number(match[2]), Number(match[3]));
    }
    function coerceDateSerial(value) {
        if (typeof value === "number") {
            return value;
        }
        const text = toText(value).trim();
        const parsed = parseDateLikeString(text);
        if (parsed !== null) {
            return parsed;
        }
        return toNumber(value);
    }
    function columnNumberFromRef(ref) {
        const match = String(ref).match(/\$?([A-Za-z]{1,3})\$?\d+/);
        if (!match) {
            throw new Error(`Invalid cell reference for COLUMN: ${ref}`);
        }
        const letters = match[1].toUpperCase();
        let number = 0;
        for (const char of letters) {
            number = number * 26 + (char.charCodeAt(0) - 64);
        }
        return number;
    }
    function rowNumberFromRef(ref) {
        const match = String(ref).match(/\$?[A-Za-z]{1,3}\$?(\d+)/);
        if (!match) {
            throw new Error(`Invalid cell reference for ROW: ${ref}`);
        }
        return Number(match[1]);
    }
    function toBoolean(value) {
        if (typeof value === "boolean") {
            return value;
        }
        if (typeof value === "number") {
            return value !== 0;
        }
        if (typeof value === "string") {
            if (!value) {
                return false;
            }
            const upper = value.toUpperCase();
            if (upper === "TRUE") {
                return true;
            }
            if (upper === "FALSE") {
                return false;
            }
            return true;
        }
        if (Array.isArray(value)) {
            return value.length > 0;
        }
        return Boolean(value);
    }
    function toNumber(value) {
        if (typeof value === "number") {
            return value;
        }
        if (typeof value === "boolean") {
            return value ? 1 : 0;
        }
        if (typeof value === "string") {
            const normalized = value.replace(/,/g, "");
            const parsed = Number(normalized);
            if (!Number.isNaN(parsed)) {
                return parsed;
            }
            if (value.toUpperCase() === "TRUE") {
                return 1;
            }
            if (value.toUpperCase() === "FALSE") {
                return 0;
            }
        }
        if (Array.isArray(value)) {
            return value.length;
        }
        return 0;
    }
    function toText(value) {
        if (value === null || value === undefined) {
            return "";
        }
        if (Array.isArray(value)) {
            return value.map((item) => toText(item)).join(":");
        }
        return String(value);
    }
    function flattenValues(value) {
        if (!Array.isArray(value)) {
            return [value];
        }
        if (value.length > 0 && Array.isArray(value[0])) {
            return value.flat();
        }
        return value;
    }
    function normalizeToMatrix(value) {
        if (!Array.isArray(value)) {
            return [[value]];
        }
        if (value.length > 0 && Array.isArray(value[0])) {
            return value;
        }
        return [value];
    }
    function matchesCriteria(value, criteria) {
        const trimmedCriteria = criteria.trim();
        const match = trimmedCriteria.match(/^(<=|>=|<>|=|<|>)(.*)$/);
        if (!match) {
            return looselyEquals(value, trimmedCriteria);
        }
        const operator = match[1];
        const rightRaw = match[2].trim();
        const leftNumeric = toNumber(value);
        const rightNumeric = Number(rightRaw.replace(/,/g, ""));
        if (!Number.isNaN(leftNumeric) && !Number.isNaN(rightNumeric)) {
            switch (operator) {
                case "<":
                    return leftNumeric < rightNumeric;
                case "<=":
                    return leftNumeric <= rightNumeric;
                case ">":
                    return leftNumeric > rightNumeric;
                case ">=":
                    return leftNumeric >= rightNumeric;
                case "=":
                    return leftNumeric === rightNumeric;
                case "<>":
                    return leftNumeric !== rightNumeric;
            }
        }
        const leftText = toText(value);
        switch (operator) {
            case "=":
                return leftText === rightRaw;
            case "<>":
                return leftText !== rightRaw;
            case "<":
                return leftText < rightRaw;
            case "<=":
                return leftText <= rightRaw;
            case ">":
                return leftText > rightRaw;
            case ">=":
                return leftText >= rightRaw;
            default:
                return false;
        }
    }
    function isCountableNumber(value) {
        if (typeof value === "number") {
            return true;
        }
        if (typeof value === "string") {
            const trimmed = value.trim();
            if (!trimmed) {
                return false;
            }
            return !Number.isNaN(Number(trimmed.replace(/,/g, "")));
        }
        return false;
    }
    function isFormulaError(value) {
        return typeof value === "string" && /^#(?:N\/A|REF!|VALUE!|DIV\/0!|NAME\?|NUM!|NULL!)/.test(value);
    }
    function looselyEquals(left, right) {
        if (typeof left === "number" || typeof right === "number") {
            return toNumber(left) === toNumber(right);
        }
        if (typeof left === "boolean" || typeof right === "boolean") {
            return toBoolean(left) === toBoolean(right);
        }
        return toText(left) === toText(right);
    }
    function compareValues(left, right) {
        if (typeof left === "number" || typeof right === "number") {
            return toNumber(left) - toNumber(right);
        }
        const leftText = toText(left);
        const rightText = toText(right);
        if (leftText === rightText) {
            return 0;
        }
        return leftText < rightText ? -1 : 1;
    }
    api.evaluateFormulaAst = evaluateFormulaAst;
    moduleRegistry.registerModule("formulaRuntime", api);
})(globalThis);

// ── core ────────────────────────────────────────────────────────
/*
 * Copyright 2026 Toshiki Iga
 * SPDX-License-Identifier: Apache-2.0
 */
(() => {
    const EMPTY_BORDERS = {
        top: false,
        bottom: false,
        left: false,
        right: false
    };
    const moduleRegistry = getXlsx2mdModuleRegistry();
    function requireCoreNarrativeStructure() {
        return requireXlsx2mdNarrativeStructureModule();
    }
    function requireCoreTableDetector() {
        return requireXlsx2mdTableDetectorModule();
    }
    function requireCoreMarkdownExport() {
        return requireXlsx2mdMarkdownExportModule();
    }
    function requireCoreStylesParser() {
        return requireXlsx2mdStylesParserModule();
    }
    function requireCoreWorksheetTables() {
        return requireXlsx2mdWorksheetTablesModule();
    }
    function requireCoreCellFormat() {
        return requireXlsx2mdCellFormatModule();
    }
    function requireCoreAddressUtils() {
        return requireXlsx2mdAddressUtilsModule();
    }
    function requireCoreSheetMarkdown() {
        return requireXlsx2mdSheetMarkdownModule();
    }
    function requireCoreFormulaEngine() {
        return requireXlsx2mdFormulaEngineModule();
    }
    function requireCoreSheetAssets() {
        return requireXlsx2mdSheetAssetsModule();
    }
    function requireCoreWorksheetParser() {
        return requireXlsx2mdWorksheetParserModule();
    }
    function requireCoreWorkbookLoader() {
        return requireXlsx2mdWorkbookLoaderModule();
    }
    function requireCoreFormulaResolver() {
        return requireXlsx2mdFormulaResolverModule();
    }
    const drawingHelper = getXlsx2mdDrawingHelperModule();
    const markdownNormalizeHelper = requireXlsx2mdMarkdownNormalize();
    const narrativeStructureHelper = requireCoreNarrativeStructure();
    const tableDetectorHelper = requireCoreTableDetector();
    const markdownExportHelper = requireCoreMarkdownExport();
    const stylesParserHelper = requireCoreStylesParser();
    const sharedStringsHelper = requireXlsx2mdSharedStringsModule();
    const worksheetTablesHelper = requireCoreWorksheetTables();
    const cellFormatHelper = requireCoreCellFormat();
    const xmlUtilsHelper = requireXlsx2mdXmlUtilsModule();
    const addressUtilsHelper = requireCoreAddressUtils();
    const relsParserModule = requireXlsx2mdRelsParserModule();
    const formulaReferenceUtilsModule = requireXlsx2mdFormulaReferenceUtilsModule();
    const sheetMarkdownModule = requireCoreSheetMarkdown();
    const formulaEngineModule = requireCoreFormulaEngine();
    const sheetAssetsHelper = requireCoreSheetAssets();
    const worksheetParserHelper = requireCoreWorksheetParser();
    const workbookLoaderHelper = requireCoreWorkbookLoader();
    const formulaResolverHelper = requireCoreFormulaResolver();
    const formulaLegacyModule = requireXlsx2mdFormulaLegacyModule();
    const formulaAstModule = requireXlsx2mdFormulaAstModule();
    const zipIoHelper = moduleRegistry.requireModule("zipIo", "xlsx2md zip io module is not loaded");
    let resolveDefinedNameScalarValue = null;
    let resolveDefinedNameRangeRef = null;
    let resolveStructuredRangeRef = null;
    const DEFAULT_CELL_WIDTH_EMU = 609600;
    const DEFAULT_CELL_HEIGHT_EMU = 190500;
    const SHAPE_BLOCK_GAP_X_EMU = DEFAULT_CELL_WIDTH_EMU * 4;
    const SHAPE_BLOCK_GAP_Y_EMU = DEFAULT_CELL_HEIGHT_EMU * 6;
    const { colToLetters, lettersToCol, parseCellAddress, normalizeFormulaAddress, formatRange, parseRangeRef, parseRangeAddress } = addressUtilsHelper;
    const { xmlToDocument, getElementsByLocalName, getFirstChildByLocalName, getDirectChildByLocalName, decodeXmlText, getTextContent } = xmlUtilsHelper;
    const relsParserHelper = relsParserModule.createRelsParserApi({
        xmlToDocument,
        decodeXmlText
    });
    const { normalizeZipPath, parseRelationshipEntries, parseRelationships, buildRelsPath } = relsParserHelper;
    const formulaReferenceUtilsHelper = formulaReferenceUtilsModule.createFormulaReferenceUtilsApi({
        normalizeFormulaAddress
    });
    const { parseSimpleFormulaReference, parseSheetScopedDefinedNameReference, normalizeFormulaSheetName, normalizeDefinedNameKey } = formulaReferenceUtilsHelper;
    const formulaLegacyHelper = formulaLegacyModule.createFormulaLegacyApi({
        normalizeFormulaSheetName,
        normalizeFormulaAddress,
        parseSimpleFormulaReference,
        parseSheetScopedDefinedNameReference,
        parseRangeAddress,
        parseCellAddress,
        colToLetters,
        tryResolveFormulaExpression: (formulaText, currentSheetName, resolveCellValue, resolveRangeValues, resolveRangeEntries, currentAddress) => tryResolveFormulaExpression(formulaText, currentSheetName, resolveCellValue, resolveRangeValues, resolveRangeEntries, currentAddress),
        getDefinedNameScalarValue: () => resolveDefinedNameScalarValue,
        getDefinedNameRangeRef: () => resolveDefinedNameRangeRef,
        getStructuredRangeRef: () => resolveStructuredRangeRef,
        cellFormat: cellFormatHelper
    });
    const formulaAstHelper = formulaAstModule.createFormulaAstApi({
        normalizeFormulaAddress,
        parseSheetScopedDefinedNameReference,
        parseRangeAddress,
        parseCellAddress
    });
    const sheetMarkdownHelper = sheetMarkdownModule.createSheetMarkdownApi({
        renderNarrativeBlock: narrativeStructureHelper.renderNarrativeBlock,
        detectTableCandidates: (sheet, buildCellMapForSheet, tableDetectionMode = "balanced") => tableDetectorHelper.detectTableCandidates(sheet, buildCellMapForSheet, undefined, tableDetectionMode),
        matrixFromCandidate: tableDetectorHelper.matrixFromCandidate,
        renderMarkdownTable: markdownExportHelper.renderMarkdownTable,
        createOutputFileName: markdownExportHelper.createOutputFileName,
        extractShapeBlocks: sheetAssetsHelper.extractShapeBlocks,
        renderHierarchicalRawEntries: sheetAssetsHelper.renderHierarchicalRawEntries,
        parseCellAddress,
        formatRange,
        colToLetters,
        normalizeMarkdownText: markdownNormalizeHelper.normalizeMarkdownText,
        defaultCellWidthEmu: DEFAULT_CELL_WIDTH_EMU,
        defaultCellHeightEmu: DEFAULT_CELL_HEIGHT_EMU,
        shapeBlockGapXEmu: SHAPE_BLOCK_GAP_X_EMU,
        shapeBlockGapYEmu: SHAPE_BLOCK_GAP_Y_EMU
    });
    const formulaEngineHelper = formulaEngineModule.createFormulaEngineApi({
        getDefinedNameScalarValue: () => resolveDefinedNameScalarValue,
        tryResolveFormulaExpressionWithAst: (expression, currentSheetName, resolveCellValue, resolveRangeEntries, currentAddress) => tryResolveFormulaExpressionWithAst(expression, currentSheetName, resolveCellValue, resolveRangeEntries, currentAddress),
        tryResolveFormulaExpressionLegacy: (normalized, currentSheetName, resolveCellValue, resolveRangeValues, resolveRangeEntries) => tryResolveFormulaExpressionLegacy(normalized, currentSheetName, resolveCellValue, resolveRangeValues, resolveRangeEntries)
    });
    const { findTopLevelOperatorIndex, parseWholeFunctionCall, splitFormulaArguments, parseQualifiedRangeReference, resolveScalarFormulaValue } = formulaLegacyHelper;
    const { buildCellMap, formatCellForMarkdown, isCellInAnyTable, extractNarrativeBlocks, splitNarrativeRowSegments, extractSectionBlocks, convertSheetToMarkdown, convertWorkbookToMarkdownFiles } = sheetMarkdownHelper;
    const tryResolveFormulaExpressionLegacy = formulaLegacyHelper.tryResolveFormulaExpressionLegacy;
    const tryResolveFormulaExpressionDetailed = formulaEngineHelper.tryResolveFormulaExpressionDetailed;
    const tryResolveFormulaExpression = formulaEngineHelper.tryResolveFormulaExpression;
    const tryResolveFormulaExpressionWithAst = (expression, currentSheetName, resolveCellValue, resolveRangeEntries, currentAddress) => formulaAstHelper.tryResolveFormulaExpressionWithAst(expression, currentSheetName, resolveCellValue, resolveDefinedNameScalarValue, resolveDefinedNameRangeRef, resolveStructuredRangeRef, resolveSpillRange, resolveRangeEntries, currentAddress);
    function resolveSpillRange(_sheetName, _ref) {
        return null;
    }
    function createWorksheetParseDeps() {
        return {
            EMPTY_BORDERS,
            xmlToDocument,
            decodeXmlText,
            getTextContent,
            parseCellAddress,
            parseRangeRef,
            parseWorksheetTables: worksheetTablesHelper.parseWorksheetTables,
            parseDrawingImages: sheetAssetsHelper.parseDrawingImages,
            parseDrawingCharts: sheetAssetsHelper.parseDrawingCharts,
            parseDrawingShapes: sheetAssetsHelper.parseDrawingShapes,
            parseRelationshipEntries,
            buildRelsPath,
            formatCellDisplayValue: cellFormatHelper.formatCellDisplayValue,
            buildAssetDeps: () => ({
                parseRelationships,
                buildRelsPath,
                xmlToDocument,
                decodeXmlText,
                getElementsByLocalName,
                getFirstChildByLocalName,
                getDirectChildByLocalName,
                getTextContent,
                colToLetters,
                drawingHelper,
                defaultCellWidthEmu: DEFAULT_CELL_WIDTH_EMU,
                defaultCellHeightEmu: DEFAULT_CELL_HEIGHT_EMU,
                shapeBlockGapXEmu: SHAPE_BLOCK_GAP_X_EMU,
                shapeBlockGapYEmu: SHAPE_BLOCK_GAP_Y_EMU
            }),
            lettersToCol,
            colToLetters
        };
    }
    function createFormulaResolverDeps() {
        return {
            normalizeStructuredTableKey: worksheetTablesHelper.normalizeStructuredTableKey,
            normalizeFormulaSheetName,
            normalizeDefinedNameKey,
            normalizeFormulaAddress,
            parseSimpleFormulaReference,
            resolveScalarFormulaValue,
            parseQualifiedRangeReference,
            findTopLevelOperatorIndex,
            parseWholeFunctionCall,
            splitFormulaArguments,
            parseCellAddress,
            colToLetters,
            parseRangeAddress,
            tryResolveFormulaExpressionDetailed,
            applyResolvedFormulaValue: cellFormatHelper.applyResolvedFormulaValue,
            setDefinedNameResolvers: (scalar, range, structured) => {
                resolveDefinedNameScalarValue = scalar;
                resolveDefinedNameRangeRef = range;
                resolveStructuredRangeRef = structured;
            }
        };
    }
    async function parseWorkbook(arrayBuffer, workbookName = "workbook.xlsx") {
        const worksheetParseDeps = createWorksheetParseDeps();
        const formulaResolverDeps = createFormulaResolverDeps();
        return workbookLoaderHelper.parseWorkbook(arrayBuffer, workbookName, {
            unzipEntries: zipIoHelper.unzipEntries,
            parseSharedStrings: sharedStringsHelper.parseSharedStrings,
            parseCellStyles: stylesParserHelper.parseCellStyles,
            parseRelationships,
            xmlToDocument,
            decodeXmlText,
            getTextContent,
            parseWorksheet: (files, name, sheetPath, sheetIndex, sharedStrings, cellStyles) => worksheetParserHelper.parseWorksheet(files, name, sheetPath, sheetIndex, sharedStrings, cellStyles, worksheetParseDeps),
            postProcessWorkbook: (workbook) => {
                formulaResolverHelper.resolveSimpleFormulaReferences(workbook, formulaResolverDeps);
            }
        });
    }
    const xlsx2mdApi = {
        parseWorkbook,
        unzipEntries: zipIoHelper.unzipEntries,
        parseRangeRef,
        applyMergeTokens: tableDetectorHelper.applyMergeTokens,
        detectTableCandidates: (sheet, tableDetectionMode = "balanced") => tableDetectorHelper.detectTableCandidates(sheet, buildCellMap, undefined, tableDetectionMode),
        extractNarrativeBlocks,
        convertSheetToMarkdown,
        convertWorkbookToMarkdownFiles,
        createSummaryText: markdownExportHelper.createSummaryText,
        createCombinedMarkdownExportFile: markdownExportHelper.createCombinedMarkdownExportFile,
        createExportEntries: markdownExportHelper.createExportEntries,
        createWorkbookExportArchive: markdownExportHelper.createWorkbookExportArchive,
        formatRange,
        colToLetters,
        lettersToCol,
        textEncoder: markdownExportHelper.textEncoder
    };
    moduleRegistry.registerModule("xlsx2md", xlsx2mdApi);
})();


// ── ES module exports ───────────────────────────────────────────────────────
const __xlsx2md = globalThis.__xlsx2mdModuleRegistry.getModule("xlsx2md");
export default __xlsx2md;
export const parseWorkbook = __xlsx2md.parseWorkbook;
export const convertWorkbookToMarkdownFiles = __xlsx2md.convertWorkbookToMarkdownFiles;
export const createCombinedMarkdownExportFile = __xlsx2md.createCombinedMarkdownExportFile;
export const createExportEntries = __xlsx2md.createExportEntries;
