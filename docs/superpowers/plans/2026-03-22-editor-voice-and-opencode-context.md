# エディタ音声入力 & Opencodeコンテキスト連携 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** エディタツールバーにマイクボタン（スペースキー長押し対応）を追加し、Opencodeチャットに編集中MDファイルのコンテキスト連携機能を追加する。

**Architecture:** Zustandストア（`editor-context-store`）でエディタの状態（カーソル位置・選択範囲・内容）を共有し、EditorPanelとOpencodeChatを疎結合に連携させる。音声入力は既存の`useSpeechToText`フックを再利用する。

**Tech Stack:** React 19, TypeScript, Zustand, Tauri 2, @huggingface/transformers (Whisper), @opencode-ai/sdk

**Spec:** `docs/superpowers/specs/2026-03-22-editor-voice-and-opencode-context-design.md`

---

## File Structure

### New Files

| File | Responsibility |
|------|---------------|
| `src/stores/editor-context-store.ts` | カーソル位置・選択範囲・ファイルパスを保持する共有ストア |

### Modified Files

| File | Changes |
|------|---------|
| `src/features/editor/components/EditorPanel.tsx` | マイクボタンUI追加、speech hook統合、スペースキー長押し、editor-context-store更新 |
| `src/features/editor/components/EditorPanel.css` | マイクボタン状態別スタイル（idle/recording/transcribing）、点滅アニメーション |
| `src/features/opencode-config/hooks/useOpencodeChat.ts` | `useMdContext` 状態を `useChatUIStore` に追加 |
| `src/features/opencode-config/components/OpencodeChat.tsx` | MDトグルUI追加、コンテキストプレフィックス付与ロジック |
| `src/features/opencode-config/components/OpencodeChat.css` | MDトグルスタイル（Planトグルと同じパターン、緑色） |
| `src/app/App.tsx` | `useFileWatcher` 接続（アクティブタブのファイル変更検知→再読み込み） |
| `src/shared/i18n/locales/en/editor.json` | `voiceInput` キー追加 |
| `src/shared/i18n/locales/ja/editor.json` | `voiceInput` キー追加 |
| `src/shared/i18n/locales/en/opencode-config.json` | `ocChatMdContext` キー追加 |
| `src/shared/i18n/locales/ja/opencode-config.json` | `ocChatMdContext` キー追加 |

---

### Task 1: editor-context-store の作成

**Files:**
- Create: `src/stores/editor-context-store.ts`

- [ ] **Step 1: ストアを作成**

```typescript
// src/stores/editor-context-store.ts
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

export const useEditorContextStore = create<EditorContextState>()((set) => ({
  filePath: null,
  content: "",
  cursorLine: 1,
  cursorColumn: 1,
  selectionStart: 0,
  selectionEnd: 0,
  selectedText: "",

  updateCursor: (cursorLine, cursorColumn, selectionStart, selectionEnd, selectedText) =>
    set({ cursorLine, cursorColumn, selectionStart, selectionEnd, selectedText }),

  updateContext: (filePath, content) =>
    set({ filePath, content }),
}));
```

- [ ] **Step 2: ビルド確認**

Run: `npm run build 2>&1 | head -20`
Expected: ビルドエラーなし（新規ファイルのみで未使用のため警告は許容）

- [ ] **Step 3: コミット**

```bash
git add src/stores/editor-context-store.ts
git commit -m "feat: add editor-context-store for sharing cursor/selection state"
```

---

### Task 2: EditorPanel にマイクボタンを追加

**Files:**
- Modify: `src/features/editor/components/EditorPanel.tsx`
- Modify: `src/features/editor/components/EditorPanel.css`
- Modify: `src/shared/i18n/locales/en/editor.json`
- Modify: `src/shared/i18n/locales/ja/editor.json`

- [ ] **Step 1: i18n キーを追加**

`src/shared/i18n/locales/en/editor.json` に追加:
```json
"voiceInput": "Voice Input (hold Space)"
```

`src/shared/i18n/locales/ja/editor.json` に追加:
```json
"voiceInput": "音声入力 (スペース長押し)"
```

- [ ] **Step 2: EditorPanel.tsx にマイクボタンとspeechフックを統合**

`src/features/editor/components/EditorPanel.tsx` を以下のように変更:

