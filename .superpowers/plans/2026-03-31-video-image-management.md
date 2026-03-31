# Video Image Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** MD内の画像を動画シーンで表示・管理できるようにし、ON/OFF・入替・配置/アニメーション変更・LLM自動設定に対応する。

**Architecture:** `ImageElement`型に`enabled`フィールドを追加し、SceneEditFormに画像管理セクションを追加。レンダラーは`enabled===false`をスキップ。LLMデコレータのプロンプトに画像のposition/animation指示を追加。マージロジックで画像設定を保持。

**Tech Stack:** React, Zustand, Tauri (convertFileSrc, plugin-dialog)

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/features/video/types.ts` | Modify | `ImageElement`に`enabled`追加 |
| `src/stores/video-store.ts` | Modify | `updateImageElement`アクション追加 |
| `src/features/video/lib/composition/ElementRenderer.tsx` | Modify | `enabled===false`スキップ |
| `src/features/video/components/SceneEditForm.tsx` | Modify | 画像セクションUI追加 |
| `src/features/video/components/VideoPanel.css` | Modify | 画像セクションCSS追加 |
| `src/features/video/lib/scene-decorator.ts` | Modify | プロンプト・型・適用ロジック変更 |
| `src/features/video/lib/merge-project.ts` | Modify | 画像設定マージ追加 |

---

### Task 1: ImageElement型にenabledフィールド追加

**Files:**
- Modify: `src/features/video/types.ts:154-160`

- [ ] **Step 1: `ImageElement`に`enabled`フィールドを追加**

```typescript
// src/features/video/types.ts — ImageElement interface (line 154-160)
// Change from:
export interface ImageElement {
  type: "image";
  src: string;
  alt?: string;
  position: "center" | "left" | "right" | "background";
  animation: "fade-in" | "zoom-in" | "ken-burns" | "none";
}

// Change to:
export interface ImageElement {
  type: "image";
  src: string;
  alt?: string;
  position: "center" | "left" | "right" | "background";
  animation: "fade-in" | "zoom-in" | "ken-burns" | "none";
  enabled?: boolean;
}
```

- [ ] **Step 2: ビルド確認**

Run: `npm run build 2>&1 | head -20`
Expected: ビルド成功（`enabled`はオプショナルなので既存コードに影響なし）

- [ ] **Step 3: コミット**

```bash
git add src/features/video/types.ts
git commit -m "feat(video): add enabled field to ImageElement type"
```

---

### Task 2: video-storeにupdateImageElementアクション追加

**Files:**
- Modify: `src/stores/video-store.ts:4-23` (interface), `src/stores/video-store.ts:56-67` (updateScene参考)

- [ ] **Step 1: VideoStateインターフェースにメソッドシグネチャ追加**

`src/stores/video-store.ts` の `VideoState` interface、`markNarrationDirty` の下（line 22の後）に追加:

```typescript
  updateImageElement: (sceneId: string, elementIndex: number, updates: Partial<{ src: string; position: string; animation: string; enabled: boolean }>) => void;
```

- [ ] **Step 2: アクション実装を追加**

`markNarrationDirty` 実装の後（line 113の`},`の後、`}));`の前）に追加:

```typescript
  updateImageElement: (sceneId, elementIndex, updates) =>
    set((s) => {
      if (!s.videoProject) return s;
      return {
        videoProject: {
          ...s.videoProject,
          scenes: s.videoProject.scenes.map((scene) => {
            if (scene.id !== sceneId) return scene;
            return {
              ...scene,
              elements: scene.elements.map((el, i) => {
                if (i !== elementIndex || el.type !== "image") return el;
                return { ...el, ...updates };
              }),
            };
          }),
        },
      };
    }),
```

- [ ] **Step 3: ビルド確認**

Run: `npm run build 2>&1 | head -20`
Expected: ビルド成功

- [ ] **Step 4: コミット**

```bash
git add src/stores/video-store.ts
git commit -m "feat(video): add updateImageElement action to video store"
```

---

### Task 3: ElementRendererでenabled===falseをスキップ

**Files:**
- Modify: `src/features/video/lib/composition/ElementRenderer.tsx:26-27`

- [ ] **Step 1: imageケースにenabledチェック追加**

```typescript
// Change from (line 26-27):
    case "image":
      return <ImageElement element={element} index={index} scale={scale} />;

// Change to:
    case "image":
      if (element.enabled === false) return null;
      return <ImageElement element={element} index={index} scale={scale} />;
