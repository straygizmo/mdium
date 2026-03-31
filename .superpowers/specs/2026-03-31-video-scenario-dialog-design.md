# Video Scenario Dialog Design

## Overview

`generate-video-scenario` コマンド実行前に、動画生成パラメータを設定する統合ダイアログを追加する。既存の `VideoOverwriteDialog`（上書き確認）を統合し、パラメータ設定 → コマンド自動登録 → Plan OFF → 自動実行までをワンクリックで完了させる。

## Parameters

テンプレートの引数マッピング:

| 引数 | 内容 | UI | デフォルト |
|---|---|---|---|
| `$1` | MD ファイルパス | （自動） | — |
| `$2` | 出力 JSON パス | （自動） | — |
| `$3` | 解像度 (WxH) | ドロップダウン | `1920x1080` |
| `$4` | アスペクト比 | （解像度連動） | `16:9` |
| `$5` | シーン数 | 「自動」チェック or スライダー 3–15 | `auto` |
| `$6` | 動画全体長さ (秒) | 「自動」チェック or スライダー 20–150 (10秒刻み) | `auto` (スライダー初期値: 30) |
| `$7` | TTS speed | スライダー 0.7–1.5 | `1.0` |

### Resolution ↔ Aspect Ratio Mapping

| Resolution | Aspect Ratio |
|---|---|
| 1920x1080 | 16:9 |
| 1080x1920 | 9:16 |
| 1280x720 | 16:9 |
| 1080x1080 | 1:1 |

## File Changes

### 1. `src/features/opencode-config/lib/builtin-commands.ts`

テンプレート内で `$3`〜`$7` を参照するよう変更:

- **Meta Settings** セクション: 固定値 (`1920×1080`, `16:9`, `30 fps`) を `$3`, `$4` に置換。シーン数 `$5`、動画長さ `$6` の指示を追加。
- **Output** セクション: TTS speed を `$7` に置換。
- **Scene Splitting Rules**: シーン数・動画長さが指定された場合の制約文を追加。

### 2. `src/features/video/components/VideoScenarioDialog.tsx` (新規)

統合ダイアログコンポーネント。

```typescript
interface VideoScenarioDialogProps {
  hasExisting: boolean;
  fileName: string;
  onSubmit: (params: VideoScenarioParams) => void;
  onCancel: () => void;
}

interface VideoScenarioParams {
  overwriteChoice: "overwrite" | "new";
  resolution: string;
  aspectRatio: string;
  sceneCount: "auto" | number;
  videoLength: "auto" | number;
  ttsSpeed: number;
}
```

**Layout:**

```
┌─────────────────────────────────────┐
│  動画シナリオ生成                      │
│                                     │
│  [既存ファイルがある場合のみ]            │
│  ○ 上書き  ○ 新規作成(タイムスタンプ)    │
│  ─────────────────────────────       │
│  解像度:  [1920x1080 ▼]              │
│                                     │
│  シーン数: □自動  ───●─── 5          │
│                                     │
│  動画長さ: □自動  ───●─── 30秒       │
│                                     │
│  TTS速度:        ───●─── 1.0        │
│                                     │
│         [キャンセル]  [生成開始]        │
└─────────────────────────────────────┘
```

- 「自動」チェック ON → スライダー disabled (グレーアウト)
- Escape / 外側クリック → キャンセル
- 既存の `VideoOverwriteDialog` のオーバーレイパターンを踏襲

### 3. `src/features/video/components/VideoScenarioDialog.css` (新規)

既存の `VideoOverwriteDialog.css` をベースにフォームフィールド用のスタイルを追加。

### 4. `src/features/preview/components/PreviewPanel.tsx`

- `overwriteDialog` state → `scenarioDialog` state に変更
- `handleEnterVideoMode()`:
  - コマンド未登録チェックの `alert` を削除（OKで自動登録するため）
  - 既存ファイル有無にかかわらず `VideoScenarioDialog` を表示
- `handleScenarioSubmit(params)`:
  1. `overwriteChoice` + パスから出力先を決定
  2. コマンド未登録の場合 → `saveCommand()` でグローバル登録
  3. `useChatUIStore.setState({ usePlanAgent: false })`
  4. UI切り替え（opencode-config パネル + chat タブ）
  5. `await doConnect(folderPath)` で接続確保
  6. `doExecuteCommand("generate-video-scenario", args)` で実行
- `setChatCommandAndFocus()` は削除
- `VideoOverwriteDialog` の import を `VideoScenarioDialog` に変更
- 既存の `consumePendingVideoOutput()` による自動ファイルオープンはそのまま維持

### 5. `src/features/opencode-config/hooks/useOpencodeChat.ts`

- `doConnect` と `doExecuteCommand` を named export に追加（PreviewPanel から直接呼べるように）

### 6. 削除ファイル

- `src/features/video/components/VideoOverwriteDialog.tsx` — `VideoScenarioDialog` に統合
- `src/features/video/components/VideoOverwriteDialog.css` — 同上

### 7. i18n (`src/shared/i18n/locales/{ja,en}/video.json`)

新規キー追加:

| キー | ja | en |
|---|---|---|
| `scenarioDialogTitle` | 動画シナリオ生成 | Generate Video Scenario |
| `scenarioResolution` | 解像度 | Resolution |
| `scenarioSceneCount` | シーン数 | Scene Count |
| `scenarioSceneCountAuto` | 自動 | Auto |
| `scenarioVideoLength` | 動画の長さ | Video Length |
| `scenarioVideoLengthAuto` | 自動 | Auto |
| `scenarioVideoLengthUnit` | 秒 | sec |
| `scenarioTtsSpeed` | TTS速度 | TTS Speed |
| `scenarioOverwrite` | 上書き | Overwrite |
| `scenarioCreateNew` | 新規作成 | Create New |
| `scenarioStart` | 生成開始 | Start Generation |
| `scenarioExistingFile` | 「{{fileName}}」が既に存在します。 | "{{fileName}}" already exists. |

既存の `overwriteDialog*` キーは残しても問題ないが、参照がなくなるため削除推奨。

## Execution Flow

```
User clicks "動画シナリオ生成" button
  ↓
handleEnterVideoMode()
  ├─ Derive paths (mdPath, videoJsonPath)
  ├─ Check if .video.json exists → hasExisting
  └─ Show VideoScenarioDialog(hasExisting, fileName)
       ↓
User configures params → clicks "生成開始"
  ↓
handleScenarioSubmit(params)
  ├─ Determine output path (overwrite vs new with timestamp)
  ├─ If command not registered globally → saveCommand()
  ├─ useChatUIStore.setState({ usePlanAgent: false })
  ├─ Switch UI to opencode-config/chat panel
  ├─ await doConnect(folderPath)
  └─ doExecuteCommand("generate-video-scenario", args)
       ↓
Command executes via opencode server
  ↓
consumePendingVideoOutput() → auto-open .video.json
```
