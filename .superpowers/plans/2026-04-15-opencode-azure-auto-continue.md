# Opencode Azure Auto-Continue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the opencode chat is backed by Azure OpenAI and returns a content-filter refusal, automatically send `続けてください` once on the user's behalf, with visual labeling and counter reset on normal response.

**Architecture:** Hook the existing `processSSEStream` `session.idle` handler in `useOpencodeChat.ts` to run a refusal-pattern check on `rawText`. When matched, gate by async provider detection (read `~/.config/opencode/config.json`, fall back to `aiSettings.provider`), then call `doSendMessage` with a new `isAutoReply: true` option. Retry counter lives in `useChatUIStore` and resets on normal response or session change.

**Tech Stack:** TypeScript, React 19, Zustand, Tauri IPC, Vitest, i18next, @opencode-ai/sdk.

**Spec:** `.superpowers/specs/2026-04-15-opencode-azure-auto-continue-design.md`

---

## File Structure

**Created:**
- `src/features/opencode-config/lib/provider-detection.ts` — `isAzureRefusal` (pure), `isAzureProviderActive` (async)
- `src/features/opencode-config/lib/__tests__/provider-detection.test.ts` — vitest unit tests for `isAzureRefusal`

**Modified:**
- `src/features/opencode-config/hooks/useOpencodeChat.ts` — type extensions, store state, `doSendMessage` signature, SSE refusal block, counter resets
- `src/features/opencode-config/components/OpencodeChat.tsx` — auto-reply label rendering
- `src/shared/i18n/locales/ja/opencode-config.json` — `ocChatAutoReplyLabel`
- `src/shared/i18n/locales/en/opencode-config.json` — `ocChatAutoReplyLabel`

---

## Task 1: Unit test for `isAzureRefusal` (failing)

**Files:**
- Create: `src/features/opencode-config/lib/__tests__/provider-detection.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/features/opencode-config/lib/__tests__/provider-detection.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { isAzureRefusal } from "../provider-detection";

describe("isAzureRefusal", () => {
  it("matches the canonical Azure content-filter refusal", () => {
    expect(
      isAzureRefusal("I'm sorry, but I cannot assist with that request."),
    ).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(
      isAzureRefusal("I'M SORRY, BUT I CAN'T HELP WITH THAT."),
    ).toBe(true);
  });

  it("accepts 'I am sorry' alternate phrasing", () => {
    expect(
      isAzureRefusal("I am sorry, but I cannot help with that request."),
    ).toBe(true);
  });

  it("accepts 'can't assist' variant", () => {
    expect(
      isAzureRefusal("I'm sorry, but I can't assist with this."),
    ).toBe(true);
  });

  it("trims leading and trailing whitespace", () => {
    expect(
      isAzureRefusal("\n  I'm sorry, but I cannot assist with that.  \n"),
    ).toBe(true);
  });

  it("returns false for empty string", () => {
    expect(isAzureRefusal("")).toBe(false);
  });

  it("returns false when only apology is present", () => {
    expect(
      isAzureRefusal("I'm sorry for the confusion. Here's the answer..."),
    ).toBe(false);
  });

  it("returns false when only refusal phrase is present (no apology)", () => {
    expect(
      isAzureRefusal("The system cannot assist with malformed input."),
    ).toBe(false);
  });

  it("returns false for long legitimate responses containing both phrases", () => {
    const longText =
      "Here is a detailed answer. ".repeat(20) +
      "I'm sorry if this is confusing, but note that the API cannot assist with this edge case. " +
      "Continuing: ".repeat(10);
    // Sanity check length > 300
    expect(longText.length).toBeGreaterThan(300);
    expect(isAzureRefusal(longText)).toBe(false);
  });

  it("returns false for null-ish input", () => {
    expect(isAzureRefusal(undefined as unknown as string)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test src/features/opencode-config/lib/__tests__/provider-detection.test.ts`

Expected: FAIL with module resolution error (`Cannot find module '../provider-detection'`).

- [ ] **Step 3: Commit the failing test**

```bash
git add src/features/opencode-config/lib/__tests__/provider-detection.test.ts
git commit -m "test(opencode): add failing tests for isAzureRefusal"
```

---

## Task 2: Implement `isAzureRefusal` (pure function)

**Files:**
- Create: `src/features/opencode-config/lib/provider-detection.ts`

- [ ] **Step 1: Create the module with `isAzureRefusal` only**

Create `src/features/opencode-config/lib/provider-detection.ts`:

