# Opencode Azure Auto-Continue on Refusal — Design

**Date:** 2026-04-15
**Status:** Approved

## Problem

When the user's opencode chat is backed by Azure OpenAI, Azure's content filter occasionally returns refusal responses such as `"I'm sorry, but I cannot assist with that request."` Continuing the conversation by sending a short Japanese nudge (`続けてください`) typically unblocks the model on the next turn. The user currently has to notice the refusal and type this continuation manually.

## Goal

Automatically detect Azure content-filter refusals in the mdium opencode chat UI and send a single `続けてください` continuation on the user's behalf, with transparent visual labeling, limited retries, and provider-gated activation.

## Scope

- **In scope:** `doSendMessage` path (normal user text input) in `src/features/opencode-config/hooks/useOpencodeChat.ts`.
- **Out of scope:** `doExecuteCommand` path (slash commands such as `/generate-video-scenario`). Refusals during slash commands require user intervention.
- **Out of scope:** Configurable UI toggle. Detection is driven by the active provider, not a user preference.
- **Out of scope:** Configurable retry count, configurable continuation text, configurable refusal regex. Keep a single opinionated behavior for v1.

## Non-Goals

- This feature does not attempt to handle non-Azure refusals (e.g., Anthropic, OpenAI direct). Other providers rarely exhibit this exact pattern and have different refusal language.
- This feature does not circumvent or bypass Azure's content filter; it only retries once with a neutral continuation prompt, which is a pattern that the filter itself allows in practice.

## High-Level Approach

Hook into the existing SSE event handler `processSSEStream` inside `useOpencodeChat.ts` at the `session.idle` event. When the final assistant text is available (`rawText`), run a refusal-pattern check. If the text matches the pattern, the retry counter is zero, and the active provider is Azure, finalize the current assistant message in UI, then call `doSendMessage` recursively with a new `isAutoReply: true` option to send `続けてください`. The user-facing message bubble for the auto-reply is labeled so users can distinguish it from manual input.

## Detailed Design

### 1. Provider Detection

New module: `src/features/opencode-config/lib/provider-detection.ts`

```ts
import { invoke } from "@tauri-apps/api/core";
import { useSettingsStore } from "@/stores/settings-store";

async function getHomeSep(): Promise<{ home: string; sep: string }> {
  const home = await invoke<string>("get_home_dir");
  const sep = home.includes("\\") ? "\\" : "/";
  return { home, sep };
}

export async function isAzureProviderActive(): Promise<boolean> {
  // 1. Primary: read opencode config.json, check "model" prefix
  try {
    const { home, sep } = await getHomeSep();
    const configPath = `${home}${sep}.config${sep}opencode${sep}config.json`;
    const raw = await invoke<string>("read_text_file", { path: configPath });
    const config = JSON.parse(raw);
    if (typeof config.model === "string") {
      return config.model.startsWith("azure/");
    }
    // config file exists but has no "model" field → fall through to fallback
  } catch {
    // file missing or invalid JSON → fall through to fallback
  }

  // 2. Fallback: mdium's own AI settings
  const settings = useSettingsStore.getState();
  return settings.aiSettings?.provider === "azure";
}
```

**Rules:**
- If `config.json` exists and has a `model` field: trust it absolutely. Do not fall back even if the value is non-Azure. Rationale: when opencode's config explicitly specifies a non-Azure model, Azure detection should be negative even if mdium's settings still say Azure.
- If `config.json` is missing or unparsable or has no `model` field: fall back to mdium settings.
- No caching. Called only when a refusal is actually detected (rare, so cost is negligible), ensuring immediate adaptation to setting changes.

### 2. Refusal Pattern Detection

Co-located in `provider-detection.ts`:

```ts
export function isAzureRefusal(text: string): boolean {
  if (!text) return false;
  const normalized = text.toLowerCase().trim();
  // Guard against long normal responses that happen to contain these phrases
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

**Rules:**
- Case-insensitive, trimmed.
- 300-character maximum normalized length. Azure content-filter refusals are consistently short (1–2 sentences, ~50–150 chars); legitimate long responses that happen to contain both phrases are treated as non-refusals.
- Requires both an apology marker AND a refusal phrase (AND condition) to minimize false positives.
- Runs on `rawText` — the raw text *before* HTML conversion via `marked()` — to avoid HTML tags disrupting matching.

### 3. State: Retry Counter

Extend `useChatUIStore` in `useOpencodeChat.ts`:

```ts
interface OpencodeChatUIState {
  // ... existing fields ...
  azureAutoRetryCount: number; // 0 = fresh, 1 = one auto-reply already sent
}
```

Initial value: `0`.

**State transitions:**

| Event | Transition |
|---|---|
| Manual user send (`doSendMessage` with `isAutoReply === false`) | no change |
| Auto-reply send (`doSendMessage` with `isAutoReply === true`) | no change (set by trigger block before send) |
| `session.idle` with refusal detected AND `azureAutoRetryCount === 0` | set to `1`, trigger auto-reply |
| `session.idle` with refusal detected AND `azureAutoRetryCount >= 1` | no auto-reply; normal completion flow |
| `session.idle` with normal response (non-refusal, non-empty `rawText`) | reset to `0` |
| `doCreateNewSession` | reset to `0` |
| `doLoadSession` | reset to `0` |
| `doDisconnect` | reset to `0` |

`0`/`1` is effectively binary, but a count field is used to leave room for a future configurable upper limit without schema churn.

### 4. SSE Handler Extension

Modify `processSSEStream` in `useOpencodeChat.ts`, inside the `ev.type === "session.idle"` branch, after `rawText` is computed (which strips the user echo) and before the existing `tryParseQuestions(rawText)` / `marked(rawText)` calls:

```ts
// ... existing rawText extraction ...

