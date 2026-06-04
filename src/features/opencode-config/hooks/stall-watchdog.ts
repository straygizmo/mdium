/**
 * Pure timing logic for the opencode chat stall watchdog, isolated from timers
 * and the store so it can be unit-tested deterministically.
 *
 * The watchdog measures the gap since the last SSE event while a turn is in
 * flight. After STALL_NOTICE_MS of complete silence it asks the UI to show a
 * soft "still waiting" notice; after STALL_GIVEUP_MS it asks the caller to give
 * up (cancel the turn and unlock input). Any incoming event resets the timer.
 */

export type StallAction = "none" | "notice" | "giveup";

export interface StallInput {
  /** Current time (ms epoch). */
  now: number;
  /** Timestamp (ms epoch) of the most recent SSE event for the active turn. */
  lastEventAt: number;
  /** Whether a turn is currently in flight. */
  loading: boolean;
  /** Whether the user has aborted the turn. */
  aborted: boolean;
  /** Whether the soft notice is already displayed. */
  noticeShown: boolean;
}

/** Silence before showing the soft "still waiting" notice. */
export const STALL_NOTICE_MS = 60_000;
/** Silence before giving up: cancel the turn and unlock input. */
export const STALL_GIVEUP_MS = 300_000;
/** How often the watchdog re-evaluates while a turn is in flight. */
export const STALL_TICK_MS = 5_000;

export function evaluateStall(input: StallInput): StallAction {
  const { now, lastEventAt, loading, aborted, noticeShown } = input;
  if (!loading || aborted) return "none";
  const silence = now - lastEventAt;
  if (silence >= STALL_GIVEUP_MS) return "giveup";
  if (silence >= STALL_NOTICE_MS && !noticeShown) return "notice";
  return "none";
}
