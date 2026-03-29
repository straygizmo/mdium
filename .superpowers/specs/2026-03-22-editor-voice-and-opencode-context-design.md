# エディタ音声入力 & Opencodeコンテキスト連携 設計書

## 概要

MDエディタに2つの機能を追加する:

1. **エディタツールバーのマイクボタン**: 音声入力でカーソル位置にテキストを挿入
2. **Opencodeチャットへのエディタコンテキスト連携**: 編集中のMDファイル情報をopencodeに自動送信

## 機能1: エディタツールバー マイクボタン

### 配置

- `EditorPanel`のフォーマットバー内、テーブルボタン(`⊞`)の直後に配置
- spacerの前（scrollSyncボタンより左）

### 動作フロー

1. **Idle**: マイクボタン通常表示。クリックまたはスペースキー長押しで録音開始
2. **Loading**: Whisperモデルのロード中（初回のみ）
3. **Recording**: ボタンが赤く点滅。再クリックまたはスペースキーを離すと録音停止
4. **Transcribing**: スピナー表示。Whisper Web Workerで文字起こし
5. **Insert**: 文字起こし結果をエディタの`selectionStart`位置にテキスト挿入。カーソルを挿入テキスト末尾に移動

### 録音トリガー

| トリガー | 録音開始 | 録音停止 | 備考 |
|----------|----------|----------|------|
| マイクボタンクリック | クリック | 再クリック | トグル動作 |
| スペースキー長押し | keydown（長押し判定後） | keyup | Push-to-talk方式 |

**スペースキー長押しの判定:**
- エディタのtextareaにフォーカスがある場合のみ有効
- `keydown`イベントで一定時間（例: 500ms）ホールドされたら録音開始
- 短押し（500ms未満）の場合は通常のスペース入力として処理
- `keydown`の`repeat`プロパティを利用してホールド検出を補助
- 録音中は`keydown`イベントの`preventDefault()`でスペース文字の入力を抑止
- `keyup`で録音停止 → 文字起こし → カーソル位置に挿入

### 技術設計

- `EditorPanel`内で既存の`useSpeechToText(speechModel)`フックを呼び出す
- 設定ストアから`speechEnabled` / `speechModel`を取得（RAGパネルと共有）
- `speechEnabled === false`の場合はマイクボタンを非表示
- `transcript`の変更を`useEffect`で監視し、変更時に`editorRef.current`のカーソル位置にテキストを挿入
- 挿入には既存の`handleContentChange`パターンを利用:
  ```
  content.substring(0, selectionStart) + transcript + content.substring(selectionEnd)
  ```
- 挿入後、`setTranscript("")`でtranscriptをリセット
- スペースキー長押しのロジックは`handleKeyDown` / `handleKeyUp`内で`setTimeout`を使い、長押し判定のタイマーを管理

### 状態に応じたボタン表示

| 状態 | 背景色 | アイコン | 追加効果 |
|------|--------|----------|----------|
| idle | 既存ボタンと同じ | マイクアイコン | なし |
| loading | 黄色系 | スピナー | disabled |
| recording | 赤色系 | マイクアイコン | 点滅アニメーション |
| transcribing | 黄色系 | スピナー | disabled |

## 機能2: Opencodeチャット MDファイルコンテキスト連携

### 概要

左サイドバーのOpencodeチャットにトグルボタンを追加し、ONの場合にメッセージ送信時に編集中MDファイルのコンテキストをプレフィックスとして付与する。

opencodeがファイルを直接書き換えた場合は、既存のファイル監視機構（`useFileWatcher`）で検知してエディタに反映する。

### UIの変更

OpencodeChattツールバーに「MD」トグルを追加:

- 配置: Planトグルの右隣
- 外観: Plan同様のスライダートグル + 「MD」ラベル
- ON時: 緑色でハイライト
- OFF時: グレー

### 新規ストア: `editor-context-store`

