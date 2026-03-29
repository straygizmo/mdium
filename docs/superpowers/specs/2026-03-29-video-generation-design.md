# MDium 動画生成機能 設計ドキュメント

## 概要

任意のMarkdownファイルからナレーション・BGM付き動画を生成する機能をmdiumに統合する。
open-motion（React ベースの動画エンジン）のソースをベンダリングし、mdium内で独自に進化させる。

## 背景・動機

- mdiumはMarkdown中心のドキュメント基盤であり、プレゼンテーション（Slidev）やPDF/DOCX等のエクスポートを既に備えている
- 次のステップとして、ドキュメントから動画コンテンツを生成する機能を追加する
- open-motionはReact + Playwright + FFmpegベースのオープンソース動画エンジンだが、開発が停止しているためソースを取り込んで独自に拡張する

## アーキテクチャ

### ディレクトリ構成

```
mdium/
├── packages/
│   └── open-motion/               # ベンダリングしたopen-motion
│       ├── core/                  # React primitives, hooks, Player
│       ├── renderer/              # Playwright フレームキャプチャ
│       ├── encoder/               # FFmpeg エンコード
│       └── components/            # Captions, Transitions等（必要なもののみ）
├── src/
│   └── features/
│       └── video/                 # 新規feature: 動画生成機能
│           ├── components/        # UI（設定パネル、プレビュー、シーン編集フォーム）
│           ├── hooks/             # useVideoGeneration等
│           ├── lib/
│           │   ├── md-to-scenes.ts       # MD → 中間JSON変換
│           │   ├── scene-to-component.ts  # 中間JSON → Reactコンポーネント生成
│           │   └── tts-provider.ts        # TTS抽象レイヤー
│           └── types.ts           # VideoProject, Scene等の型定義
├── src-tauri/
│   └── src/commands/
│       └── video.rs               # Rustバックエンド（レンダリング実行、TTS呼び出し）
└── resources/
    └── video-env/                 # Playwright Chromium等の実行環境
```

### データフロー

```
MD ファイル
    ↓  md-to-scenes.ts（<!-- pagebreak -->でシーン分割）
中間JSON (VideoProject)
    ↓  UIでプレビュー＆微調整（シーン編集フォーム）
    ↓
    ↓  TTS Provider → ナレーション音声ファイル生成
    ↓  音声の長さからシーンのdurationInFramesを自動計算
    ↓
scene-to-component.ts → React Composition
    ↓
    ├→ <Player> でリアルタイムプレビュー（映像+ナレーション+BGM）
    │   ユーザーが確認・調整
    │
    └→ open-motion renderer → PNG フレーム列
        → open-motion encoder → MP4/WebM（BGM + ナレーション合成）
```

## 中間JSON データ構造

### VideoProject

```typescript
interface VideoProject {
  meta: {
    title: string;
    width: number;           // デフォルト 1920
    height: number;          // デフォルト 1080
    fps: number;             // デフォルト 30
    aspectRatio: "16:9" | "9:16" | "4:3" | "1:1";
  };
  audio: {
    bgm?: {
      src: string;           // ファイルパス
      volume: number;        // 0.0-1.0
    };
    tts: {
      provider: "voicevox" | "openai" | "google";
      speaker?: string;      // VOICEVOX speaker ID等
      volume: number;
    };
  };
  scenes: Scene[];
}
```

### Scene

```typescript
interface Scene {
  id: string;                // "scene-1", "scene-2"...
  title?: string;            // シーンタイトル（UI表示用）
  durationInFrames?: number; // TTS音声長から自動計算、手動上書き可
  narration: string;         // ナレーションテキスト（TTS入力）
  narrationAudio?: string;   // 生成後の音声ファイルパス
  transition: {
    type: "fade" | "slide-left" | "slide-right" | "slide-up" | "none";
    durationInFrames: number; // デフォルト 15 (0.5秒@30fps)
  };
  elements: SceneElement[];
}
```

### SceneElement

```typescript
type SceneElement =
  | TitleElement
  | TextElement
  | BulletListElement
  | ImageElement
  | TableElement
  | CodeBlockElement;

interface TitleElement {
  type: "title";
  text: string;
  level: 1 | 2 | 3;
  animation: "fade-in" | "slide-in" | "typewriter" | "none";
}

interface BulletListElement {
  type: "bullet-list";
  items: string[];
  animation: "sequential" | "fade-in" | "none";
  delayPerItem: number;      // フレーム数
}

interface ImageElement {
  type: "image";
  src: string;               // 画像ファイルパス
  alt?: string;
  position: "center" | "left" | "right" | "background";
  animation: "fade-in" | "zoom-in" | "ken-burns" | "none";
}

interface TextElement {
  type: "text";
  content: string;
  animation: "fade-in" | "none";
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
```

## MD → 中間JSON 変換ルール (md-to-scenes.ts)

### シーン分割

- `<!-- pagebreak -->` でシーン分割
- `<!-- pagebreak -->` がなければ文書全体を1シーンとして扱う

### Markdown要素の変換

