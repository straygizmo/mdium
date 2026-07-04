# opencode 使用量（トークン・コスト）表示 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** opencode チャットのツールバーに現在セッションのコスト/トークンを表示し、クリックで日別（30日・モデル別内訳付き）の使用量ポップオーバーを開けるようにする。

**Architecture:** opencode の SSE イベント `message.updated` が既に運んでいる `cost`/`tokens` を `useOpencodeChat.ts` で拾い、純粋関数コア（`opencode-usage-core.ts`）で「日×モデル」「セッション」バケットに upsert 集計し、Zustand + persist（localStorage）で日別分のみ永続化する。UI は新規コンポーネント `OpencodeUsagePopover` をツールバーに挿す。Rust 側変更はゼロ。

**Tech Stack:** React 19 + TypeScript, Zustand (persist), Vitest, i18next（namespace: `opencode-config`）

**Spec:** `.superpowers/specs/2026-07-04-opencode-usage-display-design.md`

## Global Constraints

- UI 文字列のハードコード禁止。すべて `src/shared/i18n/locales/{en,ja}/opencode-config.json` に追加して `useTranslation("opencode-config")` で参照する（CLAUDE.md）。
- コード内コメントはすべて英語（CLAUDE.md）。
- localStorage キーは `mdium-opencode-usage`。永続化するのは `days`（日別集計）のみ。
- 日別集計の保持期間は 30 日（`RETENTION_DAYS = 30`）。
- 集計処理は try/catch で包み、チャット本体（SSE 処理）を絶対に壊さない。
- Rust（`src-tauri/`）は変更しない。
- テスト実行コマンド: `npm test`（= `vitest run`）。型チェック: `npx tsc --noEmit`。

---

### Task 1: 使用量集計コア（純粋関数）＋ Zustand ストア

**Files:**
- Create: `src/stores/opencode-usage-core.ts`
- Create: `src/stores/__tests__/opencode-usage-core.test.ts`
- Create: `src/stores/opencode-usage-store.ts`

**Interfaces:**
- Consumes: なし（依存ゼロの純粋関数モジュール＋zustand）
- Produces:
  - `opencode-usage-core.ts`: `UsageTotals`, `DailyUsage`, `UsageRecord`, `MessageContrib`, `UsageAggregateState` 型、`RETENTION_DAYS: number`, `emptyTotals(): UsageTotals`, `addTotals(a, b): UsageTotals`, `tokenSum(t: UsageTotals): number`, `localDayKey(d: Date): string`, `applyUsageRecord(state: UsageAggregateState, rec: UsageRecord, today: string): UsageAggregateState`, `sessionTotalsFromMessageInfos(infos): UsageTotals`
  - `opencode-usage-store.ts`: `useOpencodeUsageStore`（state: `days`, `sessions`, `messageContrib`; actions: `recordUsage(rec: UsageRecord): void`, `setSessionTotals(sessionID: string, totals: UsageTotals): void`）

- [ ] **Step 1: 失敗するテストを書く**

`src/stores/__tests__/opencode-usage-core.test.ts` を以下の内容で作成:

