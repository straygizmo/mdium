# Video Scenario Dialog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a unified dialog for the `generate-video-scenario` command that lets users configure video parameters (resolution, scene count, video length, TTS speed) before execution, and auto-registers the command, disables Plan mode, and sends the message on OK.

**Architecture:** Replace `VideoOverwriteDialog` with a new `VideoScenarioDialog` that combines overwrite confirmation with parameter settings. The command template uses `$3`–`$7` positional parameters so form values are passed as arguments at execution time. PreviewPanel calls `doConnect` + `doExecuteCommand` directly (exported from `useOpencodeChat.ts`) instead of setting chat input and waiting for the user to press Enter.

**Tech Stack:** React, TypeScript, Zustand, i18next, Tauri

---

### Task 1: Update command template to use positional parameters

**Files:**
- Modify: `src/features/opencode-config/lib/builtin-commands.ts`

- [ ] **Step 1: Update the Scene Splitting Rules section**

Replace lines 22–25 of the template string (inside the backtick template literal):

```typescript
// OLD:
## Scene Splitting Rules

- If \`<!-- pagebreak -->\` markers exist in the Markdown, use them as scene boundaries.
- If no markers exist, split based on heading structure (h1/h2) and topic changes.
- Target 30–60 seconds of narration per scene.
- Split scenes that are too information-dense; merge scenes that are too thin.

// NEW:
## Scene Splitting Rules

- If \`<!-- pagebreak -->\` markers exist in the Markdown, use them as scene boundaries.
- If no markers exist, split based on heading structure (h1/h2) and topic changes.
- Target scene count: $5 (if "auto", determine based on content structure).
- Target total video duration: $6 seconds (if "auto", use 30–60 seconds per scene as a guideline).
- When scene count is specified, aim for exactly that many scenes by merging or splitting as needed.
- When total duration is specified, distribute narration so the sum of all scenes approximates the target.
- Split scenes that are too information-dense; merge scenes that are too thin.
```

- [ ] **Step 2: Update the Meta Settings section**

Replace lines 53–57 of the template string:

```typescript
// OLD:
## Meta Settings

- \`title\`: Extract from the document's main heading.
- Default: \`1920×1080\`, \`16:9\`, \`30 fps\`.
- For vertical/mobile content, consider \`1080×1920\`, \`9:16\`.

// NEW:
## Meta Settings

- \`title\`: Extract from the document's main heading.
- Resolution: $3, aspect ratio $4, 30 fps.
```

- [ ] **Step 3: Update the Output section for TTS speed**

Replace line 152 of the template string:

```typescript
// OLD:
Include \`tts\` in \`audio\` with provider \`"voicevox"\`, speaker \`"1"\`, volume \`1.0\`, speed \`1.0\` as defaults.

// NEW:
Include \`tts\` in \`audio\` with provider \`"voicevox"\`, speaker \`"1"\`, volume \`1.0\`, speed $7 as defaults.
```

- [ ] **Step 4: Commit**

```bash
git add src/features/opencode-config/lib/builtin-commands.ts
git commit -m "feat(video): use positional params \$3-\$7 in generate-video-scenario template"
```

---

### Task 2: Add i18n keys for the new dialog

**Files:**
- Modify: `src/shared/i18n/locales/ja/video.json`
- Modify: `src/shared/i18n/locales/en/video.json`

- [ ] **Step 1: Add new keys to ja/video.json**

Add the following keys after the existing `overwriteDialogCancel` entry (keep existing `overwriteDialog*` keys — they will be removed in Task 6):

```json
"scenarioDialogTitle": "動画シナリオ生成",
"scenarioResolution": "解像度",
"scenarioSceneCount": "シーン数",
"scenarioSceneCountAuto": "自動",
"scenarioVideoLength": "動画の長さ",
"scenarioVideoLengthAuto": "自動",
"scenarioVideoLengthUnit": "秒",
"scenarioTtsSpeed": "TTS速度",
"scenarioOverwrite": "上書き",
"scenarioCreateNew": "新規作成",
"scenarioStart": "生成開始",
"scenarioExistingFile": "「{{fileName}}」が既に存在します。"
```