// === Azure auto-continue ===
const isRefusal = isAzureRefusal(rawText);
const retryCount = useChatUIStore.getState().azureAutoRetryCount;

if (isRefusal && retryCount === 0) {
  const isAzure = await isAzureProviderActive();
  if (isAzure) {
    // Finalize current assistant message in UI
    const html = rawText ? await marked(rawText) : "";
    useChatUIStore.setState((s) => {
      const updated = [...s.messages];
      updated[updated.length - 1] = {
        ...updated[updated.length - 1],
        content: html,
        completed: true,
      };
      return {
        messages: updated,
        loading: false,
        azureAutoRetryCount: 1,
      };
    });
    // Auto-reply. Await is safe here because opencode's promptAsync
    // schedules the prompt and returns immediately (it does NOT wait
    // for the model response), so the SSE loop blocks only briefly.
    // Awaiting also guarantees that the new user/assistant messages
    // are pushed to the store before the next SSE event is processed.
    await doSendMessage("続けてください", undefined, undefined, { isAutoReply: true });
    continue; // skip existing completion branch for this idle event
  }
}

// Reset counter on a genuine normal response (content exists and is not a refusal)
if (!isRefusal && rawText.trim()) {
  useChatUIStore.setState({ azureAutoRetryCount: 0 });
}

// ... existing tryParseQuestions(rawText) / marked(rawText) flow ...
```

**Rules:**
- `isAzureProviderActive()` is awaited only inside the refusal branch. Non-refusal paths pay no cost.
- Auto-reply is fire-and-forget (`doSendMessage(...)` without `await`) so the SSE `for await` loop keeps consuming subsequent events. `doSendMessage` pushes new UI messages synchronously before awaiting `promptAsync`, so the UI updates in order.
- `continue` after the auto-reply branch prevents the existing `marked → setState({ messages, loading: false })` block from running twice (it already ran inside the branch).
- Counter reset is gated on BOTH (non-refusal) AND (non-empty rawText) to avoid resetting on aborted-empty-response edge cases.

### 5. `doSendMessage` Extension

Modify the exported function signature:

```ts
interface SendOptions {
  isAutoReply?: boolean;
}

