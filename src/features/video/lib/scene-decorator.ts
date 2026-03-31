import { callAI } from "@/shared/lib/callAI";
import { useSettingsStore } from "@/stores/settings-store";
import type {
  VideoProject,
  SceneElement,
  BackgroundEffect,
} from "../types";

const SYSTEM_PROMPT = `You are a video scene visual designer.
Analyze the content of each scene and return appropriate background effects and animation settings in JSON format.

Available background effects:
- gradient: Gradient background (colors: string[], angle?: number)
- gradient-animation: Animated gradient (colors: string[], speed?: number)
- particles: Particle effects (preset: "stars"|"snow"|"fireflies"|"bubbles")
- wave-visualizer: Waveform visualizer (bars?: number, color?: string)
- three-particles: 3D particles (preset: "floating"|"galaxy"|"rain")
- three-geometry: 3D geometry (preset: "wireframe-sphere"|"rotating-cube"|"wave-mesh")
- lottie: Lottie animation (preset: "confetti"|"checkmark"|"loading"|"arrows"|"sparkle"|"wave"|"pulse")
- none: No effect

Available element animations:
- title: "fade-in"|"slide-in"|"typewriter"|"none"
- text: "fade-in"|"none"
- bullet-list: "sequential"|"fade-in"|"none"
- image: "fade-in"|"zoom-in"|"ken-burns"|"none" (also supports position: "center"|"left"|"right"|"background")
- table: "fade-in"|"row-by-row"|"none"
- code-block: "fade-in"|"none"

Available caption styles:
- "default": Standard captions
- "tiktok": Word-highlight animated captions

Guidelines:
- Technical content → gradient (blue tones) + particles (stars)
- Intro/outro → gradient-animation + lottie (sparkle)
- Data/numerical → three-geometry (wave-mesh)
- Code explanations → gradient (dark colors) + none
- Suggest a project theme that matches the overall tone
- Choose background effects that don't distract from the content
- Vary effects across scenes; avoid using the same effect consecutively
- For image elements, also set "position" in elementAnimations
- Use "background" position for atmospheric/decorative images
- Use "ken-burns" animation for photos to add visual interest
- Use "zoom-in" for diagrams or screenshots to draw attention
- Use "center" position + "fade-in" animation as safe defaults for images

Return ONLY JSON in the following format (no explanations or comments):
{
  "theme": {
    "backgroundEffect": { "type": "gradient-animation", "colors": ["#1a1a2e", "#16213e", "#0f3460"] },
    "captionStyle": "default"
  },
  "scenes": {
    "scene-1": {
      "backgroundEffect": { "type": "particles", "preset": "stars" },
      "elementAnimations": { "0": { "animation": "typewriter" }, "1": { "animation": "fade-in" }, "2": { "animation": "ken-burns", "position": "center" } }
    },
    "scene-2": {
      "backgroundEffect": { "type": "gradient", "colors": ["#0f3460", "#533483"], "angle": 135 }
    }
  }
}
The keys in "scenes" must match the input scene IDs. The keys in "elementAnimations" are zero-based element indices.`;

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
      elementAnimations?: Record<string, { animation: string; position?: string }>;
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
          return `[画像: ${el.src.split(/[\\/]/).pop() ?? ""}] ${el.alt ?? ""}`;
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
        const validAnimations: Record<string, Set<string>> = {
          title: new Set(["fade-in", "slide-in", "typewriter", "none"]),
          text: new Set(["fade-in", "none"]),
          "bullet-list": new Set(["sequential", "fade-in", "none"]),
          image: new Set(["fade-in", "zoom-in", "ken-burns", "none"]),
          table: new Set(["fade-in", "row-by-row", "none"]),
          "code-block": new Set(["fade-in", "none"]),
        };
        const updates: Record<string, unknown> = {};
        if (validAnimations[el.type]?.has(anim.animation)) {
          updates.animation = anim.animation;
        }
        if (el.type === "image" && anim.position) {
          const validPositions = new Set(["center", "left", "right", "background"]);
          if (validPositions.has(anim.position)) {
            updates.position = anim.position;
          }
        }
        if (Object.keys(updates).length === 0) return el;
        return { ...el, ...updates } as typeof el;
      });
    }

    return updatedScene;
  });

  return updatedProject;
}

export async function decorateWithLLM(project: VideoProject): Promise<VideoProject> {
  const userMessage = buildUserMessage(project);

  const aiSettings = useSettingsStore.getState().aiSettings;
  const response = await callAI(aiSettings, SYSTEM_PROMPT, userMessage, 4096);

  let jsonStr = response.trim();
  const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    jsonStr = fenceMatch[1].trim();
  }

  // Clean up common LLM JSON issues: comments and trailing commas
  jsonStr = jsonStr
    .replace(/\/\/.*$/gm, "")          // single-line comments
    .replace(/\/\*[\s\S]*?\*\//g, "")  // multi-line comments
    .replace(/,\s*([}\]])/g, "$1");    // trailing commas

  const result = JSON.parse(jsonStr) as Partial<DecorationResult>;
  if (!result.theme || !result.scenes) {
    throw new Error("LLM response missing 'theme' or 'scenes'");
  }
  return applyResult(project, result as DecorationResult);
}
