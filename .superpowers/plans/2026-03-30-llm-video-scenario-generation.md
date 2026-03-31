# LLM Video Scenario Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace mechanical MD→VideoProject conversion with an OpenCode builtin command (`/generate-video`) that uses LLM to intelligently generate the full VideoProject JSON.

**Architecture:** Add `builtin-commands.ts` (same pattern as `builtin-skills.ts` / `builtin-mcp-servers.ts`), a builtin command selector dropdown in `CommandsSection`, a 3-choice overwrite dialog in `PreviewPanel`, and auto-open logic in `useOpencodeChat` that opens the generated `.video.json` after command completion.

**Tech Stack:** React, TypeScript, Zustand, Tauri, OpenCode SDK, i18n (react-i18next)

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/shared/types/index.ts` | Modify | Add `BuiltinCommand` interface |
| `src/features/opencode-config/lib/builtin-commands.ts` | Create | Define `BUILTIN_COMMANDS` with `generate-video` command + prompt template |
| `src/features/opencode-config/components/sections/CommandsSection.tsx` | Modify | Add builtin command selector dropdown |
| `src/shared/i18n/locales/en/opencode-config.json` | Modify | Add `commandBuiltinSelect` key |
| `src/shared/i18n/locales/ja/opencode-config.json` | Modify | Add `commandBuiltinSelect` key |
| `src/features/video/components/VideoOverwriteDialog.tsx` | Create | 3-choice dialog (overwrite / new file / cancel) |
| `src/features/video/components/VideoOverwriteDialog.css` | Create | Dialog styles |
| `src/shared/i18n/locales/en/video.json` | Modify | Add dialog i18n keys |
| `src/shared/i18n/locales/ja/video.json` | Modify | Add dialog i18n keys |
| `src/features/preview/components/PreviewPanel.tsx` | Modify | Replace `handleEnterVideoMode` with dialog + chat command flow |
| `src/features/opencode-config/hooks/useOpencodeChat.ts` | Modify | Add pending output path tracking and auto-open on command completion |

---

### Task 1: Add BuiltinCommand type

**Files:**
- Modify: `src/shared/types/index.ts:195-199` (after `BuiltinSkill`)

- [ ] **Step 1: Add BuiltinCommand interface**

In `src/shared/types/index.ts`, add after the `BuiltinSkill` interface (after line 199):

```typescript
/** Built-in command definition */
export interface BuiltinCommand {
  name: string;
  description: string;
  template: string;
  agent?: string;
  model?: string;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/shared/types/index.ts
git commit -m "feat(video): add BuiltinCommand type definition"
```

---

### Task 2: Create builtin-commands.ts with generate-video command

**Files:**
- Create: `src/features/opencode-config/lib/builtin-commands.ts`

- [ ] **Step 1: Create the file with the full prompt template**

Create `src/features/opencode-config/lib/builtin-commands.ts`:

```typescript
import type { BuiltinCommand } from "@/shared/types";

export const BUILTIN_COMMANDS: Record<string, BuiltinCommand> = {
  "generate-video": {
    name: "generate-video",
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
```

- [ ] **Step 2: Commit**

```bash
git add src/features/opencode-config/lib/builtin-commands.ts
git commit -m "feat(video): add generate-video builtin command with LLM prompt template"
```

---

### Task 3: Add builtin command selector to CommandsSection

**Files:**
- Modify: `src/features/opencode-config/components/sections/CommandsSection.tsx`
- Modify: `src/shared/i18n/locales/en/opencode-config.json`
- Modify: `src/shared/i18n/locales/ja/opencode-config.json`

- [ ] **Step 1: Add i18n keys**

In `src/shared/i18n/locales/en/opencode-config.json`, add before the closing `}`:

```json
  "commandBuiltinSelect": "Select a built-in command..."
```

In `src/shared/i18n/locales/ja/opencode-config.json`, add before the closing `}`:

```json
  "commandBuiltinSelect": "ビルトイン コマンドを選択..."
```

- [ ] **Step 2: Add the selector dropdown to CommandsSection**

In `src/features/opencode-config/components/sections/CommandsSection.tsx`:

Add import at top:

```typescript
import { BUILTIN_COMMANDS } from "../../lib/builtin-commands";
```

Add the `<select>` dropdown inside the editing form block, right before the first `<div className="oc-section__field">` (the "commandName" field, around line 164). Insert this block:

```tsx
          {/* Built-In Command selector */}
          <div style={{ marginBottom: 8 }}>
            <select
              className="oc-section__builtin-select"
              value=""
              onChange={(e) => {
                const key = e.target.value;
                if (!key) return;
                const builtin = BUILTIN_COMMANDS[key];
                if (!builtin) return;
                setFormName(builtin.name);
                setFormDesc(builtin.description ?? "");
                setFormTemplate(builtin.template);
                setFormAgent(builtin.agent ?? "");
                setFormModel(builtin.model ?? "");
              }}
            >
              <option value="">{t("commandBuiltinSelect")}</option>
              {Object.keys(BUILTIN_COMMANDS).map((key) => (
                <option key={key} value={key}>{key}</option>
              ))}
            </select>
          </div>
```

- [ ] **Step 3: Verify the UI renders correctly**

```bash
cd C:/Users/mtmar/source/repos/mdium && npm run dev
```

Open the app → OpenCode Settings → Commands tab → click "+ Add" → verify the "Select a built-in command..." dropdown appears and selecting "generate-video" fills in all fields.

- [ ] **Step 4: Commit**

```bash
git add src/features/opencode-config/components/sections/CommandsSection.tsx src/shared/i18n/locales/en/opencode-config.json src/shared/i18n/locales/ja/opencode-config.json
git commit -m "feat(video): add builtin command selector dropdown to CommandsSection"
```

---

### Task 4: Create VideoOverwriteDialog component

**Files:**
- Create: `src/features/video/components/VideoOverwriteDialog.tsx`
- Create: `src/features/video/components/VideoOverwriteDialog.css`
- Modify: `src/shared/i18n/locales/en/video.json`
- Modify: `src/shared/i18n/locales/ja/video.json`

- [ ] **Step 1: Add i18n keys for the dialog**

In `src/shared/i18n/locales/en/video.json`, add before the closing `}`:

```json
  "overwriteDialogTitle": "Overwrite existing video settings?",
  "overwriteDialogMessage": "\"{{fileName}}\" already exists.",
  "overwriteDialogYes": "Yes (overwrite)",
  "overwriteDialogNo": "No (create new)",
  "overwriteDialogCancel": "Cancel"
