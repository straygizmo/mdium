// Node environment for the shared document converters: an XML DOMParser
// (browsers have one built in) and a pdfjs build that runs without a DOM or
// a separate worker file, so it works from a single esbuild bundle.
import { DOMParser as XmldomParser } from "@xmldom/xmldom";
import type { ConvertEnv, PdfjsLike, PptxLabels } from "../../src/features/export/lib/core";

/** English labels: the Markdown is read by agents, not shown in the UI. */
export const AGENT_PPTX_LABELS: PptxLabels = {
  slideFallback: (n: number) => `Slide ${n}`,
  notes: "Notes:",
};

/** Parses XML like the browser's DOMParser, without logging parse warnings. */
class QuietXmlParser {
  parseFromString(source: string, mimeType: string): Document {
    const parser = new XmldomParser({
      errorHandler: {
        warning: () => {},
        error: () => {},
        fatalError: (message: string) => {
          throw new Error(`XML parse error: ${message}`);
        },
      },
    });
    return parser.parseFromString(source, mimeType) as unknown as Document;
  }
}

let domInstalled = false;

/**
 * Install `globalThis.DOMParser` (xmldom) unless the environment already has
 * one, and polyfill `Element.children`, which xmldom 0.8 lacks.
 */
export function installXmlDom(): void {
  if (domInstalled) return;
  domInstalled = true;
  if (typeof (globalThis as { DOMParser?: unknown }).DOMParser === "function") return;
  (globalThis as { DOMParser?: unknown }).DOMParser = QuietXmlParser;
  const element = new XmldomParser().parseFromString("<a/>", "application/xml").documentElement;
  const proto = element ? Object.getPrototypeOf(element) : null;
  if (proto && !("children" in proto)) {
    Object.defineProperty(proto, "children", {
      configurable: true,
      get(this: { childNodes: ArrayLike<{ nodeType: number }> }) {
        return Array.from(this.childNodes).filter((node) => node.nodeType === 1);
      },
    });
  }
}

/**
 * pdfjs constructs a DOMMatrix while its module loads; Node has none, and the
 * native @napi-rs/canvas polyfill pdfjs looks for is not shipped. Text
 * extraction never renders, so an identity-matrix stand-in is enough.
 */
function installDomMatrixStub(): void {
  const scope = globalThis as { DOMMatrix?: unknown };
  if (scope.DOMMatrix) return;
  scope.DOMMatrix = class DOMMatrixStub {
    a = 1;
    b = 0;
    c = 0;
    d = 1;
    e = 0;
    f = 0;
    constructor(init?: unknown) {
      if (Array.isArray(init) && init.length === 6) {
        [this.a, this.b, this.c, this.d, this.e, this.f] = init as number[];
      }
    }
  };
}

let pdfjsPromise: Promise<PdfjsLike> | undefined;

/**
 * The legacy (Node) build of pdfjs with its worker running in-process
 * (`globalThis.pdfjsWorker`), and warnings silenced: pdfjs logs through
 * console.log, which would corrupt a stdio protocol.
 */
export function loadNodePdfjs(): Promise<PdfjsLike> {
  pdfjsPromise ??= (async () => {
    installDomMatrixStub();
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const scope = globalThis as { pdfjsWorker?: unknown };
    scope.pdfjsWorker ??= await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
    return {
      getDocument: (src: { data: Uint8Array }) =>
        pdfjs.getDocument({
          ...src,
          verbosity: pdfjs.VerbosityLevel.ERRORS,
          isEvalSupported: false,
          disableFontFace: true,
          useSystemFonts: false,
        }),
    } as unknown as PdfjsLike;
  })();
  return pdfjsPromise;
}

/** The conversion environment used by every Node-side converter. */
export function nodeConvertEnv(): ConvertEnv {
  installXmlDom();
  return { loadPdfjs: loadNodePdfjs, pptxLabels: AGENT_PPTX_LABELS };
}

/** Send console output to stderr, keeping stdout free for a line protocol. */
export function routeConsoleToStderr(): void {
  const toStderr = (...args: unknown[]) => {
    process.stderr.write(`${args.map((a) => (typeof a === "string" ? a : String(a))).join(" ")}\n`);
  };
  console.log = toStderr;
  console.info = toStderr;
  console.warn = toStderr;
  console.debug = toStderr;
}
