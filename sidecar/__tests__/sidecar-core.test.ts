import { describe, it, expect, vi } from "vitest";
import { SidecarCore, type SidecarCoreDeps, type SidecarQueryHandle } from "../sidecar-core";
import type { SidecarOutbound } from "../../src/shared/types/claude-sidecar";

/** A query handle whose async iteration blocks until finish() is called. */
function makeHandle() {
  let release: (() => void) | null = null;
  const done = new Promise<void>((r) => (release = r));
  const handle: SidecarQueryHandle = {
    interrupt: vi.fn(async () => {}),
    async *[Symbol.asyncIterator]() {
      await done;
    },
  };
  return { handle, finish: () => release!() };
}

function setup() {
  const sent: SidecarOutbound[] = [];
  const { handle, finish } = makeHandle();
  let capturedPrompt: AsyncIterable<unknown> | null = null;
  let capturedCanUseTool:
    | ((toolName: string, input: Record<string, unknown>) => Promise<unknown>)
    | null = null;
  const deps: SidecarCoreDeps = {
    startQuery: vi.fn((prompt, _startMsg, canUseTool) => {
      capturedPrompt = prompt;
      capturedCanUseTool = canUseTool;
      return handle;
    }),
    send: (m) => sent.push(m),
  };
  const core = new SidecarCore(deps);
  core.handleLine(
    JSON.stringify({ type: "start_session", cwd: "C:/x", permissionMode: "default" }),
  );
  return { core, sent, deps, finish, handle,
    prompt: () => capturedPrompt!, canUseTool: () => capturedCanUseTool! };
}

describe("SidecarCore", () => {
  it("starts a query on start_session and yields queued user messages in order", async () => {
    const { core, prompt } = setup();
    core.handleLine(JSON.stringify({ type: "user_message", text: "one" }));
    core.handleLine(JSON.stringify({ type: "user_message", text: "two" }));
    const it_ = prompt()[Symbol.asyncIterator]();
    const a = (await it_.next()).value as { message: { content: string } };
    const b = (await it_.next()).value as { message: { content: string } };
    expect(a.message.content).toBe("one");
    expect(b.message.content).toBe("two");
  });

  it("emits permission_request with unique ids and resolves the matching response", async () => {
    const { core, sent, canUseTool } = setup();
    const p1 = canUseTool()("Bash", { command: "ls" });
    const p2 = canUseTool()("Write", { file_path: "a.md" });
    const reqs = sent.filter((m) => m.type === "permission_request");
    expect(reqs).toHaveLength(2);
    expect(reqs[0]).toMatchObject({ toolName: "Bash", input: { command: "ls" } });
    expect(reqs[0].id).not.toBe(reqs[1].id);

    core.handleLine(JSON.stringify({
      type: "permission_response", id: reqs[1].id, behavior: "deny", message: "no",
    }));
    core.handleLine(JSON.stringify({
      type: "permission_response", id: reqs[0].id, behavior: "allow",
    }));
    await expect(p1).resolves.toMatchObject({ behavior: "allow", updatedInput: { command: "ls" } });
    await expect(p2).resolves.toMatchObject({ behavior: "deny", message: "no" });
  });

  it("denies all pending permissions on stop", async () => {
    const { core, sent, canUseTool } = setup();
    const p = canUseTool()("Bash", { command: "rm x" });
    core.handleLine(JSON.stringify({ type: "stop" }));
    await expect(p).resolves.toMatchObject({ behavior: "deny" });
    expect(sent.some((m) => m.type === "session_closed")).toBe(true);
  });

  it("forwards interrupt to the query handle", () => {
    const { core, handle } = setup();
    core.handleLine(JSON.stringify({ type: "interrupt" }));
    expect(handle.interrupt).toHaveBeenCalled();
  });

  it("emits a non-fatal error for malformed JSON lines", () => {
    const { core, sent } = setup();
    core.handleLine("{not json");
    const err = sent.find((m) => m.type === "error");
    expect(err).toBeDefined();
    expect((err as { fatal?: boolean }).fatal).not.toBe(true);
  });
});
