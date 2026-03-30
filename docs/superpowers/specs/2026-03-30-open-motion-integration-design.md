# open-motionコンポーネント統合設計

## 概要

動画生成機能で vendored `@open-motion/components` のコンポーネントを活用し、既存アニメーションの品質向上 + 新エレメント/背景エフェクトの追加を行う。LLMがシナリオ生成時に背景エフェクトやアニメーション設定を自動選択し、UIからも変更可能にする。

## 背景

現在の `scene-to-composition.tsx` は `@open-motion/core` の `Sequence`, `Audio`, `interpolate`, `useCurrentFrame`, `useVideoConfig`, `parseSrt` のみ使用。`@open-motion/components` に含まれる `Transition`, `SlideInItem`, `Typewriter`, `ThreeCanvas`, `Lottie`, `WaveVisualizer`, `ProgressBar`, `TikTokCaption`, `Captions` 等は未使用。アニメーションは自前の `outCubic`/`inOutCubic` で素朴に実装されている。

---

## 1. 型定義の拡張

### 1-1. 背景エフェクト型（新規 — types.ts に追加）

```typescript
export interface VideoTheme {
  backgroundEffect?: BackgroundEffect;
  captionStyle?: "default" | "tiktok";
}

export type BackgroundEffect =
  | { type: "none" }
  | { type: "gradient"; colors: string[]; angle?: number }
  | { type: "gradient-animation"; colors: string[]; speed?: number }
  | { type: "particles"; preset: "stars" | "snow" | "fireflies" | "bubbles" }
  | { type: "wave-visualizer"; bars?: number; color?: string }
  | { type: "three-particles"; preset: "floating" | "galaxy" | "rain" }
  | { type: "three-geometry"; preset: "wireframe-sphere" | "rotating-cube" | "wave-mesh" }
  | { type: "lottie"; preset: LottiePreset };

export type LottiePreset =
  | "confetti" | "checkmark" | "loading" | "arrows"
  | "sparkle" | "wave" | "pulse";
```

### 1-2. VideoProject / Scene の拡張

```typescript
export interface VideoProject {
  meta: VideoMeta;
  audio: AudioConfig;
  theme?: VideoTheme;       // 追加: プロジェクトレベルのデフォルト
  scenes: Scene[];
}

export interface Scene {
  // ...既存フィールド
  backgroundEffect?: BackgroundEffect;  // 追加: シーンレベルのオーバーライド
}
```

### 1-3. TransitionType の拡張

```typescript
export type TransitionType =
  | "fade"
  | "slide-left" | "slide-right" | "slide-up"
  | "wipe-left" | "wipe-right" | "wipe-up" | "wipe-down"
  | "none";
```

### 1-4. 新エレメント型

```typescript
export interface ProgressBarElement {
  type: "progress-bar";
  progress: number;
  color?: string;
  label?: string;
  animation: "grow" | "none";
}

export type SceneElement =
  | TitleElement | TextElement | BulletListElement
  | ImageElement | TableElement | CodeBlockElement
  | ProgressBarElement;
```

---

## 2. コンポーネントファイル構成

`scene-to-composition.tsx` を削除し、`composition/` ディレクトリに分割。

```
src/features/video/lib/composition/
├── index.tsx                    # VideoComposition, calculateTotalDuration
├── constants.ts                 # BASE, ANIM, getScale, scaled
├── SceneRenderer.tsx            # シーン全体 + トランジション
├── SceneAudio.tsx               # シーン音声
├── CaptionsOverlay.tsx          # デフォルト字幕
├── TikTokCaptionsOverlay.tsx    # TikTok風字幕
├── BackgroundEffectRenderer.tsx # 背景エフェクトのディスパッチャー
├── backgrounds/
│   ├── GradientBackground.tsx
│   ├── GradientAnimationBackground.tsx
│   ├── ParticlesBackground.tsx
│   ├── ThreeParticlesBackground.tsx
│   ├── ThreeGeometryBackground.tsx
│   ├── WaveVisualizerBackground.tsx
│   └── LottieBackground.tsx
├── elements/
│   ├── TitleElement.tsx
│   ├── TextElement.tsx
│   ├── BulletListElement.tsx
│   ├── ImageElement.tsx
│   ├── TableElement.tsx
│   ├── CodeBlockElement.tsx
│   └── ProgressBarElement.tsx
└── ElementRenderer.tsx
```

### open-motionコンポーネント使用マッピング