```

- [ ] **Step 2: ビルド確認**

Run: `npm run build 2>&1 | head -20`
Expected: ビルド成功

- [ ] **Step 3: コミット**

```bash
git add src/features/video/lib/composition/ElementRenderer.tsx
git commit -m "feat(video): skip disabled images in renderer"
```

---

### Task 4: SceneEditFormに画像セクションUI追加

**Files:**
- Modify: `src/features/video/components/SceneEditForm.tsx`
- Modify: `src/features/video/components/VideoPanel.css`

- [ ] **Step 1: SceneEditForm.tsxにインポート追加**

ファイル先頭のインポートに追加:

```typescript
// line 3の後に追加:
import { open } from "@tauri-apps/plugin-dialog";
```

```typescript
// line 6を変更:
// Change from:
import type { Scene, TransitionType } from "@/features/video/types";

// Change to:
import type { Scene, TransitionType, ImageElement } from "@/features/video/types";
```

- [ ] **Step 2: toPlayableSrc関数をインポート**

```typescript
// line 5の後に追加:
import { toPlayableSrc } from "@/features/video/lib/composition/constants";
```

- [ ] **Step 3: ストアフックとヘルパー関数を追加**

`SceneEditForm`コンポーネント内、既存のストアフック（line 25-26）の後に追加:

```typescript
  const updateImageElement = useVideoStore((s) => s.updateImageElement);

  // Extract image elements with their original indices
  const imageElements = useMemo(
    () =>
      scene.elements
        .map((el, i) => ({ el, i }))
        .filter((item): item is { el: ImageElement; i: number } => item.el.type === "image"),
    [scene.elements]
  );

  const handleImageToggle = useCallback(
    (elementIndex: number, currentEnabled: boolean) => {
      updateImageElement(scene.id, elementIndex, { enabled: !currentEnabled });
    },
    [scene.id, updateImageElement]
  );

  const handleImagePositionChange = useCallback(
    (elementIndex: number, position: string) => {
      updateImageElement(scene.id, elementIndex, { position });
    },
    [scene.id, updateImageElement]
  );

  const handleImageAnimationChange = useCallback(
    (elementIndex: number, animation: string) => {
      updateImageElement(scene.id, elementIndex, { animation });
    },
    [scene.id, updateImageElement]
  );

  const handleImageReplace = useCallback(
    async (elementIndex: number) => {
      const path = await open({
        multiple: false,
        filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp", "svg"] }],
      });
      if (typeof path === "string") {
        updateImageElement(scene.id, elementIndex, { src: path });
      }
    },
    [scene.id, updateImageElement]
  );