```typescript
// stores/editor-context-store.ts
import { create } from "zustand";

interface EditorContextState {
  filePath: string | null;
  content: string;
  cursorLine: number;
  cursorColumn: number;
  selectionStart: number;
  selectionEnd: number;
  selectedText: string;

  updateCursor: (
    cursorLine: number,
    cursorColumn: number,
    selectionStart: number,
    selectionEnd: number,
    selectedText: string
  ) => void;
  updateContext: (filePath: string | null, content: string) => void;
}
```

### EditorPanel側の変更

- `textarea`の`onSelect`イベントと`onClick`イベントでカーソル位置・選択範囲を`editor-context-store`に随時更新
- `content`や`activeTab`の変更時に`filePath`と`content`をストアに反映
- カーソル位置（行・列）は`selectionStart`からテキストを走査して算出

### OpencodeChat側の変更

- ツールバーに`useMdContext`トグル状態を追加（`useChatUIStore`に保持）
- `handleSubmit`内でトグルON時に`editor-context-store`からコンテキストを読み取り、メッセージにプレフィックスを付与

### コンテキストプレフィックスのフォーマット

```
以下のMarkdownファイルについて指示があります。

ファイル: {filePath}
カーソル位置: 行 {cursorLine}, 列 {cursorColumn}
選択範囲: 行 {selStartLine} 列 {selStartCol} 〜 行 {selEndLine} 列 {selEndCol}

--- 選択テキスト ---
{selectedText}
--- 選択テキスト終了 ---

指示: {ユーザーの入力}
```

- 選択範囲がない場合（`selectionStart === selectionEnd`）は選択範囲・選択テキストのセクションを省略
- `filePath`がnullの場合はコンテキスト付与をスキップ（トグルONでもプレフィックスなし）

### ファイル変更検知とエディタ再読み込み

opencodeがファイルを書き換えた場合の反映フロー:

1. opencodeがファイルシステム上のファイルを変更
2. Tauri側の`notify`ベースのwatcher（`file_watcher.rs`）が変更を検知
3. `file-changed`イベントがフロントエンドに発火
4. `useFileWatcher`経由でコールバックが呼ばれる
5. ファイルを再読み込みし、`updateTabContent`でエディタの内容を更新

現在`useFileWatcher`がどこで使われているかを確認し、EditorPanel（またはApp.tsx）でアクティブタブのファイルを監視するように接続する。

## 変更対象ファイル一覧

### 新規作成

| ファイル | 目的 |
|----------|------|
| `src/stores/editor-context-store.ts` | エディタコンテキスト共有ストア |

### 変更

| ファイル | 変更内容 |
|----------|----------|
| `src/features/editor/components/EditorPanel.tsx` | マイクボタン追加、editor-context-store更新ロジック追加 |
| `src/features/editor/components/EditorPanel.css` | マイクボタンのスタイル（状態別の色・アニメーション） |
| `src/features/opencode-config/components/OpencodeChat.tsx` | MDトグル追加、コンテキストプレフィックス付与ロジック |
| `src/features/opencode-config/components/OpencodeChat.css` | MDトグルのスタイル |
| `src/features/opencode-config/hooks/useOpencodeChat.ts` | `useMdContext`状態を`useChatUIStore`に追加 |
| `src/app/App.tsx`（または適切な親コンポーネント） | `useFileWatcher`でアクティブタブのファイル監視を接続 |

### i18n

| ファイル | 追加キー |
|----------|----------|
| 各言語のeditor翻訳ファイル | `voiceInput`: マイクボタンのツールチップ |
| 各言語のopencode-config翻訳ファイル | `ocChatMdContext`: MDトグルのツールチップ |

## スコープ外

- MDエディタ下部のチャット入力欄（不要と判断）
- チャット入力欄専用のマイクボタン
- エディタとOpencodeチャット間の個別音声設定（共有で統一）
- opencodeの応答からの差分表示・適用UI（opencodeがファイルを直接書き換える）