```ts
/**
 * Detects Azure OpenAI content-filter refusal responses.
 * Requires both an apology marker and a refusal phrase, with a length
 * guard to avoid matching long legitimate responses that happen to
 * contain these phrases in passing.
 */
export function isAzureRefusal(text: string): boolean {
  if (!text) return false;
  const normalized = text.toLowerCase().trim();
  if (normalized.length > 300) return false;
  const hasSorry =
    normalized.includes("i'm sorry") || normalized.includes("i am sorry");
  const hasRefusal =
    normalized.includes("cannot assist") ||
    normalized.includes("can't assist") ||
    normalized.includes("cannot help") ||
    normalized.includes("can't help");
  return hasSorry && hasRefusal;
}
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `bun run test src/features/opencode-config/lib/__tests__/provider-detection.test.ts`

Expected: PASS (10 tests).

- [ ] **Step 3: Commit**

```bash
git add src/features/opencode-config/lib/provider-detection.ts
git commit -m "feat(opencode): implement isAzureRefusal pattern detection"
```

---

## Task 3: Implement `isAzureProviderActive`

**Files:**
- Modify: `src/features/opencode-config/lib/provider-detection.ts`

- [ ] **Step 1: Append the provider detection function**

Append to `src/features/opencode-config/lib/provider-detection.ts`:

```ts
import { invoke } from "@tauri-apps/api/core";
import { useSettingsStore } from "@/stores/settings-store";

async function getHomeSep(): Promise<{ home: string; sep: string }> {
  const home = await invoke<string>("get_home_dir");
  const sep = home.includes("\\") ? "\\" : "/";
  return { home, sep };
}

/**
 * Returns true when the current opencode session is likely backed by Azure.
 *
 * Detection strategy:
 * 1. Read ~/.config/opencode/config.json and check whether `model` starts
 *    with "azure/". If `model` is present but non-Azure, return false
 *    without falling back — opencode's own config is authoritative.
 * 2. If config.json is missing / unparsable / has no `model` field,
 *    fall back to mdium's own AI settings (`aiSettings.provider === "azure"`).
 *
 * No caching: called only from the refusal path, which is rare.
 */
export async function isAzureProviderActive(): Promise<boolean> {
  try {
    const { home, sep } = await getHomeSep();
    const configPath = `${home}${sep}.config${sep}opencode${sep}config.json`;
    const raw = await invoke<string>("read_text_file", { path: configPath });
    const config = JSON.parse(raw);
    if (typeof config.model === "string") {
      return config.model.startsWith("azure/");
    }
  } catch {
    // fall through to fallback
  }
  const settings = useSettingsStore.getState();
  return settings.aiSettings?.provider === "azure";
}
```

Note: the `import` lines must be at the top of the file, above `isAzureRefusal`. Rearrange so the final file layout is:

```ts
import { invoke } from "@tauri-apps/api/core";
import { useSettingsStore } from "@/stores/settings-store";

export function isAzureRefusal(text: string): boolean { /* ... */ }

async function getHomeSep(): Promise<{ home: string; sep: string }> { /* ... */ }

export async function isAzureProviderActive(): Promise<boolean> { /* ... */ }
```

- [ ] **Step 2: Run unit tests to verify nothing broke**

Run: `bun run test src/features/opencode-config/lib/__tests__/provider-detection.test.ts`

Expected: PASS (10 tests still passing).

- [ ] **Step 3: Run TypeScript check**

Run: `bunx tsc --noEmit`

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/features/opencode-config/lib/provider-detection.ts
git commit -m "feat(opencode): add isAzureProviderActive with config.json + settings fallback"
```

---

## Task 4: Extend `OpencodeMessage` and `OpencodeChatUIState`

**Files:**
- Modify: `src/features/opencode-config/hooks/useOpencodeChat.ts`

- [ ] **Step 1: Add `isAutoReply` field to `OpencodeMessage`**

In `src/features/opencode-config/hooks/useOpencodeChat.ts`, locate the existing interface:

```ts
export interface OpencodeMessage {
  role: "user" | "assistant";
  content: string;
  parts?: Part[];
  completed?: boolean;
}
```

Replace with:

```ts
export interface OpencodeMessage {
  role: "user" | "assistant";
  content: string;
  parts?: Part[];
  completed?: boolean;
  isAutoReply?: boolean;
}
```

- [ ] **Step 2: Add `azureAutoRetryCount` to `OpencodeChatUIState`**

Locate the existing `OpencodeChatUIState` interface and add `azureAutoRetryCount: number` as the last field:

