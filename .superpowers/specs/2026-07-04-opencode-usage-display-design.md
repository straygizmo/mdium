# opencode 使用量（トークン・コスト）表示 — 設計

- 日付: 2026-07-04
- 対象機能: opencode チャット（`src/features/opencode-config`）
- ステータス: 設計確定（承認済み）

## 背景 / 目的

openusage（Go 製 TUI）のように、opencode の使用状況（トークン数・コスト）を mdium の UI で確認できるようにしたい。

調査の結果、opencode の SSE イベント `message.updated` が運ぶ `AssistantMessage` には既に `cost`（USD）と `tokens`（input / output / reasoning / cache.read / cache.write）が含まれており、mdium は現状これを受信しながら破棄している（`useOpencodeChat.ts` の `message.updated` ハンドラ、840 行付近）。したがって新しい通信路・Rust 側変更なしで実装できる。

## ゴール / 非ゴール

ゴール:
- 現在セッションの累計コスト・トークンをチャットのツールバーにリアルタイム表示する。
- mdium 全体（全フォルダ合算）の日別使用量（直近 30 日、モデル別内訳付き）をポップオーバーで確認できる。
- 集計対象は mdium 経由の opencode 使用分のみ。

非ゴール:
- ターミナル等 mdium 外での opencode 使用分の集計（opencode.db の直接読み取りはしない）。
- opencode.ai アカウントの残高・請求情報の表示（非公開 RPC 依存で脆く、保守コストが高いため不採用）。
- トークン単価テーブルによるコスト再計算（opencode が記録した `cost` をそのまま使う。`cost` が 0 のケースはトークン数表示にフォールバック）。

## アーキテクチャ / コンポーネント

Rust 側の変更はゼロ。すべてフロントエンド（`src/stores` + `src/features/opencode-config`）で完結する。

### 1. 使用量ストア（新規） `src/stores/opencode-usage-store.ts`

Zustand + `persist`（localStorage キー `mdium-opencode-usage`）。既存の `opencode-server-store.ts` と同パターン。

```ts
export interface UsageTotals {
  cost: number;       // USD
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface DailyUsage {
  total: UsageTotals;
  byModel: Record<string, UsageTotals>; // key = "providerID/modelID"
}

interface OpencodeUsageState {
  // --- 永続化される部分 ---
  days: Record<string, DailyUsage>; // key = "YYYY-MM-DD"（ローカルタイムゾーン）

  // --- メモリのみ（persist の partialize で除外） ---
  sessions: Record<string, UsageTotals>; // sessionID → セッション累計
  messageContrib: Record<
    string,
    { date: string; model: string } & UsageTotals
  >; // messageID → 直近の計上値（upsert 用）

  recordUsage(args: {
    messageID: string;
    sessionID: string;
    providerID: string;
    modelID: string;
    cost: number;
    tokens: {
      input: number;
      output: number;
      reasoning: number;
      cache: { read: number; write: number };
    };
  }): void;

  setSessionTotals(sessionID: string, totals: UsageTotals): void; // 履歴ロード時の再計算用
}
```

挙動仕様:
- `recordUsage` は upsert 方式: 同じ `messageID` の前回計上値（`messageContrib`）があれば当該日・モデル・セッションのバケットから差し引き、新しい値を加算し直す。ストリーミング中に同一メッセージの `message.updated` が何度も届いても二重計上しない。
- 日付キーは `recordUsage` 呼び出し時点のローカル日付。日をまたぐストリーミングでは upsert により前日分から差し引かれて当日分へ移るが、許容する（実害なし）。
- 保持期間 30 日: `recordUsage` 内で `days` の 30 日より古いキーを削除する。
- `messageContrib` は当日と前日以外のエントリを削除して肥大化を防ぐ（永続化しないため再起動でも消える。再起動後に同一メッセージの再計上は起きない — SSE は生きているストリームのみが対象のため）。
- `sessions` は永続化しない。アプリ再起動後のセッション累計は履歴ロード時の再計算（後述）で復元される。

### 2. イベントフック `useOpencodeChat.ts`

`message.updated` ハンドラ内、**`sessionID === _currentSessionId` フィルタより前**で計上する（バックグラウンドで完了するセッション分も漏らさない）:

```ts
} else if (ev.type === "message.updated") {
  const msgInfo = (ev.properties as any).info;
  // Usage accounting: record for ANY assistant message on this stream,
  // regardless of which session is currently displayed.
  try {
    if (msgInfo?.role === "assistant" && msgInfo.tokens) {
      useOpencodeUsageStore.getState().recordUsage({
        messageID: msgInfo.id,
        sessionID: msgInfo.sessionID,
        providerID: msgInfo.providerID ?? "unknown",
        modelID: msgInfo.modelID ?? "unknown",
        cost: msgInfo.cost ?? 0,
        tokens: msgInfo.tokens,
      });
    }
  } catch (e) {
    console.warn("[opencode][usage] recordUsage failed:", e);
  }
  // ...既存の表示処理はそのまま...
```