1. インポート追加:
```typescript
import { useEffect } from "react"; // 既存のimportに追加
import { useSpeechToText } from "@/features/speech/hooks/useSpeechToText";
import { useSettingsStore } from "@/stores/settings-store";
```

2. コンポーネント内にspeech関連のロジック追加:
```typescript
const speechEnabled = useSettingsStore((s) => s.speechEnabled);
const speechModel = useSettingsStore((s) => s.speechModel);
const { status: speechStatus, transcript, toggle: toggleSpeech, setTranscript } = useSpeechToText(
  speechModel ?? "Xenova/whisper-small"
);
```

3. transcript挿入のuseEffect追加:
```typescript
useEffect(() => {
  if (!transcript || !editorRef.current) return;
  const textarea = editorRef.current;
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const newContent = content.substring(0, start) + transcript + content.substring(end);
  handleContentChange(newContent);
  setTranscript("");
  // カーソルを挿入テキスト末尾に移動
  const newPos = start + transcript.length;
  setTimeout(() => {
    textarea.selectionStart = textarea.selectionEnd = newPos;
  }, 0);
}, [transcript]); // eslint-disable-line react-hooks/exhaustive-deps
```

4. テーブルボタン(`⊞`)の直後、spacerの前にマイクボタンを追加:
```tsx
{/* Table button (existing) */}
{showTableGrid && (
  <TableGridSelector ... />
)}
{/* NEW: Mic button */}
{speechEnabled && (
  <>
    <span className="editor-panel__separator" />
    <button
      className={`editor-panel__mic-btn editor-panel__mic-btn--${speechStatus}`}
      onClick={toggleSpeech}
      disabled={speechStatus === "loading" || speechStatus === "transcribing"}
      title={t("voiceInput")}
    >
      {speechStatus === "loading" || speechStatus === "transcribing" ? (
        <svg className="editor-panel__mic-spinner" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
        </svg>
      ) : (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="9" y="1" width="6" height="11" rx="3" />
          <path d="M19 10v1a7 7 0 0 1-14 0v-1" />
          <line x1="12" y1="19" x2="12" y2="23" />
          <line x1="8" y1="23" x2="16" y2="23" />
        </svg>
      )}
    </button>
  </>
)}
<span className="editor-panel__spacer" />
```

- [ ] **Step 3: EditorPanel.css にマイクボタンのスタイルを追加**

`src/features/editor/components/EditorPanel.css` の末尾に追加:

```css
/* Mic button */
.editor-panel__mic-btn {
  background: none;
  border: none;
  color: var(--text-secondary);
  font-size: 13px;
  padding: 3px 7px;
  border-radius: 3px;
  cursor: pointer;
  line-height: 1;
  transition: background 0.2s, color 0.2s;
}

.editor-panel__mic-btn:hover {
  background: var(--bg-overlay);
  color: var(--text);
}

.editor-panel__mic-btn--recording {
  background: var(--accent-red, #e64553) !important;
  color: #fff !important;
  animation: editor-mic-pulse 1s infinite;
}

.editor-panel__mic-btn--loading,
.editor-panel__mic-btn--transcribing {
  color: var(--accent-yellow, #df8e1d) !important;
  cursor: wait;
}

.editor-panel__mic-btn:disabled {
  opacity: 0.6;
  cursor: wait;
}

@keyframes editor-mic-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}

.editor-panel__mic-spinner {
  animation: editor-mic-spin 1s linear infinite;
}

@keyframes editor-mic-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
```

- [ ] **Step 4: ビルド確認**

Run: `npm run build 2>&1 | head -20`
Expected: ビルドエラーなし

- [ ] **Step 5: 手動動作確認**

`npm run tauri dev` で起動し、以下を確認:
1. エディタツールバーのTblボタン右にマイクボタンが表示される
2. Settings で Speech を有効にすると表示される
3. マイクボタンクリックで録音開始（赤点滅）、再クリックで停止→文字起こし→カーソル位置に挿入

- [ ] **Step 6: コミット**

```bash
git add src/features/editor/components/EditorPanel.tsx src/features/editor/components/EditorPanel.css src/shared/i18n/locales/en/editor.json src/shared/i18n/locales/ja/editor.json
git commit -m "feat: add mic button to editor toolbar for voice input at cursor"
```

---

### Task 3: スペースキー長押しによる録音トリガー

