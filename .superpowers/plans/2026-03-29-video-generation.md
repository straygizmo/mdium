# Video Generation Feature Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate narrated videos with BGM from Markdown files, integrated into the mdium UI with real-time preview.

**Architecture:** Vendor open-motion (core/renderer/encoder/components) into `packages/open-motion/`. New `src/features/video/` feature converts MD → intermediate JSON (VideoProject) → React Composition. TTS via VOICEVOX, LLM narration via existing AI infra. Player preview in UI, Playwright+FFmpeg export via Rust backend.

**Tech Stack:** React 18, TypeScript, Zustand, Tauri 2, open-motion (vendored), Playwright, FFmpeg, VOICEVOX

---

## File Structure

### New Files

```
packages/open-motion/
├── core/src/index.tsx              # Vendored from open-motion (Composition, Sequence, Audio, Player, hooks, interpolate, spring, Easing, parseSrt)
├── core/src/Player.tsx             # Interactive player component
├── core/src/Audio.tsx              # Audio asset registration
├── core/src/AudioSync.tsx          # Audio playback sync manager
├── core/src/context.ts             # React context definitions
├── core/package.json
├── renderer/src/index.ts           # Playwright frame capture
├── renderer/src/utils.ts           # FFmpeg utilities
├── renderer/package.json
├── encoder/src/index.ts            # FFmpeg encoding wrapper
├── encoder/package.json
├── components/src/index.tsx        # Captions, Transitions, Typewriter, SlideInItem, Series
├── components/package.json
└── LICENSE

src/features/video/
├── types.ts                        # VideoProject, Scene, SceneElement types
├── lib/md-to-scenes.ts             # MD → VideoProject JSON conversion
├── lib/tts-provider.ts             # TTS provider interface + VOICEVOX implementation
├── lib/narration-generator.ts      # LLM narration auto-generation
├── lib/srt-generator.ts            # Generate SRT from TTS timing data
├── lib/scene-to-composition.tsx    # VideoProject → React Composition builder
├── components/VideoPanel.tsx        # Main video mode panel (scene form + player)
├── components/SceneEditForm.tsx     # Per-scene editing form (narration, animation, captions)
├── components/VideoSettingsBar.tsx  # Global settings (resolution, BGM, TTS provider)
├── components/ExportDialog.tsx      # Export settings dialog
├── components/VideoPanel.css        # Styles
└── hooks/useVideoGeneration.ts     # Orchestrates TTS, LLM narration, project state

src/stores/video-store.ts            # Zustand store for video state

src/shared/i18n/locales/ja/video.json  # Japanese translations
src/shared/i18n/locales/en/video.json  # English translations

src-tauri/src/commands/video.rs      # Rust backend: TTS proxy, render orchestration
```

### Modified Files

```
src/stores/ui-store.ts                           # Add "video" to ViewTab
src/features/preview/components/PreviewPanel.tsx  # Add [▷] tab button + VideoPanel rendering
src/shared/i18n/index.ts                         # Register video namespace
src-tauri/src/commands/mod.rs                    # Add pub mod video
src-tauri/src/lib.rs                             # Register video commands
package.json                                     # Add workspace reference to packages/open-motion/*
```

---

## Task 1: Vendor open-motion packages

