# opencode Stall Watchdog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the opencode chat from hanging forever on "Thinking…" when the provider stalls (e.g. HTTP 429 retry) by adding a watchdog that shows a soft notice after 60s of SSE silence and gives up (cancels the turn, unlocks input) after 5min.

**Architecture:** A pure timing function (`evaluateStall`) decides `none|notice|giveup` from elapsed silence; a module-level `setInterval` in `useOpencodeChat.ts` feeds it the live store state and applies the result. Every incoming SSE event resets the silence timer and clears a shown notice. A new `stallNotice` boolean on the chat store drives a soft inline indicator; give-up reuses the existing `session.abort` path and shows a timeout error banner.

**Tech Stack:** TypeScript, React, Zustand (`useChatUIStore`), i18next, vitest, `@opencode-ai/sdk`.

Spec: `.superpowers/specs/2026-06-04-opencode-stall-watchdog-design.md`

---

## File Structure

- Create: `src/features/opencode-config/hooks/stall-watchdog.ts` — pure timing logic + threshold constants.
- Create: `src/features/opencode-config/hooks/stall-watchdog.test.ts` — vitest unit tests for `evaluateStall`.
- Modify: `src/features/opencode-config/hooks/useOpencodeChat.ts` — `stallNotice` store field, hook exposure, watchdog wiring.
- Modify: `src/features/opencode-config/components/OpencodeChat.tsx` — render the soft notice.
- Modify: `src/features/opencode-config/components/OpencodeChat.css` — `.oc-chat__stall` styling.
- Modify: `src/shared/i18n/locales/en/opencode-config.json` and `src/shared/i18n/locales/ja/opencode-config.json` — `ocChatStalled`, `ocChatErrorTimeout`.

Note: the `[opencode][diag]` temporary log already in `useOpencodeChat.ts` stays for now (separate concern).

---

## Task 1: Pure stall-evaluation function (TDD)

**Files:**
- Create: `src/features/opencode-config/hooks/stall-watchdog.ts`
- Test: `src/features/opencode-config/hooks/stall-watchdog.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/features/opencode-config/hooks/stall-watchdog.test.ts`:

```ts
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

  it("returns giveup at the giveup threshold", () => {
    expect(evaluateStall({ ...base, now: STALL_GIVEUP_MS })).toBe("giveup");
  });

  it("returns giveup at the giveup threshold even when notice already shown", () => {
    expect(evaluateStall({ ...base, now: STALL_GIVEUP_MS, noticeShown: true })).toBe("giveup");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/features/opencode-config/hooks/stall-watchdog.test.ts`
Expected: FAIL — cannot resolve `./stall-watchdog` (module does not exist yet).

- [ ] **Step 3: Write minimal implementation**

Create `src/features/opencode-config/hooks/stall-watchdog.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/features/opencode-config/hooks/stall-watchdog.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/features/opencode-config/hooks/stall-watchdog.ts src/features/opencode-config/hooks/stall-watchdog.test.ts
git commit -m "feat(opencode): add pure evaluateStall timing logic for chat watchdog"
```

---

## Task 2: Add `stallNotice` to store, expose via hook, add i18n keys

**Files:**
- Modify: `src/features/opencode-config/hooks/useOpencodeChat.ts` (interface `OpencodeChatUIState` ~209-225, store defaults ~227-243, `UseOpencodeChatResult` ~55-78, hook destructure ~1268-1280, hook return ~1338-1361)
- Modify: `src/shared/i18n/locales/en/opencode-config.json`
- Modify: `src/shared/i18n/locales/ja/opencode-config.json`

- [ ] **Step 1: Add `stallNotice` to the store state interface**

In `useOpencodeChat.ts`, in `interface OpencodeChatUIState`, after the line `azureAutoRetryCount: number;`:

```ts
  azureAutoRetryCount: number;
  stallNotice: boolean;
```

- [ ] **Step 2: Add `stallNotice` to the store defaults**

In the `useChatUIStore` default object, after `azureAutoRetryCount: 0,`:

```ts
  azureAutoRetryCount: 0,
  stallNotice: false,
```

- [ ] **Step 3: Expose `stallNotice` on the hook result type**

In `interface UseOpencodeChatResult`, after `loading: boolean;`:

```ts
  loading: boolean;
  stallNotice: boolean;
```

- [ ] **Step 4: Read `stallNotice` from the store in the hook**

In `useOpencodeChat`, in the `useChatUIStore()` destructure (~1268-1280), after `loading,`:

```ts
    loading,
    stallNotice,
```

- [ ] **Step 5: Return `stallNotice` from the hook**

In the hook's `return { ... }` (~1338), after `loading,`:

```ts
    loading,
    stallNotice,
```

- [ ] **Step 6: Add English i18n keys**

In `src/shared/i18n/locales/en/opencode-config.json`, after the `"ocChatErrorStatus": "status {{status}}",` line:

```json
  "ocChatErrorStatus": "status {{status}}",
  "ocChatStalled": "Waiting for a response… The provider may be rate-limiting. Still waiting…",
  "ocChatErrorTimeout": "No response (timed out). Please wait a moment and try again.",
```