**Files:**
- Modify: `src/features/editor/components/EditorPanel.tsx`

- [ ] **Step 1: スペースキー長押しロジックを追加**

`EditorPanel.tsx` に以下を追加:

1. refの追加:
```typescript
const spaceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
const isSpaceRecordingRef = useRef(false);
```

2. 既存の `handleKeyDown` を修正して、スペースキー長押し判定を追加:
```typescript
const handleKeyDown = useCallback(
  (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // スペースキー長押し: 録音開始
    if (e.key === " " && speechEnabled && !e.repeat) {
      if (speechStatus === "idle") {
        // 500ms後に録音開始するタイマーをセット
        spaceTimerRef.current = setTimeout(() => {
          e.target && (e.target as HTMLTextAreaElement).dataset.spaceLongPress = "true";
          isSpaceRecordingRef.current = true;
          toggleSpeech();
        }, 500);
      }
      return; // 通常のスペース入力を許可（短押しなら後でinsertされる）
    }
    // 録音中のスペースキーrepeatを抑止
    if (e.key === " " && e.repeat && isSpaceRecordingRef.current) {
      e.preventDefault();
      return;
    }

    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      handleInsertFormatting("pagebreak");
      return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      const textarea = e.currentTarget;
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const newContent =
        content.substring(0, start) + "  " + content.substring(end);
      handleContentChange(newContent);
      setTimeout(() => {
        textarea.selectionStart = textarea.selectionEnd = start + 2;
      }, 0);
    }
  },
  [content, handleContentChange, handleInsertFormatting, speechEnabled, speechStatus, toggleSpeech]
);
```

3. `handleKeyUp` を新規追加:
```typescript
const handleKeyUp = useCallback(
  (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === " ") {
      // タイマーが残っていればキャンセル（短押し → 通常のスペース入力）
      if (spaceTimerRef.current) {
        clearTimeout(spaceTimerRef.current);
        spaceTimerRef.current = null;
      }
      // 録音中であれば停止
      if (isSpaceRecordingRef.current) {
        isSpaceRecordingRef.current = false;
        toggleSpeech(); // stop recording
        e.preventDefault();
      }
    }
  },
  [toggleSpeech]
);
```

4. textareaに `onKeyUp` を追加:
```tsx
<textarea
  ref={editorRef}
  className="editor-panel__textarea"
  value={content}
  onChange={handleTextareaChange}
  onKeyDown={handleKeyDown}
  onKeyUp={handleKeyUp}
  placeholder={t("placeholder", { defaultValue: "" })}
  spellCheck={false}
/>
```

- [ ] **Step 2: スペースキー長押し中のスペース文字入力を抑制**

`handleKeyDown` のスペースキー処理を修正 — 長押し判定が確定したらスペース文字を削除:

```typescript
// transcript挿入のuseEffectの前に、長押し確定時のスペース削除ロジックを追加:
// 長押しが開始されたら、直前に入力されたスペース文字を除去
useEffect(() => {
  if (speechStatus === "recording" && isSpaceRecordingRef.current && editorRef.current) {
    const textarea = editorRef.current;
    const pos = textarea.selectionStart;
    // 直前のスペースを除去
    if (pos > 0 && content[pos - 1] === " ") {
      const newContent = content.substring(0, pos - 1) + content.substring(pos);
      handleContentChange(newContent);
      setTimeout(() => {
        textarea.selectionStart = textarea.selectionEnd = pos - 1;
      }, 0);
    }
  }
}, [speechStatus]); // eslint-disable-line react-hooks/exhaustive-deps
```

- [ ] **Step 3: ビルド確認**

Run: `npm run build 2>&1 | head -20`
Expected: ビルドエラーなし

- [ ] **Step 4: 手動動作確認**

`npm run tauri dev` で以下を確認:
1. スペースキー短押し（500ms未満）→ 通常のスペース文字が入力される
2. スペースキー長押し（500ms以上）→ 録音開始（ボタンが赤に）、スペースは入力されない
3. スペースキーを離す → 録音停止 → 文字起こし → カーソル位置に挿入
4. 録音中にスペースキーをホールドし続けても追加のスペースは入力されない

- [ ] **Step 5: コミット**

```bash
git add src/features/editor/components/EditorPanel.tsx
git commit -m "feat: add space key long-press for push-to-talk voice input"
```