```

- [ ] **Step 4: JSXに画像セクションを追加**

トランジションセクション（line 152）の直前に挿入:

```tsx
      {imageElements.length > 0 && (
        <div className="scene-edit-form__images">
          <label className="scene-edit-form__images-title">画像 ({imageElements.length})</label>
          {imageElements.map(({ el, i }) => {
            const enabled = el.enabled !== false;
            const fileName = el.src.split(/[\\/]/).pop() ?? el.src;
            return (
              <div
                key={i}
                className={`scene-edit-form__image-item${enabled ? "" : " scene-edit-form__image-item--disabled"}`}
              >
                <img
                  className="scene-edit-form__image-thumb"
                  src={toPlayableSrc(el.src)}
                  alt={el.alt ?? ""}
                />
                <div className="scene-edit-form__image-controls">
                  <div className="scene-edit-form__image-top-row">
                    <span
                      className={`scene-edit-form__switch${enabled ? " scene-edit-form__switch--on" : ""}`}
                      role="switch"
                      aria-checked={enabled}
                      tabIndex={0}
                      onClick={() => handleImageToggle(i, enabled)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          handleImageToggle(i, enabled);
                        }
                      }}
                    >
                      <span className="scene-edit-form__switch-thumb" />
                    </span>
                    <span className={`scene-edit-form__image-name${enabled ? "" : " scene-edit-form__image-name--disabled"}`}>
                      {fileName}
                    </span>
                    <button
                      className="scene-edit-form__btn scene-edit-form__btn--small"
                      onClick={() => handleImageReplace(i)}
                    >
                      入替
                    </button>
                  </div>
                  {enabled && (
                    <div className="scene-edit-form__image-selects">
                      <div className="scene-edit-form__image-select-group">
                        <label>配置</label>
                        <select
                          value={el.position}
                          onChange={(e) => handleImagePositionChange(i, e.target.value)}
                        >
                          <option value="center">center</option>
                          <option value="left">left</option>
                          <option value="right">right</option>
                          <option value="background">background</option>
                        </select>
                      </div>
                      <div className="scene-edit-form__image-select-group">
                        <label>アニメーション</label>
                        <select
                          value={el.animation}
                          onChange={(e) => handleImageAnimationChange(i, e.target.value)}
                        >
                          <option value="fade-in">fade-in</option>
                          <option value="zoom-in">zoom-in</option>
                          <option value="ken-burns">ken-burns</option>
                          <option value="none">none</option>
                        </select>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
```

- [ ] **Step 5: VideoPanel.cssに画像セクションのスタイル追加**

`src/features/video/components/VideoPanel.css`の`.scene-edit-form__segment-status--ok`（line 412-414）の後に追加:

```css
/* ─── Image section ──────────────────────────────────────────────────────────── */

.scene-edit-form__images {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.scene-edit-form__images-title {
  font-size: 11px;
  color: var(--text);
  opacity: 0.7;
  font-weight: 600;
}

.scene-edit-form__image-item {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  padding: 8px;
  background: var(--bg-base);
  border: 1px solid var(--border);
  border-radius: 4px;
}

.scene-edit-form__image-item--disabled {
  opacity: 0.5;
}

.scene-edit-form__image-thumb {
  width: 64px;
  height: 48px;
  object-fit: cover;
  border-radius: 3px;
  flex-shrink: 0;
  background: var(--bg-overlay);
}

.scene-edit-form__image-controls {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.scene-edit-form__image-top-row {
  display: flex;
  align-items: center;
  gap: 6px;
}

.scene-edit-form__image-name {
  flex: 1;
  font-size: 11px;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.scene-edit-form__image-name--disabled {
  text-decoration: line-through;
  color: var(--text-muted);
}

.scene-edit-form__image-selects {
  display: flex;
  gap: 6px;
}

.scene-edit-form__image-select-group {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.scene-edit-form__image-select-group label {
  font-size: 10px;
  color: var(--text);
  opacity: 0.6;
}

.scene-edit-form__image-select-group select {
  width: 100%;
  background: var(--bg-surface);
  border: 1px solid var(--border);
  color: var(--text);
  padding: 2px 4px;
  border-radius: 3px;
  font-size: 11px;
}
```

- [ ] **Step 6: ビルド確認**

Run: `npm run build 2>&1 | head -20`
Expected: ビルド成功

- [ ] **Step 7: コミット**

```bash
git add src/features/video/components/SceneEditForm.tsx src/features/video/components/VideoPanel.css
git commit -m "feat(video): add image management section to SceneEditForm"
```

---

### Task 5: LLMデコレータに画像設定を追加

**Files:**
- Modify: `src/features/video/lib/scene-decorator.ts`

- [ ] **Step 1: SYSTEM_PROMPTに画像position指示を追加**

`SYSTEM_PROMPT`内の `Available element animations:` セクション（line 23）の`image`行の後に、画像position情報を追加。さらにGuidelinesセクションに画像ガイドラインを追加:

```typescript
// line 23を変更:
// Change from:
- image: "fade-in"|"zoom-in"|"ken-burns"|"none"

// Change to:
- image: "fade-in"|"zoom-in"|"ken-burns"|"none" (also supports position: "center"|"left"|"right"|"background")
```

Guidelinesセクション（line 40の後）に追加:

```
- For image elements, also set "position" in elementAnimations
- Use "background" position for atmospheric/decorative images
- Use "ken-burns" animation for photos to add visual interest
- Use "zoom-in" for diagrams or screenshots to draw attention
- Use "center" position + "fade-in" animation as safe defaults for images
```

レスポンスフォーマットのJSONサンプル内（line 52付近）を変更:

```typescript
// Change from:
      "elementAnimations": { "0": { "animation": "typewriter" }, "1": { "animation": "fade-in" } }

// Change to:
      "elementAnimations": { "0": { "animation": "typewriter" }, "1": { "animation": "fade-in" }, "2": { "animation": "ken-burns", "position": "center" } }
```

- [ ] **Step 2: DecorationResult型を更新**

```typescript
// Change from (line 74-79):
  scenes: Record<
    string,
    {
      backgroundEffect?: BackgroundEffect;
      elementAnimations?: Record<string, { animation: string }>;
    }
  >;

// Change to:
  scenes: Record<
    string,
    {
      backgroundEffect?: BackgroundEffect;
      elementAnimations?: Record<string, { animation: string; position?: string }>;
    }
  >;
```

- [ ] **Step 3: buildElementSummaryで画像のファイル名も出力**

```typescript
// Change from (line 93):
        case "image":
          return `[画像] ${el.alt ?? ""}`;

// Change to:
        case "image":
          return `[画像: ${el.src.split(/[\\/]/).pop() ?? ""}] ${el.alt ?? ""}`;
```

- [ ] **Step 4: applyResultで画像のpositionも反映**

```typescript
// Change from (line 148-150):
        const anim = sceneDecor.elementAnimations?.[String(i)];
        if (!anim) return el;
        return { ...el, animation: anim.animation } as typeof el;

// Change to:
        const anim = sceneDecor.elementAnimations?.[String(i)];
        if (!anim) return el;
        const updates: Record<string, unknown> = { animation: anim.animation };
        if (el.type === "image" && anim.position) {
          updates.position = anim.position;
        }
        return { ...el, ...updates } as typeof el;
```

- [ ] **Step 5: ビルド確認**

Run: `npm run build 2>&1 | head -20`
Expected: ビルド成功

- [ ] **Step 6: コミット**

```bash
git add src/features/video/lib/scene-decorator.ts
git commit -m "feat(video): add image position/animation to LLM decorator"
```

---

### Task 6: マージロジックで画像設定を保持

**Files:**
- Modify: `src/features/video/lib/merge-project.ts:33-60`

- [ ] **Step 1: mergedScenesのマッピング内で画像設定をマージ**

`merge-project.ts`のシーンマージ部分を変更。return文（line 50-59）を更新:

```typescript
// Change from (line 50-59):
    return {
      ...fresh,
      narration: savedScene.narration ?? fresh.narration,
      narrationAudio: savedScene.narrationAudio,
      narrationSegments: segments,
      narrationDirty: savedScene.narrationDirty,
      durationInFrames: savedScene.durationInFrames,
      transition: savedScene.transition ?? fresh.transition,
      captions: savedScene.captions ?? fresh.captions,
    };

// Change to:
    // Merge image element settings (enabled, position, animation, src replacement)
    const mergedElements = fresh.elements.map((el, idx) => {
      if (el.type !== "image") return el;
      const savedEl = savedScene.elements?.[idx];
      if (!savedEl || savedEl.type !== "image") return el;
      return {
        ...el,
        enabled: savedEl.enabled,
        position: savedEl.position ?? el.position,
        animation: savedEl.animation ?? el.animation,
        src: savedEl.src ?? el.src,
      };
    });

    return {
      ...fresh,
      elements: mergedElements,
      narration: savedScene.narration ?? fresh.narration,
      narrationAudio: savedScene.narrationAudio,
      narrationSegments: segments,
      narrationDirty: savedScene.narrationDirty,
      durationInFrames: savedScene.durationInFrames,
      transition: savedScene.transition ?? fresh.transition,
      captions: savedScene.captions ?? fresh.captions,
    };
```

- [ ] **Step 2: マージ結果にthemeも保持**

```typescript
// Change from (line 62-66):
  return {
    meta: { ...freshProject.meta, ...saved.meta },
    audio: { ...freshProject.audio, ...saved.audio },
    scenes: mergedScenes,
  };

// Change to:
  return {
    meta: { ...freshProject.meta, ...saved.meta },
    audio: { ...freshProject.audio, ...saved.audio },
    theme: saved.theme ?? freshProject.theme,
    scenes: mergedScenes,
  };
```

- [ ] **Step 3: ビルド確認**

Run: `npm run build 2>&1 | head -20`
Expected: ビルド成功

- [ ] **Step 4: コミット**

```bash
git add src/features/video/lib/merge-project.ts
git commit -m "feat(video): preserve image settings and theme in merge logic"
```

---

### Task 7: 動作確認

- [ ] **Step 1: 画像を含むMDファイルで動画モードを開く**

画像を含むMarkdownファイルで動画モードを起動し、以下を確認:
- SceneEditFormに画像セクションが表示されること
- サムネイルが表示されること
- ON/OFFトグルが動作すること
- 配置/アニメーション変更が反映されること
- 入替ボタンでファイル選択ダイアログが開くこと
- プレイヤーでOFF画像が非表示になること

- [ ] **Step 2: LLMで自動設定を実行**

「LLMで自動設定」ボタンを押し、画像のposition/animationが自動設定されることを確認。

- [ ] **Step 3: 保存・再読み込み確認**

ファイルを閉じて再度開き、画像設定（enabled/position/animation/src変更）が保持されていることを確認。