- [ ] **Step 7: Add Japanese i18n keys**

In `src/shared/i18n/locales/ja/opencode-config.json`, after the `"ocChatErrorStatus"` line (mirror the English placement), add:

```json
  "ocChatStalled": "応答が滞っています。レート制限の可能性があります。待機を続けています…",
  "ocChatErrorTimeout": "応答がありませんでした（タイムアウト）。しばらく待ってから再試行してください。",
```

(Keep valid JSON: ensure the preceding line ends with a comma and these new lines sit before the next key.)

- [ ] **Step 8: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add src/features/opencode-config/hooks/useOpencodeChat.ts src/shared/i18n/locales/en/opencode-config.json src/shared/i18n/locales/ja/opencode-config.json
git commit -m "feat(opencode): add stallNotice chat state and watchdog i18n strings"
```

---

## Task 3: Wire the watchdog into the chat hook

**Files:**
- Modify: `src/features/opencode-config/hooks/useOpencodeChat.ts` (imports top of file; module-level state ~197-206; SSE loop ~395-396; `doSendMessage` ~1019-1032; `doExecuteCommand` ~1114-1123; `doAbortSession` ~1077-1089)

- [ ] **Step 1: Import the watchdog helpers**

At the top of `useOpencodeChat.ts`, add an import alongside the other local imports:

```ts
import { evaluateStall, STALL_TICK_MS } from "./stall-watchdog";
```

- [ ] **Step 2: Add module-level watchdog state**

Near the other module-level `let _...` declarations (around `let _currentSessionId: string | null = null;`), add:

```ts
let _lastEventAt = 0;
let _watchdogTimer: ReturnType<typeof setInterval> | null = null;
```

- [ ] **Step 3: Add the watchdog control + give-up functions**

Add these functions at module scope (e.g. directly above `function processSSEStream(...)`):

```ts
/** Start (or restart) the stall watchdog for a freshly-sent turn. */
function startWatchdog() {
  _lastEventAt = Date.now();
  if (_watchdogTimer) clearInterval(_watchdogTimer);
  _watchdogTimer = setInterval(watchdogTick, STALL_TICK_MS);
}

/** Stop the stall watchdog. */
function stopWatchdog() {
  if (_watchdogTimer) {
    clearInterval(_watchdogTimer);
    _watchdogTimer = null;
  }
}

/** Periodic check: surface a notice, give up, or self-stop. */
function watchdogTick() {
  const s = useChatUIStore.getState();
  if (!s.loading) {
    stopWatchdog();
    return;
  }
  const action = evaluateStall({
    now: Date.now(),
    lastEventAt: _lastEventAt,
    loading: s.loading,
    aborted: s.aborted,
    noticeShown: s.stallNotice,
  });
  if (action === "notice") {
    useChatUIStore.setState({ stallNotice: true });
  } else if (action === "giveup") {
    stopWatchdog();
    void triggerStallGiveup();
  }
}

/**
 * Give up after prolonged silence: cancel the in-flight turn on the opencode
 * side, unlock the UI, and show a timeout error banner. `aborted: true`
 * suppresses normal-completion handling of any session.idle that arrives after
 * the cancel; the banner still renders because `error` is set explicitly.
 */
async function triggerStallGiveup() {
  if (_client && _currentSessionId) {
    try {
      await _client.session.abort({ path: { id: _currentSessionId } });
    } catch (e: any) {
      console.error("[opencode] stall give-up abort failed:", e);
    }
  }
  useChatUIStore.setState((s) => {
    const last = s.messages[s.messages.length - 1];
    const messages =
      last?.role === "assistant" && !last.content && (!last.parts || last.parts.length === 0)
        ? s.messages.slice(0, -1)
        : s.messages;
    return {
      messages,
      loading: false,
      stallNotice: false,
      pendingQuestions: null,
      aborted: true,
      error: i18n.t("ocChatErrorTimeout", { ns: "opencode-config" }),
    };
  });
}
```

- [ ] **Step 4: Reset the silence timer on every SSE event**

In `processSSEStream`, immediately after `const ev = event as OcEvent;` (and before the existing `[opencode][diag]` block), insert:

```ts
        const ev = event as OcEvent;
        // Watchdog: any event proves opencode is alive — reset the silence
        // timer and clear a shown stall notice so the UI recovers on its own.
        _lastEventAt = Date.now();
        if (useChatUIStore.getState().stallNotice) {
          useChatUIStore.setState({ stallNotice: false });
        }
```

- [ ] **Step 5: Start the watchdog when sending a message**

In `doSendMessage`, the `useChatUIStore.setState((s) => ({ ... loading: true, pendingQuestions: null, aborted: false, }))` call (~1019-1032): add `stallNotice: false,` to that object, then call `startWatchdog();` on the line immediately after the `setState(...)` closes:

```ts
    loading: true,
    pendingQuestions: null,
    aborted: false,
    stallNotice: false,
  }));
  startWatchdog();
