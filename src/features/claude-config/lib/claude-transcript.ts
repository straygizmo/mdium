// Reconstructs a renderable chat model from a Claude Code session transcript
// (the `~/.claude/projects/<cwd>/<id>.jsonl` file). Each `user`/`assistant`
// jsonl entry carries the same `message.content` shape as the live SDK events,
// so we fold them through the same reducer used for streaming — keeping display
// of restored sessions consistent with live ones.

import {
  applySdkEvent,
  appendUserMessage,
  emptyChatModel,
  type ClaudeMessage,
} from "./claude-message-mapper";

/** Drop the mdium context wrapper we prepend to outgoing messages. */
function stripMdiumContext(text: string): string {
  const m = text.match(/^<mdium_context>[\s\S]*?<\/mdium_context>\s*/);
  return m ? text.slice(m[0].length) : text;
}

/** Harness/command scaffolding that should not surface as a user bubble. */
function isNoiseUserText(text: string): boolean {
  return (
    text.startsWith("<local-command") ||
    text.startsWith("<command-") ||
    text.startsWith("<system-reminder") ||
    text.startsWith("[")
  );
}

type AnyRec = Record<string, unknown>;

export function parseTranscript(jsonl: string): ClaudeMessage[] {
  let state = emptyChatModel();

  for (const line of jsonl.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: AnyRec;
    try {
      entry = JSON.parse(trimmed) as AnyRec;
    } catch {
      continue;
    }

    const message = entry.message as AnyRec | undefined;
    if (entry.type === "assistant" && message) {
      // Reuses the reducer: text + tool_use blocks render, thinking is ignored.
      state = applySdkEvent(state, { type: "assistant", message });
    } else if (entry.type === "user" && message) {
      const content = message.content;
      if (Array.isArray(content)) {
        // tool_result blocks close out the matching tool card...
        if ((content as AnyRec[]).some((b) => b?.type === "tool_result")) {
          state = applySdkEvent(state, { type: "user", message });
        }
        // ...and any inline text is a real user turn.
        const text = (content as AnyRec[])
          .filter((b) => b?.type === "text")
          .map((b) => (typeof b.text === "string" ? b.text : ""))
          .join("");
        const cleaned = stripMdiumContext(text).trim();
        if (cleaned && !isNoiseUserText(cleaned)) {
          state = appendUserMessage(state, cleaned);
        }
      } else if (typeof content === "string") {
        if (entry.isMeta) continue;
        const cleaned = stripMdiumContext(content).trim();
        if (!cleaned || isNoiseUserText(cleaned)) continue;
        state = appendUserMessage(state, cleaned);
      }
    }
  }

  return state.messages.map((m) => ({ ...m, streaming: false }));
}
