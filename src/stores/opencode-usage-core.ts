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

// Oldest day key still inside the retention window for the given day.
export function retentionCutoffDayKey(today: string): string {
  return shiftDayKey(today, -(RETENTION_DAYS - 1));
}

// Sanitize a persisted `days` value of unknown shape (localStorage can be
// tampered with or partially written). Keeps only entries that look like
// DailyUsage; anything else is dropped so rehydration can never crash the UI.
export function sanitizePersistedDays(value: unknown): Record<string, DailyUsage> {
  const days: Record<string, DailyUsage> = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return days;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const d = v as DailyUsage | null | undefined;
    if (
      d &&
      typeof d === "object" &&
      d.total &&
      typeof d.total === "object" &&
      d.byModel &&
      typeof d.byModel === "object"
    ) {
      days[k] = d;
    }
  }
  return days;
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