| Markdown記法 | 変換先 | アニメーションデフォルト |
|:---|:---|:---|
| `# 見出し` | `TitleElement { level: 1 }` | `fade-in` |
| `## 見出し` | `TitleElement { level: 2 }` | `fade-in` |
| `### 見出し` | `TitleElement { level: 3 }` | `fade-in` |
| `- 箇条書き` | `BulletListElement` | `sequential` |
| `![alt](src)` / `<img>` | `ImageElement` | `fade-in` |
| `\| 表 \|` | `TableElement` | `row-by-row` |
| ` ```lang ` | `CodeBlockElement` | `fade-in` |
| その他テキスト | `TextElement` | `fade-in` |
| `<div class="grid...">` | 内部要素をフラットに展開 | - |
| ` ```mermaid ` | スキップ（初期版） | - |

### ナレーション

- `<!-- narration: テキスト -->` 形式のHTMLコメントを `Scene.narration` に格納
- コメントがないシーンは、タイトル＋箇条書きテキストを連結して自動生成

### 画像パス解決

- MDファイルからの相対パスを絶対パスに解決
- 動画プロジェクトの一時ディレクトリ `public/images/` にコピー

### Slidev固有要素の扱い

- Slidev形式のMDも入力可能（`---`区切りはそのまま通常テキストとして扱われる）
- `layout`, `background`, `transition` 等のSlidev frontmatterがあれば参考値として活用するが、必須ではない

## Reactコンポーネント描画 (scene-to-component.ts)

### Composition構造

```tsx
<Composition id="video-project" width={meta.width} height={meta.height} fps={meta.fps} durationInFrames={totalDuration}>
  <Sequence from={0} durationInFrames={scene1Duration}>
    <SceneRenderer scene={scene1} />
    <Audio src={scene1.narrationAudio} />
  </Sequence>
  <Sequence from={scene1Duration - transitionOverlap} durationInFrames={scene2Duration}>
    <SceneRenderer scene={scene2} />
    <Audio src={scene2.narrationAudio} />
  </Sequence>
  ...
  <Audio src={bgm.src} volume={bgm.volume} />
</Composition>
```

### SceneRenderer

```tsx
<SceneRenderer scene={scene}>
  <TransitionWrapper type={scene.transition.type}>
    <SceneBackground />
    {scene.elements.map(el => <ElementRenderer element={el} />)}
  </TransitionWrapper>
</SceneRenderer>
```

### ElementRenderer マッピング

| type | レンダリング | アニメーション実装 |
|:---|:---|:---|
| `title` | スタイル付き `<h1>`〜`<h3>` | `interpolate()` で opacity/translateY |
| `bullet-list` | `<ul><li>` の連続 | 各itemを `<Sequence>` で囲み `delayPerItem` ずつずらして表示 |
| `image` | `<img>` + positionに応じたCSS | opacity, scale の `interpolate()` |
| `table` | `<table>` + スタイル | `row-by-row` は各 `<tr>` を `<Sequence>` で順次表示 |
| `code-block` | `<pre><code>` + シンタックスカラー | opacity の `interpolate()` |
| `text` | `<p>` | opacity の `interpolate()` |

### durationInFrames 自動計算

```
シーンのduration = max(
  ナレーション音声の長さ(秒) × fps,
  全要素アニメーションの最小必要フレーム数
) + transition.durationInFrames
```

## TTS 抽象レイヤー (tts-provider.ts)

### インターフェース

```typescript
interface TTSProvider {
  name: string;
  synthesize(text: string, options: TTSOptions): Promise<TTSResult>;
  getVoices(): Promise<Voice[]>;
}

interface TTSOptions {
  voice: string;
  speed?: number;        // 0.5-2.0, デフォルト 1.0
  volume?: number;       // 0.0-1.0
}

interface TTSResult {
  audioPath: string;     // 生成された音声ファイルパス
  durationMs: number;    // 音声の長さ（ミリ秒）
}

interface Voice {
  id: string;
  name: string;
  language: string;
}
```

### 初期実装: VOICEVOX プロバイダー

- `http://localhost:50021` にリクエスト（open-motionの既存実装を流用）
- `/audio_query` → `/synthesis` の2ステップ
- 複数話者から選択可能

### 将来追加可能なプロバイダー

- OpenAI TTS (`/v1/audio/speech`)
- Google Cloud TTS
- VOICEPEAK等のローカルTTS

### 音声生成フロー

1. 各 `Scene.narration` テキストを取得
2. `TTSProvider.synthesize()` で音声ファイル生成
3. 結果の `durationMs` から `durationInFrames` を計算: `ceil(durationMs / 1000 * fps) + paddingFrames`
4. `Scene.narrationAudio` にファイルパスを格納
5. Compositionの全体durationを再計算

### 音声ファイル管理

- 一時ディレクトリ: `%TEMP%/mdium-video/<hash>/audio/`
- `scene-1.wav`, `scene-2.wav` ... と保存
- テキスト修正後は該当シーンだけ再生成可能

## UI 統合

### エントリポイント

ツールバーの既存エクスポートボタン群に `[▷]` を追加:

