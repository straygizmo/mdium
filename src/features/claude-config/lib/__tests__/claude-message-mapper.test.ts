import { describe, it, expect } from "vitest";
import {
  emptyChatModel,
  appendUserMessage,
  applySdkEvent,
  type ClaudeToolPart,
} from "../claude-message-mapper";

describe("claude-message-mapper", () => {
  it("captures session id from system init", () => {
    const s = applySdkEvent(emptyChatModel(), {
      type: "system", subtype: "init", session_id: "sess-1",
    });
    expect(s.sessionId).toBe("sess-1");
  });

  it("accumulates stream_event text deltas into a streaming assistant message", () => {
    let s = emptyChatModel();
    const delta = (text: string) => ({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text } },
    });
    s = applySdkEvent(s, delta("Hel"));
    s = applySdkEvent(s, delta("lo"));
    expect(s.messages).toHaveLength(1);
    expect(s.messages[0]).toMatchObject({
      role: "assistant", streaming: true, parts: [{ type: "text", text: "Hello" }],
    });
  });

  it("replaces the streaming placeholder with the complete assistant message", () => {
    let s = applySdkEvent(emptyChatModel(), {
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hel" } },
    });
    s = applySdkEvent(s, {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Hello there" },
          { type: "tool_use", id: "tu-1", name: "Read", input: { file_path: "a.md" } },
        ],
      },
    });
    expect(s.messages).toHaveLength(1);
    expect(s.messages[0].streaming).toBeUndefined();
    expect(s.messages[0].parts[0]).toEqual({ type: "text", text: "Hello there" });
    expect(s.messages[0].parts[1]).toMatchObject({
      type: "tool", id: "tu-1", name: "Read", done: false,
    });
  });

  it("attaches tool results to the matching tool part", () => {
    let s = applySdkEvent(emptyChatModel(), {
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "tu-1", name: "Bash", input: {} }] },
    });
    s = applySdkEvent(s, {
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: "tu-1", content: "ok", is_error: false }],
      },
    });
    const tool = s.messages[0].parts[0] as ClaudeToolPart;
    expect(tool.done).toBe(true);
    expect(tool.output).toBe("ok");
    expect(tool.isError).toBe(false);
  });

  it("result event stops running and records usage", () => {
    let s = { ...emptyChatModel(), running: true };
    s = applySdkEvent(s, {
      type: "result", session_id: "sess-1",
      usage: { input_tokens: 10, output_tokens: 20 },
    });
    expect(s.running).toBe(false);
    expect(s.usage).toEqual({ inputTokens: 10, outputTokens: 20 });
  });

  it("appendUserMessage adds a user message and sets running", () => {
    const s = appendUserMessage(emptyChatModel(), "hi");
    expect(s.messages[0]).toEqual({ role: "user", parts: [{ type: "text", text: "hi" }] });
    expect(s.running).toBe(true);
  });
});