- [ ] **Step 2: Add new keys to en/video.json**

Add the same keys with English translations:

```json
"scenarioDialogTitle": "Generate Video Scenario",
"scenarioResolution": "Resolution",
"scenarioSceneCount": "Scene Count",
"scenarioSceneCountAuto": "Auto",
"scenarioVideoLength": "Video Length",
"scenarioVideoLengthAuto": "Auto",
"scenarioVideoLengthUnit": "sec",
"scenarioTtsSpeed": "TTS Speed",
"scenarioOverwrite": "Overwrite",
"scenarioCreateNew": "Create New",
"scenarioStart": "Start Generation",
"scenarioExistingFile": "\"{{fileName}}\" already exists."
```

- [ ] **Step 3: Commit**

```bash
git add src/shared/i18n/locales/ja/video.json src/shared/i18n/locales/en/video.json
git commit -m "i18n(video): add scenario dialog translation keys"
```

---

### Task 3: Create VideoScenarioDialog component and CSS

**Files:**
- Create: `src/features/video/components/VideoScenarioDialog.tsx`
- Create: `src/features/video/components/VideoScenarioDialog.css`

- [ ] **Step 1: Create VideoScenarioDialog.css**

Based on `VideoOverwriteDialog.css` pattern, extended with form field styles:

```css
.video-scenario-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 9999;
}

.video-scenario-dialog {
  background: var(--bg-primary, #1e1e1e);
  border: 1px solid var(--border-color, #333);
  border-radius: 8px;
  padding: 20px 24px;
  min-width: 400px;
  max-width: 500px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
}

.video-scenario-dialog__title {
  margin: 0 0 16px;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary, #e0e0e0);
}

.video-scenario-dialog__existing {
  margin: 0 0 12px;
  padding: 0 0 12px;
  border-bottom: 1px solid var(--border-color, #333);
}

.video-scenario-dialog__existing-msg {
  margin: 0 0 8px;
  font-size: 12px;
  color: var(--text-secondary, #aaa);
}

.video-scenario-dialog__radio-group {
  display: flex;
  gap: 16px;
}

.video-scenario-dialog__radio-group label {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--text-primary, #e0e0e0);
  cursor: pointer;
}

.video-scenario-dialog__field {
  margin: 0 0 12px;
}

.video-scenario-dialog__field-label {
  display: block;
  margin: 0 0 4px;
  font-size: 12px;
  font-weight: 500;
  color: var(--text-secondary, #aaa);
}

.video-scenario-dialog__field-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.video-scenario-dialog__field-row select {
  flex: 1;
  padding: 4px 8px;
  border-radius: 4px;
  border: 1px solid var(--border-color, #444);
  background: var(--bg-secondary, #2a2a2a);
  color: var(--text-primary, #e0e0e0);
  font-size: 12px;
}

.video-scenario-dialog__field-row input[type="range"] {
  flex: 1;
}

.video-scenario-dialog__field-row input[type="range"]:disabled {
  opacity: 0.3;
}

.video-scenario-dialog__field-value {
  min-width: 40px;
  text-align: right;
  font-size: 12px;
  color: var(--text-primary, #e0e0e0);
  font-variant-numeric: tabular-nums;
}

.video-scenario-dialog__auto-check {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--text-primary, #e0e0e0);
  cursor: pointer;
}

.video-scenario-dialog__actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  margin-top: 16px;
}

.video-scenario-dialog__btn {
  padding: 6px 14px;
  border-radius: 4px;
  border: 1px solid var(--border-color, #444);
  font-size: 12px;
  cursor: pointer;
  background: var(--bg-secondary, #2a2a2a);
  color: var(--text-primary, #e0e0e0);
}

.video-scenario-dialog__btn:hover {
  background: var(--bg-hover, #333);
}

.video-scenario-dialog__btn--primary {
  background: var(--accent-blue, #3b82f6);
  border-color: var(--accent-blue, #3b82f6);
  color: #fff;
}

.video-scenario-dialog__btn--primary:hover {
  opacity: 0.9;
}
```

- [ ] **Step 2: Create VideoScenarioDialog.tsx**