```
[Preview] [PDF] [W] [</>] [▷]
```

### [▷] 押下後のレイアウト

```
┌─────────────────────────────────┬──────────────────────┐
│  シーン編集フォーム（元エディタ領域） │  Player プレビュー     │
│                                 │                      │
│  ── 全体設定 ──                  │                      │
│  解像度: [1920x1080 ▼]          │                      │
│  BGM: [選択...] 音量: [━━●━]    │                      │
│  TTS: [VOICEVOX ▼] 話者: [▼]    │                      │
│                                 │   (音声生成前は       │
│  ── シーン 1: MDium ──           │    静止プレビュー)     │
│  ナレーション:                    │                      │
│  [テキストエリア]                 │                      │
│  トランジション: [fade ▼]        │  [▶] [⏸] ━━●━━━     │
│  タイトルアニメ: [fade-in ▼]     │  00:32 / 02:15      │
│                                 │                      │
│  ── シーン 2 ──                  ├──────────────────────┤
│  ナレーション:                    │  [音声生成]           │
│  [テキストエリア]                 │  [エクスポート]        │
│  ...                            │  [← MDに戻る]        │
└─────────────────────────────────┴──────────────────────┘
```

### 操作フロー

1. 任意のMDファイルを開いた状態で `[▷]` ボタンを押下
2. MD → 中間JSON変換が実行され、シーン編集フォームに切り替わる
3. シーン一覧でナレーションテキストやアニメーション設定を微調整
4. **[音声生成]** → TTS実行 → 音声が揃うとPlayerでプレビュー可能
5. Playerで映像+音声を確認。必要に応じて調整し再度音声生成
6. **[エクスポート]** → 出力設定ダイアログ → レンダリング実行 → ファイル保存
7. **[← MDに戻る]** でいつでもMD編集に復帰

### 状態管理

`src/stores/video-store.ts` (Zustand):

```typescript
interface VideoStore {
  videoProject: VideoProject | null;
  audioGenerated: boolean;
  renderProgress: number;         // 0-100
  selectedSceneId: string | null;
  isVideoMode: boolean;           // エディタ ↔ シーン編集フォーム切り替え
}
```

### MDとの同期

- [▷] 押下時点のMDから中間JSONを生成
- シーン編集フォーム中にMDは自動同期しない（フォーム上の微調整を保護）
- [← MDに戻る] → MD再編集 → [▷] 再押下でJSON再生成（ユーザー編集済みの値はシーンIDで照合して保持）

## レンダリングパイプライン & エクスポート

### 実行環境

- open-motionのrenderer/encoderをRustバックエンド (`video.rs`) から呼び出す
- Vite devサーバーを一時的に起動し、Compositionを配信 → Playwrightでフレームキャプチャ
- 一時ディレクトリ: `%TEMP%/mdium-video/<hash>/`
  - `frames/` — PNG連番
  - `audio/` — TTS音声ファイル
  - `public/images/` — MD参照画像のコピー
  - `project.json` — 中間JSON

### エクスポートダイアログ

```
┌─ 動画エクスポート ─────────────────┐
│                                   │
│  フォーマット: (●) MP4  ( ) WebM   │
│  解像度:      [1920] x [1080]     │
│  FPS:         [30]                │
│  並列数:      [4]                  │
│                                   │
│  出力先: [C:\...\output.mp4] [...]│
│                                   │
│  [キャンセル]          [エクスポート]│
└───────────────────────────────────┘
```

### 進捗表示

- Rustバックエンドからフロントエンドへイベント発行 (`video-progress`)
- フレームレンダリング進捗 → エンコード進捗の2段階
- キャンセル可能（プロセス中断 + 一時ファイル削除）

### 外部依存

- **FFmpeg**: ユーザー環境にインストール済みを前提。なければエラー表示＆インストールガイドを案内
- **Playwright Chromium**: `resources/video-env/` にバンドル（Slidev環境の `playwright-chromium` と共有可能）

## open-motion ベンダリング方針

### 取り込む範囲

| パッケージ | 取り込み | 理由 |
|:---|:---|:---|
| `@open-motion/core` | ○ | Composition, Sequence, Audio, Player, hooks, interpolate, spring, Easing |
| `@open-motion/renderer` | ○ | Playwrightフレームキャプチャ、時間ハイジャック |
| `@open-motion/encoder` | ○ | FFmpegエンコード、音声ミキシング |
| `@open-motion/components` | 一部 | Transitions, Captions のみ。Three.js/Lottie は不要 |
| `@open-motion/cli` | × | CLIは不要。generate/edit/config コマンドは使わない |

### ライセンス

- open-motionはMITライセンス。ベンダリング・改変は自由
- ライセンスファイルを `packages/open-motion/LICENSE` として保持

## 初期スコープ外（将来対応）

- Mermaid図の動画内レンダリング（事前PNG変換で対応可能）
- LLMによるナレーション自動生成（テキスト連結による簡易生成で初期対応）
- 3Dトランジション、パーティクル等のリッチ演出
- 字幕（キャプション）表示（open-motion componentsに既存実装あり、後から統合可能）
