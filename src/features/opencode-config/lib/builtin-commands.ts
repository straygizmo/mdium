import type { BuiltinCommand } from "@/shared/types";

export const BUILTIN_COMMANDS: Record<string, BuiltinCommand> = {
  "generate-video-scenario": {
    name: "generate-video-scenario",
    description:
      "Convert Markdown to VideoProject JSON with AI-powered scene splitting and narration",
    template: `# Video Scenario Generator

Read the Markdown file specified in the first argument, analyze its content,
and generate a VideoProject JSON file at the path specified in the second argument.

## Instructions

1. Read the Markdown file at the first argument path.
2. Analyze the content structure, topics, and flow.
3. Generate a complete VideoProject JSON following the schema below.
4. Write the JSON to the second argument path.

## Scene Splitting Rules

- If \`<!-- pagebreak -->\` markers exist in the Markdown, use them as scene boundaries.
- If no markers exist, split based on heading structure (h1/h2) and topic changes.
- Target 30–60 seconds of narration per scene.
- Split scenes that are too information-dense; merge scenes that are too thin.

## Narration Rules

- If \`<!-- narration: text -->\` exists for a scene, use that text as the narration.
- Otherwise, write natural narration summarizing the scene content.
- Use a conversational presenter tone — professional but approachable.
- Match the language of the source Markdown content.
- Do NOT simply concatenate bullet points. Write flowing sentences.

## Image Handling

- Markdown images (\`![alt](path)\` or \`<img>\` tags) become ImageElement entries.
- Resolve relative paths against the Markdown file's directory to produce absolute paths.
- Choose \`position\`: \`"center"\` for standalone images, \`"left"\` or \`"right"\` when alongside text, \`"background"\` for full-bleed backgrounds.
- Choose \`animation\`: \`"fade-in"\` for standard, \`"zoom-in"\` for detail shots, \`"ken-burns"\` for photos/landscapes.

## Animation & Transition Guide

- Title/cover scenes: transition \`"fade"\`
- Continuation of the same topic: transition \`"none"\` or \`"slide-left"\`
- New topic/section: transition \`"fade"\` or \`"slide-up"\`
- Bullet lists: animation \`"sequential"\`
- Code blocks: animation \`"fade-in"\`
- Tables: animation \`"row-by-row"\`
- Titles: animation \`"fade-in"\` or \`"slide-in"\`
- Keep it professional — avoid excessive motion.

## Meta Settings

- \`title\`: Extract from the document's main heading.
- Default: \`1920×1080\`, \`16:9\`, \`30 fps\`.
- For vertical/mobile content, consider \`1080×1920\`, \`9:16\`.

## VideoProject JSON Schema

\`\`\`typescript
interface VideoProject {
  meta: VideoMeta;
  audio: AudioConfig;
  scenes: Scene[];
}

interface VideoMeta {
  title: string;
  width: number;    // default 1920
  height: number;   // default 1080
  fps: number;      // default 30
  aspectRatio: "16:9" | "9:16" | "4:3" | "1:1";
}

interface AudioConfig {
  bgm?: { src: string; volume: number };
  tts?: {
    provider: "voicevox" | "openai" | "google";
    speaker?: string;   // VOICEVOX speaker ID, default "1"
    volume: number;     // default 1.0
    speed?: number;     // default 1.0
  };
}

interface Scene {
  id: string;              // "scene-1", "scene-2", ...
  title?: string;          // from first heading in scene
  narration: string;       // TTS narration text
  transition: {
    type: "fade" | "slide-left" | "slide-right" | "slide-up" | "none";
    durationInFrames: number; // default 15 (0.5s @ 30fps)
  };
  elements: SceneElement[];
  captions?: {
    enabled: boolean;      // default true
  };
}

// Element types — use exactly one of these per element:

interface TitleElement {
  type: "title";
  text: string;
  level: 1 | 2 | 3;
  animation: "fade-in" | "slide-in" | "typewriter" | "none";
}

interface TextElement {
  type: "text";
  content: string;
  animation: "fade-in" | "none";
}

interface BulletListElement {
  type: "bullet-list";
  items: string[];
  animation: "sequential" | "fade-in" | "none";
  delayPerItem: number;  // default 30 frames
}

interface ImageElement {
  type: "image";
  src: string;           // absolute path or URL
  alt?: string;
  position: "center" | "left" | "right" | "background";
  animation: "fade-in" | "zoom-in" | "ken-burns" | "none";
}

interface TableElement {
  type: "table";
  headers: string[];
  rows: string[][];
  animation: "fade-in" | "row-by-row" | "none";
}

interface CodeBlockElement {
  type: "code-block";
  code: string;
  language: string;
  animation: "fade-in" | "none";
}

type SceneElement =
  | TitleElement | TextElement | BulletListElement
  | ImageElement | TableElement | CodeBlockElement;
\`\`\`

## Output

Write ONLY valid JSON (no markdown fences, no comments) to the output path.
Include \`tts\` in \`audio\` with provider \`"voicevox"\`, speaker \`"1"\`, volume \`1.0\`, speed \`1.0\` as defaults.
`,
  },
};
