// Pure reducer that folds raw Agent SDK messages (passed through the sidecar
// as sdk_event) into a renderable chat model. Keeping this pure isolates the
// UI from SDK message-shape changes and makes it unit-testable.

export interface ClaudeTextPart {
  type: "text";
  text: string;
}
export interface ClaudeToolPart {
  type: "tool";
  id: string;
  name: string;
  input: unknown;
  output?: string;
  isError?: boolean;
  done: boolean;
}
export type ClaudePart = ClaudeTextPart | ClaudeToolPart;

export interface ClaudeMessage {
  role: "user" | "assistant";
  parts: ClaudePart[];
  streaming?: boolean;
}

export interface ChatModelState {
  sessionId: string | null;
  messages: ClaudeMessage[];
  running: boolean;
  usage: { inputTokens: number; outputTokens: number } | null;
}

export function emptyChatModel(): ChatModelState {
  return { sessionId: null, messages: [], running: false, usage: null };
}

export function appendUserMessage(state: ChatModelState, text: string): ChatModelState {
  return {
    ...state,
    running: true,
    messages: [...state.messages, { role: "user", parts: [{ type: "text", text }] }],
  };
}

type AnyRec = Record<string, unknown>;

function contentBlocks(event: AnyRec): AnyRec[] {
  const message = event.message as AnyRec | undefined;
  const content = message?.content;
  return Array.isArray(content) ? (content as AnyRec[]) : [];
}

function toolResultText(block: AnyRec): string {
  const content = block.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return (content as AnyRec[])
      .map((c) => (typeof c.text === "string" ? c.text : ""))
      .join("");
  }
  return "";
}

function dropStreamingPlaceholder(messages: ClaudeMessage[]): ClaudeMessage[] {
  const last = messages[messages.length - 1];
  return last?.streaming ? messages.slice(0, -1) : messages;
}

export function applySdkEvent(state: ChatModelState, event: AnyRec): ChatModelState {
  switch (event.type) {
    case "system": {
      if (event.subtype === "init" && typeof event.session_id === "string") {
        return { ...state, sessionId: event.session_id };
      }
      return state;
    }

    case "stream_event": {
      const inner = event.event as AnyRec | undefined;
      const delta = inner?.delta as AnyRec | undefined;
      if (inner?.type !== "content_block_delta" || delta?.type !== "text_delta") return state;
      const text = typeof delta.text === "string" ? delta.text : "";
      if (!text) return state;
      const messages = [...state.messages];
      const last = messages[messages.length - 1];
      if (last?.streaming) {
        const firstPart = last.parts[0] as ClaudeTextPart;
        messages[messages.length - 1] = {
          ...last,
          parts: [{ type: "text", text: firstPart.text + text }],
        };
      } else {
        messages.push({ role: "assistant", streaming: true, parts: [{ type: "text", text }] });
      }
      return { ...state, messages };
    }

    case "assistant": {
      const parts: ClaudePart[] = [];
      for (const block of contentBlocks(event)) {
        if (block.type === "text" && typeof block.text === "string" && block.text) {
          parts.push({ type: "text", text: block.text });
        } else if (block.type === "tool_use") {
          parts.push({
            type: "tool",
            id: String(block.id ?? ""),
            name: String(block.name ?? ""),
            input: block.input,
            done: false,
          });
        }
      }
      if (parts.length === 0) return state;
      return {
        ...state,
        messages: [...dropStreamingPlaceholder(state.messages), { role: "assistant", parts }],
      };
    }

    case "user": {
      // Tool results echo back as user messages containing tool_result blocks.
      let messages = state.messages;
      for (const block of contentBlocks(event)) {
        if (block.type !== "tool_result") continue;
        const toolUseId = String(block.tool_use_id ?? "");
        messages = messages.map((m) => ({
          ...m,
          parts: m.parts.map((p) =>
            p.type === "tool" && p.id === toolUseId
              ? {
                  ...p,
                  done: true,
                  output: toolResultText(block),
                  isError: block.is_error === true,
                }
              : p,
          ),
        }));
      }
      return messages === state.messages ? state : { ...state, messages };
    }

    case "result": {
      const usage = event.usage as AnyRec | undefined;
      return {
        ...state,
        running: false,
        messages: dropStreamingPlaceholder(state.messages).map((m) => ({ ...m })),
        sessionId: typeof event.session_id === "string" ? event.session_id : state.sessionId,
        usage:
          usage &&
          typeof usage.input_tokens === "number" &&
          typeof usage.output_tokens === "number"
            ? { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens }
            : state.usage,
      };
    }

    default:
      return state;
  }
}