- try/catch で包み、使用量集計のバグが SSE 処理（チャット本体）を止めないことを保証する。
- フォルダごとに別サーバー・別 SSE ストリームだが、全ストリームが同一グローバルストアへ書き込むため全フォルダ合算が成立する。

履歴セッションのロード時（既存のセッション復元処理）: 取得したメッセージ一覧の assistant メッセージから `cost`/`tokens` を合算し `setSessionTotals` でセッション累計を復元する（日別集計へは加算しない — 過去分の二重計上を避けるため。日別集計はライブイベントのみから積む）。

### 3. UI（新規コンポーネント） `src/features/opencode-config/components/OpencodeUsagePopover.tsx`

- **ツールバー表示**: `OpencodeChat.tsx` の接続バッジ（437 行付近）の隣にボタンを追加。表示内容は現在セッションの累計:
  - `cost > 0` → `$0.042` 形式（有効数字 3 桁程度、`Intl.NumberFormat` 使用）
  - `cost === 0` かつトークンあり → `12.3k` 形式のトークン合計
  - 未使用（累計なし）→ アイコンのみ
- **ポップオーバー**: ボタンクリックで開閉（外側クリック / Esc で閉じる）。内容は上から:
  1. 現在セッションの内訳（input / output / reasoning / cache read / cache write / コスト）
  2. 今日の合計＋モデル別内訳
  3. 直近 30 日の日別リスト（日付・コスト・トークン合計）。各行は `<details>` で開くとモデル別内訳。
- スタイル: `OpencodeChat.css` に `oc-chat__usage-*` クラスで追加。色はテーマ CSS 変数を使用（直近の replacement パネルと同方針）。

### 4. i18n

すべての表示文字列を `src/shared/i18n/locales/{en,ja}/opencode-config.json` に `ocUsage*` キーで追加（例: `ocUsageTitle`, `ocUsageSession`, `ocUsageToday`, `ocUsageLast30Days`, `ocUsageInput`, `ocUsageOutput`, `ocUsageReasoning`, `ocUsageCacheRead`, `ocUsageCacheWrite`, `ocUsageCost`, `ocUsageTokens`, `ocUsageEmpty`）。ハードコード禁止（CLAUDE.md 準拠）。

## エラー処理

- `msgInfo.tokens` / `cost` が欠落・不正型の場合は計上をスキップ（警告ログのみ）。
- localStorage の永続化失敗（容量超過等）は Zustand persist が握るため、チャット動作には影響しない。
- ポップオーバーはデータ 0 件でも空状態文言（`ocUsageEmpty`）を表示して壊れない。

## テスト

TDD で進める。既存の `src/features/opencode-config/lib/__tests__/` パターン（Vitest）に合わせる。

- ストア単体テスト（`opencode-usage-store` をモジュール分離してテスト可能にする）:
  - 新規メッセージの計上（日別・モデル別・セッション別すべてに反映）
  - 同一 messageID の再計上で二重計上しない（upsert: 差し引き→再加算）
  - 30 日より古い日付のプルーニング
  - `messageContrib` のプルーニング（当日・前日以外を削除）
  - cost=0 メッセージの計上（トークンのみ加算）
  - 不正入力（tokens 欠落）のスキップ
- 表示フォーマット関数（コスト・トークンの整形）の単体テスト。
- UI はコンパイル＋手動確認（既存方針に合わせ、コンポーネントの自動テストは追加しない）。

## 実装ファイル一覧（見込み）

| 種別 | パス |
|---|---|
| 新規 | `src/stores/opencode-usage-store.ts` |
| 新規 | `src/features/opencode-config/components/OpencodeUsagePopover.tsx` |
| 変更 | `src/features/opencode-config/hooks/useOpencodeChat.ts`（recordUsage 呼び出し＋履歴ロード時の再計算） |
| 変更 | `src/features/opencode-config/components/OpencodeChat.tsx`（ツールバーへのボタン追加） |
| 変更 | `src/features/opencode-config/components/OpencodeChat.css`（`oc-chat__usage-*`） |
| 変更 | `src/shared/i18n/locales/en/opencode-config.json` |
| 変更 | `src/shared/i18n/locales/ja/opencode-config.json` |
| 新規 | ストアのユニットテスト |

## 参考（調査メモ）

- openusage は opencode のローカル SQLite（`~/.local/share/opencode/opencode.db`）の message/part テーブルから `cost`/`tokens` を読む。opencode 自身がコストを記録しているため単価計算は不要 — 本設計でも同じ前提（SSE で届く `cost` を信頼する）。
- 残高表示は opencode.ai コンソールの非公開 SolidStart RPC（デプロイごとに関数 ID が変わる）への依存が必要で不採用。
- SDK 型定義: `@opencode-ai/sdk` の `AssistantMessage` に `cost: number` と `tokens: {...}` が正式に定義されている（`dist/gen/types.gen.d.ts`）。