```ts
interface OpencodeChatUIState {
  connected: boolean;
  connecting: boolean;
  error: string | null;
  messages: OpencodeMessage[];
  loading: boolean;
  sessions: OpencodeSessionInfo[];
  currentSessionId: string | null;
  pendingQuestions: PendingQuestion[] | null;
  selectedAgent: string | null;
  availableAgents: { name: string; description: string }[];
  useMdContext: boolean;
  chatInput: string;
  aborted: boolean;
  chatSplitRatio: number;
  azureAutoRetryCount: number;
}
```

- [ ] **Step 3: Add default value to the `create` call**

Locate the existing `useChatUIStore = create<OpencodeChatUIState>()(() => ({ ... }))` and add `azureAutoRetryCount: 0` as the last entry:

```ts
export const useChatUIStore = create<OpencodeChatUIState>()(() => ({
  connected: false,
  connecting: false,
  error: null,
  messages: [],
  loading: false,
  sessions: [],
  currentSessionId: null,
  pendingQuestions: null,
  selectedAgent: "build",
  availableAgents: [],
  useMdContext: false,
  chatInput: "",
  aborted: false,
  chatSplitRatio: 75,
  azureAutoRetryCount: 0,
}));
```

- [ ] **Step 4: Run TypeScript check**

Run: `bunx tsc --noEmit`

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/features/opencode-config/hooks/useOpencodeChat.ts
git commit -m "feat(opencode): add isAutoReply message flag and retry counter state"
```

---

## Task 5: Extend `doSendMessage` with `SendOptions`

**Files:**
- Modify: `src/features/opencode-config/hooks/useOpencodeChat.ts`

- [ ] **Step 1: Add `SendOptions` interface**

In `useOpencodeChat.ts`, add above the `doSendMessage` function declaration:

```ts
interface SendOptions {
  isAutoReply?: boolean;
}
```

- [ ] **Step 2: Extend the `doSendMessage` signature**

Locate:

```ts
export async function doSendMessage(text: string, agentOverride?: string, images?: ImageAttachment[]) {
```

Replace with:

```ts
export async function doSendMessage(
  text: string,
  agentOverride?: string,
  images?: ImageAttachment[],
  options?: SendOptions,
) {
```

- [ ] **Step 3: Pass `isAutoReply` into the pushed user message**

Inside `doSendMessage`, locate:

```ts
useChatUIStore.setState((s) => ({
  messages: [
    ...s.messages,
    { role: "user" as const, content: displayText },
    { role: "assistant" as const, content: "", parts: [] },
  ],
  loading: true,
  pendingQuestions: null,
  aborted: false,
}));
```

Replace with:

```ts
useChatUIStore.setState((s) => ({
  messages: [
    ...s.messages,
    {
      role: "user" as const,
      content: displayText,
      isAutoReply: options?.isAutoReply ?? false,
    },
    { role: "assistant" as const, content: "", parts: [] },
  ],
  loading: true,
  pendingQuestions: null,
  aborted: false,
}));
```

- [ ] **Step 4: Run TypeScript check**

Run: `bunx tsc --noEmit`

Expected: no errors. (The hook wrapper `sendMessage` in `useOpencodeChat` still uses the 3-arg form, which is valid because `options` is optional.)

- [ ] **Step 5: Commit**

```bash
git add src/features/opencode-config/hooks/useOpencodeChat.ts
git commit -m "feat(opencode): add SendOptions to doSendMessage for auto-reply labeling"
```

---

## Task 6: Add refusal detection block in SSE `session.idle` handler

**Files:**
- Modify: `src/features/opencode-config/hooks/useOpencodeChat.ts`

- [ ] **Step 1: Import the detection helpers**

At the top of `useOpencodeChat.ts`, add to the existing imports:

```ts
import { isAzureRefusal, isAzureProviderActive } from "../lib/provider-detection";
```

- [ ] **Step 2: Insert the refusal branch after `rawText` is computed**

In `processSSEStream`, inside the `ev.type === "session.idle"` branch, locate this code block (currently around lines 310–325):

```ts
              // Try to detect questions in the final text before converting to HTML
              const questionsFromIdle = tryParseQuestions(rawText);
              if (questionsFromIdle) {
```

Immediately before the `const questionsFromIdle = ...` line, insert:

```ts
              // === Azure auto-continue on content-filter refusal ===
              const isRefusal = isAzureRefusal(rawText);
              const retryCount = useChatUIStore.getState().azureAutoRetryCount;

              if (isRefusal && retryCount === 0) {
                const isAzure = await isAzureProviderActive();
                if (isAzure) {
                  // Finalize the current assistant message in UI first
                  const refusalHtml = rawText ? await marked(rawText) : "";
                  useChatUIStore.setState((s) => {
                    const updated = [...s.messages];
                    updated[updated.length - 1] = {
                      ...updated[updated.length - 1],
                      content: refusalHtml,
                      completed: true,
                    };
                    return {
                      messages: updated,
                      loading: false,
                      azureAutoRetryCount: 1,
                    };
                  });
                  // Send the auto-reply. Awaiting is safe: promptAsync
                  // schedules the prompt and returns before the model
                  // response arrives. Awaiting also guarantees the new
                  // messages are in the store before the next SSE event.
                  await doSendMessage("続けてください", undefined, undefined, { isAutoReply: true });
                  continue;
                }
              }

              // Reset counter on a genuine normal response (non-refusal + non-empty)
              if (!isRefusal && rawText.trim()) {
                useChatUIStore.setState({ azureAutoRetryCount: 0 });
              }
              // === end Azure auto-continue ===

```

- [ ] **Step 3: Run TypeScript check**

Run: `bunx tsc --noEmit`

Expected: no errors.

- [ ] **Step 4: Run existing tests**

Run: `bun run test`

Expected: all existing tests still pass. The `provider-detection.test.ts` tests should still pass (10/10).

- [ ] **Step 5: Commit**

```bash
git add src/features/opencode-config/hooks/useOpencodeChat.ts
git commit -m "feat(opencode): auto-continue on Azure refusal in session.idle handler"
```

---

## Task 7: Reset retry counter on session lifecycle events

**Files:**
- Modify: `src/features/opencode-config/hooks/useOpencodeChat.ts`

- [ ] **Step 1: Reset in `doDisconnect`**

Locate `doDisconnect` and its `useChatUIStore.setState({ ... })` call. Add `azureAutoRetryCount: 0` to the state object:

```ts
useChatUIStore.setState({
  connected: false,
  connecting: false,
  messages: [],
  loading: false,
  sessions: [],
  currentSessionId: null,
  error: null,
  pendingQuestions: null,
  azureAutoRetryCount: 0,
});
```

- [ ] **Step 2: Reset in `doCreateNewSession`**

Locate:

```ts
export async function doCreateNewSession() {
  _currentSessionId = null;
  useChatUIStore.setState({
    messages: [],
    currentSessionId: null,
    error: null,
    pendingQuestions: null,
  });
}
```

Replace with:

```ts
export async function doCreateNewSession() {
  _currentSessionId = null;
  useChatUIStore.setState({
    messages: [],
    currentSessionId: null,
    error: null,
    pendingQuestions: null,
    azureAutoRetryCount: 0,
  });
}
```

- [ ] **Step 3: Reset in `doLoadSession`**

Inside `doLoadSession`, locate the final setState that commits the loaded messages:

```ts
_currentSessionId = sessionId;
useChatUIStore.setState({
  messages: loaded,
  currentSessionId: sessionId,
});
```

Replace with:

```ts
_currentSessionId = sessionId;
useChatUIStore.setState({
  messages: loaded,
  currentSessionId: sessionId,
  azureAutoRetryCount: 0,
});
```

- [ ] **Step 4: Run TypeScript check**

Run: `bunx tsc --noEmit`

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/features/opencode-config/hooks/useOpencodeChat.ts
git commit -m "feat(opencode): reset azureAutoRetryCount on session lifecycle events"
```

---

## Task 8: Add i18n label keys

**Files:**
- Modify: `src/shared/i18n/locales/ja/opencode-config.json`
- Modify: `src/shared/i18n/locales/en/opencode-config.json`

- [ ] **Step 1: Add the Japanese key**

In `src/shared/i18n/locales/ja/opencode-config.json`, add this key near the other `ocChat*` entries (e.g. just after `"ocChatError"`):

```json
"ocChatAutoReplyLabel": "(自動返答)",
```

Make sure the surrounding JSON remains valid (check trailing commas).

- [ ] **Step 2: Add the English key**

In `src/shared/i18n/locales/en/opencode-config.json`, at the same structural position:

```json
"ocChatAutoReplyLabel": "(Auto-reply)",
```

- [ ] **Step 3: Validate JSON syntax**

Run: `node -e "JSON.parse(require('fs').readFileSync('src/shared/i18n/locales/ja/opencode-config.json','utf8')); JSON.parse(require('fs').readFileSync('src/shared/i18n/locales/en/opencode-config.json','utf8')); console.log('OK')"`

Expected: `OK`.

- [ ] **Step 4: Commit**

```bash
git add src/shared/i18n/locales/ja/opencode-config.json src/shared/i18n/locales/en/opencode-config.json
git commit -m "feat(opencode): add auto-reply label i18n strings"
```

---

## Task 9: Render auto-reply label in `OpencodeChat.tsx`

**Files:**
- Modify: `src/features/opencode-config/components/OpencodeChat.tsx`

- [ ] **Step 1: Modify the user message render block**

In `src/features/opencode-config/components/OpencodeChat.tsx`, locate the user message render at approximately lines 477–483:

```tsx
            if (msg.role === "user") {
              return (
                <div key={i} className="oc-chat__msg oc-chat__msg--user">
                  <div className="oc-chat__msg-content">{msg.content}</div>
                </div>
              );
            }
```

Replace with:

```tsx
            if (msg.role === "user") {
              return (
                <div
                  key={i}
                  className={
                    "oc-chat__msg oc-chat__msg--user" +
                    (msg.isAutoReply ? " oc-chat__msg--auto-reply" : "")
                  }
                >
                  {msg.isAutoReply && (
                    <div className="oc-chat__msg-auto-label">
                      {t("ocChatAutoReplyLabel")}
                    </div>
                  )}
                  <div className="oc-chat__msg-content">{msg.content}</div>
                </div>
              );
            }
```

Note: `t` is already in scope (the component already uses `useTranslation("opencode-config")`).

- [ ] **Step 2: Add styling to OpencodeChat.css**

Open `src/features/opencode-config/components/OpencodeChat.css` and append to the end of the file:

```css
.oc-chat__msg--auto-reply .oc-chat__msg-content {
  opacity: 0.75;
}

.oc-chat__msg-auto-label {
  font-size: 0.75rem;
  opacity: 0.6;
  margin-bottom: 0.25rem;
}
```

- [ ] **Step 3: Run TypeScript check**

Run: `bunx tsc --noEmit`

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/features/opencode-config/components/OpencodeChat.tsx src/features/opencode-config/components/OpencodeChat.css
git commit -m "feat(opencode): render auto-reply label on user messages"
```

---

## Task 10: Full build and test verification

**Files:** none modified (verification only)

- [ ] **Step 1: Full test suite**

Run: `bun run test`

Expected: all tests pass (including the 10 `isAzureRefusal` tests).

- [ ] **Step 2: Full build**

Run: `bun run build`

Expected: TypeScript compilation passes, Vite build succeeds with no errors.

- [ ] **Step 3: If any failure, fix and commit separately**

If `tsc` or `vite` surfaces an error, fix it and commit with a clear message explaining the fix. Do NOT amend prior commits.

---

## Task 11: Manual test plan (user-executed)

**Files:** none

This task documents the manual testing the user must perform after merging. It produces no code.

- [ ] **Step 1: Azure happy path**

1. Ensure `~/.config/opencode/config.json` has `"model": "azure/<some-model>"` and a valid Azure API key.
2. Launch mdium, open an opencode chat.
3. Send a prompt known to trigger Azure content-filter refusal (e.g., request blocked content in Japanese).
4. Verify: the refusal bubble appears as an assistant message, a `(自動返答) 続けてください` bubble appears as a user message with the label shown and slightly faded content, and a new assistant response follows.

- [ ] **Step 2: Counter reset after normal response**

1. In the same session, continue with a normal prompt. Verify a normal response arrives and the counter is implicitly reset.
2. Trigger another refusal in the same session. Verify auto-continue fires again.

- [ ] **Step 3: Two consecutive refusals**

1. Trigger a refusal that the continuation cannot unblock (the model refuses twice in a row).
2. Verify the second refusal is NOT auto-continued — it appears in the UI and loading is cleared.

- [ ] **Step 4: Non-Azure provider**

1. Edit `~/.config/opencode/config.json` to set `"model": "anthropic/claude-..."` or similar.
2. Restart the chat session.
3. Contrive any response containing apology+refusal phrasing. Verify no auto-continue fires.

- [ ] **Step 5: Fallback path**

1. Rename `~/.config/opencode/config.json` to disable the primary detection.
2. In mdium settings, set the AI provider to Azure.
3. Trigger a refusal. Verify auto-continue fires via the fallback.
4. Restore `config.json`.

- [ ] **Step 6: Abort mid auto-reply**

1. Trigger a refusal and let auto-continue fire.
2. While the continuation response is streaming, press the abort button.
3. Verify no extra auto-reply is sent and the UI stays consistent.

---

## Summary

11 tasks, TDD-oriented (tests in Task 1 drive implementation in Task 2), each task produces a self-contained commit. Total: 10 code tasks + 1 documentation-only verification task.
