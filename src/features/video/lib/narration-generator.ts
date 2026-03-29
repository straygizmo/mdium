import { invoke } from "@tauri-apps/api/core";
import type { Scene, SceneElement } from "../types";

const SYSTEM_PROMPT = `あなたはプレゼンテーションのナレーション作成者です。
スライドの内容から、聴衆に語りかける自然な話し言葉のナレーションを生成してください。
- 丁寧語で、聴衆に語りかける口調
- 箇条書きの内容を自然な文章に変換
- 30秒〜1分程度で読み上げられる長さ
- ナレーションテキストのみを返してください（説明や注釈は不要）`;

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
    const response = await invoke<string>("ai_chat", {
      systemPrompt: SYSTEM_PROMPT,
      userMessage: prompt,
    });
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