```

- [ ] **Step 6: Start the watchdog when executing a command**

In `doExecuteCommand`, the `useChatUIStore.setState((s) => ({ ... loading: true, pendingQuestions: null, aborted: false, }))` call (~1114-1123): add `stallNotice: false,` to that object and call `startWatchdog();` immediately after the `setState(...)` closes:

```ts
    loading: true,
    pendingQuestions: null,
    aborted: false,
    stallNotice: false,
  }));
  startWatchdog();
```

- [ ] **Step 7: Stop the watchdog on user abort**

In `doAbortSession`, update the `finally` block to also stop the watchdog and clear the notice:

```ts
  } finally {
    stopWatchdog();
    useChatUIStore.setState({ loading: false, pendingQuestions: null, stallNotice: false });
  }
```

- [ ] **Step 8: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 9: Run the full unit test suite (no regressions)**

Run: `npx vitest run`
Expected: PASS (including Task 1's `stall-watchdog.test.ts`).

- [ ] **Step 10: Commit**

```bash
git add src/features/opencode-config/hooks/useOpencodeChat.ts
git commit -m "feat(opencode): wire stall watchdog into chat SSE loop and send paths"
```

---

## Task 4: Render the soft stall notice

**Files:**
- Modify: `src/features/opencode-config/components/OpencodeChat.tsx` (destructure ~31-49; loading block ~576-583)
- Modify: `src/features/opencode-config/components/OpencodeChat.css`

- [ ] **Step 1: Destructure `stallNotice` from the hook**

In `OpencodeChat.tsx`, in the `const { ... } = useOpencodeChat(...)` destructure, after `loading,`:

```ts
    loading,
    stallNotice,
```

- [ ] **Step 2: Render the notice inside the loading indicator**

In the `{loading && !pendingQuestions && ( ... )}` block, after the `<span className="oc-chat__loading-label">{t("ocChatThinking", "Thinking...")}</span>` line, insert the notice (shown only when `stallNotice` is set):

```tsx
              <span className="oc-chat__loading-label">{t("ocChatThinking", "Thinking...")}</span>
              {stallNotice && (
                <span className="oc-chat__stall">{t("ocChatStalled")}</span>
              )}
```

- [ ] **Step 3: Add the notice styling**

In `OpencodeChat.css`, add a rule (place near `.oc-chat__loading` styles). Use a non-error, informational color:

```css
.oc-chat__stall {
  margin-left: 8px;
  font-size: 12px;
  color: #8a6d00;
  background: rgba(255, 196, 0, 0.12);
  border: 1px solid rgba(255, 196, 0, 0.35);
  border-radius: 4px;
  padding: 1px 6px;
}
```

- [ ] **Step 4: Typecheck and build**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Manual smoke (optional, requires a running build)**

Temporarily lower `STALL_NOTICE_MS` to e.g. `3_000` in `stall-watchdog.ts`, run `npm run tauri dev`, send a message to opencode, and confirm the yellow "Waiting…" chip appears ~3s after the last event and disappears when the reply streams. Revert the constant before committing.

- [ ] **Step 6: Commit**

```bash
git add src/features/opencode-config/components/OpencodeChat.tsx src/features/opencode-config/components/OpencodeChat.css
git commit -m "feat(opencode): show soft stall notice in chat while waiting"
```

---

## Self-Review

**Spec coverage:**
- 60s soft notice → Task 1 (`STALL_NOTICE_MS`, `evaluateStall`) + Task 3 (`watchdogTick` notice) + Task 4 (UI). ✓
- 5min give-up (cancel turn, unlock, timeout banner) → Task 3 (`triggerStallGiveup`). ✓
- Reset on every event → Task 3 Step 4. ✓
- Auto-clear notice on resume → Task 3 Step 4. ✓
- `stallNotice` store field + reset points (send/command/abort) → Task 2 + Task 3 Steps 5-7. ✓
- Pure, unit-tested timing logic → Task 1. ✓
- Soft info styling distinct from error banner → Task 4 (`.oc-chat__stall`). ✓
- i18n (no hardcoded UI strings) → Task 2 Steps 6-7; component uses `t(...)`. ✓
- Keep `[opencode][diag]` log → noted; no task removes it. ✓
- Edge cases (user abort, question-wait with loading:false, Azure auto-continue restart, slow-but-progressing resets) → covered by `evaluateStall` guards + per-event reset + self-stop tick. ✓

**Placeholder scan:** No TBD/TODO; all steps contain concrete code and exact anchors. ✓

**Type consistency:** `evaluateStall`/`StallInput`/`StallAction` and constants `STALL_NOTICE_MS`/`STALL_GIVEUP_MS`/`STALL_TICK_MS` are used identically across tasks. `stallNotice: boolean` is consistent across `OpencodeChatUIState`, store defaults, `UseOpencodeChatResult`, hook destructure/return, and component. `triggerStallGiveup`/`startWatchdog`/`stopWatchdog`/`watchdogTick` names are consistent within Task 3. `i18n.t(...)` matches the existing usage in `formatSessionError`. ✓
