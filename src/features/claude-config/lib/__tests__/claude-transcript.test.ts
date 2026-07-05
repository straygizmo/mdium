import { describe, it, expect } from "vitest";
import { parseTranscript } from "../claude-transcript";
import type { ClaudeToolPart } from "../claude-message-mapper";

/** Build a jsonl string from an array of entry objects. */
function jsonl(entries: unknown[]): string {
  return entries.map((e) => JSON.stringify(e)).join("\n");
}

describe("parseTranscript", () => {
  it("reconstructs user and assistant text turns in order", () => {
    const raw = jsonl([
      { type: "mode", mode: "normal" },
      { type: "user", message: { role: "user", content: "Hello there" } },
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Hi!" }] } },
    ]);
    const messages = parseTranscript(raw);
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("user");
    expect(messages[0].parts[0]).toEqual({ type: "text", text: "Hello there" });
    expect(messages[1].role).toBe("assistant");
    expect(messages[1].parts[0]).toEqual({ type: "text", text: "Hi!" });
  });

  it("closes out tool cards from tool_result user entries", () => {
    const raw = jsonl([
      { type: "user", message: { role: "user", content: "run it" } },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }],
        },
      },
      {
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t1", content: "file.txt" }],
        },
      },
    ]);
    const messages = parseTranscript(raw);
    const toolMsg = messages.find((m) => m.parts.some((p) => p.type === "tool"));
    const tool = toolMsg?.parts.find((p) => p.type === "tool") as ClaudeToolPart;
    expect(tool.done).toBe(true);
    expect(tool.output).toBe("file.txt");
  });

  it("strips the mdium context wrapper from user turns", () => {
    const raw = jsonl([
      {
        type: "user",
        message: {
          role: "user",
          content: '<mdium_context>\nactive_file="a.md"\n</mdium_context>\n\nWhat is this?',
        },
      },
    ]);
    const messages = parseTranscript(raw);
    expect(messages).toHaveLength(1);
    expect(messages[0].parts[0]).toEqual({ type: "text", text: "What is this?" });
  });

  it("skips meta and command/harness noise", () => {
    const raw = jsonl([
      { type: "user", isMeta: true, message: { role: "user", content: "<system-reminder>ctx</system-reminder>" } },
      { type: "user", message: { role: "user", content: "<command-name>/clear</command-name>" } },
      { type: "user", message: { role: "user", content: "<local-command-caveat>noise</local-command-caveat>" } },
      { type: "user", message: { role: "user", content: "Real question" } },
    ]);
    const messages = parseTranscript(raw);
    expect(messages).toHaveLength(1);
    expect(messages[0].parts[0]).toEqual({ type: "text", text: "Real question" });
  });

  it("marks restored messages as non-streaming and tolerates blank/garbage lines", () => {
    const raw = [
      "",
      "not json",
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } }),
    ].join("\n");
    const messages = parseTranscript(raw);
    expect(messages).toHaveLength(1);
    expect(messages[0].streaming).toBe(false);
  });
});
