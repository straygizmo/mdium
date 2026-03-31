# Video Image Management Design

## Problem

Markdown内の画像はVideoProjectのImageElementとして正しくパースされるが、SceneEditFormに画像の表示UIがないため、ユーザーは画像が存在しているか確認できない。また、画像のON/OFF・入替・配置/アニメーション変更ができず、LLMデコレータも画像を考慮しない。

## Goals

1. SceneEditFormで各シーンの画像をサムネイル付きで表示する
2. 画像ごとにON/OFF切替ができる（OFFでもデータ保持、レンダリングから除外のみ）
3. 画像の入替（ファイルダイアログ）ができる
4. 画像のposition（center/left/right/background）とanimation（fade-in/zoom-in/ken-burns/none）を変更できる
5. LLMデコレータが画像のposition/animationを内容に応じて設定する
6. .video.json保存/復元時に画像設定が保持される

## Design

### 1. Data Model — `ImageElement`に`enabled`追加

**File:** `src/features/video/types.ts`

```typescript
export interface ImageElement {
  type: "image";
  src: string;
  alt?: string;
  position: "center" | "left" | "right" | "background";
  animation: "fade-in" | "zoom-in" | "ken-burns" | "none";
  enabled?: boolean; // default true, false = skip rendering
}
```

`enabled`は`undefined`の場合`true`として扱う。既存データとの後方互換性を維持。

### 2. Video Store — 画像更新アクション

**File:** `src/stores/video-store.ts`

新規アクション追加:

- `updateImageElement(sceneId: string, elementIndex: number, updates: Partial<ImageElement>)` — 指定シーンの指定インデックスの画像要素を更新する

### 3. SceneEditForm — 画像セクションUI

**File:** `src/features/video/components/SceneEditForm.tsx`

ナレーションセクションとトランジションセクションの間に画像セクションを追加。

**表示条件:** シーン内にtype="image"のelementが1つ以上ある場合のみ表示。

**各画像の表示内容:**
- サムネイル（80x60px、Tauriの`convertFileSrc`でローカルファイル表示）
- ファイル名（srcの末尾部分）
- ON/OFFトグルスイッチ
- 入替ボタン（`@tauri-apps/plugin-dialog`のopenでファイル選択）
- 配置ドロップダウン（center/left/right/background）
- アニメーションドロップダウン（fade-in/zoom-in/ken-burns/none）

**OFF時の表示:**
- 半透明（opacity: 0.5）
- ファイル名に取り消し線
- 配置/アニメーションのドロップダウンを`disabled`

### 4. Rendering — 無効画像のスキップ

**File:** `src/features/video/lib/composition/ElementRenderer.tsx`

```typescript
case "image":
  if (element.enabled === false) return null;
  return <ImageElement element={element} index={index} scale={scale} />;
```

`enabled`が`undefined`または`true`の場合は従来通りレンダリング。

### 5. LLM Decorator — 画像設定の自動生成

**File:** `src/features/video/lib/scene-decorator.ts`

#### System Prompt変更

既存のプロンプトに画像に関する指示を追加:

```
For scenes with images, also suggest position and animation settings:
- position: "center" (default), "left", "right", "background" (full-screen behind content)
- animation: "fade-in", "zoom-in", "ken-burns", "none"

Guidelines for images:
- Use "background" for atmospheric/decorative images
- Use "ken-burns" for photos to add visual interest
- Use "zoom-in" for diagrams or screenshots to draw attention
- Use "center" + "fade-in" as safe defaults
```

#### User Message変更

`buildElementSummary`は既に画像の情報（`[画像] alt`）を含んでいるため変更不要。

#### Response Format変更

`elementAnimations`を拡張し、画像要素にはposition情報も含める:

```json
{
  "scenes": {
    "scene-1": {
      "elementAnimations": {
        "0": { "animation": "typewriter" },
        "2": { "animation": "ken-burns", "position": "center" }
      }
    }
  }
}
```

#### applyResult変更

`applyResult`関数で、画像要素の場合は`position`も反映する:

```typescript
if (anim) {
  const updates: any = { animation: anim.animation };
  if (el.type === "image" && anim.position) {
    updates.position = anim.position;
  }
  return { ...el, ...updates } as typeof el;
}
```

### 6. Merge Logic — 画像設定の保持

**File:** `src/features/video/lib/merge-project.ts`

マージ時、保存済みシーンの画像設定をfreshパース結果に反映する。画像の照合はelement indexとtype="image"の一致で行う:

```typescript
// Scene merge内で、elementsの画像設定を復元
const mergedElements = fresh.elements.map((el, idx) => {
  if (el.type !== "image") return el;
  const savedEl = savedScene.elements?.[idx];
  if (savedEl?.type !== "image") return el;
  return {
    ...el,
    enabled: savedEl.enabled,
    position: savedEl.position ?? el.position,
    animation: savedEl.animation ?? el.animation,
    src: savedEl.src ?? el.src, // 入替された画像パスを保持
  };
});
```

## Files Changed

| File | Change |
|------|--------|
| `src/features/video/types.ts` | `ImageElement`に`enabled?: boolean`追加 |
| `src/stores/video-store.ts` | `updateImageElement`アクション追加 |
| `src/features/video/components/SceneEditForm.tsx` | 画像セクションUI追加 |
| `src/features/video/lib/composition/ElementRenderer.tsx` | `enabled===false`スキップ |
| `src/features/video/lib/scene-decorator.ts` | プロンプト・レスポンス・適用ロジック変更 |
| `src/features/video/lib/merge-project.ts` | 画像設定のマージ追加 |

## Out of Scope

- 画像の並び替え・新規追加・削除
- 画像のリサイズ・トリミング
- 画像のON/OFFをLLMに判断させる機能
