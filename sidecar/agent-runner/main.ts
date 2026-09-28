// Entry point: wires RunnerCore to stdin/stdout and the real provider adapters.
// Bundled by scripts/build-agent-runner.mjs into resources/agent-runner/.
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { RunnerOutbound } from "../../src/shared/types/agent-runner";
import { convertInWorker, runConversionWorker } from "../doc-converter/convert-worker";
import { RunnerCore } from "./runner-core";
import { CodexAdapter } from "./codex-adapter";
import { CopilotAdapter } from "./copilot-adapter";
import { ClaudeAdapter } from "./claude-adapter";
import { OpencodeAdapter } from "./opencode-adapter";

// This bundle also runs as the document-conversion worker thread
// (convert_document); a worker only runs its job.
if (!runConversionWorker()) startRunner();

function startRunner(): void {
  function send(message: RunnerOutbound): void {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  }

  const core = new RunnerCore({
    adapters: { codex: new CodexAdapter(), copilot: new CopilotAdapter(), claude: new ClaudeAdapter(), opencode: new OpencodeAdapter() },
    send,
    convertDocument: (inputPath, outputPath) => convertInWorker(fileURLToPath(import.meta.url), inputPath, outputPath),
  });

  // Upper bound on how long shutdown may wait for in-flight requests and
  // session closes before exiting anyway, so a hung adapter/CLI cannot leave
  // the process running forever once mdium has asked it to stop.
  const SHUTDOWN_TIMEOUT_MS = 5_000;

  const inFlight = new Set<Promise<void>>();
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    const handled = core
      .handleLine(line)
      .catch((error: unknown) => {
        // Last-resort guard: a bug reaching here must not crash the process or
        // silently drop the request — always answer with an error line.
        send({ type: "error", message: error instanceof Error ? error.message : String(error) });
      })
      .finally(() => inFlight.delete(handled));
    inFlight.add(handled);
  });
  // When mdium closes stdin, let in-flight requests answer, then cancel every session and exit.
  rl.on("close", () => {
    const settled = Promise.allSettled([...inFlight]).then(() => core.shutdown());
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS));
    void Promise.race([settled, timeout]).finally(() => process.exit(0));
  });
  send({ type: "ready" });
}
