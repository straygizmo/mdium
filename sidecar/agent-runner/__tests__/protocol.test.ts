import { describe, expect, it } from "vitest";
import { parseInbound } from "../protocol";

const start = {
  type: "start_session",
  requestId: "r1",
  sessionId: "s1",
  provider: "codex",
  workingDirectory: "C:/work",
  permission: "cli-default",
};

describe("parseInbound", () => {
  it("accepts every valid command", () => {
    expect(parseInbound(JSON.stringify({ type: "probe", requestId: "r", provider: "copilot" })).type).toBe("probe");
    expect(parseInbound(JSON.stringify(start))).toMatchObject({ sessionId: "s1", permission: "cli-default" });
    expect(parseInbound(JSON.stringify({ type: "send", sessionId: "s1", text: "hi" })).type).toBe("send");
    expect(parseInbound(JSON.stringify({ type: "cancel", sessionId: "s1" })).type).toBe("cancel");
    expect(parseInbound(JSON.stringify({ type: "respond_permission", sessionId: "s1", permissionId: "p", allow: true })).type).toBe("respond_permission");
    expect(parseInbound(JSON.stringify({ type: "list_sessions", requestId: "r", provider: "copilot", workingDirectory: "C:/w" })).type).toBe("list_sessions");
    expect(parseInbound(JSON.stringify({ type: "close_session", sessionId: "s1" })).type).toBe("close_session");
  });

  it.each([
    ["non-JSON", "not json"],
    ["unknown type", JSON.stringify({ type: "explode" })],
    ["bad permission", JSON.stringify({ ...start, permission: "workspace-write" })],
    ["empty workingDirectory", JSON.stringify({ ...start, workingDirectory: " " })],
    ["missing sessionId", JSON.stringify({ type: "send", text: "hi" })],
    ["non-string text", JSON.stringify({ type: "send", sessionId: "s1", text: 3 })],
    ["non-boolean allow", JSON.stringify({ type: "respond_permission", sessionId: "s1", permissionId: "p", allow: "yes" })],
    ["non-string env value", JSON.stringify({ ...start, env: { A: 1 } })],
    ["negative timeout", JSON.stringify({ ...start, timeoutMs: -5 })],
  ])("rejects %s", (_name, line) => {
    expect(() => parseInbound(line)).toThrow();
  });

  it("accepts all runner providers and the guard option", () => {
    for (const provider of ["codex", "copilot", "opencode", "claude"]) {
      expect(parseInbound(JSON.stringify({ type: "probe", requestId: "r", provider })).type).toBe("probe");
    }
    expect(parseInbound(JSON.stringify({ ...start, provider: "claude", guard: { workspaceRoot: "C:/wt" } })))
      .toMatchObject({ provider: "claude", guard: { workspaceRoot: "C:/wt" } });
  });

  it.each([
    ["guard without workspaceRoot", JSON.stringify({ ...start, guard: {} })],
    ["guard with empty workspaceRoot", JSON.stringify({ ...start, guard: { workspaceRoot: " " } })],
    ["unknown provider", JSON.stringify({ ...start, provider: "gemini" })],
  ])("rejects %s", (_name, line) => {
    expect(() => parseInbound(line)).toThrow();
  });
});