```tsx
import { useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import "./VideoScenarioDialog.css";

export interface VideoScenarioParams {
  overwriteChoice: "overwrite" | "new";
  resolution: string;
  aspectRatio: string;
  sceneCount: "auto" | number;
  videoLength: "auto" | number;
  ttsSpeed: number;
}

interface VideoScenarioDialogProps {
  hasExisting: boolean;
  fileName: string;
  onSubmit: (params: VideoScenarioParams) => void;
  onCancel: () => void;
}

const RESOLUTION_OPTIONS: { value: string; label: string; aspect: string }[] = [
  { value: "1920x1080", label: "1920x1080", aspect: "16:9" },
  { value: "1080x1920", label: "1080x1920", aspect: "9:16" },
  { value: "1280x720", label: "1280x720", aspect: "16:9" },
  { value: "1080x1080", label: "1080x1080", aspect: "1:1" },
];

export function VideoScenarioDialog({
  hasExisting,
  fileName,
  onSubmit,
  onCancel,
}: VideoScenarioDialogProps) {
  const { t } = useTranslation("video");

  const [overwriteChoice, setOverwriteChoice] = useState<"overwrite" | "new">("overwrite");
  const [resolution, setResolution] = useState("1920x1080");
  const [sceneCountAuto, setSceneCountAuto] = useState(true);
  const [sceneCount, setSceneCount] = useState(5);
  const [videoLengthAuto, setVideoLengthAuto] = useState(true);
  const [videoLength, setVideoLength] = useState(30);
  const [ttsSpeed, setTtsSpeed] = useState(1.0);

  const aspectRatio = RESOLUTION_OPTIONS.find((o) => o.value === resolution)?.aspect ?? "16:9";

  const handleSubmit = useCallback(() => {
    onSubmit({
      overwriteChoice: hasExisting ? overwriteChoice : "overwrite",
      resolution,
      aspectRatio,
      sceneCount: sceneCountAuto ? "auto" : sceneCount,
      videoLength: videoLengthAuto ? "auto" : videoLength,
      ttsSpeed,
    });
  }, [hasExisting, overwriteChoice, resolution, aspectRatio, sceneCountAuto, sceneCount, videoLengthAuto, videoLength, ttsSpeed, onSubmit]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
      if (e.key === "Enter") handleSubmit();
    },
    [onCancel, handleSubmit],
  );

  return (
    <div className="video-scenario-overlay" onClick={onCancel}>
      <div
        className="video-scenario-dialog"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
        tabIndex={-1}
      >
        <h3 className="video-scenario-dialog__title">
          {t("scenarioDialogTitle")}
        </h3>

        {hasExisting && (
          <div className="video-scenario-dialog__existing">
            <p className="video-scenario-dialog__existing-msg">
              {t("scenarioExistingFile", { fileName })}
            </p>
            <div className="video-scenario-dialog__radio-group">
              <label>
                <input
                  type="radio"
                  name="overwrite"
                  checked={overwriteChoice === "overwrite"}
                  onChange={() => setOverwriteChoice("overwrite")}
                />
                {t("scenarioOverwrite")}
              </label>
              <label>
                <input
                  type="radio"
                  name="overwrite"
                  checked={overwriteChoice === "new"}
                  onChange={() => setOverwriteChoice("new")}
                />
                {t("scenarioCreateNew")}
              </label>
            </div>
          </div>
        )}

        {/* Resolution */}
        <div className="video-scenario-dialog__field">
          <span className="video-scenario-dialog__field-label">
            {t("scenarioResolution")}
          </span>
          <div className="video-scenario-dialog__field-row">
            <select
              value={resolution}
              onChange={(e) => setResolution(e.target.value)}
            >
              {RESOLUTION_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label} ({opt.aspect})
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Scene Count */}
        <div className="video-scenario-dialog__field">
          <span className="video-scenario-dialog__field-label">
            {t("scenarioSceneCount")}
          </span>
          <div className="video-scenario-dialog__field-row">
            <label className="video-scenario-dialog__auto-check">
              <input
                type="checkbox"
                checked={sceneCountAuto}
                onChange={(e) => setSceneCountAuto(e.target.checked)}
              />
              {t("scenarioSceneCountAuto")}
            </label>
            <input
              type="range"
              min={3}
              max={15}
              step={1}
              value={sceneCount}
              disabled={sceneCountAuto}
              onChange={(e) => setSceneCount(Number(e.target.value))}
            />
            <span className="video-scenario-dialog__field-value">
              {sceneCountAuto ? "—" : sceneCount}
            </span>
          </div>
        </div>

        {/* Video Length */}
        <div className="video-scenario-dialog__field">
          <span className="video-scenario-dialog__field-label">
            {t("scenarioVideoLength")}
          </span>
          <div className="video-scenario-dialog__field-row">
            <label className="video-scenario-dialog__auto-check">
              <input
                type="checkbox"
                checked={videoLengthAuto}
                onChange={(e) => setVideoLengthAuto(e.target.checked)}
              />
              {t("scenarioVideoLengthAuto")}
            </label>
            <input
              type="range"
              min={20}
              max={150}
              step={10}
              value={videoLength}
              disabled={videoLengthAuto}
              onChange={(e) => setVideoLength(Number(e.target.value))}
            />
            <span className="video-scenario-dialog__field-value">
              {videoLengthAuto ? "—" : `${videoLength}${t("scenarioVideoLengthUnit")}`}
            </span>
          </div>
        </div>

        {/* TTS Speed */}
        <div className="video-scenario-dialog__field">
          <span className="video-scenario-dialog__field-label">
            {t("scenarioTtsSpeed")}
          </span>
          <div className="video-scenario-dialog__field-row">
            <input
              type="range"
              min={0.7}
              max={1.5}
              step={0.1}
              value={ttsSpeed}
              onChange={(e) => setTtsSpeed(Number(e.target.value))}
            />
            <span className="video-scenario-dialog__field-value">
              {ttsSpeed.toFixed(1)}
            </span>
          </div>
        </div>

        <div className="video-scenario-dialog__actions">
          <button
            className="video-scenario-dialog__btn"
            onClick={onCancel}
          >
            {t("cancel")}
          </button>
          <button
            className="video-scenario-dialog__btn video-scenario-dialog__btn--primary"
            onClick={handleSubmit}
          >
            {t("scenarioStart")}
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add src/features/video/components/VideoScenarioDialog.tsx src/features/video/components/VideoScenarioDialog.css
git commit -m "feat(video): add VideoScenarioDialog component"
```

