import type { BuiltinCommand } from "@/shared/types";

export const BUILTIN_COMMANDS: Record<string, BuiltinCommand> = {
  "generate-video-scenario": {
    name: "generate-video-scenario",
    description:
      "Convert Markdown to VideoProject JSON with AI-powered scene splitting and narration",
    template: `# Video Scenario Generator

Read the Markdown file at \`$1\`, analyze its content,
and generate a VideoProject JSON file at \`$2\`.

## Instructions

1. Read the Markdown file at \`$1\`.
2. Analyze the content structure, topics, and flow.
3. Generate a complete VideoProject JSON following the schema below.
4. Write the JSON to \`$2\`.

## Scene Splitting Rules

- If \`<!-- pagebreak -->\` markers exist in the Markdown, use them as scene boundaries.
- If no markers exist, split based on heading structure (h1/h2) and topic changes.
- Target scene count: $5 (if "auto", determine based on content structure).
- Target total video duration: $6 seconds (if "auto", use 30–60 seconds per scene as a guideline).
- When scene count is specified, aim for exactly that many scenes by merging or splitting as needed.
- When total duration is specified, distribute narration so the sum of all scenes approximates the target.
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
- Resolution: $3, aspect ratio $4, 30 fps.

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
Include \`tts\` in \`audio\` with provider \`"voicevox"\`, speaker \`"1"\`, volume \`1.0\`, speed $7 as defaults.
`,
  },
  "convert-to-km-mindmap": {
    name: "convert-to-km-mindmap",
    description:
      "Convert Markdown content into KityMinder mindmap JSON format (.km)",
    template: `# KityMinder Mindmap Converter

Read the Markdown file at \`$ARGUMENTS\`, analyze its content,
and generate a KityMinder-compatible JSON file.

## Instructions

1. Read the Markdown file at \`$ARGUMENTS\`.
2. Determine the output path by replacing the file extension with \`.km\` (e.g. \`notes.md\` → \`notes.km\`).
3. Analyze the content structure and topics.
4. Generate a KityMinder JSON following the schema below.
5. Write the JSON to the output path.

## Output Format

\`\`\`json
{
  "root": {
    "data": {
      "text": "Central Topic"
    },
    "children": [
      {
        "data": {
          "text": "Main Topic 1"
        },
        "children": [
          {
            "data": {
              "text": "Subtopic 1"
            },
            "children": []
          }
        ]
      }
    ]
  },
  "theme": "fresh-blue",
  "template": "right"
}
\`\`\`

## Node Structure

Every node follows this shape:

\`\`\`json
{
  "data": {
    "text": "Node label"
  },
  "children": []
}
\`\`\`

- \`data.text\` — the label displayed on the node (keep it concise)
- \`children\` — array of child nodes; use \`[]\` for leaf nodes

## Top-Level Properties

| Property | Description | Default |
|----------|-------------|---------|
| \`root\` | The root node of the mindmap (required) | — |
| \`theme\` | Visual theme | \`"fresh-blue"\` |
| \`template\` | Layout direction | \`"right"\` |

### Available Themes
\`fresh-blue\`, \`fresh-green\`, \`fresh-pink\`, \`fresh-purple\`, \`fresh-red\`, \`fresh-soil\`, \`snow\`, \`fish\`, \`wire\`

### Available Templates
\`default\` (both sides), \`right\` (right only), \`structure\` (org-chart), \`filetree\` (file-tree style), \`fish-bone\` (fishbone diagram)

## Structuring Guidelines

1. **Central topic** — one root node that captures the overall subject
2. **Main topics** — direct children of root; aim for 3–7 branches
3. **Subtopics** — children of main topics; keep depth ≤ 4 levels
4. **Leaf nodes** — concrete facts, examples, or action items
5. **Language** — match the language of the source Markdown content
6. **Conciseness** — keep node labels short (ideally ≤ 10 words)
7. **Balance** — distribute content evenly across branches when possible

## Output

Write ONLY valid JSON (no markdown fences, no comments) to the output path.
`,
  },
  "slidev-presentation": {
    name: "slidev-presentation",
    description:
      "Generate Slidev-format Markdown presentation from Markdown content",
    template: `# Slidev Presentation Generator

Read the Markdown file at \`$ARGUMENTS\`, analyze its content,
and generate a Slidev-format Markdown presentation.

## Instructions

1. Read the Markdown file at \`$ARGUMENTS\`.
2. Determine the output path by replacing the file extension with \`.slidev.md\` (e.g. \`notes.md\` → \`notes.slidev.md\`).
3. Analyze the content structure and topics.
4. Generate a Slidev-format Markdown presentation following the rules below.
5. Write the result to the output path.

## Slidev Format Rules

### Frontmatter (first slide)
\`\`\`yaml
---
theme: default
title: Presentation Title
author: Author Name
---
\`\`\`

### Slide Separation
- Separate slides with \`---\` on its own line
- Each slide can have a layout specified in its own frontmatter block

### Available Layouts
- \`cover\` — Title slide with centered content
- \`default\` — Standard content slide
- \`two-cols\` — Two-column layout (use \`::left::\` and \`::right::\` slot markers)
- \`image-right\` — Content left, image right (set \`image\` in frontmatter)
- \`image-left\` — Image left, content right
- \`center\` — Centered content
- \`section\` — Section divider
- \`quote\` — Quote slide
- \`fact\` — Key fact/statistic

### Rich Content Support
- Mermaid diagrams: use \\\`\\\`\\\`mermaid code blocks
- KaTeX math: use \`$inline$\` or \`$$display$$\`
- Code highlighting: use code blocks with optional line highlighting \`{1,3-5}\`

## Narration Script Rules

- Write narration notes inside HTML comment blocks at the end of each slide
- Write narration in the same language as the source Markdown
- Use a natural presenter speaking style — conversational but professional
- Target 30 seconds to 1 minute of narration per slide
- Cover the key points shown on the slide, adding context not visible in the text

Example:
\`\`\`markdown
# System Architecture

- Frontend: React + TypeScript
- Backend: Rust (Tauri)
- Database: SQLite

<!--
Let me walk you through our system architecture.
The frontend is built with React and TypeScript.
On the backend, we use Rust via the Tauri framework.
For data storage, we use SQLite.
-->
\`\`\`

## Image Generation Guidelines

### When to use the \`generate_image\` tool
- Architecture or system diagrams
- Conceptual illustrations
- Visual metaphors
- Data flow or process visualizations

### When NOT to use it
- The slide contains only text, bullet points, or code
- A Mermaid diagram can express the content
- The slide is a title/section divider slide

### Tool parameters
- \`prompt\` (required) — description of the image to generate
- \`filename\` (required) — output filename (e.g. \`slide03-architecture.png\`)
- \`aspectRatio\` (optional) — one of: 1:1, 2:3, 3:2, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, 21:9 (default: 16:9)
- \`imageSize\` (optional) — one of: 512, 1K, 2K, 4K (default: 1K)

### File naming convention
- Use descriptive names: \`slide03-system-overview.png\`, \`slide07-data-flow.png\`
- Always place in \`/images/\` directory
- Reference in Markdown as: \`![Description](/images/filename.png)\`

## Output

Write the complete Slidev Markdown to the output path.
`,
  },
};
