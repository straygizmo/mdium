import { invoke } from "@tauri-apps/api/core";
import type {
  VideoProject,
  SceneElement,
  BackgroundEffect,
} from "../types";

const SYSTEM_PROMPT = `あなたは動画シーンのビジュアルデザイナーです。
各シーンの内容を分析し、適切な背景エフェクトとアニメーション設定をJSON形式で返してください。

利用可能な背景エフェクト:
- gradient: グラデーション背景 (colors: string[], angle?: number)
- gradient-animation: アニメーション付きグラデーション (colors: string[], speed?: number)
- particles: パーティクル (preset: "stars"|"snow"|"fireflies"|"bubbles")
- wave-visualizer: 波形 (bars?: number, color?: string)
- three-particles: 3Dパーティクル (preset: "floating"|"galaxy"|"rain")
- three-geometry: 3Dジオメトリ (preset: "wireframe-sphere"|"rotating-cube"|"wave-mesh")
- lottie: Lottieアニメーション (preset: "confetti"|"checkmark"|"loading"|"arrows"|"sparkle"|"wave"|"pulse")
- none: エフェクトなし

利用可能なエレメントアニメーション:
- title: "fade-in"|"slide-in"|"typewriter"|"none"
- text: "fade-in"|"none"
- bullet-list: "sequential"|"fade-in"|"none"
- image: "fade-in"|"zoom-in"|"ken-burns"|"none"
- table: "fade-in"|"row-by-row"|"none"
- code-block: "fade-in"|"none"

利用可能な字幕スタイル:
- "default": 通常字幕
- "tiktok": 単語ハイライト付きアニメーション字幕

ガイドライン:
- 技術的な内容 → gradient(青系) + particles(stars)
- 導入・まとめ → gradient-animation + lottie(sparkle)
- データ・数値系 → three-geometry(wave-mesh)
- コード解説 → gradient(暗い色) + none
- 全体トーンに合わせてプロジェクトテーマも提案
- 背景エフェクトはコンテンツの邪魔にならないものを選ぶ
- 同じエフェクトを連続で使わず、シーンごとに変化をつける

JSON形式のみを返してください（説明や注釈は不要）。`;

interface SceneSummary {
  id: string;
  title: string | undefined;
  elementSummary: string;
  hasNarration: boolean;
}

interface DecorationResult {
  theme: {
    backgroundEffect: BackgroundEffect;
    captionStyle: "default" | "tiktok";
  };
  scenes: Record<
    string,
    {
      backgroundEffect?: BackgroundEffect;
      elementAnimations?: Record<string, { animation: string }>;
    }
  >;
}

function buildElementSummary(elements: SceneElement[]): string {
  return elements
    .map((el) => {
      switch (el.type) {
        case "title":
          return `[見出し${el.level}] ${el.text}`;
        case "text":
          return `[テキスト] ${el.content.slice(0, 50)}`;
        case "bullet-list":
          return `[箇条書き] ${el.items.length}項目`;
        case "image":
          return `[画像] ${el.alt ?? ""}`;
        case "table":
          return `[表] ${el.headers.join(", ")}`;
        case "code-block":
          return `[コード: ${el.language}]`;
        case "progress-bar":
          return `[プログレスバー] ${Math.round(el.progress * 100)}%`;
        default:
          return "";
      }
    })
    .filter(Boolean)
    .join(", ");
}

function buildUserMessage(project: VideoProject): string {
  const summaries: SceneSummary[] = project.scenes.map((scene) => ({
    id: scene.id,
    title: scene.title,
    elementSummary: buildElementSummary(scene.elements),
    hasNarration: !!scene.narration?.trim(),
  }));

  return JSON.stringify(
    {
      projectTitle: project.meta.title,
      sceneCount: project.scenes.length,
      scenes: summaries,
    },
    null,
    2
  );
}

function applyResult(project: VideoProject, result: DecorationResult): VideoProject {
  const updatedProject = { ...project };

  updatedProject.theme = {
    backgroundEffect: result.theme.backgroundEffect,
    captionStyle: result.theme.captionStyle,
  };

  updatedProject.scenes = project.scenes.map((scene) => {
    const sceneDecor = result.scenes[scene.id];
    if (!sceneDecor) return scene;

    const updatedScene = { ...scene };

    if (sceneDecor.backgroundEffect) {
      updatedScene.backgroundEffect = sceneDecor.backgroundEffect;
    }

    if (sceneDecor.elementAnimations) {
      updatedScene.elements = scene.elements.map((el, i) => {
        const anim = sceneDecor.elementAnimations?.[String(i)];
        if (!anim) return el;
        return { ...el, animation: anim.animation } as typeof el;
      });
    }

    return updatedScene;
  });

  return updatedProject;
}

export async function decorateWithLLM(project: VideoProject): Promise<VideoProject> {
  const userMessage = buildUserMessage(project);

  try {
    const response = await invoke<string>("ai_chat", {
      systemPrompt: SYSTEM_PROMPT,
      userMessage,
    });

    let jsonStr = response.trim();
    const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) {
      jsonStr = fenceMatch[1].trim();
    }

    const result: DecorationResult = JSON.parse(jsonStr);
    return applyResult(project, result);
  } catch (e) {
    console.error("scene-decorator LLM call failed:", e);
    return project;
  }
}