---

### Task 4: EditorPanel から editor-context-store を更新

**Files:**
- Modify: `src/features/editor/components/EditorPanel.tsx`

- [ ] **Step 1: ストアのインポートと更新ロジックを追加**

`EditorPanel.tsx` に以下を追加:

1. インポート:
```typescript
import { useEditorContextStore } from "@/stores/editor-context-store";
```

2. ストアのアクション取得:
```typescript
const updateCursor = useEditorContextStore((s) => s.updateCursor);
const updateEditorContext = useEditorContextStore((s) => s.updateContext);
```

3. カーソル位置から行・列を算出するヘルパー:
```typescript
const computeLineCol = useCallback((text: string, pos: number) => {
  const before = text.substring(0, pos);
  const lines = before.split("\n");
  return { line: lines.length, col: lines[lines.length - 1].length + 1 };
}, []);
```

4. カーソル/選択変更ハンドラ:
```typescript
const handleCursorChange = useCallback(() => {
  const textarea = editorRef.current;
  if (!textarea) return;
  const { selectionStart, selectionEnd } = textarea;
  const { line, col } = computeLineCol(content, selectionStart);
  const selectedText = content.substring(selectionStart, selectionEnd);
  updateCursor(line, col, selectionStart, selectionEnd, selectedText);
}, [content, computeLineCol, updateCursor, editorRef]);
```

5. textarea に `onSelect` と `onClick` を追加:
```tsx
<textarea
  ...
  onSelect={handleCursorChange}
  onClick={handleCursorChange}
  onKeyUp={(e) => { handleKeyUp(e); handleCursorChange(); }}
/>
```
注: `onKeyUp` は既存の `handleKeyUp` と `handleCursorChange` を両方呼ぶ。

6. コンテキスト更新のuseEffect（タブ変更時）:
```typescript
useEffect(() => {
  updateEditorContext(activeTab?.filePath ?? null, content);
}, [activeTab?.filePath, content, updateEditorContext]);
```

- [ ] **Step 2: ビルド確認**

Run: `npm run build 2>&1 | head -20`
Expected: ビルドエラーなし

- [ ] **Step 3: コミット**

```bash
git add src/features/editor/components/EditorPanel.tsx
git commit -m "feat: sync editor cursor/selection to editor-context-store"
```

---

### Task 5: useOpencodeChat に useMdContext 状態を追加

**Files:**
- Modify: `src/features/opencode-config/hooks/useOpencodeChat.ts`

- [ ] **Step 1: useChatUIStore に useMdContext を追加**

`src/features/opencode-config/hooks/useOpencodeChat.ts` を変更:

1. `OpencodeChatUIState` interface に追加:
```typescript
interface OpencodeChatUIState {
  // ... existing fields
  useMdContext: boolean;
}
```

2. 初期値に追加:
```typescript
const useChatUIStore = create<OpencodeChatUIState>()(() => ({
  // ... existing fields
  useMdContext: false,
}));
```

3. `UseOpencodeChatResult` interface に追加:
```typescript
interface UseOpencodeChatResult {
  // ... existing fields
  useMdContext: boolean;
  setUseMdContext: (value: boolean) => void;
}
```

4. フック内に追加:
```typescript
export function useOpencodeChat(folderPath?: string): UseOpencodeChatResult {
  const {
    // ... existing destructuring
    useMdContext,
  } = useChatUIStore();

  // ... existing code

  const setUseMdContext = useCallback((value: boolean) => {
    useChatUIStore.setState({ useMdContext: value });
  }, []);

  return {
    // ... existing return values
    useMdContext,
    setUseMdContext,
  };
}
```

- [ ] **Step 2: ビルド確認**

Run: `npm run build 2>&1 | head -20`
Expected: ビルドエラーなし

- [ ] **Step 3: コミット**

```bash
git add src/features/opencode-config/hooks/useOpencodeChat.ts
git commit -m "feat: add useMdContext state to opencode chat store"
```

---

### Task 6: OpencodeChat に MD トグルとコンテキストプレフィックスを追加

**Files:**
- Modify: `src/features/opencode-config/components/OpencodeChat.tsx`
- Modify: `src/features/opencode-config/components/OpencodeChat.css`
- Modify: `src/shared/i18n/locales/en/opencode-config.json`
- Modify: `src/shared/i18n/locales/ja/opencode-config.json`

