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
