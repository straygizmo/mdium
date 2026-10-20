// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";

const sendToSidecar = vi.fn(async (_id: number, _msg: unknown) => {});
let onMessage: ((m: unknown) => void) | null = null;

vi.mock("../../lib/claude-sidecar-client", () => ({
  spawnSidecar: vi.fn(async () => 1),
  sendToSidecar: (id: number, msg: unknown) => sendToSidecar(id, msg),
  killSidecar: vi.fn(async () => {}),
  subscribeSidecar: vi.fn(async (_id: number, h: { onMessage: (m: unknown) => void }) => {
    onMessage = h.onMessage;
    return () => {};
  }),
}));
vi.mock("@/shared/lib/ensureCommand", () => ({
  ensureCommand: vi.fn(async () => true),
  NODE_INSTALL_URL: "",
}));
vi.mock("@/features/agent-chat/lib/mdium-rag-mcp", async (orig) => {
  const actual = await orig<typeof import("@/features/agent-chat/lib/mdium-rag-mcp")>();
  return {
    ...actual,
    mdiumRagServerFor: vi.fn(async (_p: string, permission: string) => ({
      "mdium-rag": { command: "node", args: ["x"], env: { MDIUM_RAG_PERMISSION: permission } },
    })),
  };
});

import { doClaudeConnect, killClaudeSidecar } from "../useClaudeChat";
import { useClaudeSessionStore } from "@/stores/claude-session-store";

type StartMsg = {
  type: string;
  mcpServers?: Record<string, { env: Record<string, string> }>;
};

async function startMessageFor(folder: string, permissionMode: string): Promise<StartMsg> {
  vi.spyOn(useClaudeSessionStore.getState(), "getFolderSettings").mockReturnValue({
    model: "",
    permissionMode,
    lastSessionId: null,
  } as never);
  await doClaudeConnect(folder);
  onMessage!({ type: "ready" });
  const find = () =>
    sendToSidecar.mock.calls.map((c) => c[1] as StartMsg).find((m) => m.type === "start_session");
  await vi.waitFor(() => expect(find()).toBeDefined());
  return find()!;
}

describe("useClaudeChat start_session", () => {
  beforeEach(async () => {
    await killClaudeSidecar();
    sendToSidecar.mockClear();
    onMessage = null;
  });

  it("passes mdium-rag with ask permission in default mode", async () => {
    const msg = await startMessageFor("C:/a", "default");
    expect(msg.mcpServers!["mdium-rag"].env.MDIUM_RAG_PERMISSION).toBe("ask");
  });

  it("passes mdium-rag with read-only permission in plan mode", async () => {
    const msg = await startMessageFor("C:/b", "plan");
    expect(msg.mcpServers!["mdium-rag"].env.MDIUM_RAG_PERMISSION).toBe("read-only");
  });
});