---

### Task 4: Export doConnect and doExecuteCommand from useOpencodeChat

**Files:**
- Modify: `src/features/opencode-config/hooks/useOpencodeChat.ts`

- [ ] **Step 1: Export the two module-level functions**

Add the `export` keyword to `doConnect` (line 297) and `doExecuteCommand` (line 438):

Change:
```typescript
async function doConnect(folderPath?: string) {
```
to:
```typescript
export async function doConnect(folderPath?: string) {
```

Change:
```typescript
async function doExecuteCommand(commandName: string, args?: string) {
```
to:
```typescript
export async function doExecuteCommand(commandName: string, args?: string) {
```

- [ ] **Step 2: Commit**

```bash
git add src/features/opencode-config/hooks/useOpencodeChat.ts
git commit -m "refactor(opencode): export doConnect and doExecuteCommand for direct invocation"
```

---

### Task 5: Integrate VideoScenarioDialog into PreviewPanel

**Files:**
- Modify: `src/features/preview/components/PreviewPanel.tsx`

- [ ] **Step 1: Update imports**

Replace line 17:
```typescript
// OLD:
import { VideoOverwriteDialog, type OverwriteChoice } from "@/features/video/components/VideoOverwriteDialog";

// NEW:
import { VideoScenarioDialog, type VideoScenarioParams } from "@/features/video/components/VideoScenarioDialog";
```

Add `doConnect` and `doExecuteCommand` to the existing import on line 21:
```typescript
// OLD:
import { useChatUIStore, consumePendingVideoOutput } from "@/features/opencode-config/hooks/useOpencodeChat";

// NEW:
import { useChatUIStore, consumePendingVideoOutput, doConnect, doExecuteCommand } from "@/features/opencode-config/hooks/useOpencodeChat";
```

