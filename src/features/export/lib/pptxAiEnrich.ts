import { callAI } from "@/shared/lib/callAI";
import { useSettingsStore } from "@/stores/settings-store";
import { pptxAiEnrichSystemPrompt } from "@/shared/lib/constants";
import { pptxToMarkdownPreview } from "./pptxToMarkdownPreview";
import { extractPptxLayout, type SlideLayout } from "./pptxLayout";
import type { PptxLabels } from "./pptxParser";

export interface EnrichLabels {
  aiSection: string;
  lang: string;
}

const SLIDE_SEPARATOR = "\n\n---\n\n";
const MAX_CONCURRENCY = 4;

// Serialize a slide layout into a compact textual payload for the LLM.
function layoutToPayload(layout: SlideLayout): string {
  const shapeLines = layout.shapes.map(
    (s) => `[${s.id}] (${s.x},${s.y} ${s.w}x${s.h}): ${s.text.replace(/\n/g, " / ")}`,
  );
  const connLines = layout.connectors.map((c) => `${c.from ?? "?"} -> ${c.to ?? "?"}`);
  return (
    "Shapes:\n" + (shapeLines.join("\n") || "(none)") +
    "\n\nConnectors:\n" + (connLines.join("\n") || "(none)")
  );
}

// Run async tasks with bounded concurrency, preserving input order in output.
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

// Build AI-enriched preview markdown: deterministic markdown per slide with an
// "AI interpretation" section appended. Slides whose AI call fails keep only
// their deterministic markdown. Throws only if deterministic extraction fails.
export async function pptxToMarkdownPreviewEnriched(
  data: Uint8Array,
  labels: PptxLabels,
  enrich: EnrichLabels,
): Promise<string> {
  const md = await pptxToMarkdownPreview(data, labels);
  const layouts = await extractPptxLayout(data);

  const chunks = md.split(SLIDE_SEPARATOR);
  // Safety: if slide boundaries don't line up with layouts, skip AI insertion.
  if (chunks.length !== layouts.length) {
    return md;
  }

  const aiSettings = useSettingsStore.getState().aiSettings;
  const systemPrompt = pptxAiEnrichSystemPrompt(enrich.lang);

  const enriched = await mapWithConcurrency(chunks, MAX_CONCURRENCY, async (chunk, i) => {
    try {
      const interpretation = await callAI(aiSettings, systemPrompt, layoutToPayload(layouts[i]));
      const body = interpretation.trim();
      if (!body) return chunk;
      return `${chunk}\n\n### ${enrich.aiSection}\n\n${body}`;
    } catch {
      // Per-slide failure: keep deterministic markdown only.
      return chunk;
    }
  });

  return enriched.join(SLIDE_SEPARATOR);
}