export async function doSendMessage(
  text: string,
  agentOverride?: string,
  images?: ImageAttachment[],
  options?: SendOptions,
) {
  // ... existing guard / ensureSessionId / displayText ...

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

  // ... existing promptAsync call unchanged ...
}
```

Extend `OpencodeMessage`:

```ts
export interface OpencodeMessage {
  role: "user" | "assistant";
  content: string;
  parts?: Part[];
  completed?: boolean;
  isAutoReply?: boolean;
}
```

**Rules:**
- Default `isAutoReply: false` for all existing call sites (they omit `options`).
- The server payload is identical to a manual send — opencode sees `続けてください` as a normal user text part. The flag is purely UI metadata.
- `executeCommand` is NOT modified (out of scope).

### 6. UI Labeling

Modify `OpencodeChat.tsx` message rendering. The current user-message block needs an additional label when `msg.isAutoReply === true`.

Conceptual structure:

```tsx
{msg.role === "user" && (
  <>
    {msg.isAutoReply && (
      <div className="text-xs text-muted-foreground mb-1">
        {t("ocChatAutoReplyLabel")}
      </div>
    )}
    <div className={msg.isAutoReply ? "opacity-75" : ""}>
      {msg.content}
    </div>
  </>
)}
```

Exact class names and placement must follow the existing `OpencodeChat.tsx` user-message rendering pattern (to be confirmed during implementation).

**i18n:**

Add to `src/shared/i18n/locales/ja/opencode-config.json`:
```json
"ocChatAutoReplyLabel": "(自動返答)"
```

Add to `src/shared/i18n/locales/en/opencode-config.json`:
```json
"ocChatAutoReplyLabel": "(Auto-reply)"
```

Key naming follows the existing `ocChat*` prefix convention used for all opencode-chat-related strings in this file.

Per project standard (`CLAUDE.md`), all UI strings are required to use i18n; both locales must be updated in the same change.

### 7. Error Handling & Edge Cases

1. **Auto-reply send fails:** `doSendMessage`'s existing `catch` shows the error and clears `loading`. `azureAutoRetryCount` remains at `1`; a future normal response will reset it. No extra handling needed.
2. **User aborts mid auto-reply:** `doAbortSession` sets `aborted: true`. The existing `session.idle` handler checks `state.aborted` early and continues past the refusal-detection block. The counter will be reset when the next session starts or loads. No extra handling needed.
3. **Race on provider check:** `isAzureProviderActive()` is async (reads a file). If another message arrives during the await, their SSE idle events are processed independently; there is no cross-contamination because each idle handler reads its own `rawText` and its own state snapshot.
4. **Empty response:** The existing handler already skips `session.idle` when the assistant bubble has no content and no parts. The refusal check is inserted *after* the rawText extraction but *before* the existing completion flow; the empty-skip is upstream and still fires first. The 300-char guard in `isAzureRefusal` also makes empty strings return `false` trivially.
5. **Two consecutive refusals:** After the first auto-reply, `azureAutoRetryCount === 1`. If the second response is also a refusal, the refusal branch short-circuits (`retryCount === 0` is false), and the normal completion flow runs (HTML conversion, "Done" toast). The user sees the refusal in the UI and can intervene.
6. **Refusal followed by normal response:** The normal response branch resets `azureAutoRetryCount` to `0`. If the model refuses again later in the same session, the auto-continue fires once more. This matches the user's requirement: "後段で正常応答だった場合は同一セッション内でカウントをリセット".

## Testing

**Unit tests** (vitest, colocated in `src/features/opencode-config/lib/__tests__/provider-detection.test.ts`):

Cover `isAzureRefusal`:
- Typical Azure refusal: `"I'm sorry, but I cannot assist with that request."` → `true`
- Case variation: `"I'M SORRY, BUT I CAN'T HELP WITH THAT."` → `true`
- Alternate phrasing: `"I am sorry, but I cannot help with that request."` → `true`
- Empty string → `false`
- Only apology, no refusal phrase: `"I'm sorry for the confusion. Here's the answer..."` → `false`
- Only refusal phrase, no apology: `"The system cannot assist with malformed input."` → `false`
- Long legitimate response containing both phrases (400+ chars) → `false` (length guard)
- Whitespace variants, trailing newline, etc.

`isAzureProviderActive` is harder to unit-test (Tauri IPC + zustand). Integration testing is manual.

**Manual test plan:**

1. Configure opencode to use Azure (`model: "azure/gpt-5.1"` in `~/.config/opencode/config.json`) and set an Azure API key.
2. In mdium, send a prompt likely to trigger Azure content-filter refusal (e.g., request content the filter blocks in Japanese).
3. Verify: the refusal bubble appears, then a `(自動返答) 続けてください` bubble appears, then a new assistant response appears.
4. Send another prompt that triggers refusal in the same session; verify auto-continue fires again (counter reset worked).
5. Send two refusal-triggering prompts back-to-back such that the first refusal is followed by a second refusal (not a normal response). Verify the second refusal does NOT trigger auto-continue (counter not reset).
6. Switch opencode config to a non-Azure provider (`model: "anthropic/claude-..."`) and trigger any refusal. Verify no auto-continue fires.
7. Delete `~/.config/opencode/config.json` and set mdium's AI settings to Azure. Trigger a refusal (by swapping the underlying opencode default to Azure via env). Verify fallback path activates auto-continue.
8. During an auto-continue cycle, click abort. Verify no subsequent auto-continue fires and UI stays consistent.

## Files Changed

**New:**
- `src/features/opencode-config/lib/provider-detection.ts`
- `src/features/opencode-config/lib/__tests__/provider-detection.test.ts`

**Modified:**
- `src/features/opencode-config/hooks/useOpencodeChat.ts`
  - Import `isAzureRefusal`, `isAzureProviderActive`
  - Extend `OpencodeMessage` with `isAutoReply?: boolean`
  - Extend `OpencodeChatUIState` with `azureAutoRetryCount: number`
  - Extend `doSendMessage` signature with `options?: SendOptions`
  - Insert refusal-detection block in `processSSEStream` `session.idle` handler
  - Reset counter in `doCreateNewSession`, `doLoadSession`, `doDisconnect`
- `src/features/opencode-config/components/OpencodeChat.tsx`
  - Render auto-reply label for user messages with `isAutoReply === true`
- `src/shared/i18n/locales/ja/opencode-config.json`
  - Add `opencodeAutoReplyLabel`
- `src/shared/i18n/locales/en/opencode-config.json`
  - Add `opencodeAutoReplyLabel`

## Risks

- **False positive detection** blocking legitimate responses that contain apology+refusal phrasing. Mitigated by the 300-char length guard and the AND condition, but not eliminated. Acceptable for v1 given the rarity.
- **Provider detection mismatch:** if the user configures opencode via an agent-specific model override (not the top-level `model`), detection may miss the actual provider. Out of scope for v1; acceptable because the fallback to mdium settings catches the common case.
- **Silent infinite loop impossible:** retry counter hard-limits to 1 auto-reply per consecutive refusal; second consecutive refusal always surfaces to the user.