- [ ] **Step 1: i18n キーを追加**

`src/shared/i18n/locales/en/opencode-config.json` に追加:
```json
"ocChatMdContext": "MD File Context"
```

`src/shared/i18n/locales/ja/opencode-config.json` に追加:
```json
"ocChatMdContext": "MDファイル連携"
```

- [ ] **Step 2: OpencodeChat.tsx に MD トグルを追加**

1. インポート追加:
```typescript
import { useEditorContextStore } from "@/stores/editor-context-store";
```

2. フックの destructuring に追加:
```typescript
const {
  // ... existing
  useMdContext,
  setUseMdContext,
} = useOpencodeChat(activeFolderPath ?? undefined);
```

3. ツールバーの Plan トグルの直後に MD トグルを追加（`OpencodeChat.tsx` の L252-260 の後）:
```tsx
<label className="oc-chat__md-toggle" title={t("ocChatMdContext")}>
  <input
    type="checkbox"
    checked={useMdContext}
    onChange={(e) => setUseMdContext(e.target.checked)}
  />
  <span className="oc-chat__md-toggle-slider" />
  <span className="oc-chat__md-toggle-label">MD</span>
</label>
```

4. `handleSubmit` を修正してコンテキストプレフィックスを付与:
```typescript
const handleSubmit = useCallback(() => {
  if (!input.trim() || loading) return;

  let textToSend = input.trim();
  let agent: string | undefined;

  // Only use agent override when the @agent prefix is still present
  if (agentOverrideRef.current && textToSend.startsWith(`@${agentOverrideRef.current}`)) {
    agent = agentOverrideRef.current;
    textToSend = textToSend.slice(`@${agent}`.length).trim();
  }

  agentOverrideRef.current = null;
  if (!textToSend) return;

  // MD Context prefix
  if (useMdContext) {
    const ctx = useEditorContextStore.getState();
    if (ctx.filePath) {
      let prefix = `以下のMarkdownファイルについて指示があります。\n\nファイル: ${ctx.filePath}\nカーソル位置: 行 ${ctx.cursorLine}, 列 ${ctx.cursorColumn}`;

      if (ctx.selectionStart !== ctx.selectionEnd) {
        const startLC = computeLineColFromContext(ctx.content, ctx.selectionStart);
        const endLC = computeLineColFromContext(ctx.content, ctx.selectionEnd);
        prefix += `\n選択範囲: 行 ${startLC.line} 列 ${startLC.col} 〜 行 ${endLC.line} 列 ${endLC.col}`;
        prefix += `\n\n--- 選択テキスト ---\n${ctx.selectedText}\n--- 選択テキスト終了 ---`;
      }

      textToSend = prefix + `\n\n指示: ${textToSend}`;
    }
  }

  sendMessage(textToSend, agent);
  setInput("");
}, [input, loading, sendMessage, useMdContext]);
```

5. ヘルパー関数を追加（コンポーネント外またはファイル上部）:
```typescript
function computeLineColFromContext(text: string, pos: number) {
  const before = text.substring(0, pos);
  const lines = before.split("\n");
  return { line: lines.length, col: lines[lines.length - 1].length + 1 };
}
```

- [ ] **Step 3: OpencodeChat.css に MD トグルスタイルを追加**

`src/features/opencode-config/components/OpencodeChat.css` の Plan toggle セクション（L154）の直後に追加:

```css
/* MD context toggle */
.oc-chat__md-toggle {
  display: flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
  user-select: none;
}

.oc-chat__md-toggle input {
  display: none;
}

.oc-chat__md-toggle-slider {
  position: relative;
  width: 26px;
  height: 14px;
  background: var(--bg-overlay);
  border: 1px solid var(--border);
  border-radius: 7px;
  transition: background 0.2s;
}

.oc-chat__md-toggle-slider::after {
  content: "";
  position: absolute;
  top: 1px;
  left: 1px;
  width: 10px;
  height: 10px;
  background: var(--text-muted);
  border-radius: 50%;
  transition: transform 0.2s, background 0.2s;
}

.oc-chat__md-toggle input:checked + .oc-chat__md-toggle-slider {
  background: var(--accent-green);
  border-color: var(--accent-green);
}

.oc-chat__md-toggle input:checked + .oc-chat__md-toggle-slider::after {
  transform: translateX(12px);
  background: #fff;
}

.oc-chat__md-toggle-label {
  font-size: 11px;
  color: var(--text-muted);
  font-weight: 600;
}

.oc-chat__md-toggle input:checked ~ .oc-chat__md-toggle-label {
  color: var(--accent-green);
}
```