```ts
import { describe, it, expect } from "vitest";
import {
  RETENTION_DAYS,
  applyUsageRecord,
  emptyTotals,
  localDayKey,
  sessionTotalsFromMessageInfos,
  tokenSum,
  type UsageAggregateState,
  type UsageRecord,
} from "../opencode-usage-core";

const TODAY = "2026-07-04";

function rec(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    messageID: "msg1",
    sessionID: "ses1",
    providerID: "anthropic",
    modelID: "claude-sonnet-5",
    cost: 0.01,
    tokens: { input: 100, output: 50, reasoning: 10, cache: { read: 5, write: 2 } },
    ...overrides,
  };
}

function emptyState(): UsageAggregateState {
  return { days: {}, sessions: {}, messageContrib: {} };
}

describe("localDayKey", () => {
  it("formats a local date as zero-padded YYYY-MM-DD", () => {
    expect(localDayKey(new Date(2026, 0, 5))).toBe("2026-01-05");
    expect(localDayKey(new Date(2026, 11, 31))).toBe("2026-12-31");
  });
});

describe("applyUsageRecord", () => {
  it("records a new message into day, model and session buckets", () => {
    const next = applyUsageRecord(emptyState(), rec(), TODAY);
    expect(next.days[TODAY].total).toEqual({
      cost: 0.01, input: 100, output: 50, reasoning: 10, cacheRead: 5, cacheWrite: 2,
    });
    expect(next.days[TODAY].byModel["anthropic/claude-sonnet-5"].input).toBe(100);
    expect(next.sessions["ses1"].output).toBe(50);
    expect(next.messageContrib["msg1"].date).toBe(TODAY);
  });

  it("upserts: re-applying the same messageID keeps only the latest values", () => {
    let s = applyUsageRecord(emptyState(), rec(), TODAY);
    s = applyUsageRecord(
      s,
      rec({ cost: 0.03, tokens: { input: 300, output: 150, reasoning: 30, cache: { read: 15, write: 6 } } }),
      TODAY,
    );
    expect(s.days[TODAY].total.input).toBe(300);
    expect(s.days[TODAY].total.cost).toBeCloseTo(0.03);
    expect(s.days[TODAY].byModel["anthropic/claude-sonnet-5"].output).toBe(150);
    expect(s.sessions["ses1"].input).toBe(300);
  });

  it("accumulates different messages", () => {
    let s = applyUsageRecord(emptyState(), rec(), TODAY);
    s = applyUsageRecord(s, rec({ messageID: "msg2" }), TODAY);
    expect(s.days[TODAY].total.input).toBe(200);
    expect(s.sessions["ses1"].input).toBe(200);
  });

  it("prunes day buckets older than RETENTION_DAYS", () => {
    const s = emptyState();
    // 2026-07-04 minus 29 days = 2026-06-05 (oldest kept day)
    s.days["2026-06-05"] = { total: emptyTotals(), byModel: {} };
    s.days["2026-06-04"] = { total: emptyTotals(), byModel: {} };
    const next = applyUsageRecord(s, rec(), TODAY);
    expect(next.days["2026-06-05"]).toBeDefined();
    expect(next.days["2026-06-04"]).toBeUndefined();
    expect(RETENTION_DAYS).toBe(30);
  });

  it("prunes messageContrib entries older than yesterday", () => {
    const s = emptyState();
    s.messageContrib["old"] = {
      date: "2026-07-01", model: "m", sessionID: "s",
      cost: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0,
    };
    s.messageContrib["yesterday"] = {
      date: "2026-07-03", model: "m", sessionID: "s",
      cost: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0,
    };
    const next = applyUsageRecord(s, rec(), TODAY);
    expect(next.messageContrib["old"]).toBeUndefined();
    expect(next.messageContrib["yesterday"]).toBeDefined();
  });

  it("records zero-cost messages (tokens only)", () => {
    const next = applyUsageRecord(emptyState(), rec({ cost: 0 }), TODAY);
    expect(next.days[TODAY].total.cost).toBe(0);
    expect(next.days[TODAY].total.input).toBe(100);
  });

  it("ignores records without messageID or tokens", () => {
    const s = emptyState();
    expect(applyUsageRecord(s, rec({ messageID: "" }), TODAY)).toBe(s);
    expect(applyUsageRecord(s, rec({ tokens: undefined as any }), TODAY)).toBe(s);
  });

  it("treats missing/non-finite numeric fields as 0", () => {
    const next = applyUsageRecord(
      emptyState(),
      rec({ cost: NaN as any, tokens: { input: 100 } }),
      TODAY,
    );
    expect(next.days[TODAY].total.cost).toBe(0);
    expect(next.days[TODAY].total.output).toBe(0);
    expect(next.days[TODAY].total.input).toBe(100);
  });
});

describe("tokenSum", () => {
  it("sums all token categories", () => {
    expect(
      tokenSum({ cost: 9, input: 1, output: 2, reasoning: 3, cacheRead: 4, cacheWrite: 5 }),
    ).toBe(15);
  });
});

describe("sessionTotalsFromMessageInfos", () => {
  it("sums assistant messages only and ignores others", () => {
    const totals = sessionTotalsFromMessageInfos([
      { role: "user" },
      { role: "assistant", cost: 0.01, tokens: { input: 10, output: 5 } },
      { role: "assistant", cost: 0.02, tokens: { input: 20, output: 10, cache: { read: 3 } } },
      null,
      { role: "assistant" }, // no tokens -> ignored
    ]);
    expect(totals.cost).toBeCloseTo(0.03);
    expect(totals.input).toBe(30);
    expect(totals.output).toBe(15);
    expect(totals.cacheRead).toBe(3);
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `npm test -- src/stores/__tests__/opencode-usage-core.test.ts`
Expected: FAIL（`Cannot find module '../opencode-usage-core'` 等の解決エラー）

- [ ] **Step 3: コアを実装**

`src/stores/opencode-usage-core.ts` を以下の内容で作成:

```ts
// Pure aggregation logic for opencode usage accounting (tokens/cost).
// Kept free of zustand/localStorage/Date.now so it can be unit-tested
// deterministically; the store wrapper supplies the current day key.

