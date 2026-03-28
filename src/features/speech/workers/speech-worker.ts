/**
 * Web Worker for speech-to-text inference (Whisper / Moonshine).
 * Runs the heavy ONNX/WASM pipeline off the main thread so the UI stays responsive.
 *
 * IMPORTANT: onmessage is synchronous and chains async work via a promise queue
 * to prevent concurrent execution when multiple messages arrive while awaiting.
 */

let transcriber: any = null;
let loadedModelName: string | null = null;

function isMoonshine(modelName: string): boolean {
  return modelName.toLowerCase().includes("moonshine");
}

// Promise chain ensures messages are processed one at a time
let chain = Promise.resolve();

self.onmessage = (e: MessageEvent) => {
  const msg = e.data;

  if (msg.type === "load") {
    chain = chain.then(async () => {
      try {
        if (transcriber && loadedModelName !== msg.modelName) {
          transcriber = null;
          loadedModelName = null;
        }
        if (transcriber) {
          self.postMessage({ type: "loaded" });
          return;
        }

        const { pipeline, env } = await import("@huggingface/transformers");
        env.remoteHost = "http://models.localhost/";
        env.remotePathTemplate = "{model}/";
        env.allowRemoteModels = true;
        env.allowLocalModels = false;
        env.useBrowserCache = false;

        const pipelineOptions: Record<string, unknown> = { revision: "" };
        if (!isMoonshine(msg.modelName)) {
          pipelineOptions.dtype = "q8";
        }

        transcriber = await pipeline(
          "automatic-speech-recognition",
          msg.modelName,
          pipelineOptions as any,
        );
        loadedModelName = msg.modelName;
        self.postMessage({ type: "loaded" });
      } catch (err: any) {
        self.postMessage({ type: "error", error: err?.message ?? String(err) });
      }
    });
    return;
  }

  if (msg.type === "transcribe") {
    chain = chain.then(async () => {
      if (!transcriber) {
        self.postMessage({ type: "error", error: "Model not loaded" });
        return;
      }
      try {
        const opts = isMoonshine(loadedModelName ?? "") ? {} : { language: "ja" };
        const result = await transcriber(msg.audioData, opts);
        const text =
          typeof result === "string" ? result : (result as any).text ?? "";
        const processed = isMoonshine(loadedModelName ?? "")
          ? text.trim()
          : text.replace(/\s+/g, "");
        self.postMessage({ type: "result", text: processed });
      } catch (err: any) {
        self.postMessage({ type: "error", error: err?.message ?? String(err) });
      }
    });
    return;
  }
};
