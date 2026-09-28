// Runs a document conversion on a worker thread, so a large document does not
// stall the host's event loop (the agent runner keeps streaming sessions while
// it converts). The worker is started from the host's own bundle file: the
// host's entry point calls `runConversionWorker()` when it is not the main
// thread.
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { convertFileToMarkdown } from "./convert-file";
import { routeConsoleToStderr } from "./node-env";

/** Upper bound on one conversion; the worker is terminated after it. */
export const CONVERT_TIMEOUT_MS = 5 * 60_000;

interface ConvertJob {
  kind: "mdium-convert-document";
  inputPath: string;
  outputPath: string;
}

type ConvertReply = { ok: true; markdownPath: string } | { ok: false; error: string };

function isConvertJob(value: unknown): value is ConvertJob {
  return !!value && typeof value === "object" && (value as ConvertJob).kind === "mdium-convert-document";
}

/**
 * Convert `inputPath` to `outputPath` on a worker thread running `scriptPath`
 * (the caller's bundle). Resolves with the Markdown path.
 */
export function convertInWorker(
  scriptPath: string,
  inputPath: string,
  outputPath: string,
  timeoutMs: number = CONVERT_TIMEOUT_MS,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const job: ConvertJob = { kind: "mdium-convert-document", inputPath, outputPath };
    const worker = new Worker(scriptPath, { workerData: job, stdout: true });
    // Nothing a library prints may reach the host's stdout protocol.
    worker.stdout.on("data", (chunk: Buffer) => process.stderr.write(chunk));
    let settled = false;
    const finish = (error: Error | undefined, markdownPath?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      if (error) reject(error);
      else resolve(markdownPath as string);
    };
    const timer = setTimeout(() => finish(new Error("conversion timed out")), timeoutMs);
    worker.once("message", (reply: ConvertReply) => {
      if (reply.ok) finish(undefined, reply.markdownPath);
      else finish(new Error(reply.error));
    });
    worker.once("error", (error: unknown) => finish(error instanceof Error ? error : new Error(String(error))));
    worker.once("exit", (code) => finish(new Error(`conversion worker exited with code ${code}`)));
  });
}

/**
 * When this thread is a conversion worker, run its job and return true; the
 * caller must then skip its own startup. Returns false on the main thread.
 */
export function runConversionWorker(): boolean {
  if (isMainThread || !isConvertJob(workerData)) return false;
  routeConsoleToStderr();
  const job = workerData;
  convertFileToMarkdown(job.inputPath, job.outputPath).then(
    ({ markdownPath }) => parentPort?.postMessage({ ok: true, markdownPath } satisfies ConvertReply),
    (error: unknown) =>
      parentPort?.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) } satisfies ConvertReply),
  );
  return true;
}
