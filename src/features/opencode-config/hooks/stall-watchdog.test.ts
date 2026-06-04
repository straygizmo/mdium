import { describe, it, expect } from "vitest";
import {
  evaluateStall,
  STALL_NOTICE_MS,
  STALL_GIVEUP_MS,
} from "./stall-watchdog";

const base = {
  now: 0,
  lastEventAt: 0,
  loading: true,
  aborted: false,
  noticeShown: false,
};

describe("evaluateStall", () => {
  it("returns none when not loading", () => {
    expect(evaluateStall({ ...base, loading: false, now: STALL_GIVEUP_MS + 1 })).toBe("none");
  });

  it("returns none when aborted", () => {
    expect(evaluateStall({ ...base, aborted: true, now: STALL_GIVEUP_MS + 1 })).toBe("none");
  });

  it("returns none just before the notice threshold", () => {
    expect(evaluateStall({ ...base, now: STALL_NOTICE_MS - 1 })).toBe("none");
  });

  it("returns notice at the notice threshold when not yet shown", () => {
    expect(evaluateStall({ ...base, now: STALL_NOTICE_MS })).toBe("notice");
  });

  it("returns none at the notice threshold when already shown", () => {
    expect(evaluateStall({ ...base, now: STALL_NOTICE_MS, noticeShown: true })).toBe("none");
  });

  it("returns none mid-window when notice already shown", () => {
    const mid = Math.floor((STALL_NOTICE_MS + STALL_GIVEUP_MS) / 2);
    expect(evaluateStall({ ...base, now: mid, noticeShown: true })).toBe("none");
  });

  it("returns giveup at the giveup threshold", () => {
    expect(evaluateStall({ ...base, now: STALL_GIVEUP_MS })).toBe("giveup");
  });

  it("returns giveup at the giveup threshold even when notice already shown", () => {
    expect(evaluateStall({ ...base, now: STALL_GIVEUP_MS, noticeShown: true })).toBe("giveup");
  });
});