```

In `src/shared/i18n/locales/ja/video.json`, add before the closing `}`:

```json
  "overwriteDialogTitle": "既存のビデオ設定を上書きしますか？",
  "overwriteDialogMessage": "「{{fileName}}」が既に存在します。",
  "overwriteDialogYes": "はい（上書き）",
  "overwriteDialogNo": "いいえ（新規作成）",
  "overwriteDialogCancel": "キャンセル"
```

- [ ] **Step 2: Create the dialog CSS**

Create `src/features/video/components/VideoOverwriteDialog.css`:

```css
.video-overwrite-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 9999;
}

.video-overwrite-dialog {
  background: var(--bg-primary, #1e1e1e);
  border: 1px solid var(--border-color, #333);
  border-radius: 8px;
  padding: 20px 24px;
  min-width: 360px;
  max-width: 480px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
}

.video-overwrite-dialog__title {
  margin: 0 0 8px;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary, #e0e0e0);
}

.video-overwrite-dialog__message {
  margin: 0 0 16px;
  font-size: 12px;
  color: var(--text-secondary, #aaa);
}

.video-overwrite-dialog__actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}

.video-overwrite-dialog__btn {
  padding: 6px 14px;
  border-radius: 4px;
  border: 1px solid var(--border-color, #444);
  font-size: 12px;
  cursor: pointer;
  background: var(--bg-secondary, #2a2a2a);
  color: var(--text-primary, #e0e0e0);
}

.video-overwrite-dialog__btn:hover {
  background: var(--bg-hover, #333);
}

.video-overwrite-dialog__btn--primary {
  background: var(--accent-blue, #3b82f6);
  border-color: var(--accent-blue, #3b82f6);
  color: #fff;
}

.video-overwrite-dialog__btn--primary:hover {
  opacity: 0.9;
}
```

- [ ] **Step 3: Create the dialog component**

Create `src/features/video/components/VideoOverwriteDialog.tsx`:

```tsx
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import "./VideoOverwriteDialog.css";

export type OverwriteChoice = "overwrite" | "new" | "cancel";

interface VideoOverwriteDialogProps {
  fileName: string;
  onChoice: (choice: OverwriteChoice) => void;
}

export function VideoOverwriteDialog({
  fileName,
  onChoice,
}: VideoOverwriteDialogProps) {
  const { t } = useTranslation("video");

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") onChoice("cancel");
    },
    [onChoice],
  );

  return (
    <div className="video-overwrite-overlay" onClick={() => onChoice("cancel")}>
      <div
        className="video-overwrite-dialog"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
        tabIndex={-1}
      >
        <h3 className="video-overwrite-dialog__title">
          {t("overwriteDialogTitle")}
        </h3>
        <p className="video-overwrite-dialog__message">
          {t("overwriteDialogMessage", { fileName })}
        </p>
        <div className="video-overwrite-dialog__actions">
          <button
            className="video-overwrite-dialog__btn"
            onClick={() => onChoice("cancel")}
          >
            {t("overwriteDialogCancel")}
          </button>
          <button
            className="video-overwrite-dialog__btn"
            onClick={() => onChoice("new")}
          >
            {t("overwriteDialogNo")}
          </button>
          <button
            className="video-overwrite-dialog__btn video-overwrite-dialog__btn--primary"
            onClick={() => onChoice("overwrite")}
          >
            {t("overwriteDialogYes")}
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Commit**

```bash
git add src/features/video/components/VideoOverwriteDialog.tsx src/features/video/components/VideoOverwriteDialog.css src/shared/i18n/locales/en/video.json src/shared/i18n/locales/ja/video.json
git commit -m "feat(video): add VideoOverwriteDialog with 3-choice (overwrite/new/cancel)"
```

---

### Task 5: Modify PreviewPanel to use dialog + chat command flow

**Files:**
- Modify: `src/features/preview/components/PreviewPanel.tsx`

- [ ] **Step 1: Add imports**

In `src/features/preview/components/PreviewPanel.tsx`, add these imports at the top (after existing imports):

```typescript
import { VideoOverwriteDialog, type OverwriteChoice } from "@/features/video/components/VideoOverwriteDialog";
import { useChatUIStore } from "@/features/opencode-config/hooks/useOpencodeChat";
import { useUiStore } from "@/stores/ui-store";
```

Note: `useUiStore` and `invoke` are already imported. Only add the ones that are missing.

- [ ] **Step 2: Add dialog state and helper**

Inside the `PreviewPanel` component body (near the existing state declarations), add:

```typescript
  const [overwriteDialog, setOverwriteDialog] = useState<{ videoJsonName: string; mdPath: string; baseName: string } | null>(null);
```

- [ ] **Step 3: Replace handleEnterVideoMode**

Replace the existing `handleEnterVideoMode` callback (lines 296-307) with:

```typescript
  const handleEnterVideoMode = useCallback(async () => {
    if (!filePath) return;

    // Derive paths
    const lastDot = filePath.lastIndexOf(".");
    const basePath = lastDot > 0 ? filePath.slice(0, lastDot) : filePath;
    const baseName = basePath.split(/[/\\]/).pop() ?? basePath;
    const videoJsonPath = basePath + ".video.json";
    const videoJsonName = baseName + ".video.json";

    // Check if .video.json already exists
    const existing = await invoke<string | null>("video_load_project", { mdPath: filePath });
    if (existing) {
      setOverwriteDialog({ videoJsonName, mdPath: filePath, baseName });
      return;
    }

    // No existing file — set command directly
    setChatCommandAndFocus(filePath, videoJsonPath);
  }, [filePath]);

  const setChatCommandAndFocus = useCallback((mdPath: string, outputPath: string) => {
    const command = `/generate-video ${mdPath} ${outputPath}`;
    useChatUIStore.setState({ chatInput: command });
    // Switch to chat panel and focus
    useUiStore.getState().setLeftPanel("opencode-config");
    useUiStore.getState().setOpencodeTopTab("chat");
  }, []);

  const handleOverwriteChoice = useCallback((choice: OverwriteChoice) => {
    if (!overwriteDialog) return;
    setOverwriteDialog(null);

    if (choice === "cancel") return;

    const { mdPath, baseName } = overwriteDialog;
    const lastDot = mdPath.lastIndexOf(".");
    const basePath = lastDot > 0 ? mdPath.slice(0, lastDot) : mdPath;
    const dir = mdPath.substring(0, Math.max(mdPath.lastIndexOf("/"), mdPath.lastIndexOf("\\")) + 1);

    if (choice === "overwrite") {
      setChatCommandAndFocus(mdPath, basePath + ".video.json");
    } else {
      // "new" — add timestamp
      const now = new Date();
      const ts = [
        now.getFullYear(),
        String(now.getMonth() + 1).padStart(2, "0"),
        String(now.getDate()).padStart(2, "0"),
        String(now.getHours()).padStart(2, "0"),
        String(now.getMinutes()).padStart(2, "0"),
        String(now.getSeconds()).padStart(2, "0"),
      ].join("");
      setChatCommandAndFocus(mdPath, dir + baseName + "_" + ts + ".video.json");
    }
  }, [overwriteDialog, setChatCommandAndFocus]);
```

- [ ] **Step 4: Remove unused imports**

Remove the now-unused imports:

```typescript
// REMOVE these imports:
import { convertMdToVideoProject } from "@/features/video/lib/md-to-scenes";
import { mergeWithSavedProject } from "@/features/video/lib/merge-project";
```

Note: Only remove these if no other code in `PreviewPanel.tsx` uses them. The `isVideoJson` detection block (lines 309-323) parses content directly from the tab, it does NOT use `convertMdToVideoProject`. Verify before removing.

- [ ] **Step 5: Add dialog to JSX**

In the component's return JSX, add the dialog just before the final closing `</div>` or alongside other modals:

```tsx
      {overwriteDialog && (
        <VideoOverwriteDialog
          fileName={overwriteDialog.videoJsonName}
          onChoice={handleOverwriteChoice}
        />
      )}
```

- [ ] **Step 6: Verify the flow**

```bash
cd C:/Users/mtmar/source/repos/mdium && npm run dev
```

Open a `.md` file → click ▷ → verify:
1. If no `.video.json` exists: chat input is set with `/generate-video ...` and chat panel is focused.
2. If `.video.json` exists: dialog appears with 3 choices. "Yes" sets the same filename, "No" sets a timestamped filename, "Cancel" closes the dialog.

- [ ] **Step 7: Commit**

```bash
git add src/features/preview/components/PreviewPanel.tsx
git commit -m "feat(video): replace mechanical video conversion with LLM command flow"
```

---

### Task 6: Add auto-open on command completion

**Files:**
- Modify: `src/features/opencode-config/hooks/useOpencodeChat.ts`

- [ ] **Step 1: Add pending output path state**

At module level (around line 62, after the existing module-level state), add:

```typescript
/** Output path to auto-open when a generate-video command completes */
let _pendingVideoOutput: string | null = null;
```

- [ ] **Step 2: Store output path on command execution**

In the `doExecuteCommand` function (line 435), add output path detection after the `displayText` line (line 442):

```typescript
  // Track generate-video output path for auto-open
  if (commandName === "generate-video" && args) {
    const parts = args.trim().split(/\s+/);
    if (parts.length >= 2) {
      _pendingVideoOutput = parts[parts.length - 1];
    }
  }
```

- [ ] **Step 3: Export a getter for the pending output and a clear function**

Add after the existing `getOpencodeClient` export (around line 52):

```typescript
/** Get and clear the pending video output path (consumed once) */
export function consumePendingVideoOutput(): string | null {
  const path = _pendingVideoOutput;
  _pendingVideoOutput = null;
  return path;
}
```

- [ ] **Step 4: Commit**

```bash
git add src/features/opencode-config/hooks/useOpencodeChat.ts
git commit -m "feat(video): track generate-video output path for auto-open"
```

---

### Task 7: Auto-open video file on command completion

**Files:**
- Modify: `src/features/preview/components/PreviewPanel.tsx`

- [ ] **Step 1: Import consumePendingVideoOutput**

Add to the imports in `PreviewPanel.tsx`:

```typescript
import { useChatUIStore, consumePendingVideoOutput } from "@/features/opencode-config/hooks/useOpencodeChat";
```

(Update the existing `useChatUIStore` import to also include `consumePendingVideoOutput`.)

- [ ] **Step 2: Add effect to watch for command completion**

Inside the `PreviewPanel` component body, add a `useEffect` that watches for the last assistant message becoming `completed`:

```typescript
  // Auto-open .video.json when generate-video command completes
  const chatMessages = useChatUIStore((s) => s.messages);
  const chatLoading = useChatUIStore((s) => s.loading);
  const prevChatLoadingRef = useRef(true);

  useEffect(() => {
    // Detect transition from loading → not loading
    if (prevChatLoadingRef.current && !chatLoading) {
      const outputPath = consumePendingVideoOutput();
      if (outputPath && onOpenFile) {
        // Small delay to ensure file is written
        setTimeout(() => onOpenFile(outputPath), 500);
      }
    }
    prevChatLoadingRef.current = chatLoading;
  }, [chatLoading, onOpenFile]);
```

- [ ] **Step 3: Verify the end-to-end flow**

```bash
cd C:/Users/mtmar/source/repos/mdium && npm run dev
```

1. Register the `generate-video` command: OpenCode Settings → Commands → Add → select builtin → Save.
2. Open a `.md` file → click ▷ → chat input is set.
3. Press Enter → LLM executes → writes `.video.json`.
4. After completion → `.video.json` is auto-opened → VideoPanel displays.

- [ ] **Step 4: Commit**

```bash
git add src/features/preview/components/PreviewPanel.tsx
git commit -m "feat(video): auto-open generated .video.json on command completion"
```

---

### Task 8: Final verification and cleanup

- [ ] **Step 1: TypeScript check**

```bash
cd C:/Users/mtmar/source/repos/mdium && npx tsc --noEmit
```

Fix any type errors.

- [ ] **Step 2: Verify no unused imports remain**

Check that `convertMdToVideoProject` and `mergeWithSavedProject` are not imported in `PreviewPanel.tsx` if they are no longer used. If other code still references them, keep the imports.

- [ ] **Step 3: Full flow test**

Manually test all paths:
1. **No existing `.video.json`**: ▷ → command in chat → Enter → streaming → auto-open
2. **Existing `.video.json` + Yes**: ▷ → dialog → Yes → command with original name → auto-open
3. **Existing `.video.json` + No**: ▷ → dialog → No → command with timestamped name → auto-open
4. **Existing `.video.json` + Cancel**: ▷ → dialog → Cancel → nothing happens
5. **Manual command**: Type `/generate-video <path> <output>` in chat directly → works
6. **Builtin selector**: Commands tab → Add → select `generate-video` from dropdown → fields auto-fill → Save

- [ ] **Step 4: Final commit if any fixes were needed**

```bash
git add -A
git commit -m "fix(video): address cleanup from final verification"
```
