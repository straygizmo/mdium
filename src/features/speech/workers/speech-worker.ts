/**
 * Web Worker for Whisper speech-to-text inference.
 * Runs the heavy ONNX/WASM pipeline off the main thread so the UI stays responsive.
 */

let transcriber: any = null;
let loadedModelName: string | null = null;

interface LoadMessage {
  type: "load";
  modelName: string;
}

interface TranscribeMessage {
  type: "transcribe";
  audioData: Float32Array;
}

type WorkerMessage = LoadMessage | TranscribeMessage;

self.onmessage = async (e: MessageEvent<WorkerMessage>) => {
  const msg = e.data;

  if (msg.type === "load") {
    try {
      // If model changed, discard old pipeline
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

      transcriber = await pipeline(
        "automatic-speech-recognition",
        msg.modelName,
        {
          dtype: "q8",
          revision: "",
        } as any,
      );
      loadedModelName = msg.modelName;
      self.postMessage({ type: "loaded" });
    } catch (err: any) {
      self.postMessage({ type: "error", error: err?.message ?? String(err) });
    }
    return;
  }

  if (msg.type === "transcribe") {
    if (!transcriber) {
      self.postMessage({ type: "error", error: "Model not loaded" });
      return;
    }
    try {
      const result = await transcriber(msg.audioData, { language: "ja" });
      const text =
        typeof result === "string" ? result : (result as any).text ?? "";
      self.postMessage({ type: "result", text: text.replace(/\s+/g, "") });
    } catch (err: any) {
      self.postMessage({ type: "error", error: err?.message ?? String(err) });
    }
    return;
  }
};
