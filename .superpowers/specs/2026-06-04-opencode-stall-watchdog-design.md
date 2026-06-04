# opencode チャット ストール・ウォッチドッグ — 設計

- 日付: 2026-06-04
- 対象機能: opencode チャット（`src/features/opencode-config`）
- ステータス: 設計確定（承認済み）

## 背景 / 問題

プロキシ環境かつ UNC パスのフォルダで opencode の RAG エージェントを使うと、エージェントの実行が「途中で」永久にハングする（戻らない）という報告があった。調査の結果、次が判明した。

- ハングは `rag_search` 自体ではなく、その後の `glob`/`read` ツール利用中に発生し、**必ずしも再現しない**。
- 発生時、コンソールに「too many requests」（HTTP 429 = プロバイダのレート制限）が出て待たされる。
- ローカル（C:）では正常、UNC でのみ再現。UNC 上では `glob`/`read` が SMB 経由で遅く、エージェントのターン数・実行時間が伸びるため 429 に当たりやすい、というのが UNC 相関の説明（429 自体は間欠的・環境依存）。

根本原因: mdium は opencode チャットの「待機解除」（`loading: false`）を、opencode から飛んでくる
`session.idle` / `session.error` / `message.updated(error)` の各イベント（および質問検出・Azure 自動継続・送信時の即時エラー）だけに依存している。**タイムアウトもハートビートも無い**。プロバイダが 429 を返して opencode が内部リトライ／待機している間、これらのイベントが一切飛んでこないことがあり、その場合チャットは「Thinking…」のまま永久に固まる。opencode サブプロセスの stdout/stderr は `pty.rs` で破棄されるため、リトライ中ログも mdium には届かない。

429 は間欠的で強制再現できないため、イベントの有無に依存しない**ウォッチドッグ**で対処する。

## ゴール / 非ゴール

ゴール:
- `loading` 中に SSE イベントが一定時間途絶えたことを検知し、ユーザーに状況を提示する。
- 長時間の完全無音時には待機を打ち切り、入力可能状態へ復帰させる（放置しても無限ハングしない）。
- 正常に進行中の処理（巨大コンテキストの初回トークン待ち、UNC 上の遅い `glob`/`read`）を誤って打ち切らない。

非ゴール:
- 429 の `session.error` を即時に正式なレート制限メッセージとして出すための `session.error` の `sessionID` フィルタ（`useOpencodeChat.ts:648` 付近）の見直しは**本スコープ外**（証拠未確定のため。診断ログを残し、再現後に別途判断）。
- opencode 側のリトライ/バックオフ挙動の変更。

## 挙動仕様

しきい値（定数で保持。後から調整可能）:
- `STALL_NOTICE_MS = 60_000`（60 秒）
- `STALL_GIVEUP_MS = 300_000`（5 分）
- `STALL_TICK_MS = 5_000`（ウォッチドッグの確認間隔）

ここでの秒数は「**最後の SSE イベントからの完全無音時間**」。イベントが来るたびにリセットされる。

- 無音 ≥ 60 秒（かつ `loading` 中・未 abort）: ソフト通知を表示（`stallNotice = true`）。
- 無音 ≥ 5 分: ギブアップ。進行中の turn を opencode 側で中断し、`loading` を解除、赤エラーバナーにタイムアウト文言を表示、入力可能へ復帰。
- イベントが来たら `stallNotice` を解除（応答再開で通知は自動的に消える）。

## アーキテクチャ / コンポーネント

すべて `opencode-config` フィーチャ内で完結する。

### 1. 純粋関数（新規モジュール） `src/features/opencode-config/hooks/stall-watchdog.ts`

時間判定をタイマー/ストアから分離し、単体テスト可能にする。

```ts
export type StallAction = "none" | "notice" | "giveup";

export interface StallInput {
  now: number;
  lastEventAt: number;
  loading: boolean;
  aborted: boolean;
  noticeShown: boolean;
}

export const STALL_NOTICE_MS = 60_000;
export const STALL_GIVEUP_MS = 300_000;
export const STALL_TICK_MS = 5_000;

export function evaluateStall(input: StallInput): StallAction;
```

判定ロジック:
- `!loading || aborted` → `"none"`
- `silence = now - lastEventAt`
- `silence >= STALL_GIVEUP_MS` → `"giveup"`
- `silence >= STALL_NOTICE_MS && !noticeShown` → `"notice"`
- それ以外 → `"none"`

（`notice` は未表示時のみ返し、表示済みなら `none`。これにより毎 tick の重複 setState を避ける。）

### 2. ストア（`useChatUIStore`、`useOpencodeChat.ts`）

- 新規フィールド `stallNotice: boolean`（既定 `false`）。
- 既存の初期化／リセット箇所（接続初期化、`doSendMessage`/`doExecuteCommand` の送信時 setState、abort）で `stallNotice: false` を併せて設定。