Add `BUILTIN_COMMANDS` import:
```typescript
import { BUILTIN_COMMANDS } from "@/features/opencode-config/lib/builtin-commands";
```

Add `useTabStore` import (if not already present):
```typescript
import { useTabStore } from "@/stores/tab-store";
```

- [ ] **Step 2: Replace state and add activeFolderPath**

Replace line 294:
```typescript
// OLD:
const [overwriteDialog, setOverwriteDialog] = useState<{ videoJsonName: string; mdPath: string; baseName: string } | null>(null);

// NEW:
const [scenarioDialog, setScenarioDialog] = useState<{ videoJsonName: string; mdPath: string; baseName: string; hasExisting: boolean } | null>(null);
```

Add near the other store hooks (around line 300):
```typescript
const activeFolderPath = useTabStore((s) => s.activeFolderPath);
```

- [ ] **Step 3: Replace handleEnterVideoMode**

Replace lines 303–330 (`handleEnterVideoMode` and its body):
```typescript
  const handleEnterVideoMode = useCallback(async () => {
    if (!filePath) return;

    // Derive paths
    const lastDot = filePath.lastIndexOf(".");
    const basePath = lastDot > 0 ? filePath.slice(0, lastDot) : filePath;
    const baseName = basePath.split(/[/\\]/).pop() ?? basePath;
    const videoJsonName = baseName + ".video.json";

    // Check if .video.json already exists
    const existing = await invoke<string | null>("video_load_project", { mdPath: filePath });

    setScenarioDialog({ videoJsonName, mdPath: filePath, baseName, hasExisting: !!existing });
  }, [filePath]);
```

- [ ] **Step 4: Remove setChatCommandAndFocus and replace handleOverwriteChoice with handleScenarioSubmit**

Remove `setChatCommandAndFocus` (lines 332–338) entirely.

Replace `handleOverwriteChoice` (lines 356–382) with:
```typescript
  const handleScenarioSubmit = useCallback(async (params: VideoScenarioParams) => {
    if (!scenarioDialog) return;
    const { mdPath, baseName } = scenarioDialog;
    setScenarioDialog(null);

    // Determine output path
    const lastDot = mdPath.lastIndexOf(".");
    const basePath = lastDot > 0 ? mdPath.slice(0, lastDot) : mdPath;
    const dir = mdPath.substring(0, Math.max(mdPath.lastIndexOf("/"), mdPath.lastIndexOf("\\")) + 1);

    let outputPath: string;
    if (params.overwriteChoice === "overwrite") {
      outputPath = basePath + ".video.json";
    } else {
      const now = new Date();
      const ts = [
        now.getFullYear(),
        String(now.getMonth() + 1).padStart(2, "0"),
        String(now.getDate()).padStart(2, "0"),
        String(now.getHours()).padStart(2, "0"),
        String(now.getMinutes()).padStart(2, "0"),
        String(now.getSeconds()).padStart(2, "0"),
      ].join("");
      outputPath = dir + baseName + "_" + ts + ".video.json";
    }

    // Auto-register command if not registered
    const { config, projectCommands } = useOpencodeConfigStore.getState();
    const globalCommands = config.command ?? {};
    if (!globalCommands["generate-video-scenario"] && !projectCommands["generate-video-scenario"]) {
      const builtin = BUILTIN_COMMANDS["generate-video-scenario"];
      await useOpencodeConfigStore.getState().saveCommand("generate-video-scenario", {
        template: builtin.template,
        description: builtin.description,
      });
    }

    // Disable Plan mode
    useChatUIStore.setState({ usePlanAgent: false });

    // Switch UI to chat panel
    useUiStore.getState().setLeftPanel("opencode-config");
    useUiStore.getState().setOpencodeTopTab("chat");

    // Build command arguments
    const args = `"${mdPath}" "${outputPath}" "${params.resolution}" "${params.aspectRatio}" "${params.sceneCount}" "${params.videoLength}" "${params.ttsSpeed}"`;

    // Ensure connection and execute
    await doConnect(activeFolderPath ?? undefined);
    doExecuteCommand("generate-video-scenario", args);
  }, [scenarioDialog, activeFolderPath]);

  const handleScenarioCancel = useCallback(() => {
    setScenarioDialog(null);
  }, []);
```

