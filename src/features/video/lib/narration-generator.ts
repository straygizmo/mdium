import { callAI } from "@/shared/lib/callAI";
import { useSettingsStore } from "@/stores/settings-store";
import type { Scene, SceneElement } from "../types";

const SYSTEM_PROMPT = `You are a presentation narration writer.
Generate natural, spoken narration from the slide content, as if addressing an audience.
- Use polite, audience-facing tone
- Convert bullet points into natural sentences
- Keep the length readable in 30 seconds to 1 minute
- Return ONLY the narration text (no explanations or annotations)
- Write the narration in the SAME LANGUAGE as the input content`;

function buildContentText(elements: SceneElement[]): string {
  const parts: string[] = [];
  let headingCount = 0;

  for (const el of elements) {
    switch (el.type) {
      case "title":
        headingCount++;
        parts.push(`[見出し${headingCount}] ${el.text}`);
        break;
      case "text":
        parts.push(el.content);
        break;
      case "bullet-list":
        for (const item of el.items) {
          parts.push(`・${item}`);
        }
        break;
      case "table":
        parts.push(`[表] ${el.headers.join(", ")}`);
        break;
      case "code-block":
        parts.push(`[コード: ${el.language}]`);
        break;
      case "image":
        if (el.alt) {
          parts.push(`[画像: ${el.alt}]`);
        }
        break;
    }
  }

  return parts.join("\n");
}

function buildFallback(elements: SceneElement[]): string {
  const parts: string[] = [];

  for (const el of elements) {
    switch (el.type) {
      case "title":
        parts.push(el.text);
        break;
      case "bullet-list":
        parts.push(el.items.join("。"));
        break;
    }
  }

  return parts.join("。");
}

export async function generateNarrationForScene(scene: Scene): Promise<string> {
  const contentText = buildContentText(scene.elements);
  const prompt = contentText.trim() || scene.title || "";

  try {
    const aiSettings = useSettingsStore.getState().aiSettings;
    const response = await callAI(aiSettings, SYSTEM_PROMPT, prompt);
    return response;
  } catch {
    return buildFallback(scene.elements);
  }
}

export async function generateNarrationsForScenes(
  scenes: Scene[],
  onProgress?: (sceneIndex: number) => void,
): Promise<Map<string, string>> {
  const result = new Map<string, string>();

  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];
    if (!scene.narration || !scene.narration.trim()) {
      const narration = await generateNarrationForScene(scene);
      result.set(scene.id, narration);
    }
    onProgress?.(i);
  }

  return result;
}