| ファイル | 使用するopen-motionコンポーネント |
|---|---|
| SceneRenderer.tsx | `Transition` (fade/slide/wipe) — `slide-left`→`<Transition type="slide" direction="left">` 等にマッピング |
| TitleElement.tsx | `SlideInItem`, `Typewriter`, `spring` |
| TextElement.tsx | `Transition` (fade) |
| BulletListElement.tsx | `SlideInItem` |
| ImageElement.tsx | `Transition`, `interpolate` |
| TableElement.tsx | `SlideInItem` |
| CodeBlockElement.tsx | `Transition`, `Typewriter` |
| ProgressBarElement.tsx | `ProgressBar` |
| WaveVisualizerBackground.tsx | `WaveVisualizer` |
| LottieBackground.tsx | `Lottie` |
| ThreeParticlesBackground.tsx | `ThreeCanvas` |
| ThreeGeometryBackground.tsx | `ThreeCanvas` |
| TikTokCaptionsOverlay.tsx | `TikTokCaption`, `Captions` |

---

## 3. 背景エフェクトの仕組み

### 3-1. レイヤー構造

```
CaptionsOverlay (最前面)      z-index: 30
Elements (コンテンツ)          z-index: 20
BackgroundEffect (装飾)        z-index: 10
Scene背景色                    z-index: 0
```

### 3-2. エフェクト解決の優先順位

```typescript
const effect = scene.backgroundEffect ?? project.theme?.backgroundEffect ?? { type: "none" };
```

### 3-3. 3Dプリセット

`ThreeCanvas` の `renderScene` コールバックにプリセットごとの設定を渡す：

```typescript
const PRESETS = {
  floating: { count: 200, speed: 0.3, size: 2, color: 0xffffff },
  galaxy:   { count: 500, speed: 0.1, size: 1, color: 0x8888ff },
  rain:     { count: 300, speed: 1.0, size: 1, color: 0xaaddff },
};
```

WebGL取得失敗時は `GradientBackground` にフォールバック。

### 3-4. Lottieアセット

```
resources/lottie-presets/
├── confetti.json
├── checkmark.json
├── loading.json
├── arrows.json
├── sparkle.json
├── wave.json
└── pulse.json
```

Tauriリソースとしてバンドル。エクスポート時に `temp_dir/public/lottie/` にコピー。

---

## 4. LLMによる自動適用

### 4-1. パイプライン

```
Markdown → md-to-scenes.ts → VideoProject
  → scene-decorator.ts (新規) → 背景エフェクト・アニメーション自動適用
  → narration-generator.ts → ナレーション付きVideoProject
```

### 4-2. scene-decorator.ts

LLMに全シーンの概要を一括送信し、以下のJSONを返してもらう：

**入力：**
```json
{
  "projectTitle": "Rustの基本",
  "sceneCount": 5,
  "scenes": [
    {
      "id": "scene-1",
      "title": "はじめに",
      "elementSummary": "[見出し1] はじめに, [テキスト] Rustは...",
      "hasNarration": true
    }
  ]
}
```

**出力：**
```json
{
  "theme": {
    "backgroundEffect": { "type": "gradient", "colors": ["#1a1a2e", "#16213e"], "angle": 135 },
    "captionStyle": "default"
  },
  "scenes": {
    "scene-1": {
      "backgroundEffect": { "type": "gradient-animation", "colors": ["#1a1a2e", "#0f3460", "#533483"], "speed": 0.5 },
      "elementAnimations": {
        "0": { "animation": "slide-in" },
        "1": { "animation": "fade-in" }
      }
    }
  }
}
```

### 4-3. LLMのガイドライン（システムプロンプト内）

- 技術的な内容 → gradient(青系) + particles(stars)
- 導入・まとめ → gradient-animation + lottie(sparkle)
- データ・数値 → three-geometry(wave-mesh)
- コード解説 → gradient(暗い色) + none

### 4-4. 呼び出しタイミング

UIの「LLMで自動設定」ボタン押下時に実行。Markdown読み込み時の自動実行はしない（LLM呼び出しコスト制御のため）。

---

## 5. UIからの変更

### 5-1. SceneEditForm の拡張

各シーンの編集フォームに以下を追加：
- 背景エフェクト選択（ドロップダウン + エフェクト固有の設定フィールド）
- 「プロジェクトデフォルトを使用」チェックボックス
- 字幕スタイル選択（default / tiktok）
- 各エレメントのアニメーション種別変更

### 5-2. プロジェクト設定パネル

VideoSettingsBar に以下を追加：
- デフォルト背景エフェクト設定
- デフォルト字幕スタイル設定
- 「LLMで自動設定」ボタン（scene-decorator を再実行）

---

## 6. エクスポートパイプラインへの影響

### 6-1. 追加依存

- `@open-motion/components` のリンクをtemp環境に追加
- `three` パッケージのリンクを追加

### 6-2. Lottieアセットコピー

`video_export` コマンド内で `resources/lottie-presets/` → `temp_dir/public/lottie/` へコピー。

### 6-3. render-video.mjs

変更不要。React コンポジションの中身が変わるだけ。

### 6-4. Three.js (WebGL)

Playwright起動時に `--enable-webgl` フラグを追加。WebGL未対応環境では `gradient` にフォールバック。