**Files:**
- Create: `packages/open-motion/core/` (copy from `C:\Users\mtmar\source\repos\open-motion\packages\core\`)
- Create: `packages/open-motion/renderer/` (copy from open-motion)
- Create: `packages/open-motion/encoder/` (copy from open-motion)
- Create: `packages/open-motion/components/` (copy from open-motion)
- Create: `packages/open-motion/LICENSE`

- [ ] **Step 1: Copy open-motion packages**

```bash
mkdir -p packages/open-motion
cp -r /c/Users/mtmar/source/repos/open-motion/packages/core packages/open-motion/
cp -r /c/Users/mtmar/source/repos/open-motion/packages/renderer packages/open-motion/
cp -r /c/Users/mtmar/source/repos/open-motion/packages/encoder packages/open-motion/
cp -r /c/Users/mtmar/source/repos/open-motion/packages/components packages/open-motion/
cp /c/Users/mtmar/source/repos/open-motion/LICENSE packages/open-motion/LICENSE
```

- [ ] **Step 2: Clean up unnecessary files from vendored packages**

Remove node_modules, dist, .turbo and other build artifacts if present:

```bash
find packages/open-motion -name "node_modules" -type d -exec rm -rf {} + 2>/dev/null
find packages/open-motion -name "dist" -type d -exec rm -rf {} + 2>/dev/null
find packages/open-motion -name ".turbo" -type d -exec rm -rf {} + 2>/dev/null
```

- [ ] **Step 3: Update package.json workspace references in core**

Edit `packages/open-motion/core/package.json` — remove `"workspace:*"` references since these are now local. The core package has no internal deps. Verify `peerDependencies` lists `react` and `react-dom`:

```json
{
  "name": "@open-motion/core",
  "version": "0.1.9",
  "main": "src/index.tsx",
  "types": "src/index.tsx",
  "peerDependencies": {
    "react": "^18.0.0",
    "react-dom": "^18.0.0"
  }
}
```

- [ ] **Step 4: Update renderer package.json**

Edit `packages/open-motion/renderer/package.json` — change `"@open-motion/core": "workspace:*"` to a relative path reference:

```json
{
  "name": "@open-motion/renderer",
  "version": "0.1.9",
  "main": "src/index.ts",
  "types": "src/index.ts",
  "dependencies": {
    "@open-motion/core": "file:../core",
    "playwright": "^1.40.0"
  },
  "peerDependencies": {
    "react": "^18.0.0",
    "react-dom": "^18.0.0"
  }
}
```

- [ ] **Step 5: Update encoder package.json**

```json
{
  "name": "@open-motion/encoder",
  "version": "0.1.9",
  "main": "src/index.ts",
  "types": "src/index.ts",
  "dependencies": {
    "fluent-ffmpeg": "^2.1.3"
  }
}
```

- [ ] **Step 6: Update components package.json**

```json
{
  "name": "@open-motion/components",
  "version": "0.1.0",
  "main": "src/index.tsx",
  "types": "src/index.tsx",
  "dependencies": {
    "@open-motion/core": "file:../core"
  },
  "peerDependencies": {
    "react": "^18.0.0",
    "react-dom": "^18.0.0"
  }
}
```

- [ ] **Step 7: Add workspace references to root package.json**

Add to the root `package.json` dependencies:

```json
"@open-motion/core": "file:packages/open-motion/core",
"@open-motion/components": "file:packages/open-motion/components"
```

These are the packages used by the frontend (Tauri webview). Renderer and encoder will be used by a separate Node.js process spawned by the Rust backend, so they don't need to be in the main deps.

- [ ] **Step 8: Install dependencies**

```bash
npm install
```

- [ ] **Step 9: Verify TypeScript can resolve vendored packages**

```bash
npx tsc --noEmit --module esnext --moduleResolution bundler --jsx react-jsx packages/open-motion/core/src/index.tsx 2>&1 | head -20
```

If there are errors, fix the tsconfig path mapping. Add to `tsconfig.json` paths if needed:

```json
"paths": {
  "@open-motion/core": ["./packages/open-motion/core/src"],
  "@open-motion/components": ["./packages/open-motion/components/src"]
}
```

- [ ] **Step 10: Commit**

```bash
git add packages/open-motion/
git add package.json package-lock.json
git commit -m "chore: vendor open-motion core/renderer/encoder/components (MIT)"
```

---

## Task 2: Define VideoProject types

**Files:**
- Create: `src/features/video/types.ts`

- [ ] **Step 1: Create the types file**

```typescript
// src/features/video/types.ts

export interface VideoProject {
  meta: VideoMeta;
  audio: AudioConfig;
  scenes: Scene[];
}

export interface VideoMeta {
  title: string;
  width: number;
  height: number;
  fps: number;
  aspectRatio: "16:9" | "9:16" | "4:3" | "1:1";
}

export interface AudioConfig {
  bgm?: {
    src: string;
    volume: number;
  };
  tts: TTSConfig;
}

export interface TTSConfig {
  provider: "voicevox" | "openai" | "google";
  speaker?: string;
  volume: number;
  speed?: number;
}

export interface Scene {
  id: string;
  title?: string;
  durationInFrames?: number;
  narration: string;
  narrationAudio?: string;
  narrationDirty?: boolean;
  transition: TransitionConfig;
  elements: SceneElement[];
  captions?: CaptionsConfig;
}

export interface TransitionConfig {
  type: "fade" | "slide-left" | "slide-right" | "slide-up" | "none";
  durationInFrames: number;
}

export interface CaptionsConfig {
  enabled: boolean;
  srt?: string;
}

export type SceneElement =
  | TitleElement
  | TextElement
  | BulletListElement
  | ImageElement
  | TableElement
  | CodeBlockElement;

export interface TitleElement {
  type: "title";
  text: string;
  level: 1 | 2 | 3;
  animation: "fade-in" | "slide-in" | "typewriter" | "none";
}

export interface TextElement {
  type: "text";
  content: string;
  animation: "fade-in" | "none";
}

export interface BulletListElement {
  type: "bullet-list";
  items: string[];
  animation: "sequential" | "fade-in" | "none";
  delayPerItem: number;
}

export interface ImageElement {
  type: "image";
  src: string;
  alt?: string;
  position: "center" | "left" | "right" | "background";
  animation: "fade-in" | "zoom-in" | "ken-burns" | "none";
}

export interface TableElement {
  type: "table";
  headers: string[];
  rows: string[][];
  animation: "fade-in" | "row-by-row" | "none";
}

export interface CodeBlockElement {
  type: "code-block";
  code: string;
  language: string;
  animation: "fade-in" | "none";
}

// TTS provider interfaces
export interface TTSProvider {
  name: string;
  synthesize(text: string, options: TTSOptions): Promise<TTSResult>;
  getVoices(): Promise<Voice[]>;
}

export interface TTSOptions {
  voice: string;
  speed?: number;
  volume?: number;
}

export interface TTSResult {
  audioPath: string;
  durationMs: number;
  timingData?: TimingEntry[];
}

export interface TimingEntry {
  startMs: number;
  endMs: number;
  text: string;
}

export interface Voice {
  id: string;
  name: string;
  language: string;
}

export const DEFAULT_META: VideoMeta = {
  title: "",
  width: 1920,
  height: 1080,
  fps: 30,
  aspectRatio: "16:9",
};

export const DEFAULT_TRANSITION: TransitionConfig = {
  type: "fade",
  durationInFrames: 15,
};

export const DEFAULT_TTS_CONFIG: TTSConfig = {
  provider: "voicevox",
  speaker: "1",
  volume: 1.0,
  speed: 1.0,
};
```

- [ ] **Step 2: Commit**

```bash
git add src/features/video/types.ts
git commit -m "feat(video): define VideoProject types and interfaces"
```

---

## Task 3: Implement MD → VideoProject conversion

**Files:**
- Create: `src/features/video/lib/md-to-scenes.ts`
- Test: `src/features/video/lib/__tests__/md-to-scenes.test.ts`

- [ ] **Step 1: Write the test file**

```typescript
// src/features/video/lib/__tests__/md-to-scenes.test.ts
import { describe, it, expect } from "vitest";
import { convertMdToVideoProject } from "../md-to-scenes";

describe("convertMdToVideoProject", () => {
  it("splits scenes on <!-- pagebreak -->", () => {
    const md = `# Scene One
Some text

<!-- pagebreak -->

# Scene Two
More text`;
    const project = convertMdToVideoProject(md, "test.md");
    expect(project.scenes).toHaveLength(2);
    expect(project.scenes[0].id).toBe("scene-1");
    expect(project.scenes[1].id).toBe("scene-2");
  });

  it("treats entire document as one scene when no pagebreak", () => {
    const md = `# Only Scene
Some text`;
    const project = convertMdToVideoProject(md, "test.md");
    expect(project.scenes).toHaveLength(1);
  });

  it("extracts title elements from headings", () => {
    const md = `# Main Title
## Subtitle`;
    const project = convertMdToVideoProject(md, "test.md");
    const elements = project.scenes[0].elements;
    expect(elements[0]).toEqual({
      type: "title",
      text: "Main Title",
      level: 1,
      animation: "fade-in",
    });
    expect(elements[1]).toEqual({
      type: "title",
      text: "Subtitle",
      level: 2,
      animation: "fade-in",
    });
  });

  it("extracts bullet list elements", () => {
    const md = `- Item A
- Item B
- Item C`;
    const project = convertMdToVideoProject(md, "test.md");
    const el = project.scenes[0].elements[0];
    expect(el.type).toBe("bullet-list");
    if (el.type === "bullet-list") {
      expect(el.items).toEqual(["Item A", "Item B", "Item C"]);
      expect(el.animation).toBe("sequential");
      expect(el.delayPerItem).toBe(30);
    }
  });

  it("extracts image elements from markdown syntax", () => {
    const md = `![Alt text](./images/photo.png)`;
    const project = convertMdToVideoProject(md, "/path/to/test.md");
    const el = project.scenes[0].elements[0];
    expect(el.type).toBe("image");
    if (el.type === "image") {
      expect(el.src).toContain("images/photo.png");
      expect(el.alt).toBe("Alt text");
      expect(el.animation).toBe("fade-in");
    }
  });

  it("extracts image elements from <img> tags", () => {
    const md = `<img src="./images/photo.png" class="h-40 mx-auto" />`;
    const project = convertMdToVideoProject(md, "/path/to/test.md");
    const el = project.scenes[0].elements[0];
    expect(el.type).toBe("image");
  });

  it("extracts narration from HTML comments", () => {
    const md = `# Title
<!-- narration: This is the narration text -->`;
    const project = convertMdToVideoProject(md, "test.md");
    expect(project.scenes[0].narration).toBe("This is the narration text");
  });

  it("auto-generates narration from content when no comment", () => {
    const md = `# My Title
- Point one
- Point two`;
    const project = convertMdToVideoProject(md, "test.md");
    expect(project.scenes[0].narration).toContain("My Title");
    expect(project.scenes[0].narration).toContain("Point one");
  });

  it("extracts table elements", () => {
    const md = `| Header1 | Header2 |
| :--- | :--- |
| A | B |
| C | D |`;
    const project = convertMdToVideoProject(md, "test.md");
    const el = project.scenes[0].elements[0];
    expect(el.type).toBe("table");
    if (el.type === "table") {
      expect(el.headers).toEqual(["Header1", "Header2"]);
      expect(el.rows).toEqual([["A", "B"], ["C", "D"]]);
    }
  });

  it("extracts code block elements", () => {
    const md = "```typescript\nconst x = 1;\n```";
    const project = convertMdToVideoProject(md, "test.md");
    const el = project.scenes[0].elements[0];
    expect(el.type).toBe("code-block");
    if (el.type === "code-block") {
      expect(el.code).toBe("const x = 1;");
      expect(el.language).toBe("typescript");
    }
  });

  it("skips mermaid code blocks", () => {
    const md = "```mermaid\ngraph LR\nA-->B\n```";
    const project = convertMdToVideoProject(md, "test.md");
    expect(project.scenes[0].elements).toHaveLength(0);
  });

  it("extracts title from first heading for meta", () => {
    const md = `# My Presentation

<!-- pagebreak -->

# Slide 2`;
    const project = convertMdToVideoProject(md, "test.md");
    expect(project.meta.title).toBe("My Presentation");
  });

  it("sets scene title from first heading in scene", () => {
    const md = `# First Scene
text

<!-- pagebreak -->

# Second Scene
more text`;
    const project = convertMdToVideoProject(md, "test.md");
    expect(project.scenes[0].title).toBe("First Scene");
    expect(project.scenes[1].title).toBe("Second Scene");
  });

  it("handles captions default to enabled", () => {
    const md = `# Title`;
    const project = convertMdToVideoProject(md, "test.md");
    expect(project.scenes[0].captions).toEqual({ enabled: true });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run src/features/video/lib/__tests__/md-to-scenes.test.ts
```

Expected: FAIL — module `../md-to-scenes` does not exist.

- [ ] **Step 3: Implement md-to-scenes.ts**

```typescript
// src/features/video/lib/md-to-scenes.ts
import * as path from "path";
import type {
  VideoProject,
  Scene,
  SceneElement,
  TitleElement,
  TextElement,
  BulletListElement,
  ImageElement,
  TableElement,
  CodeBlockElement,
  DEFAULT_META,
  DEFAULT_TRANSITION,
  DEFAULT_TTS_CONFIG,
} from "../types";
import {
  DEFAULT_META as META_DEFAULTS,
  DEFAULT_TRANSITION as TRANSITION_DEFAULTS,
  DEFAULT_TTS_CONFIG as TTS_DEFAULTS,
} from "../types";

const PAGEBREAK_PATTERN = /<!--\s*pagebreak\s*-->/i;
const NARRATION_PATTERN = /<!--\s*narration:\s*([\s\S]*?)\s*-->/i;
const HEADING_PATTERN = /^(#{1,3})\s+(.+)$/;
const BULLET_PATTERN = /^[-*]\s+(.+)$/;
const IMAGE_MD_PATTERN = /^!\[([^\]]*)\]\(([^)]+)\)\s*$/;
const IMAGE_HTML_PATTERN = /<img\s+[^>]*src=["']([^"']+)["'][^>]*\/?>/i;
const CODE_FENCE_OPEN = /^```(\w*)\s*$/;
const CODE_FENCE_CLOSE = /^```\s*$/;
const TABLE_ROW_PATTERN = /^\|(.+)\|$/;
const TABLE_SEPARATOR_PATTERN = /^\|[\s:|-]+\|$/;

export function convertMdToVideoProject(
  markdown: string,
  filePath: string,
): VideoProject {
  const rawScenes = splitScenes(markdown);
  const scenes: Scene[] = rawScenes.map((raw, i) => parseScene(raw, i, filePath));

  const title = scenes[0]?.title ?? path.basename(filePath, path.extname(filePath));

  return {
    meta: { ...META_DEFAULTS, title },
    audio: { tts: { ...TTS_DEFAULTS } },
    scenes,
  };
}

function splitScenes(markdown: string): string[] {
  const parts = markdown.split(PAGEBREAK_PATTERN).map((s) => s.trim()).filter(Boolean);
  return parts.length > 0 ? parts : [markdown.trim()];
}

function parseScene(raw: string, index: number, filePath: string): Scene {
  const narrationMatch = raw.match(NARRATION_PATTERN);
  const contentWithoutNarration = raw.replace(NARRATION_PATTERN, "").trim();
  const elements = parseElements(contentWithoutNarration, filePath);
  const title = extractSceneTitle(elements);
  const narration = narrationMatch
    ? narrationMatch[1].trim()
    : autoGenerateNarration(elements);

  return {
    id: `scene-${index + 1}`,
    title,
    narration,
    transition: { ...TRANSITION_DEFAULTS },
    elements,
    captions: { enabled: true },
  };
}

function extractSceneTitle(elements: SceneElement[]): string | undefined {
  const firstTitle = elements.find((e) => e.type === "title") as TitleElement | undefined;
  return firstTitle?.text;
}

function autoGenerateNarration(elements: SceneElement[]): string {
  const parts: string[] = [];
  for (const el of elements) {
    switch (el.type) {
      case "title":
        parts.push(el.text);
        break;
      case "text":
        parts.push(el.content);
        break;
      case "bullet-list":
        parts.push(...el.items);
        break;
    }
  }
  return parts.join("。");
}

function parseElements(content: string, filePath: string): SceneElement[] {
  const lines = content.split("\n");
  const elements: SceneElement[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Code block
    const codeMatch = line.match(CODE_FENCE_OPEN);
    if (codeMatch) {
      const language = codeMatch[1] || "plaintext";
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !CODE_FENCE_CLOSE.test(lines[i])) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing ```
      if (language === "mermaid") continue; // skip mermaid
      elements.push({
        type: "code-block",
        code: codeLines.join("\n"),
        language,
        animation: "fade-in",
      } satisfies CodeBlockElement);
      continue;
    }

    // Heading
    const headingMatch = line.match(HEADING_PATTERN);
    if (headingMatch) {
      elements.push({
        type: "title",
        text: headingMatch[2].trim(),
        level: headingMatch[1].length as 1 | 2 | 3,
        animation: "fade-in",
      } satisfies TitleElement);
      i++;
      continue;
    }

    // Bullet list
    const bulletMatch = line.match(BULLET_PATTERN);
    if (bulletMatch) {
      const items: string[] = [bulletMatch[1]];
      i++;
      while (i < lines.length) {
        const nextBullet = lines[i].match(BULLET_PATTERN);
        if (!nextBullet) break;
        items.push(nextBullet[1]);
        i++;
      }
      elements.push({
        type: "bullet-list",
        items,
        animation: "sequential",
        delayPerItem: 30,
      } satisfies BulletListElement);
      continue;
    }

    // Image (markdown syntax)
    const imgMdMatch = line.match(IMAGE_MD_PATTERN);
    if (imgMdMatch) {
      elements.push(makeImageElement(imgMdMatch[2], imgMdMatch[1], filePath));
      i++;
      continue;
    }

    // Image (HTML tag)
    const imgHtmlMatch = line.match(IMAGE_HTML_PATTERN);
    if (imgHtmlMatch) {
      elements.push(makeImageElement(imgHtmlMatch[1], "", filePath));
      i++;
      continue;
    }

    // Table
    if (TABLE_ROW_PATTERN.test(line)) {
      const tableLines: string[] = [line];
      i++;
      while (i < lines.length && TABLE_ROW_PATTERN.test(lines[i])) {
        tableLines.push(lines[i]);
        i++;
      }
      const table = parseTable(tableLines);
      if (table) {
        elements.push(table);
      }
      continue;
    }

    // Plain text (skip empty lines, HTML divs, frontmatter markers)
    const trimmed = line.trim();
    if (
      trimmed &&
      !trimmed.startsWith("<!--") &&
      !trimmed.startsWith("<div") &&
      !trimmed.startsWith("</div") &&
      trimmed !== "---"
    ) {
      // Collect consecutive text lines
      const textLines: string[] = [trimmed];
      i++;
      while (i < lines.length) {
        const next = lines[i].trim();
        if (
          !next ||
          next.match(HEADING_PATTERN) ||
          next.match(BULLET_PATTERN) ||
          next.match(IMAGE_MD_PATTERN) ||
          next.match(IMAGE_HTML_PATTERN) ||
          next.match(CODE_FENCE_OPEN) ||
          TABLE_ROW_PATTERN.test(next) ||
          next.startsWith("<!--") ||
          next.startsWith("<div") ||
          next === "---"
        ) {
          break;
        }
        textLines.push(next);
        i++;
      }
      elements.push({
        type: "text",
        content: textLines.join(" "),
        animation: "fade-in",
      } satisfies TextElement);
      continue;
    }

    i++;
  }

  return elements;
}

function makeImageElement(src: string, alt: string, filePath: string): ImageElement {
  let resolvedSrc = src;
  if (src.startsWith("./") || src.startsWith("../")) {
    const dir = path.dirname(filePath);
    resolvedSrc = path.resolve(dir, src);
  }
  return {
    type: "image",
    src: resolvedSrc,
    alt: alt || undefined,
    position: "center",
    animation: "fade-in",
  };
}

function parseTable(lines: string[]): TableElement | null {
  if (lines.length < 2) return null;

  const parseCells = (line: string): string[] =>
    line
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((c) => c.trim());

  const headers = parseCells(lines[0]);

  // Skip separator row
  const dataStartIndex = TABLE_SEPARATOR_PATTERN.test(lines[1]) ? 2 : 1;
  const rows = lines.slice(dataStartIndex).map(parseCells);

  return {
    type: "table",
    headers,
    rows,
    animation: "row-by-row",
  };
}
```

- [ ] **Step 4: Run the tests**

```bash
npx vitest run src/features/video/lib/__tests__/md-to-scenes.test.ts
```

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/features/video/types.ts src/features/video/lib/md-to-scenes.ts src/features/video/lib/__tests__/md-to-scenes.test.ts
git commit -m "feat(video): implement MD to VideoProject JSON conversion"
```

---

## Task 4: Implement TTS provider (VOICEVOX)

**Files:**
- Create: `src/features/video/lib/tts-provider.ts`

- [ ] **Step 1: Implement the TTS provider abstraction and VOICEVOX**

This module runs in the Tauri webview and calls the VOICEVOX API directly (localhost). The Rust backend is used only for file I/O (saving audio).

```typescript
// src/features/video/lib/tts-provider.ts
import { invoke } from "@tauri-apps/api/core";
import type { TTSProvider, TTSOptions, TTSResult, Voice, TimingEntry } from "../types";

export class VoicevoxProvider implements TTSProvider {
  name = "voicevox";
  private host: string;

  constructor(host = "http://localhost:50021") {
    this.host = host;
  }

  async synthesize(text: string, options: TTSOptions): Promise<TTSResult> {
    const speakerId = parseInt(options.voice, 10) || 1;
    const speed = options.speed ?? 1.0;

    // Step 1: Get audio query
    const queryRes = await fetch(
      `${this.host}/audio_query?text=${encodeURIComponent(text)}&speaker=${speakerId}`,
      { method: "POST" },
    );
    if (!queryRes.ok) throw new Error(`VOICEVOX audio_query failed: ${queryRes.status}`);
    const audioQuery = await queryRes.json();

    // Apply speed
    audioQuery.speedScale = speed;

    // Extract timing data from accent phrases before synthesis
    const timingData = extractTimingFromQuery(audioQuery, text);

    // Step 2: Synthesize audio
    const synthRes = await fetch(
      `${this.host}/synthesis?speaker=${speakerId}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(audioQuery),
      },
    );
    if (!synthRes.ok) throw new Error(`VOICEVOX synthesis failed: ${synthRes.status}`);

    const audioBuffer = await synthRes.arrayBuffer();
    const audioBytes = Array.from(new Uint8Array(audioBuffer));

    // Save via Rust backend (returns file path and duration)
    const result = await invoke<{ path: string; durationMs: number }>("video_save_audio", {
      audioBytes,
    });

    return {
      audioPath: result.path,
      durationMs: result.durationMs,
      timingData,
    };
  }

  async getVoices(): Promise<Voice[]> {
    try {
      const res = await fetch(`${this.host}/speakers`);
      if (!res.ok) return [];
      const speakers = await res.json();
      const voices: Voice[] = [];
      for (const speaker of speakers) {
        for (const style of speaker.styles) {
          voices.push({
            id: String(style.id),
            name: `${speaker.name} (${style.name})`,
            language: "ja",
          });
        }
      }
      return voices;
    } catch {
      return [];
    }
  }
}

function extractTimingFromQuery(audioQuery: any, originalText: string): TimingEntry[] {
  // VOICEVOX audio_query returns accent_phrases with moras containing duration info
  const entries: TimingEntry[] = [];
  let currentMs = 0;

  if (!audioQuery.accent_phrases) return [];

  // Collect all mora text and durations
  const segments: { text: string; durationMs: number }[] = [];
  for (const phrase of audioQuery.accent_phrases) {
    let phraseText = "";
    let phraseDuration = 0;
    if (phrase.pause_mora) {
      phraseDuration += (phrase.pause_mora.vowel_length ?? 0) * 1000;
    }
    for (const mora of phrase.moras ?? []) {
      phraseText += mora.text ?? "";
      phraseDuration += ((mora.consonant_length ?? 0) + (mora.vowel_length ?? 0)) * 1000;
    }
    if (phraseText) {
      segments.push({ text: phraseText, durationMs: phraseDuration });
    }
  }

  // Build timing entries from segments
  for (const seg of segments) {
    entries.push({
      startMs: Math.round(currentMs),
      endMs: Math.round(currentMs + seg.durationMs),
      text: seg.text,
    });
    currentMs += seg.durationMs;
  }

  return entries;
}

export function createTTSProvider(provider: string, host?: string): TTSProvider {
  switch (provider) {
    case "voicevox":
      return new VoicevoxProvider(host);
    default:
      throw new Error(`Unknown TTS provider: ${provider}`);
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/features/video/lib/tts-provider.ts
git commit -m "feat(video): implement VOICEVOX TTS provider with timing extraction"
```

---

## Task 5: Implement SRT generator

**Files:**
- Create: `src/features/video/lib/srt-generator.ts`
- Test: `src/features/video/lib/__tests__/srt-generator.test.ts`

- [ ] **Step 1: Write tests**

```typescript
// src/features/video/lib/__tests__/srt-generator.test.ts
import { describe, it, expect } from "vitest";
import { generateSrt } from "../srt-generator";
import type { TimingEntry } from "../../types";

describe("generateSrt", () => {
  it("generates valid SRT from timing entries", () => {
    const entries: TimingEntry[] = [
      { startMs: 0, endMs: 1500, text: "こんにちは" },
      { startMs: 1500, endMs: 3000, text: "世界" },
    ];
    const srt = generateSrt(entries);
    expect(srt).toContain("1\n00:00:00,000 --> 00:00:01,500\nこんにちは");
    expect(srt).toContain("2\n00:00:01,500 --> 00:00:03,000\n世界");
  });

  it("generates SRT from plain text and duration when no timing data", () => {
    const srt = generateSrt(undefined, "Hello world test", 3000);
    expect(srt).toContain("1\n00:00:00,000 --> 00:00:03,000\nHello world test");
  });

  it("returns empty string for no input", () => {
    const srt = generateSrt(undefined, "", 0);
    expect(srt).toBe("");
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

```bash
npx vitest run src/features/video/lib/__tests__/srt-generator.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement srt-generator.ts**

```typescript
// src/features/video/lib/srt-generator.ts
import type { TimingEntry } from "../types";

export function generateSrt(
  timingData?: TimingEntry[],
  fallbackText?: string,
  fallbackDurationMs?: number,
): string {
  if (timingData && timingData.length > 0) {
    return timingData
      .map((entry, i) => {
        const start = formatSrtTime(entry.startMs);
        const end = formatSrtTime(entry.endMs);
        return `${i + 1}\n${start} --> ${end}\n${entry.text}`;
      })
      .join("\n\n");
  }

  if (fallbackText && fallbackDurationMs && fallbackDurationMs > 0) {
    const start = formatSrtTime(0);
    const end = formatSrtTime(fallbackDurationMs);
    return `1\n${start} --> ${end}\n${fallbackText}`;
  }

  return "";
}

function formatSrtTime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const milliseconds = Math.round(ms % 1000);
  return (
    String(hours).padStart(2, "0") +
    ":" +
    String(minutes).padStart(2, "0") +
    ":" +
    String(seconds).padStart(2, "0") +
    "," +
    String(milliseconds).padStart(3, "0")
  );
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run src/features/video/lib/__tests__/srt-generator.test.ts
```

Expected: All PASS.

- [ ] **Step 5: Commit**

```bash
git add src/features/video/lib/srt-generator.ts src/features/video/lib/__tests__/srt-generator.test.ts
git commit -m "feat(video): implement SRT subtitle generator from TTS timing data"
```

---

## Task 6: Implement LLM narration generator

**Files:**
- Create: `src/features/video/lib/narration-generator.ts`

- [ ] **Step 1: Implement narration generator using existing AI infrastructure**

The mdium project uses `opencode-sdk` for AI. The narration generator calls the AI chat endpoint via the existing Tauri command.

```typescript
// src/features/video/lib/narration-generator.ts
import { invoke } from "@tauri-apps/api/core";
import type { Scene, SceneElement } from "../types";

const SYSTEM_PROMPT = `あなたはプレゼンテーションのナレーション作成者です。
スライドの内容から、聴衆に語りかける自然な話し言葉のナレーションを生成してください。
- 丁寧語で、聴衆に語りかける口調
- 箇条書きの内容を自然な文章に変換
- 30秒〜1分程度で読み上げられる長さ
- ナレーションテキストのみを返してください（説明や注釈は不要）`;

export async function generateNarrationForScene(scene: Scene): Promise<string> {
  const contentText = buildContentText(scene);
  const prompt = `以下のスライド内容から、プレゼンテーション用のナレーションを生成してください。

スライドタイトル: ${scene.title ?? "(なし)"}
スライド内容:
${contentText}`;

  try {
    const response = await invoke<string>("ai_chat", {
      systemPrompt: SYSTEM_PROMPT,
      userMessage: prompt,
    });
    return response.trim();
  } catch (e) {
    // Fallback to simple concatenation if AI is unavailable
    return buildFallbackNarration(scene);
  }
}

export async function generateNarrationsForScenes(
  scenes: Scene[],
  onProgress?: (sceneIndex: number) => void,
): Promise<Map<string, string>> {
  const results = new Map<string, string>();
  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];
    if (!scene.narration || scene.narration.trim() === "") {
      const narration = await generateNarrationForScene(scene);
      results.set(scene.id, narration);
    }
    onProgress?.(i);
  }
  return results;
}

function buildContentText(scene: Scene): string {
  const parts: string[] = [];
  for (const el of scene.elements) {
    switch (el.type) {
      case "title":
        parts.push(`[見出し${el.level}] ${el.text}`);
        break;
      case "text":
        parts.push(el.content);
        break;
      case "bullet-list":
        parts.push(el.items.map((item) => `・${item}`).join("\n"));
        break;
      case "table":
        parts.push(`[表] ${el.headers.join(", ")}`);
        break;
      case "code-block":
        parts.push(`[コード: ${el.language}]`);
        break;
      case "image":
        if (el.alt) parts.push(`[画像: ${el.alt}]`);
        break;
    }
  }
  return parts.join("\n");
}

function buildFallbackNarration(scene: Scene): string {
  const parts: string[] = [];
  for (const el of scene.elements) {
    switch (el.type) {
      case "title":
        parts.push(el.text);
        break;
      case "text":
        parts.push(el.content);
        break;
      case "bullet-list":
        parts.push(...el.items);
        break;
    }
  }
  return parts.join("。");
}
```

- [ ] **Step 2: Commit**

```bash
git add src/features/video/lib/narration-generator.ts
git commit -m "feat(video): implement LLM-based narration auto-generation"
```

---

## Task 7: Implement Rust backend video commands

**Files:**
- Create: `src-tauri/src/commands/video.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Create video.rs with audio save and render commands**

```rust
// src-tauri/src/commands/video.rs
use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;

fn video_temp_base() -> PathBuf {
    std::env::temp_dir().join("mdium-video")
}

fn hash_string(s: &str) -> String {
    let mut hasher = DefaultHasher::new();
    s.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

#[tauri::command]
pub async fn video_save_audio(audio_bytes: Vec<u8>) -> Result<serde_json::Value, String> {
    let temp_dir = video_temp_base().join("audio");
    fs::create_dir_all(&temp_dir)
        .map_err(|e| format!("Failed to create audio temp dir: {}", e))?;

    // Generate unique filename
    let hash = hash_string(&format!("{:?}{}", std::time::SystemTime::now(), audio_bytes.len()));
    let file_path = temp_dir.join(format!("{}.wav", hash));

    fs::write(&file_path, &audio_bytes)
        .map_err(|e| format!("Failed to write audio file: {}", e))?;

    // Read WAV header to get duration
    let duration_ms = calculate_wav_duration(&audio_bytes).unwrap_or(0);

    Ok(serde_json::json!({
        "path": file_path.to_string_lossy(),
        "durationMs": duration_ms,
    }))
}

fn calculate_wav_duration(data: &[u8]) -> Option<u64> {
    // WAV header: bytes 24-27 = sample rate, bytes 34-35 = bits per sample, bytes 22-23 = channels
    if data.len() < 44 {
        return None;
    }
    let sample_rate = u32::from_le_bytes([data[24], data[25], data[26], data[27]]) as u64;
    let bits_per_sample = u16::from_le_bytes([data[34], data[35]]) as u64;
    let channels = u16::from_le_bytes([data[22], data[23]]) as u64;
    let data_size = u32::from_le_bytes([data[40], data[41], data[42], data[43]]) as u64;

    if sample_rate == 0 || bits_per_sample == 0 || channels == 0 {
        return None;
    }
    let bytes_per_sample = bits_per_sample / 8;
    let total_samples = data_size / (bytes_per_sample * channels);
    Some(total_samples * 1000 / sample_rate)
}

#[tauri::command]
pub async fn video_clean_temp() -> Result<(), String> {
    let temp_dir = video_temp_base();
    if temp_dir.exists() {
        fs::remove_dir_all(&temp_dir)
            .map_err(|e| format!("Failed to clean temp dir: {}", e))?;
    }
    Ok(())
}

#[tauri::command]
pub async fn video_copy_images(
    source_paths: Vec<String>,
    dest_dir: String,
) -> Result<(), String> {
    fs::create_dir_all(&dest_dir)
        .map_err(|e| format!("Failed to create image dir: {}", e))?;

    for src in source_paths {
        let src_path = PathBuf::from(&src);
        if src_path.exists() {
            if let Some(filename) = src_path.file_name() {
                let dest_path = PathBuf::from(&dest_dir).join(filename);
                fs::copy(&src_path, &dest_path)
                    .map_err(|e| format!("Failed to copy image {}: {}", src, e))?;
            }
        }
    }
    Ok(())
}
```

- [ ] **Step 2: Register the module in mod.rs**

Add to `src-tauri/src/commands/mod.rs`:

```rust
pub mod video;
```

- [ ] **Step 3: Register commands in lib.rs**

Add to the `invoke_handler` list in `src-tauri/src/lib.rs`, after the Slidev operations block:

```rust
// Video operations
commands::video::video_save_audio,
commands::video::video_clean_temp,
commands::video::video_copy_images,
```

- [ ] **Step 4: Verify it compiles**

```bash
cd src-tauri && cargo check
```

Expected: compiles without errors.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands/video.rs src-tauri/src/commands/mod.rs src-tauri/src/lib.rs
git commit -m "feat(video): add Rust backend commands for audio save and image copy"
```

---

## Task 8: Create video store (Zustand)

**Files:**
- Create: `src/stores/video-store.ts`

- [ ] **Step 1: Create the store**

```typescript
// src/stores/video-store.ts
import { create } from "zustand";
import type { VideoProject, Scene } from "@/features/video/types";

interface VideoState {
  videoProject: VideoProject | null;
  audioGenerated: boolean;
  renderProgress: number;
  selectedSceneId: string | null;
  isVideoMode: boolean;

  setVideoProject: (project: VideoProject | null) => void;
  updateScene: (sceneId: string, partial: Partial<Scene>) => void;
  setSelectedSceneId: (id: string | null) => void;
  setAudioGenerated: (generated: boolean) => void;
  setRenderProgress: (progress: number) => void;
  setIsVideoMode: (mode: boolean) => void;
  updateMeta: (partial: Partial<VideoProject["meta"]>) => void;
  updateAudioConfig: (partial: Partial<VideoProject["audio"]>) => void;
  markNarrationDirty: (sceneId: string) => void;
}

export const useVideoStore = create<VideoState>()((set) => ({
  videoProject: null,
  audioGenerated: false,
  renderProgress: 0,
  selectedSceneId: null,
  isVideoMode: false,

  setVideoProject: (project) =>
    set({ videoProject: project, audioGenerated: false, renderProgress: 0 }),

  updateScene: (sceneId, partial) =>
    set((s) => {
      if (!s.videoProject) return s;
      const scenes = s.videoProject.scenes.map((scene) =>
        scene.id === sceneId ? { ...scene, ...partial } : scene,
      );
      return { videoProject: { ...s.videoProject, scenes } };
    }),

  setSelectedSceneId: (id) => set({ selectedSceneId: id }),
  setAudioGenerated: (generated) => set({ audioGenerated: generated }),
  setRenderProgress: (progress) => set({ renderProgress: progress }),
  setIsVideoMode: (mode) => set({ isVideoMode: mode }),

  updateMeta: (partial) =>
    set((s) => {
      if (!s.videoProject) return s;
      return {
        videoProject: {
          ...s.videoProject,
          meta: { ...s.videoProject.meta, ...partial },
        },
      };
    }),

  updateAudioConfig: (partial) =>
    set((s) => {
      if (!s.videoProject) return s;
      return {
        videoProject: {
          ...s.videoProject,
          audio: { ...s.videoProject.audio, ...partial },
        },
      };
    }),

  markNarrationDirty: (sceneId) =>
    set((s) => {
      if (!s.videoProject) return s;
      const scenes = s.videoProject.scenes.map((scene) =>
        scene.id === sceneId ? { ...scene, narrationDirty: true } : scene,
      );
      return {
        videoProject: { ...s.videoProject, scenes },
        audioGenerated: false,
      };
    }),
}));
```

- [ ] **Step 2: Commit**

```bash
git add src/stores/video-store.ts
git commit -m "feat(video): add Zustand store for video project state"
```

---

## Task 9: Add i18n translations and UI store update

**Files:**
- Create: `src/shared/i18n/locales/ja/video.json`
- Create: `src/shared/i18n/locales/en/video.json`
- Modify: `src/shared/i18n/index.ts`
- Modify: `src/stores/ui-store.ts`

- [ ] **Step 1: Create Japanese translation file**

```json
{
  "videoMode": "動画モード",
  "backToEditor": "MDに戻る",
  "generateAudio": "音声生成",
  "export": "エクスポート",
  "globalSettings": "全体設定",
  "resolution": "解像度",
  "bgm": "BGM",
  "bgmSelect": "選択...",
  "bgmVolume": "BGM音量",
  "ttsProvider": "TTSプロバイダー",
  "ttsSpeaker": "話者",
  "ttsSpeed": "速度",
  "scene": "シーン",
  "narration": "ナレーション",
  "narrationRegenerate": "再生成",
  "narrationDirty": "未同期",
  "captions": "字幕",
  "captionsOn": "ON",
  "captionsOff": "OFF",
  "transition": "トランジション",
  "animation": "アニメーション",
  "fade": "フェード",
  "slideLeft": "スライド（左）",
  "slideRight": "スライド（右）",
  "slideUp": "スライド（上）",
  "none": "なし",
  "fadeIn": "フェードイン",
  "slideIn": "スライドイン",
  "typewriter": "タイプライター",
  "sequential": "順次表示",
  "zoomIn": "ズームイン",
  "kenBurns": "Ken Burns",
  "rowByRow": "行ごと",
  "exportDialog": "動画エクスポート",
  "format": "フォーマット",
  "fps": "FPS",
  "concurrency": "並列数",
  "outputPath": "出力先",
  "cancel": "キャンセル",
  "exporting": "エクスポート中...",
  "renderProgress": "レンダリング進捗",
  "audioNotGenerated": "音声が未生成です。先に音声を生成してください。",
  "voicevoxNotRunning": "VOICEVOXに接続できません。VOICEVOXを起動してください。",
  "ffmpegNotFound": "FFmpegが見つかりません。インストールしてください。",
  "generatingNarration": "ナレーション生成中...",
  "generatingAudio": "音声生成中..."
}
```

- [ ] **Step 2: Create English translation file**

```json
{
  "videoMode": "Video Mode",
  "backToEditor": "Back to MD",
  "generateAudio": "Generate Audio",
  "export": "Export",
  "globalSettings": "Global Settings",
  "resolution": "Resolution",
  "bgm": "BGM",
  "bgmSelect": "Select...",
  "bgmVolume": "BGM Volume",
  "ttsProvider": "TTS Provider",
  "ttsSpeaker": "Speaker",
  "ttsSpeed": "Speed",
  "scene": "Scene",
  "narration": "Narration",
  "narrationRegenerate": "Regenerate",
  "narrationDirty": "Out of sync",
  "captions": "Captions",
  "captionsOn": "ON",
  "captionsOff": "OFF",
  "transition": "Transition",
  "animation": "Animation",
  "fade": "Fade",
  "slideLeft": "Slide Left",
  "slideRight": "Slide Right",
  "slideUp": "Slide Up",
  "none": "None",
  "fadeIn": "Fade In",
  "slideIn": "Slide In",
  "typewriter": "Typewriter",
  "sequential": "Sequential",
  "zoomIn": "Zoom In",
  "kenBurns": "Ken Burns",
  "rowByRow": "Row by Row",
  "exportDialog": "Export Video",
  "format": "Format",
  "fps": "FPS",
  "concurrency": "Concurrency",
  "outputPath": "Output",
  "cancel": "Cancel",
  "exporting": "Exporting...",
  "renderProgress": "Render Progress",
  "audioNotGenerated": "Audio not generated. Please generate audio first.",
  "voicevoxNotRunning": "Cannot connect to VOICEVOX. Please start VOICEVOX.",
  "ffmpegNotFound": "FFmpeg not found. Please install it.",
  "generatingNarration": "Generating narration...",
  "generatingAudio": "Generating audio..."
}
```

- [ ] **Step 3: Register video namespace in i18n/index.ts**

Add imports and register in both language resources:

```typescript
// Add after existing imports
import jaVideo from "./locales/ja/video.json";
import enVideo from "./locales/en/video.json";

// Add to ja resources object:
video: jaVideo,

// Add to en resources object:
video: enVideo,
```

- [ ] **Step 4: Update ViewTab type in ui-store.ts**

Change line 5 of `src/stores/ui-store.ts`:

```typescript
type ViewTab = "preview" | "table" | "pdf-preview" | "docx-preview" | "html-preview" | "slidev-preview" | "video";
```

- [ ] **Step 5: Commit**

```bash
git add src/shared/i18n/locales/ja/video.json src/shared/i18n/locales/en/video.json src/shared/i18n/index.ts src/stores/ui-store.ts
git commit -m "feat(video): add i18n translations and video ViewTab"
```

---

## Task 10: Build scene editing UI components

**Files:**
- Create: `src/features/video/components/VideoSettingsBar.tsx`
- Create: `src/features/video/components/SceneEditForm.tsx`
- Create: `src/features/video/components/ExportDialog.tsx`
- Create: `src/features/video/components/VideoPanel.css`

- [ ] **Step 1: Create VideoSettingsBar**

```tsx
// src/features/video/components/VideoSettingsBar.tsx
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { open } from "@tauri-apps/plugin-dialog";
import { useVideoStore } from "@/stores/video-store";

const RESOLUTION_OPTIONS = [
  { label: "1920x1080 (16:9)", width: 1920, height: 1080, aspectRatio: "16:9" as const },
  { label: "1080x1920 (9:16)", width: 1080, height: 1920, aspectRatio: "9:16" as const },
  { label: "1280x720 (16:9)", width: 1280, height: 720, aspectRatio: "16:9" as const },
  { label: "1080x1080 (1:1)", width: 1080, height: 1080, aspectRatio: "1:1" as const },
];

export function VideoSettingsBar() {
  const { t } = useTranslation("video");
  const meta = useVideoStore((s) => s.videoProject?.meta);
  const audio = useVideoStore((s) => s.videoProject?.audio);
  const updateMeta = useVideoStore((s) => s.updateMeta);
  const updateAudioConfig = useVideoStore((s) => s.updateAudioConfig);

  const handleResolutionChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const opt = RESOLUTION_OPTIONS[parseInt(e.target.value, 10)];
      if (opt) updateMeta({ width: opt.width, height: opt.height, aspectRatio: opt.aspectRatio });
    },
    [updateMeta],
  );

  const handleBgmSelect = useCallback(async () => {
    const path = await open({
      filters: [{ name: "Audio", extensions: ["mp3", "wav", "ogg", "m4a"] }],
    });
    if (path) {
      updateAudioConfig({ bgm: { src: path as string, volume: audio?.bgm?.volume ?? 0.3 } });
    }
  }, [updateAudioConfig, audio]);

  if (!meta || !audio) return null;

  const currentResIdx = RESOLUTION_OPTIONS.findIndex(
    (o) => o.width === meta.width && o.height === meta.height,
  );

  return (
    <div className="video-settings-bar">
      <div className="video-settings-bar__title">{t("globalSettings")}</div>
      <div className="video-settings-bar__row">
        <label>{t("resolution")}</label>
        <select value={currentResIdx >= 0 ? currentResIdx : 0} onChange={handleResolutionChange}>
          {RESOLUTION_OPTIONS.map((opt, i) => (
            <option key={i} value={i}>{opt.label}</option>
          ))}
        </select>
      </div>
      <div className="video-settings-bar__row">
        <label>{t("bgm")}</label>
        <button className="video-settings-bar__btn" onClick={handleBgmSelect}>
          {audio.bgm ? audio.bgm.src.split(/[/\\]/).pop() : t("bgmSelect")}
        </button>
        {audio.bgm && (
          <input
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={audio.bgm.volume}
            onChange={(e) =>
              updateAudioConfig({ bgm: { ...audio.bgm!, volume: parseFloat(e.target.value) } })
            }
          />
        )}
      </div>
      <div className="video-settings-bar__row">
        <label>{t("ttsProvider")}</label>
        <select
          value={audio.tts.provider}
          onChange={(e) =>
            updateAudioConfig({ tts: { ...audio.tts, provider: e.target.value as any } })
          }
        >
          <option value="voicevox">VOICEVOX</option>
        </select>
      </div>
      <div className="video-settings-bar__row">
        <label>{t("ttsSpeaker")}</label>
        <input
          type="text"
          value={audio.tts.speaker ?? "1"}
          onChange={(e) => updateAudioConfig({ tts: { ...audio.tts, speaker: e.target.value } })}
          style={{ width: 60 }}
        />
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Create SceneEditForm**

```tsx
// src/features/video/components/SceneEditForm.tsx
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useVideoStore } from "@/stores/video-store";
import { generateNarrationForScene } from "../lib/narration-generator";
import type { Scene, TransitionConfig } from "../types";

interface SceneEditFormProps {
  scene: Scene;
}

export function SceneEditForm({ scene }: SceneEditFormProps) {
  const { t } = useTranslation("video");
  const updateScene = useVideoStore((s) => s.updateScene);
  const markNarrationDirty = useVideoStore((s) => s.markNarrationDirty);

  const handleNarrationChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      updateScene(scene.id, { narration: e.target.value });
      markNarrationDirty(scene.id);
    },
    [scene.id, updateScene, markNarrationDirty],
  );

  const handleRegenerateNarration = useCallback(async () => {
    const narration = await generateNarrationForScene(scene);
    updateScene(scene.id, { narration });
    markNarrationDirty(scene.id);
  }, [scene, updateScene, markNarrationDirty]);

  const handleTransitionChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      updateScene(scene.id, {
        transition: { ...scene.transition, type: e.target.value as TransitionConfig["type"] },
      });
    },
    [scene.id, scene.transition, updateScene],
  );

  const handleCaptionsToggle = useCallback(() => {
    updateScene(scene.id, {
      captions: { ...scene.captions, enabled: !scene.captions?.enabled },
    });
  }, [scene.id, scene.captions, updateScene]);

  return (
    <div className="scene-edit-form">
      <div className="scene-edit-form__header">
        {scene.title ?? scene.id}
        {scene.narrationDirty && (
          <span className="scene-edit-form__dirty">{t("narrationDirty")}</span>
        )}
      </div>

      <div className="scene-edit-form__field">
        <label>{t("narration")}</label>
        <div className="scene-edit-form__narration-row">
          <textarea
            value={scene.narration}
            onChange={handleNarrationChange}
            rows={3}
          />
          <button
            className="scene-edit-form__btn"
            onClick={handleRegenerateNarration}
            title={t("narrationRegenerate")}
          >
            ↻
          </button>
        </div>
      </div>

      <div className="scene-edit-form__row">
        <div className="scene-edit-form__field">
          <label>{t("captions")}</label>
          <button
            className={`scene-edit-form__toggle ${scene.captions?.enabled ? "scene-edit-form__toggle--on" : ""}`}
            onClick={handleCaptionsToggle}
          >
            {scene.captions?.enabled ? t("captionsOn") : t("captionsOff")}
          </button>
        </div>

        <div className="scene-edit-form__field">
          <label>{t("transition")}</label>
          <select value={scene.transition.type} onChange={handleTransitionChange}>
            <option value="fade">{t("fade")}</option>
            <option value="slide-left">{t("slideLeft")}</option>
            <option value="slide-right">{t("slideRight")}</option>
            <option value="slide-up">{t("slideUp")}</option>
            <option value="none">{t("none")}</option>
          </select>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Create ExportDialog**

```tsx
// src/features/video/components/ExportDialog.tsx
import { useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { save } from "@tauri-apps/plugin-dialog";
import { useVideoStore } from "@/stores/video-store";

interface ExportDialogProps {
  onClose: () => void;
  onExport: (options: ExportOptions) => void;
}

export interface ExportOptions {
  format: "mp4" | "webm";
  width: number;
  height: number;
  fps: number;
  concurrency: number;
  outputPath: string;
}

export function ExportDialog({ onClose, onExport }: ExportDialogProps) {
  const { t } = useTranslation("video");
  const meta = useVideoStore((s) => s.videoProject?.meta);
  const renderProgress = useVideoStore((s) => s.renderProgress);

  const [format, setFormat] = useState<"mp4" | "webm">("mp4");
  const [fps, setFps] = useState(meta?.fps ?? 30);
  const [concurrency, setConcurrency] = useState(4);
  const [outputPath, setOutputPath] = useState("");
  const [exporting, setExporting] = useState(false);

  const handleSelectOutput = useCallback(async () => {
    const path = await save({
      filters: [
        { name: format === "mp4" ? "MP4 Video" : "WebM Video", extensions: [format] },
      ],
      defaultPath: `output.${format}`,
    });
    if (path) setOutputPath(path);
  }, [format]);

  const handleExport = useCallback(() => {
    if (!outputPath || !meta) return;
    setExporting(true);
    onExport({
      format,
      width: meta.width,
      height: meta.height,
      fps,
      concurrency,
      outputPath,
    });
  }, [outputPath, meta, format, fps, concurrency, onExport]);

  return (
    <div className="export-dialog__overlay">
      <div className="export-dialog">
        <h3>{t("exportDialog")}</h3>

        <div className="export-dialog__field">
          <label>{t("format")}</label>
          <label><input type="radio" value="mp4" checked={format === "mp4"} onChange={() => setFormat("mp4")} /> MP4</label>
          <label><input type="radio" value="webm" checked={format === "webm"} onChange={() => setFormat("webm")} /> WebM</label>
        </div>

        <div className="export-dialog__field">
          <label>{t("resolution")}</label>
          <span>{meta?.width ?? 1920} x {meta?.height ?? 1080}</span>
        </div>

        <div className="export-dialog__field">
          <label>{t("fps")}</label>
          <input type="number" value={fps} onChange={(e) => setFps(parseInt(e.target.value, 10))} min={1} max={60} />
        </div>

        <div className="export-dialog__field">
          <label>{t("concurrency")}</label>
          <input type="number" value={concurrency} onChange={(e) => setConcurrency(parseInt(e.target.value, 10))} min={1} max={16} />
        </div>

        <div className="export-dialog__field">
          <label>{t("outputPath")}</label>
          <button onClick={handleSelectOutput}>{outputPath || "..."}</button>
        </div>

        {exporting && (
          <div className="export-dialog__progress">
            <div className="export-dialog__progress-bar" style={{ width: `${renderProgress}%` }} />
            <span>{renderProgress}%</span>
          </div>
        )}

        <div className="export-dialog__actions">
          <button onClick={onClose} disabled={exporting}>{t("cancel")}</button>
          <button onClick={handleExport} disabled={exporting || !outputPath}>
            {exporting ? t("exporting") : t("export")}
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Create CSS**

```css
/* src/features/video/components/VideoPanel.css */

.video-panel {
  display: flex;
  height: 100%;
  gap: 0;
}

.video-panel__left {
  flex: 1;
  overflow-y: auto;
  padding: 12px;
  border-right: 1px solid var(--border-color, #333);
}

.video-panel__right {
  width: 400px;
  min-width: 300px;
  display: flex;
  flex-direction: column;
  padding: 12px;
}

.video-panel__player {
  flex: 1;
  background: #000;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  overflow: hidden;
}

.video-panel__actions {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 12px;
}

.video-panel__actions button {
  padding: 8px 16px;
  border: 1px solid var(--border-color, #555);
  border-radius: 4px;
  background: var(--bg-secondary, #2a2a2a);
  color: var(--text-primary, #ccc);
  cursor: pointer;
}

.video-panel__actions button:hover {
  background: var(--bg-hover, #3a3a3a);
}

/* Settings Bar */
.video-settings-bar {
  margin-bottom: 16px;
  padding: 12px;
  border: 1px solid var(--border-color, #333);
  border-radius: 4px;
}

.video-settings-bar__title {
  font-weight: bold;
  margin-bottom: 8px;
  font-size: 13px;
}

.video-settings-bar__row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
  font-size: 12px;
}

.video-settings-bar__row label {
  min-width: 100px;
}

.video-settings-bar__row select,
.video-settings-bar__row input[type="text"] {
  background: var(--bg-secondary, #2a2a2a);
  color: var(--text-primary, #ccc);
  border: 1px solid var(--border-color, #555);
  border-radius: 3px;
  padding: 2px 6px;
}

.video-settings-bar__btn {
  background: var(--bg-secondary, #2a2a2a);
  color: var(--text-primary, #ccc);
  border: 1px solid var(--border-color, #555);
  border-radius: 3px;
  padding: 2px 8px;
  cursor: pointer;
  font-size: 12px;
  max-width: 150px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Scene Edit Form */
.scene-edit-form {
  border: 1px solid var(--border-color, #333);
  border-radius: 4px;
  padding: 12px;
  margin-bottom: 8px;
}

.scene-edit-form__header {
  font-weight: bold;
  font-size: 13px;
  margin-bottom: 8px;
  display: flex;
  align-items: center;
  gap: 8px;
}

.scene-edit-form__dirty {
  font-size: 11px;
  color: #f59e0b;
  font-weight: normal;
}

.scene-edit-form__field {
  margin-bottom: 6px;
  font-size: 12px;
}

.scene-edit-form__field label {
  display: block;
  margin-bottom: 2px;
  opacity: 0.7;
}

.scene-edit-form__narration-row {
  display: flex;
  gap: 4px;
}

.scene-edit-form__narration-row textarea {
  flex: 1;
  background: var(--bg-secondary, #1e1e1e);
  color: var(--text-primary, #ccc);
  border: 1px solid var(--border-color, #555);
  border-radius: 3px;
  padding: 6px;
  font-size: 12px;
  resize: vertical;
}

.scene-edit-form__btn {
  background: var(--bg-secondary, #2a2a2a);
  color: var(--text-primary, #ccc);
  border: 1px solid var(--border-color, #555);
  border-radius: 3px;
  padding: 4px 8px;
  cursor: pointer;
  font-size: 14px;
}

.scene-edit-form__row {
  display: flex;
  gap: 12px;
}

.scene-edit-form__toggle {
  background: var(--bg-secondary, #2a2a2a);
  color: #999;
  border: 1px solid var(--border-color, #555);
  border-radius: 3px;
  padding: 2px 8px;
  cursor: pointer;
  font-size: 11px;
}

.scene-edit-form__toggle--on {
  color: #4ade80;
  border-color: #4ade80;
}

.scene-edit-form__field select {
  background: var(--bg-secondary, #2a2a2a);
  color: var(--text-primary, #ccc);
  border: 1px solid var(--border-color, #555);
  border-radius: 3px;
  padding: 2px 6px;
  font-size: 12px;
}

/* Export Dialog */
.export-dialog__overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.export-dialog {
  background: var(--bg-primary, #1e1e1e);
  border: 1px solid var(--border-color, #555);
  border-radius: 8px;
  padding: 24px;
  min-width: 400px;
}

.export-dialog h3 {
  margin: 0 0 16px;
}

.export-dialog__field {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
  font-size: 13px;
}

.export-dialog__field label:first-child {
  min-width: 100px;
}

.export-dialog__progress {
  margin: 12px 0;
  background: var(--bg-secondary, #2a2a2a);
  border-radius: 4px;
  overflow: hidden;
  position: relative;
  height: 24px;
}

.export-dialog__progress-bar {
  height: 100%;
  background: #3b82f6;
  transition: width 0.3s;
}

.export-dialog__progress span {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
}

.export-dialog__actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 16px;
}

.export-dialog__actions button {
  padding: 6px 16px;
  border: 1px solid var(--border-color, #555);
  border-radius: 4px;
  background: var(--bg-secondary, #2a2a2a);
  color: var(--text-primary, #ccc);
  cursor: pointer;
}
```

- [ ] **Step 5: Commit**

```bash
git add src/features/video/components/
git commit -m "feat(video): add scene editing UI components and styles"
```

---

## Task 11: Build the main VideoPanel and hook

**Files:**
- Create: `src/features/video/hooks/useVideoGeneration.ts`
- Create: `src/features/video/components/VideoPanel.tsx`

- [ ] **Step 1: Create useVideoGeneration hook**

```tsx
// src/features/video/hooks/useVideoGeneration.ts
import { useCallback, useState } from "react";
import { useVideoStore } from "@/stores/video-store";
import { createTTSProvider } from "../lib/tts-provider";
import { generateSrt } from "../lib/srt-generator";
import { generateNarrationForScene } from "../lib/narration-generator";
import type { Scene } from "../types";

export function useVideoGeneration() {
  const videoProject = useVideoStore((s) => s.videoProject);
  const updateScene = useVideoStore((s) => s.updateScene);
  const setAudioGenerated = useVideoStore((s) => s.setAudioGenerated);
  const [generating, setGenerating] = useState(false);
  const [generatingStatus, setGeneratingStatus] = useState("");

  const generateAudioForAllScenes = useCallback(async () => {
    if (!videoProject) return;
    setGenerating(true);

    try {
      const provider = createTTSProvider(videoProject.audio.tts.provider);
      const fps = videoProject.meta.fps;

      for (let i = 0; i < videoProject.scenes.length; i++) {
        const scene = videoProject.scenes[i];

        // Skip if audio is already generated and not dirty
        if (scene.narrationAudio && !scene.narrationDirty) continue;

        setGeneratingStatus(`${i + 1}/${videoProject.scenes.length}: ${scene.title ?? scene.id}`);

        // Generate narration text with LLM if empty
        let narrationText = scene.narration;
        if (!narrationText || narrationText.trim() === "") {
          narrationText = await generateNarrationForScene(scene);
          updateScene(scene.id, { narration: narrationText });
        }

        // Synthesize audio
        const result = await provider.synthesize(narrationText, {
          voice: videoProject.audio.tts.speaker ?? "1",
          speed: videoProject.audio.tts.speed,
          volume: videoProject.audio.tts.volume,
        });

        // Generate SRT captions
        const srt = generateSrt(result.timingData, narrationText, result.durationMs);

        // Calculate duration in frames with padding
        const paddingFrames = 15;
        const durationInFrames = Math.ceil((result.durationMs / 1000) * fps) + paddingFrames;

        updateScene(scene.id, {
          narrationAudio: result.audioPath,
          durationInFrames,
          narrationDirty: false,
          captions: { ...scene.captions, enabled: scene.captions?.enabled ?? true, srt },
        });
      }

      setAudioGenerated(true);
    } catch (e) {
      console.error("Audio generation failed:", e);
      throw e;
    } finally {
      setGenerating(false);
      setGeneratingStatus("");
    }
  }, [videoProject, updateScene, setAudioGenerated]);

  const generateAudioForScene = useCallback(
    async (sceneId: string) => {
      if (!videoProject) return;
      const scene = videoProject.scenes.find((s) => s.id === sceneId);
      if (!scene) return;

      setGenerating(true);
      try {
        const provider = createTTSProvider(videoProject.audio.tts.provider);
        const fps = videoProject.meta.fps;

        const result = await provider.synthesize(scene.narration, {
          voice: videoProject.audio.tts.speaker ?? "1",
          speed: videoProject.audio.tts.speed,
          volume: videoProject.audio.tts.volume,
        });

        const srt = generateSrt(result.timingData, scene.narration, result.durationMs);
        const paddingFrames = 15;
        const durationInFrames = Math.ceil((result.durationMs / 1000) * fps) + paddingFrames;

        updateScene(sceneId, {
          narrationAudio: result.audioPath,
          durationInFrames,
          narrationDirty: false,
          captions: { ...scene.captions, enabled: scene.captions?.enabled ?? true, srt },
        });
      } finally {
        setGenerating(false);
      }
    },
    [videoProject, updateScene],
  );

  return {
    generating,
    generatingStatus,
    generateAudioForAllScenes,
    generateAudioForScene,
  };
}
```

- [ ] **Step 2: Create VideoPanel**

```tsx
// src/features/video/components/VideoPanel.tsx
import { useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useVideoStore } from "@/stores/video-store";
import { useUiStore } from "@/stores/ui-store";
import { useVideoGeneration } from "../hooks/useVideoGeneration";
import { VideoSettingsBar } from "./VideoSettingsBar";
import { SceneEditForm } from "./SceneEditForm";
import { ExportDialog } from "./ExportDialog";
import type { ExportOptions } from "./ExportDialog";
import "./VideoPanel.css";

export function VideoPanel() {
  const { t } = useTranslation("video");
  const videoProject = useVideoStore((s) => s.videoProject);
  const audioGenerated = useVideoStore((s) => s.audioGenerated);
  const setIsVideoMode = useVideoStore((s) => s.setIsVideoMode);
  const setActiveViewTab = useUiStore((s) => s.setActiveViewTab);
  const { generating, generatingStatus, generateAudioForAllScenes } = useVideoGeneration();
  const [showExport, setShowExport] = useState(false);

  const handleBackToEditor = useCallback(() => {
    setIsVideoMode(false);
    setActiveViewTab("preview");
  }, [setIsVideoMode, setActiveViewTab]);

  const handleGenerateAudio = useCallback(async () => {
    try {
      await generateAudioForAllScenes();
    } catch (e) {
      console.error(e);
    }
  }, [generateAudioForAllScenes]);

  const handleExport = useCallback(async (_options: ExportOptions) => {
    // TODO: Task 13 will implement the full render pipeline
    console.log("Export requested:", _options);
  }, []);

  if (!videoProject) {
    return <div className="video-panel">{t("audioNotGenerated")}</div>;
  }

  return (
    <div className="video-panel">
      <div className="video-panel__left">
        <VideoSettingsBar />
        {videoProject.scenes.map((scene) => (
          <SceneEditForm key={scene.id} scene={scene} />
        ))}
      </div>

      <div className="video-panel__right">
        <div className="video-panel__player">
          {/* Player component will be added in Task 12 */}
          <span style={{ color: "#666", fontSize: 13 }}>
            {audioGenerated ? "Player Preview" : t("audioNotGenerated")}
          </span>
        </div>

        <div className="video-panel__actions">
          <button onClick={handleGenerateAudio} disabled={generating}>
            {generating ? generatingStatus || t("generatingAudio") : t("generateAudio")}
          </button>
          <button
            onClick={() => setShowExport(true)}
            disabled={!audioGenerated}
          >
            {t("export")}
          </button>
          <button onClick={handleBackToEditor}>{t("backToEditor")}</button>
        </div>
      </div>

      {showExport && (
        <ExportDialog onClose={() => setShowExport(false)} onExport={handleExport} />
      )}
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add src/features/video/hooks/useVideoGeneration.ts src/features/video/components/VideoPanel.tsx
git commit -m "feat(video): add main VideoPanel and audio generation hook"
```

---

## Task 12: Integrate VideoPanel into PreviewPanel

**Files:**
- Modify: `src/features/preview/components/PreviewPanel.tsx`

- [ ] **Step 1: Add video tab button and VideoPanel rendering**

Add import at the top of PreviewPanel.tsx:

```typescript
import { VideoPanel } from "@/features/video/components/VideoPanel";
import { useVideoStore } from "@/stores/video-store";
import { convertMdToVideoProject } from "@/features/video/lib/md-to-scenes";
```

Add near the existing `isSlidev` useMemo (around line 288):

```typescript
const isVideoMode = useVideoStore((s) => s.isVideoMode);
const setIsVideoMode = useVideoStore((s) => s.setIsVideoMode);
const setVideoProject = useVideoStore((s) => s.setVideoProject);

const handleEnterVideoMode = useCallback(() => {
  if (!filePath) return;
  const project = convertMdToVideoProject(content, filePath);
  setVideoProject(project);
  setIsVideoMode(true);
  setActiveViewTab("video");
}, [content, filePath, setVideoProject, setIsVideoMode, setActiveViewTab]);
```

Add a [▷] tab button in the tab bar, after the Slidev tab button (around line 755):

```tsx
<button
  className={`preview-panel__tab preview-panel__tab--icon ${activeViewTab === "video" ? "preview-panel__tab--active" : ""}`}
  onClick={handleEnterVideoMode}
  title="Video"
>
  ▷
</button>
```

Add the VideoPanel rendering condition, after the `slidev-preview` block (around line 815):

```tsx
{activeViewTab === "video" && <VideoPanel />}
```

- [ ] **Step 2: Verify the app compiles**

```bash
npm run build
```

Expected: No TypeScript or build errors.

- [ ] **Step 3: Commit**

```bash
git add src/features/preview/components/PreviewPanel.tsx
git commit -m "feat(video): integrate VideoPanel into PreviewPanel with [▷] tab button"
```

---

## Task 13: Implement React Composition builder (scene-to-composition)

**Files:**
- Create: `src/features/video/lib/scene-to-composition.tsx`

- [ ] **Step 1: Implement the Composition builder**

This file creates the React component tree that open-motion's Player and renderer will use.

```tsx
// src/features/video/lib/scene-to-composition.tsx
import React from "react";
import {
  Sequence,
  Audio,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
} from "@open-motion/core";
import { Captions } from "@open-motion/components";
import { parseSrt } from "@open-motion/core";
import type { VideoProject, Scene, SceneElement } from "../types";

// --- Main Composition Component ---

interface VideoCompositionProps {
  project: VideoProject;
}

export function VideoComposition({ project }: VideoCompositionProps) {
  const { scenes, audio } = project;
  let frameOffset = 0;

  return (
    <>
      {scenes.map((scene) => {
        const duration = scene.durationInFrames ?? 150; // fallback 5s@30fps
        const from = frameOffset;
        frameOffset += duration - (scene.transition.durationInFrames ?? 0);

        return (
          <Sequence key={scene.id} from={from} durationInFrames={duration}>
            <SceneRenderer scene={scene} />
            {scene.narrationAudio && (
              <Audio src={scene.narrationAudio} volume={audio.tts.volume} />
            )}
            {scene.captions?.enabled && scene.captions?.srt && (
              <CaptionsOverlay srt={scene.captions.srt} />
            )}
          </Sequence>
        );
      })}
      {audio.bgm && <Audio src={audio.bgm.src} volume={audio.bgm.volume} />}
    </>
  );
}

export function calculateTotalDuration(project: VideoProject): number {
  let total = 0;
  for (const scene of project.scenes) {
    const duration = scene.durationInFrames ?? 150;
    total += duration;
    // Subtract overlap for transitions (except last scene)
    if (scene !== project.scenes[project.scenes.length - 1]) {
      total -= scene.transition.durationInFrames ?? 0;
    }
  }
  return Math.max(total, 1);
}

// --- Scene Renderer ---

function SceneRenderer({ scene }: { scene: Scene }) {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const transitionFrames = scene.transition.durationInFrames;

  // Transition: fade in at start
  const opacity =
    scene.transition.type === "none"
      ? 1
      : interpolate(frame, [0, transitionFrames], [0, 1], {
          extrapolateRight: "clamp",
        });

  // Slide transition offset
  let translateX = 0;
  let translateY = 0;
  if (scene.transition.type === "slide-left") {
    translateX = interpolate(frame, [0, transitionFrames], [width, 0], {
      extrapolateRight: "clamp",
    });
  } else if (scene.transition.type === "slide-right") {
    translateX = interpolate(frame, [0, transitionFrames], [-width, 0], {
      extrapolateRight: "clamp",
    });
  } else if (scene.transition.type === "slide-up") {
    translateY = interpolate(frame, [0, transitionFrames], [height, 0], {
      extrapolateRight: "clamp",
    });
  }

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        opacity,
        transform: `translate(${translateX}px, ${translateY}px)`,
        backgroundColor: "#1a1a2e",
        color: "#fff",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        padding: "60px 80px",
        boxSizing: "border-box",
        fontFamily: "'Noto Sans JP', 'Segoe UI', sans-serif",
      }}
    >
      {scene.elements.map((el, i) => (
        <ElementRenderer key={i} element={el} index={i} />
      ))}
    </div>
  );
}

// --- Element Renderers ---

function ElementRenderer({ element, index }: { element: SceneElement; index: number }) {
  switch (element.type) {
    case "title":
      return <TitleRenderer element={element} index={index} />;
    case "text":
      return <TextRenderer element={element} index={index} />;
    case "bullet-list":
      return <BulletListRenderer element={element} index={index} />;
    case "image":
      return <ImageRenderer element={element} index={index} />;
    case "table":
      return <TableRenderer element={element} index={index} />;
    case "code-block":
      return <CodeBlockRenderer element={element} index={index} />;
    default:
      return null;
  }
}

function TitleRenderer({ element, index }: { element: { type: "title"; text: string; level: 1 | 2 | 3; animation: string }; index: number }) {
  const frame = useCurrentFrame();
  const delay = index * 10;
  const opacity =
    element.animation === "none" ? 1 : interpolate(frame, [delay, delay + 20], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const translateY =
    element.animation === "slide-in"
      ? interpolate(frame, [delay, delay + 20], [30, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
      : 0;

  const fontSize = element.level === 1 ? 56 : element.level === 2 ? 42 : 32;

  return (
    <div style={{ opacity, transform: `translateY(${translateY}px)`, fontSize, fontWeight: "bold", marginBottom: 20 }}>
      {element.text}
    </div>
  );
}

function TextRenderer({ element, index }: { element: { type: "text"; content: string; animation: string }; index: number }) {
  const frame = useCurrentFrame();
  const delay = index * 10;
  const opacity = element.animation === "none" ? 1 : interpolate(frame, [delay, delay + 15], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

  return (
    <p style={{ opacity, fontSize: 24, lineHeight: 1.6, marginBottom: 12 }}>{element.content}</p>
  );
}

function BulletListRenderer({ element, index }: { element: { type: "bullet-list"; items: string[]; animation: string; delayPerItem: number }; index: number }) {
  const frame = useCurrentFrame();
  const baseDelay = index * 10;

  return (
    <ul style={{ fontSize: 24, lineHeight: 1.8, marginBottom: 16, paddingLeft: 30 }}>
      {element.items.map((item, i) => {
        const itemDelay = baseDelay + (element.animation === "sequential" ? i * element.delayPerItem : 0);
        const opacity = element.animation === "none" ? 1 : interpolate(frame, [itemDelay, itemDelay + 15], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
        return (
          <li key={i} style={{ opacity }}>
            {item}
          </li>
        );
      })}
    </ul>
  );
}

function ImageRenderer({ element, index }: { element: { type: "image"; src: string; alt?: string; position: string; animation: string }; index: number }) {
  const frame = useCurrentFrame();
  const delay = index * 10;
  const opacity = element.animation === "none" ? 1 : interpolate(frame, [delay, delay + 20], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const scale = element.animation === "zoom-in" ? interpolate(frame, [delay, delay + 30], [0.8, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) : 1;

  return (
    <div style={{ opacity, transform: `scale(${scale})`, textAlign: "center", marginBottom: 16 }}>
      <img src={element.src} alt={element.alt ?? ""} style={{ maxWidth: "80%", maxHeight: 400, borderRadius: 8 }} />
    </div>
  );
}

function TableRenderer({ element, index }: { element: { type: "table"; headers: string[]; rows: string[][]; animation: string }; index: number }) {
  const frame = useCurrentFrame();
  const baseDelay = index * 10;

  return (
    <table style={{ borderCollapse: "collapse", fontSize: 20, marginBottom: 16, width: "100%" }}>
      <thead>
        <tr>
          {element.headers.map((h, i) => (
            <th key={i} style={{ border: "1px solid #555", padding: "8px 12px", background: "#2a2a3e", textAlign: "left" }}>
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {element.rows.map((row, ri) => {
          const rowDelay = baseDelay + (element.animation === "row-by-row" ? ri * 20 : 0);
          const opacity = element.animation === "none" ? 1 : interpolate(frame, [rowDelay, rowDelay + 15], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
          return (
            <tr key={ri} style={{ opacity }}>
              {row.map((cell, ci) => (
                <td key={ci} style={{ border: "1px solid #444", padding: "8px 12px" }}>
                  {cell}
                </td>
              ))}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function CodeBlockRenderer({ element, index }: { element: { type: "code-block"; code: string; language: string; animation: string }; index: number }) {
  const frame = useCurrentFrame();
  const delay = index * 10;
  const opacity = element.animation === "none" ? 1 : interpolate(frame, [delay, delay + 15], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

  return (
    <pre
      style={{
        opacity,
        background: "#0d1117",
        borderRadius: 8,
        padding: 16,
        fontSize: 18,
        fontFamily: "'Cascadia Code', 'Fira Code', monospace",
        overflow: "hidden",
        marginBottom: 16,
      }}
    >
      <code>{element.code}</code>
    </pre>
  );
}

// --- Captions Overlay ---

function CaptionsOverlay({ srt }: { srt: string }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const subtitles = parseSrt(srt);
  const currentTimeMs = (frame / fps) * 1000;

  const activeSub = subtitles.find(
    (s: { start: number; end: number }) => currentTimeMs >= s.start && currentTimeMs <= s.end,
  );

  if (!activeSub) return null;

  return (
    <div
      style={{
        position: "absolute",
        bottom: 60,
        left: 0,
        right: 0,
        textAlign: "center",
        pointerEvents: "none",
      }}
    >
      <span
        style={{
          background: "rgba(0,0,0,0.7)",
          color: "#fff",
          padding: "8px 20px",
          borderRadius: 6,
          fontSize: 28,
          fontFamily: "'Noto Sans JP', sans-serif",
        }}
      >
        {activeSub.text}
      </span>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/features/video/lib/scene-to-composition.tsx
git commit -m "feat(video): implement React Composition builder with element renderers and captions"
```

---

## Task 14: Integrate Player preview into VideoPanel

**Files:**
- Modify: `src/features/video/components/VideoPanel.tsx`

- [ ] **Step 1: Add Player import and rendering**

Update VideoPanel.tsx to use the open-motion Player with the Composition:

Add imports:

```typescript
import { Player } from "@open-motion/core";
import { VideoComposition, calculateTotalDuration } from "../lib/scene-to-composition";
```

Replace the placeholder `<span>` inside `.video-panel__player` with:

```tsx
<div className="video-panel__player">
  {videoProject && (
    <Player
      component={() => <VideoComposition project={videoProject} />}
      durationInFrames={calculateTotalDuration(videoProject)}
      width={videoProject.meta.width}
      height={videoProject.meta.height}
      fps={videoProject.meta.fps}
    />
  )}
</div>
```

Remove the old placeholder `<span>` that was there.

- [ ] **Step 2: Verify the app compiles**

```bash
npm run build
```

- [ ] **Step 3: Commit**

```bash
git add src/features/video/components/VideoPanel.tsx
git commit -m "feat(video): integrate open-motion Player preview into VideoPanel"
```

---

## Task 15: Verify end-to-end flow and fix issues

**Files:** Various (depends on issues found)

- [ ] **Step 1: Start the dev environment**

```bash
npm run tauri dev
```

- [ ] **Step 2: Manual test the end-to-end flow**

1. Open a Markdown file with `<!-- pagebreak -->` separators
2. Click the [▷] tab button
3. Verify scenes are parsed and shown in the edit form
4. Verify the Player shows static preview (no audio yet)
5. Edit a narration text field — verify the "Out of sync" indicator appears
6. If VOICEVOX is running, click "Generate Audio" and verify:
   - Audio files are generated
   - durationInFrames is set per scene
   - Player plays with narration and captions
7. Click "Export" and verify the dialog appears

- [ ] **Step 3: Fix any TypeScript or runtime errors found**

Address issues as they come up. Common issues to watch for:
- Path resolution for images (Windows backslash vs forward slash)
- open-motion core API differences from what we assumed
- Player component prop interface mismatches

- [ ] **Step 4: Commit fixes**

```bash
git add -A
git commit -m "fix(video): address integration issues from end-to-end testing"
```

---

## Task 16: Add VOICEVOX connection check

**Files:**
- Modify: `src/features/video/hooks/useVideoGeneration.ts`
- Modify: `src/features/video/components/VideoPanel.tsx`

- [ ] **Step 1: Add connection check to useVideoGeneration**

Add at the top of the `generateAudioForAllScenes` callback, before the TTS loop:

```typescript
// Check VOICEVOX connectivity
if (videoProject.audio.tts.provider === "voicevox") {
  try {
    const res = await fetch("http://localhost:50021/version");
    if (!res.ok) throw new Error("VOICEVOX not responding");
  } catch {
    throw new Error("voicevox_not_running");
  }
}
```

- [ ] **Step 2: Handle error in VideoPanel**

In VideoPanel's `handleGenerateAudio`, update the catch block:

```typescript
const handleGenerateAudio = useCallback(async () => {
  try {
    await generateAudioForAllScenes();
  } catch (e: any) {
    if (e?.message === "voicevox_not_running") {
      alert(t("voicevoxNotRunning"));
    } else {
      console.error(e);
      alert(String(e));
    }
  }
}, [generateAudioForAllScenes, t]);
```

- [ ] **Step 3: Commit**

```bash
git add src/features/video/hooks/useVideoGeneration.ts src/features/video/components/VideoPanel.tsx
git commit -m "feat(video): add VOICEVOX connection check before audio generation"
```
