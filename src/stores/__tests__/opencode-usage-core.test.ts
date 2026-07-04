import { describe, it, expect } from "vitest";
import {
  RETENTION_DAYS,
  applyUsageRecord,
  emptyTotals,
  localDayKey,
  retentionCutoffDayKey,
  sanitizePersistedDays,
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

  it("moves a message's contribution to the new day when re-applied after rollover", () => {
    let s = applyUsageRecord(emptyState(), rec(), "2026-07-03");
    s = applyUsageRecord(
      s,
      rec({ cost: 0.02, tokens: { input: 200 } }),
      "2026-07-04",
    );
    expect(s.days["2026-07-03"].total.input).toBe(0);
    expect(s.days["2026-07-03"].total.cost).toBe(0);
    expect(s.days["2026-07-04"].total.input).toBe(200);
    expect(s.sessions["ses1"].input).toBe(200);
    expect(s.messageContrib["msg1"].date).toBe("2026-07-04");
  });
});

describe("sanitizePersistedDays", () => {
  it("returns {} for null/array/non-object input", () => {
    expect(sanitizePersistedDays(null)).toEqual({});
    expect(sanitizePersistedDays([1, 2])).toEqual({});
    expect(sanitizePersistedDays("junk")).toEqual({});
  });

  it("drops malformed entries and keeps valid ones", () => {
    const valid = { total: emptyTotals(), byModel: {} };
    const result = sanitizePersistedDays({
      "2026-07-01": valid,
      "2026-07-02": null,
      "2026-07-03": { total: null, byModel: {} },
      "2026-07-04": { total: emptyTotals() },
    });
    expect(Object.keys(result)).toEqual(["2026-07-01"]);
  });
});

describe("retentionCutoffDayKey", () => {
  it("returns the oldest kept day (today minus 29 days)", () => {
    expect(retentionCutoffDayKey("2026-07-04")).toBe("2026-06-05");
    // 2026 is not a leap year (Feb has 28 days), so 2026-03-01 minus 29 days
    // is 2026-01-31 (verified against the same shiftDayKey logic already
    // exercised by the "prunes day buckets older than RETENTION_DAYS" test).
    expect(retentionCutoffDayKey("2026-03-01")).toBe("2026-01-31");
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