- [ ] **Step 4: ビルド確認**

Run: `npm run build 2>&1 | head -20`
Expected: ビルドエラーなし

- [ ] **Step 5: 手動動作確認**

`npm run tauri dev` で以下を確認:
1. OpencodeチャットのツールバーにPlanの右隣に「MD」トグルが表示される
2. トグルOFF → 通常のメッセージ送信
3. トグルON → メッセージにファイルパス・カーソル位置がプレフィックスとして付与される
4. テキスト選択中にトグルON → 選択テキストもプレフィックスに含まれる
5. ファイル未開封時はトグルONでもプレフィックスなし

- [ ] **Step 6: コミット**

```bash
git add src/features/opencode-config/components/OpencodeChat.tsx src/features/opencode-config/components/OpencodeChat.css src/shared/i18n/locales/en/opencode-config.json src/shared/i18n/locales/ja/opencode-config.json
git commit -m "feat: add MD context toggle to opencode chat with file/cursor/selection prefix"
```

---

### Task 7: useFileWatcher でファイル変更検知 → エディタ再読み込み

**Files:**
- Modify: `src/app/App.tsx`

- [ ] **Step 1: App.tsx に useFileWatcher を接続**

`src/app/App.tsx` を変更:

1. インポート追加:
```typescript
import { useFileWatcher } from "@/shared/hooks/useFileWatcher";
```

2. `App` コンポーネント内に追加（既存の `useScrollSync` の後あたり）:
```typescript
const updateTabContent = useTabStore((s) => s.updateTabContent);

// Watch active tab file for external changes (e.g., opencode edits)
const activeFilePath = activeTab?.filePath ?? null;
useFileWatcher(activeFilePath, useCallback(async (changedPath: string) => {
  if (!activeTab || activeTab.filePath !== changedPath) return;
  try {
    const newContent = await invoke<string>("read_text_file", { path: changedPath });
    if (newContent !== activeTab.content) {
      updateTabContent(activeTab.id, newContent);
    }
  } catch (e) {
    console.error("Failed to reload file after external change:", e);
  }
}, [activeTab]));
```

注: `updateTabContent` は既に tab-store にある既存メソッド。`read_text_file` は既に `App.tsx:275` で使用されている Tauri コマンド。

- [ ] **Step 2: ビルド確認**

Run: `npm run build 2>&1 | head -20`
Expected: ビルドエラーなし

- [ ] **Step 3: 手動動作確認**

`npm run tauri dev` で以下を確認:
1. MDファイルを開いた状態で、外部エディタ（メモ帳等）でそのファイルを変更
2. mdiumエディタに変更が自動的に反映される

- [ ] **Step 4: コミット**

```bash
git add src/app/App.tsx
git commit -m "feat: watch active file for external changes and reload editor content"
```

---

### Task 8: 最終統合確認

- [ ] **Step 1: フルビルド確認**

Run: `npm run build`
Expected: ビルド成功、エラーなし

- [ ] **Step 2: 全機能の統合テスト**

`npm run tauri dev` で以下の全シナリオを手動確認:

**音声入力（マイクボタン）:**
1. Settings で Speech を有効にしたらマイクボタンがツールバーに表示される
2. マイクボタンクリック → 録音 → 再クリック → 文字起こし → カーソル位置に挿入
3. スペースキー短押し → 通常のスペース入力
4. スペースキー長押し → 録音 → キーを離す → 文字起こし → カーソル位置に挿入

**Opencodeコンテキスト連携:**
5. OpencodeチャットにMDトグルが表示される
6. MDトグルON → メッセージにファイル情報プレフィックスが付与される
7. テキスト選択中 → 選択テキストもプレフィックスに含まれる
8. opencodeがファイルを書き換えた場合 → エディタに自動反映される

- [ ] **Step 3: コミット（必要な場合のみ）**

統合テストで問題が見つかった場合のみ修正コミット。
