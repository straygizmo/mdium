// Entry point: wires RunnerCore to stdin/stdout and the real provider adapters.
// Bundled by scripts/build-agent-runner.mjs into resources/agent-runner/.
import { createInterface } from "node:readline";
import type { RunnerOutbound } from "../../src/shared/types/agent-runner";
import { RunnerCore } from "./runner-core";
import { CodexAdapter } from "./codex-adapter";
import { CopilotAdapter } from "./copilot-adapter";

function send(message: RunnerOutbound): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const core = new RunnerCore({
  adapters: { codex: new CodexAdapter(), copilot: new CopilotAdapter() },
  send,
});

const inFlight = new Set<Promise<void>>();
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const handled = core.handleLine(line).finally(() => inFlight.delete(handled));
  inFlight.add(handled);
});
// When mdium closes stdin, let in-flight requests answer, then cancel every session and exit.
rl.on("close", () => {
  void Promise.allSettled([...inFlight])
    .then(() => core.shutdown())
    .finally(() => process.exit(0));
});
send({ type: "ready" });