### 3. ウォッチドッグ（モジュールレベル、`useOpencodeChat.ts`）

- `let _lastEventAt = 0;` と `let _watchdogTimer: ReturnType<typeof setInterval> | null = null;`
- `startWatchdog()`: 送信で `loading: true` にする箇所（`doSendMessage` / `doExecuteCommand`）で呼ぶ。`_lastEventAt = Date.now()`、既存タイマーがあれば消してから `setInterval(tick, STALL_TICK_MS)`。
- `stopWatchdog()`: タイマーを `clearInterval` して `null`。
- `tick()`:
  - ストアから `loading` / `aborted` / `stallNotice` を読み、`evaluateStall({ now: Date.now(), lastEventAt: _lastEventAt, ... })` を呼ぶ。
  - `"notice"` → `useChatUIStore.setState({ stallNotice: true })`。
  - `"giveup"` → `triggerStallGiveup()` を呼び、`stopWatchdog()`。
  - `loading` が false なら `stopWatchdog()`（自己停止）。
- SSE ループ先頭（現行 `[opencode][diag]` ログの隣）で毎イベント:
  - `_lastEventAt = Date.now();`
  - `if (useChatUIStore.getState().stallNotice) useChatUIStore.setState({ stallNotice: false });`

`triggerStallGiveup()`:
- 既存の abort 経路を再利用して進行中の turn を opencode 側で停止する（`_client?.session.abort({ path: { id: _currentSessionId } })`、best-effort / try-catch）。
- ストアを更新: `aborted: true`（中断後に飛ぶ `session.idle` の通常完了処理を抑止するため）、`loading: false`、`stallNotice: false`、`pendingQuestions: null`、`error: <タイムアウト文言>`。末尾が空のアシスタントプレースホルダなら除去する（`applySessionError` と同様）。
- 注: `aborted: true` はユーザー abort と違いバナー抑止には影響しない（バナーは `error` フィールドの有無のみで描画されるため、`error` を明示設定すれば表示される）。

### 4. UI（`OpencodeChat.tsx` / `OpencodeChat.css`）

- `loading && stallNotice` のとき、「Thinking…」インジケータ付近に控えめな情報色の通知を表示。赤エラーバナー（`oc-chat__error`）とは別クラス `oc-chat__stall`（情報色: 黄系/グレー、非エラー）。
- 文言は i18n（`t("ocChatStalled")`）。
- ギブアップ時は既存の `oc-chat__error` バナーに `error`（= `ocChatErrorTimeout`）が出る（追加 UI 不要）。

### 5. i18n（`src/shared/i18n/locales/{en,ja}/opencode-config.json`）

新規キー:
- `ocChatStalled`
  - ja: 「応答が滞っています。レート制限の可能性があります。待機を続けています…」
  - en: "Waiting for a response… The provider may be rate-limiting. Still waiting…"
- `ocChatErrorTimeout`
  - ja: 「応答がありませんでした（タイムアウト）。しばらく待ってから再試行してください。」
  - en: "No response (timed out). Please wait a moment and try again."

## エッジケース

- ユーザー停止: `aborted` または `loading:false` で `evaluateStall` は `"none"`。通知もギブアップも発火しない。`doAbortSession` で `stallNotice:false` もリセット。
- 質問待ち（QuestionsCard 表示）: 表示時は `loading:false` のためウォッチドッグ非作動 → 誤発火しない。
- Azure 自動継続（`続けてください`）: `loading` を一旦 false にして再送 → `startWatchdog` で `_lastEventAt` リセット。
- ストール中の新規送信: 送信時 setState で `stallNotice:false`＋`startWatchdog` でリセット。
- 進行中の遅い処理: reasoning/部分テキスト/tool 状態更新のイベントが来るたび `_lastEventAt` がリセットされるため誤打ち切りしない。
- 切断/再接続: `stopWatchdog` を切断・アンマウント経路で確実に呼ぶ。

## テスト（vitest）

- `src/features/opencode-config/hooks/stall-watchdog.test.ts`
  - `loading:false` → `"none"`
  - `aborted:true` → `"none"`
  - `silence` 59,999ms → `"none"`、60,000ms かつ `noticeShown:false` → `"notice"`、`noticeShown:true` → `"none"`
  - `silence` 299,999ms → `"notice"/"none"` 相当、300,000ms → `"giveup"`（`noticeShown` の真偽に関わらず giveup 優先）

## 既存コードへの影響 / 留意

- `[opencode][diag]` 一時診断ログは**本スコープでは残す**（証拠採取は別件、原因確定後に削除）。
- 変更は `opencode-config` フィーチャ内に限定。`session.error` フィルタやプロキシ/UNC の I/O 経路には触れない。
- UI 文言はハードコードせず必ず i18n を使う（プロジェクト規約）。