export interface UsageTotals {
  cost: number; // USD, as reported by opencode
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

export interface MessageContrib extends UsageTotals {
  date: string; // day bucket this message was counted into
  model: string;
  sessionID: string;
}

export interface UsageRecord {
  messageID: string;
  sessionID: string;
  providerID: string;
  modelID: string;
  cost: number;
  tokens: {
    input?: number;
    output?: number;
    reasoning?: number;
    cache?: { read?: number; write?: number };
  };
}

export interface UsageAggregateState {
  days: Record<string, DailyUsage>; // key = "YYYY-MM-DD" (local time)
  sessions: Record<string, UsageTotals>;
  messageContrib: Record<string, MessageContrib>;
}

export const RETENTION_DAYS = 30;

export function emptyTotals(): UsageTotals {
  return { cost: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
}

function safeNum(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

export function addTotals(a: UsageTotals, b: UsageTotals): UsageTotals {
  return {
    cost: a.cost + b.cost,
    input: a.input + b.input,
    output: a.output + b.output,
    reasoning: a.reasoning + b.reasoning,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
  };
}

// Clamp at 0 so floating-point residue can never show up as a negative total.
function subTotals(a: UsageTotals, b: UsageTotals): UsageTotals {
  return {
    cost: Math.max(0, a.cost - b.cost),
    input: Math.max(0, a.input - b.input),
    output: Math.max(0, a.output - b.output),
    reasoning: Math.max(0, a.reasoning - b.reasoning),
    cacheRead: Math.max(0, a.cacheRead - b.cacheRead),
    cacheWrite: Math.max(0, a.cacheWrite - b.cacheWrite),
  };
}

export function tokenSum(t: UsageTotals): number {
  return t.input + t.output + t.reasoning + t.cacheRead + t.cacheWrite;
}

export function localDayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function shiftDayKey(day: string, deltaDays: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return localDayKey(new Date(y, m - 1, d + deltaDays));
}

function totalsFromRecord(rec: Pick<UsageRecord, "cost" | "tokens">): UsageTotals {
  const t = rec.tokens ?? {};
  return {
    cost: safeNum(rec.cost),
    input: safeNum(t.input),
    output: safeNum(t.output),
    reasoning: safeNum(t.reasoning),
    cacheRead: safeNum(t.cache?.read),
    cacheWrite: safeNum(t.cache?.write),
  };
}

export function applyUsageRecord(
  state: UsageAggregateState,
  rec: UsageRecord,
  today: string,
): UsageAggregateState {
  if (!rec.messageID || !rec.tokens || typeof rec.tokens !== "object") {
    return state;
  }
  const model = `${rec.providerID}/${rec.modelID}`;
  const totals = totalsFromRecord(rec);

  const days: Record<string, DailyUsage> = { ...state.days };
  const sessions: Record<string, UsageTotals> = { ...state.sessions };
  const messageContrib: Record<string, MessageContrib> = { ...state.messageContrib };

  // Upsert: remove this message's previous contribution before re-adding,
  // so repeated message.updated events during streaming never double count.
  const prev = messageContrib[rec.messageID];
  if (prev) {
    const prevDay = days[prev.date];
    if (prevDay) {
      const byModel = { ...prevDay.byModel };
      if (byModel[prev.model]) {
        byModel[prev.model] = subTotals(byModel[prev.model], prev);
      }
      days[prev.date] = { total: subTotals(prevDay.total, prev), byModel };
    }
    if (sessions[prev.sessionID]) {
      sessions[prev.sessionID] = subTotals(sessions[prev.sessionID], prev);
    }
  }

  const day = days[today] ?? { total: emptyTotals(), byModel: {} };
  days[today] = {
    total: addTotals(day.total, totals),
    byModel: {
      ...day.byModel,
      [model]: addTotals(day.byModel[model] ?? emptyTotals(), totals),
    },
  };
  sessions[rec.sessionID] = addTotals(sessions[rec.sessionID] ?? emptyTotals(), totals);
  messageContrib[rec.messageID] = { date: today, model, sessionID: rec.sessionID, ...totals };

  // Retention: keep only the trailing RETENTION_DAYS of daily buckets.
  const dayCutoff = shiftDayKey(today, -(RETENTION_DAYS - 1));
  for (const key of Object.keys(days)) {
    if (key < dayCutoff) delete days[key];
  }
  // messageContrib only needs to survive an in-flight stream:
  // keep today's and yesterday's entries.
  const contribCutoff = shiftDayKey(today, -1);
  for (const [id, c] of Object.entries(messageContrib)) {
    if (c.date < contribCutoff) delete messageContrib[id];
  }

  return { days, sessions, messageContrib };
}

// Rebuild a session's totals from a loaded message list (history restore).
export function sessionTotalsFromMessageInfos(
  infos: Array<
    { role?: string; cost?: number; tokens?: UsageRecord["tokens"] } | null | undefined
  >,
): UsageTotals {
  let acc = emptyTotals();
  for (const info of infos) {
    if (!info || info.role !== "assistant" || !info.tokens) continue;
    acc = addTotals(acc, totalsFromRecord({ cost: info.cost ?? 0, tokens: info.tokens }));
  }
  return acc;
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npm test -- src/stores/__tests__/opencode-usage-core.test.ts`
Expected: PASS（全テスト green）

- [ ] **Step 5: Zustand ストアラッパーを作成**

`src/stores/opencode-usage-store.ts` を以下の内容で作成（薄いラッパーなので単体テストなし。既存 `opencode-server-store.ts` と同パターン）:

```ts
import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  applyUsageRecord,
  localDayKey,
  type DailyUsage,
  type MessageContrib,
  type UsageRecord,
  type UsageTotals,
} from "./opencode-usage-core";

interface OpencodeUsageState {
  /** Daily aggregates, key = "YYYY-MM-DD" (local time). Persisted. */
  days: Record<string, DailyUsage>;
  /** Per-session running totals. In-memory only. */
  sessions: Record<string, UsageTotals>;
  /** Last counted contribution per messageID (upsert dedup). In-memory only. */
  messageContrib: Record<string, MessageContrib>;

  /** Record (or re-record) an assistant message's usage. */
  recordUsage: (rec: UsageRecord) => void;

  /** Replace a session's totals (used when restoring a session from history). */
  setSessionTotals: (sessionID: string, totals: UsageTotals) => void;
}

export const useOpencodeUsageStore = create<OpencodeUsageState>()(
  persist(
    (set, get) => ({
      days: {},
      sessions: {},
      messageContrib: {},

      recordUsage: (rec: UsageRecord) => {
        const { days, sessions, messageContrib } = get();
        const next = applyUsageRecord(
          { days, sessions, messageContrib },
          rec,
          localDayKey(new Date()),
        );
        set(next);
      },

      setSessionTotals: (sessionID: string, totals: UsageTotals) => {
        set((s) => ({ sessions: { ...s.sessions, [sessionID]: totals } }));
      },
    }),
    {
      name: "mdium-opencode-usage",
      // Only daily aggregates persist; session totals and per-message
      // contributions are rebuilt at runtime.
      partialize: (s) => ({ days: s.days }),
    },
  ),
);
```

- [ ] **Step 6: 型チェックと全テスト**

Run: `npx tsc --noEmit`
Expected: エラーなし
Run: `npm test`
Expected: 既存テスト含め全 PASS

- [ ] **Step 7: コミット**

```bash
git add src/stores/opencode-usage-core.ts src/stores/opencode-usage-store.ts src/stores/__tests__/opencode-usage-core.test.ts
git commit -m "feat(usage): add opencode usage aggregation core and store"
```

---

### Task 2: 表示フォーマットヘルパー

**Files:**
- Create: `src/features/opencode-config/lib/usage-format.ts`
- Test: `src/features/opencode-config/lib/__tests__/usage-format.test.ts`

**Interfaces:**
- Consumes: なし
- Produces: `formatUsageCost(cost: number): string`（例 `$0.0423`）, `formatTokenCount(n: number): string`（例 `12.3k`, `1.2M`）

- [ ] **Step 1: 失敗するテストを書く**

`src/features/opencode-config/lib/__tests__/usage-format.test.ts` を作成:

```ts
import { describe, it, expect } from "vitest";
import { formatTokenCount, formatUsageCost } from "../usage-format";

describe("formatUsageCost", () => {
  it("formats small costs with 3 significant digits", () => {
    expect(formatUsageCost(0.0423)).toBe("$0.0423");
    expect(formatUsageCost(0.001234)).toBe("$0.00123");
  });
  it("formats larger costs", () => {
    expect(formatUsageCost(1.5)).toBe("$1.5");
    expect(formatUsageCost(12.34)).toBe("$12.3");
  });
  it("formats zero", () => {
    expect(formatUsageCost(0)).toBe("$0");
  });
});

describe("formatTokenCount", () => {
  it("shows small counts as-is", () => {
    expect(formatTokenCount(0)).toBe("0");
    expect(formatTokenCount(999)).toBe("999");
  });
  it("abbreviates thousands", () => {
    expect(formatTokenCount(12_345)).toBe("12.3k");
    expect(formatTokenCount(1_000)).toBe("1.0k");
  });
  it("abbreviates millions", () => {
    expect(formatTokenCount(2_500_000)).toBe("2.5M");
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `npm test -- src/features/opencode-config/lib/__tests__/usage-format.test.ts`
Expected: FAIL（モジュール解決エラー）

- [ ] **Step 3: 実装**

`src/features/opencode-config/lib/usage-format.ts` を作成:

```ts
// Compact display formatting for the usage readout. Locale is fixed to
// en-US so "$0.0423" / "12.3k" render identically for every UI language.

const COST_FORMAT = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumSignificantDigits: 3,
});

export function formatUsageCost(cost: number): string {
  return COST_FORMAT.format(cost);
}

export function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npm test -- src/features/opencode-config/lib/__tests__/usage-format.test.ts`
Expected: PASS（`Intl` の丸めが期待値とずれる場合はテスト期待値を実挙動へ合わせて修正してよいが、`$` 記号と有効数字 3 桁の方針は維持すること）

- [ ] **Step 5: コミット**

```bash
git add src/features/opencode-config/lib/usage-format.ts src/features/opencode-config/lib/__tests__/usage-format.test.ts
git commit -m "feat(usage): add cost/token display formatters"
```

---

### Task 3: SSE イベントからの計上＋履歴ロード時のセッション累計復元

**Files:**
- Modify: `src/features/opencode-config/hooks/useOpencodeChat.ts`（`message.updated` ハンドラ 840 行付近、`doLoadSession` 1504 行付近、import 追加）

**Interfaces:**
- Consumes: `useOpencodeUsageStore.getState().recordUsage(rec)` / `.setSessionTotals(id, totals)`（Task 1）、`sessionTotalsFromMessageInfos(infos)`（Task 1）
- Produces: なし（副作用のみ。以後 SSE 受信で使用量ストアが更新される）

- [ ] **Step 1: import を追加**

`useOpencodeChat.ts` の既存 import 群（ファイル先頭）に追加。パス表記はファイル内の既存 store import（`opencode-server-store`）と同スタイルに合わせること:

```ts
import { useOpencodeUsageStore } from "../../../stores/opencode-usage-store";
import { sessionTotalsFromMessageInfos } from "../../../stores/opencode-usage-core";
```

- [ ] **Step 2: `message.updated` ハンドラに計上処理を挿入**

`useOpencodeChat.ts` 840 行付近。**現在セッションのフィルタ（`msgInfo.sessionID === _currentSessionId`）より前**に入れる。既存コード:

```ts
        } else if (ev.type === "message.updated") {
          // Completion (loading: false) is handled exclusively by session.idle
          // to avoid premature "Done" toast when intermediate messages complete
          // before the full agent loop finishes.
          //
          // However, populate assistant message content from message.updated in
          // case message.part.updated events were not fired (e.g. LLM refusal
          // or very short responses).
          const msgInfo = (ev.properties as any).info;
          if (
```

これを次のように変更（`const msgInfo` 行の直後に try/catch ブロックを挿入）:

```ts
        } else if (ev.type === "message.updated") {
          // Completion (loading: false) is handled exclusively by session.idle
          // to avoid premature "Done" toast when intermediate messages complete
          // before the full agent loop finishes.
          //
          // However, populate assistant message content from message.updated in
          // case message.part.updated events were not fired (e.g. LLM refusal
          // or very short responses).
          const msgInfo = (ev.properties as any).info;
          // Usage accounting: record cost/tokens for ANY assistant message on
          // this stream (not only the displayed session) so background
          // sessions are counted too. Guarded so a usage bug can never break
          // chat handling. Repeated events for the same message are deduped
          // by upsert inside recordUsage.
          try {
            if (msgInfo && msgInfo.role === "assistant" && msgInfo.id && msgInfo.tokens) {
              useOpencodeUsageStore.getState().recordUsage({
                messageID: msgInfo.id,
                sessionID: msgInfo.sessionID ?? "",
                providerID: msgInfo.providerID ?? "unknown",
                modelID: msgInfo.modelID ?? "unknown",
                cost: msgInfo.cost ?? 0,
                tokens: msgInfo.tokens,
              });
            }
          } catch (e) {
            console.warn("[opencode][usage] recordUsage failed:", e);
          }
          if (
```

- [ ] **Step 3: `doLoadSession` にセッション累計の復元を追加**

`doLoadSession`（1504 行付近）で `msgArray` を組み立てた直後（`const msgArray = Array.isArray(raw) ? raw : [];` の後）に挿入:

```ts
      // Rebuild this session's usage totals for the toolbar readout.
      // Daily aggregates are NOT touched here — they accumulate from live
      // events only, so reloading history never double counts.
      try {
        useOpencodeUsageStore
          .getState()
          .setSessionTotals(
            sessionId,
            sessionTotalsFromMessageInfos(msgArray.map((m: any) => m.info ?? m)),
          );
      } catch (e) {
        console.warn("[opencode][usage] session totals rebuild failed:", e);
      }
```

- [ ] **Step 4: 型チェックと全テスト**

Run: `npx tsc --noEmit`
Expected: エラーなし
Run: `npm test`
Expected: 全 PASS

- [ ] **Step 5: コミット**

```bash
git add src/features/opencode-config/hooks/useOpencodeChat.ts
git commit -m "feat(usage): record opencode usage from message.updated events"
```

---

### Task 4: UI — ツールバー表示＋ポップオーバー（i18n・CSS 込み）

**Files:**
- Create: `src/features/opencode-config/components/OpencodeUsagePopover.tsx`
- Modify: `src/features/opencode-config/components/OpencodeChat.tsx`（import 追加＋接続バッジ直後、437-445 行付近）
- Modify: `src/features/opencode-config/components/OpencodeChat.css`（末尾に追記）
- Modify: `src/shared/i18n/locales/en/opencode-config.json`
- Modify: `src/shared/i18n/locales/ja/opencode-config.json`

**Interfaces:**
- Consumes: `useOpencodeUsageStore`（Task 1）、`emptyTotals`/`tokenSum`/`localDayKey`/`UsageTotals`（Task 1）、`formatUsageCost`/`formatTokenCount`（Task 2）、`useChatUIStore`（`useOpencodeChat.ts` から export 済み、`currentSessionId` を読む）
- Produces: `OpencodeUsagePopover`（props なしの React コンポーネント）

- [ ] **Step 1: i18n キーを追加**

`src/shared/i18n/locales/en/opencode-config.json` の `"ocChatAutoReplyLabel"` 行の後に追加:

```json
  "ocUsageTitle": "opencode Usage",
  "ocUsageSession": "Current Session",
  "ocUsageToday": "Today",
  "ocUsageLast30Days": "Last 30 Days",
  "ocUsageInput": "Input",
  "ocUsageOutput": "Output",
  "ocUsageReasoning": "Reasoning",
  "ocUsageCacheRead": "Cache Read",
  "ocUsageCacheWrite": "Cache Write",
  "ocUsageCost": "Cost",
  "ocUsageEmpty": "No usage yet",
```

`src/shared/i18n/locales/ja/opencode-config.json` の同じ位置に追加:

```json
  "ocUsageTitle": "opencode 使用量",
  "ocUsageSession": "現在のセッション",
  "ocUsageToday": "今日",
  "ocUsageLast30Days": "過去30日",
  "ocUsageInput": "入力",
  "ocUsageOutput": "出力",
  "ocUsageReasoning": "推論",
  "ocUsageCacheRead": "キャッシュ読取",
  "ocUsageCacheWrite": "キャッシュ書込",
  "ocUsageCost": "コスト",
  "ocUsageEmpty": "使用データはまだありません",
```

- [ ] **Step 2: ポップオーバーコンポーネントを作成**

`src/features/opencode-config/components/OpencodeUsagePopover.tsx` を作成:

```tsx
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useChatUIStore } from "../hooks/useOpencodeChat";
import { useOpencodeUsageStore } from "../../../stores/opencode-usage-store";
import {
  emptyTotals,
  localDayKey,
  tokenSum,
  type UsageTotals,
} from "../../../stores/opencode-usage-core";
import { formatTokenCount, formatUsageCost } from "../lib/usage-format";

function TotalsRows({ totals }: { totals: UsageTotals }) {
  const { t } = useTranslation("opencode-config");
  const rows: Array<[string, string]> = [
    [t("ocUsageInput"), formatTokenCount(totals.input)],
    [t("ocUsageOutput"), formatTokenCount(totals.output)],
    [t("ocUsageReasoning"), formatTokenCount(totals.reasoning)],
    [t("ocUsageCacheRead"), formatTokenCount(totals.cacheRead)],
    [t("ocUsageCacheWrite"), formatTokenCount(totals.cacheWrite)],
    [t("ocUsageCost"), formatUsageCost(totals.cost)],
  ];
  return (
    <div className="oc-chat__usage-rows">
      {rows.map(([label, value]) => (
        <div key={label} className="oc-chat__usage-row">
          <span>{label}</span>
          <span>{value}</span>
        </div>
      ))}
    </div>
  );
}

function ModelBreakdown({ byModel }: { byModel: Record<string, UsageTotals> }) {
  const entries = Object.entries(byModel).sort((a, b) => b[1].cost - a[1].cost);
  return (
    <div className="oc-chat__usage-models">
      {entries.map(([model, totals]) => (
        <div key={model} className="oc-chat__usage-row">
          <span className="oc-chat__usage-model-name" title={model}>
            {model}
          </span>
          <span>
            {formatUsageCost(totals.cost)} · {formatTokenCount(tokenSum(totals))}
          </span>
        </div>
      ))}
    </div>
  );
}

export function OpencodeUsagePopover() {
  const { t } = useTranslation("opencode-config");
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const currentSessionId = useChatUIStore((s) => s.currentSessionId);
  const sessions = useOpencodeUsageStore((s) => s.sessions);
  const days = useOpencodeUsageStore((s) => s.days);

  const sessionTotals =
    (currentSessionId ? sessions[currentSessionId] : undefined) ?? emptyTotals();

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  // Compact toolbar label: cost when known, token count for zero-cost
  // (e.g. subscription-authenticated providers), icon only when unused.
  const label =
    sessionTotals.cost > 0
      ? formatUsageCost(sessionTotals.cost)
      : tokenSum(sessionTotals) > 0
        ? formatTokenCount(tokenSum(sessionTotals))
        : null;

  const todayKey = localDayKey(new Date());
  const today = days[todayKey];
  const dayKeys = Object.keys(days).sort().reverse();
  const sessionHasUsage = sessionTotals.cost > 0 || tokenSum(sessionTotals) > 0;

  return (
    <div className="oc-chat__usage" ref={rootRef}>
      <button
        className="oc-chat__toolbar-btn oc-chat__usage-btn"
        onClick={() => setOpen((v) => !v)}
        title={t("ocUsageTitle")}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="12" y1="2" x2="12" y2="22" />
          <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
        </svg>
        {label && <span className="oc-chat__usage-label">{label}</span>}
      </button>
      {open && (
        <div className="oc-chat__usage-popover">
          <div className="oc-chat__usage-section">
            <div className="oc-chat__usage-heading">{t("ocUsageSession")}</div>
            {sessionHasUsage ? (
              <TotalsRows totals={sessionTotals} />
            ) : (
              <div className="oc-chat__usage-empty">{t("ocUsageEmpty")}</div>
            )}
          </div>
          <div className="oc-chat__usage-section">
            <div className="oc-chat__usage-heading">{t("ocUsageToday")}</div>
            {today ? (
              <>
                <div className="oc-chat__usage-row oc-chat__usage-row--total">
                  <span>{t("ocUsageCost")}</span>
                  <span>
                    {formatUsageCost(today.total.cost)} ·{" "}
                    {formatTokenCount(tokenSum(today.total))}
                  </span>
                </div>
                <ModelBreakdown byModel={today.byModel} />
              </>
            ) : (
              <div className="oc-chat__usage-empty">{t("ocUsageEmpty")}</div>
            )}
          </div>
          <div className="oc-chat__usage-section">
            <div className="oc-chat__usage-heading">{t("ocUsageLast30Days")}</div>
            {dayKeys.length === 0 ? (
              <div className="oc-chat__usage-empty">{t("ocUsageEmpty")}</div>
            ) : (
              dayKeys.map((key) => (
                <details key={key} className="oc-chat__usage-day">
                  <summary className="oc-chat__usage-row">
                    <span>{key}</span>
                    <span>
                      {formatUsageCost(days[key].total.cost)} ·{" "}
                      {formatTokenCount(tokenSum(days[key].total))}
                    </span>
                  </summary>
                  <ModelBreakdown byModel={days[key].byModel} />
                </details>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: ツールバーへ組み込み**

`src/features/opencode-config/components/OpencodeChat.tsx` の先頭 import 群に追加:

```tsx
import { OpencodeUsagePopover } from "./OpencodeUsagePopover";
```

接続バッジ（437-445 行付近）の閉じタグ `</span>` の直後に挿入。既存コード:

```tsx
        <span
          className={`oc-chat__badge oc-chat__badge--${connected ? "connected" : connecting ? "connecting" : "disconnected"}`}
        >
          {connecting
            ? t("ocChatConnecting")
            : connected
              ? t("ocChatConnected")
              : t("ocChatDisconnected")}
        </span>
        <button
```

変更後:

```tsx
        <span
          className={`oc-chat__badge oc-chat__badge--${connected ? "connected" : connecting ? "connecting" : "disconnected"}`}
        >
          {connecting
            ? t("ocChatConnecting")
            : connected
              ? t("ocChatConnected")
              : t("ocChatDisconnected")}
        </span>
        <OpencodeUsagePopover />
        <button
```

- [ ] **Step 4: CSS を追加**

`src/features/opencode-config/components/OpencodeChat.css` の末尾に追記（色は必ずテーマ CSS 変数を使う）:

```css
/* ---- Usage readout (toolbar button + popover) ---- */
.oc-chat__usage {
  position: relative;
  display: inline-flex;
}

.oc-chat__usage-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.oc-chat__usage-label {
  font-size: 11px;
  color: var(--text-secondary);
}

.oc-chat__usage-popover {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  z-index: 30;
  min-width: 260px;
  max-width: 320px;
  max-height: 340px;
  overflow-y: auto;
  padding: 8px;
  background: var(--bg-base);
  border: 1px solid var(--border);
  border-radius: 6px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.25);
}

.oc-chat__usage-section + .oc-chat__usage-section {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--border);
}

.oc-chat__usage-heading {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-muted);
  margin-bottom: 4px;
}

.oc-chat__usage-row {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  font-size: 12px;
  color: var(--text-secondary);
  padding: 1px 0;
}

.oc-chat__usage-row--total {
  font-weight: 600;
}

.oc-chat__usage-model-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 180px;
}

.oc-chat__usage-day summary {
  cursor: pointer;
  list-style: none;
}

.oc-chat__usage-day summary::-webkit-details-marker {
  display: none;
}

.oc-chat__usage-day[open] summary {
  color: var(--text-secondary);
  font-weight: 600;
}

.oc-chat__usage-models {
  padding-left: 8px;
}

.oc-chat__usage-empty {
  font-size: 12px;
  color: var(--text-muted);
}
```

- [ ] **Step 5: 型チェックと全テスト**

Run: `npx tsc --noEmit`
Expected: エラーなし
Run: `npm test`
Expected: 全 PASS

- [ ] **Step 6: コミット**

```bash
git add src/features/opencode-config/components/OpencodeUsagePopover.tsx src/features/opencode-config/components/OpencodeChat.tsx src/features/opencode-config/components/OpencodeChat.css src/shared/i18n/locales/en/opencode-config.json src/shared/i18n/locales/ja/opencode-config.json
git commit -m "feat(usage): add usage readout and popover to opencode chat toolbar"
```

---

### Task 5: 実機検証（手動スモークテスト）

**Files:** 変更なし（検証のみ）

**Interfaces:**
- Consumes: Task 1〜4 のすべて
- Produces: 動作確認済みの機能

- [ ] **Step 1: ビルドが通ることを確認**

Run: `npm run build`
Expected: `tsc && vite build` が成功

- [ ] **Step 2: アプリを起動して実際のチャットで確認**

Run: `npm run tauri dev`（起動に時間がかかる。ユーザーに起動済みアプリでの確認を依頼してもよい）

確認項目:
1. opencode チャットでメッセージを送信 → 応答完了後、ツールバーの接続バッジ隣にコスト（またはトークン数）が表示される。
2. 表示をクリック → ポップオーバーが開き、「現在のセッション」「今日」「過去30日」の3セクションが表示される。今日のセクションにモデル別内訳が出る。
3. もう1往復送信 → 数値が増える（減らない・二重にならない）。
4. ポップオーバーの外側クリックまたは Esc で閉じる。
5. アプリ再起動 → 日別集計（今日の分）が残っている。ツールバーのセッション表示は 0 に戻る（新規セッションのため正常）。
6. 履歴から過去セッションをロード → ツールバーにそのセッションの累計が表示される。
7. ライト/ダークテーマ両方でポップオーバーの配色が破綻しない。

- [ ] **Step 3: 問題があれば修正してコミット、なければ完了**

修正した場合:

```bash
git add -A
git commit -m "fix(usage): address issues found in manual verification"
```