- [ ] **Step 5: Update JSX — replace VideoOverwriteDialog with VideoScenarioDialog**

Replace lines 1116–1121:
```tsx
// OLD:
      {overwriteDialog && (
        <VideoOverwriteDialog
          fileName={overwriteDialog.videoJsonName}
          onChoice={handleOverwriteChoice}
        />
      )}

// NEW:
      {scenarioDialog && (
        <VideoScenarioDialog
          hasExisting={scenarioDialog.hasExisting}
          fileName={scenarioDialog.videoJsonName}
          onSubmit={handleScenarioSubmit}
          onCancel={handleScenarioCancel}
        />
      )}
```

- [ ] **Step 6: Commit**

```bash
git add src/features/preview/components/PreviewPanel.tsx
git commit -m "feat(video): integrate VideoScenarioDialog into PreviewPanel with auto-execute"
```

---

### Task 6: Remove VideoOverwriteDialog and clean up i18n

**Files:**
- Delete: `src/features/video/components/VideoOverwriteDialog.tsx`
- Delete: `src/features/video/components/VideoOverwriteDialog.css`
- Modify: `src/shared/i18n/locales/ja/video.json`
- Modify: `src/shared/i18n/locales/en/video.json`

- [ ] **Step 1: Delete VideoOverwriteDialog files**

```bash
rm src/features/video/components/VideoOverwriteDialog.tsx
rm src/features/video/components/VideoOverwriteDialog.css
```

- [ ] **Step 2: Remove unused overwriteDialog i18n keys from ja/video.json**

Remove these keys:
```json
"overwriteDialogTitle": "既存のビデオ設定を上書きしますか？",
"overwriteDialogMessage": "「{{fileName}}」が既に存在します。",
"overwriteDialogYes": "はい（上書き）",
"overwriteDialogNo": "いいえ（新規作成）",
"overwriteDialogCancel": "キャンセル",
```

- [ ] **Step 3: Remove unused overwriteDialog i18n keys from en/video.json**

Remove these keys:
```json
"overwriteDialogTitle": "Overwrite existing video settings?",
"overwriteDialogMessage": "\"{{fileName}}\" already exists.",
"overwriteDialogYes": "Yes (overwrite)",
"overwriteDialogNo": "No (create new)",
"overwriteDialogCancel": "Cancel",
```

- [ ] **Step 4: Commit**

```bash
git add -A src/features/video/components/VideoOverwriteDialog.tsx src/features/video/components/VideoOverwriteDialog.css src/shared/i18n/locales/ja/video.json src/shared/i18n/locales/en/video.json
git commit -m "refactor(video): remove VideoOverwriteDialog, replaced by VideoScenarioDialog"
```

---

### Task 7: Manual verification

- [ ] **Step 1: Build check**

```bash
npm run build
```

Expected: No TypeScript errors, no broken imports.

- [ ] **Step 2: Functional test — new file (no existing .video.json)**

1. Open a `.md` file that has no corresponding `.video.json`
2. Click the video scenario generation button in the preview toolbar
3. Verify the `VideoScenarioDialog` appears with:
   - No overwrite section shown
   - Resolution dropdown defaulting to 1920x1080
   - Scene count defaulting to "auto" with disabled slider
   - Video length defaulting to "auto" with slider showing 30
   - TTS speed slider at 1.0
4. Change some values and click "生成開始"
5. Verify:
   - Command is auto-registered (check `~/.config/opencode/opencode.jsonc`)
   - Plan toggle is OFF in chat
   - Command executes automatically (chat shows the command running)

- [ ] **Step 3: Functional test — existing file**

1. Open a `.md` file that has an existing `.video.json`
2. Click the video scenario generation button
3. Verify the overwrite section appears with radio buttons
4. Test both "上書き" and "新規作成" options
5. Verify the correct output path is used

- [ ] **Step 4: Functional test — keyboard**

1. Open the dialog
2. Press Escape → dialog should close
3. Open again, press Enter → should submit with default values
