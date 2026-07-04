// sidecar/claude-sidecar.ts
// Entry point: wires SidecarCore to stdin/stdout and the real Agent SDK.
// Bundled by scripts/build-claude-sidecar.mjs into resources/claude-sidecar/.
import { createInterface } from "node:readline";
import { query, type Options, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { SidecarCore, type SidecarCoreDeps } from "./sidecar-core";
import { resolveClaudeExecutable, type ResolvedClaude } from "./resolve-claude";
import type { SidecarOutbound, StartSessionMessage } from "../src/shared/types/claude-sidecar";

function send(msg: SidecarOutbound): void {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

let resolved: ResolvedClaude | null = null;

const deps: SidecarCoreDeps = {
  startQuery(prompt, startMsg: StartSessionMessage, canUseTool) {
    if (!resolved) {
      throw new Error("CLAUDE_CLI_NOT_FOUND");
    }
    const options: Options = {
      cwd: startMsg.cwd,
      permissionMode: startMsg.permissionMode,
      settingSources: ["user", "project", "local"],
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        ...(startMsg.systemPromptAppend ? { append: startMsg.systemPromptAppend } : {}),
      },
      includePartialMessages: true,
      // The installed SDK's CanUseTool callback takes a third `options`
      // argument (signal, toolUseID, requestId, suggestions, ...) that our
      // core's CanUseToolFn does not need; a 2-arg function is structurally
      // assignable to the 3-arg callback type (JS callers may pass extra
      // args the callee ignores).
      canUseTool: (toolName, input) => canUseTool(toolName, input),
      pathToClaudeCodeExecutable: resolved.executablePath,
      ...(resolved.executable ? { executable: resolved.executable } : {}),
      ...(startMsg.model ? { model: startMsg.model } : {}),
      ...(startMsg.resumeSessionId ? { resume: startMsg.resumeSessionId } : {}),
      stderr: (data: string) => process.stderr.write(data),
    };
    // Cast: the SDK's `query()` expects `AsyncIterable<SDKUserMessage>`, whose
    // `message` field is the broader `MessageParam` type; our core only ever
    // produces the minimal `{role:"user", content:string}` shape, which is a
    // structural subtype, but the extra `session_id` field on our
    // `SdkUserMessageLike` and the nominal distance between the two `message`
    // types make a direct assignment too strict for the compiler, hence the
    // cast. Likewise the returned `Query` is narrowed to the minimal
    // `SidecarQueryHandle` (AsyncIterable + interrupt()) shape the core needs.
    return query({
      prompt: prompt as unknown as AsyncIterable<SDKUserMessage>,
      options,
    }) as unknown as ReturnType<SidecarCoreDeps["startQuery"]>;
  },
  send,
};

async function main(): Promise<void> {
  resolved = await resolveClaudeExecutable();
  if (!resolved) {
    // Fatal: mdium shows the "install claude CLI" guidance and stops. Return
    // immediately so `ready` is never sent and, with no readline interface
    // registered, the event loop is empty and the process exits on its own.
    send({ type: "error", message: "CLAUDE_CLI_NOT_FOUND", fatal: true });
    return;
  }
  const core = new SidecarCore(deps);
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    if (line.trim()) core.handleLine(line);
  });
  rl.on("close", () => process.exit(0));
  send({ type: "ready" });
}

void main();
