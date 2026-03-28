import { useState, useCallback, useRef, useEffect } from "react";

// ---------------------------------------------------------------------------
// Module-level shared state
// ---------------------------------------------------------------------------
let sharedWorker: Worker | null = null;
let sharedWorkerModelName: string | null = null;

/**
 * Map of instance ID → callback. Each hook instance registers its own
 * callback so that EditorPanel and RagPanel don't overwrite each other.
 */
const listeners = new Map<
  number,
  (data: { type: string; text?: string; error?: string }) => void
>();

let nextInstanceId = 1;

function getWorker(modelName: string): Worker {
  if (sharedWorker && sharedWorkerModelName === modelName) {
    return sharedWorker;
  }
  if (sharedWorker) {
    sharedWorker.terminate();
    sharedWorker = null;
    sharedWorkerModelName = null;
  }
  const w = new Worker(
    new URL("../workers/speech-worker.ts", import.meta.url),
    { type: "module" },
  );
  w.onmessage = (e: MessageEvent) => {
    for (const [, cb] of listeners.entries()) {
      cb(e.data);
    }
  };
  sharedWorker = w;
  sharedWorkerModelName = modelName;
  return w;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------
export function useSpeechToText(modelName: string) {
  const [status, setStatus] = useState<"idle" | "loading" | "recording" | "transcribing">("idle");
  const [transcript, setTranscript] = useState("");
  const [partialTranscript] = useState("");
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const chunksRef = useRef<Float32Array[]>([]);
  const workerRef = useRef<Worker | null>(null);

  // Stable instance ID for this hook's lifetime
  const instanceIdRef = useRef<number>(0);
  if (instanceIdRef.current === 0) {
    instanceIdRef.current = nextInstanceId++;
  }
  const instanceId = instanceIdRef.current;

  /**
   * Track what this specific instance is currently waiting for from the worker.
   * null = not waiting, "loaded" = waiting for model load, "result" = waiting for transcription
   */
  const expectingRef = useRef<"loaded" | "result" | null>(null);

  /** Promise resolve/reject for loadModel */
  const loadResolveRef = useRef<(() => void) | null>(null);
  const loadRejectRef = useRef<((err: Error) => void) | null>(null);

  // Register/unregister listener on mount/unmount
  useEffect(() => {
    const handler = (data: { type: string; text?: string; error?: string }) => {
      const expecting = expectingRef.current;
      if (!expecting) return; // Not waiting for anything

      if (expecting === "loaded") {
        if (data.type === "loaded") {
          expectingRef.current = null;
          loadResolveRef.current?.();
          loadResolveRef.current = null;
          loadRejectRef.current = null;
        } else if (data.type === "error") {
          expectingRef.current = null;
          loadRejectRef.current?.(new Error(data.error));
          loadResolveRef.current = null;
          loadRejectRef.current = null;
        }
      } else if (expecting === "result") {
        if (data.type === "result") {
          expectingRef.current = null;
          setTranscript(data.text ?? "");
          setStatus("idle");
        } else if (data.type === "error") {
          expectingRef.current = null;
          console.error("Transcription failed:", data.error);
          setStatus("idle");
        }
      }
    };

    listeners.set(instanceId, handler);
    return () => {
      listeners.delete(instanceId);
      workerRef.current = null;
    };
  }, [instanceId]);

  const loadModel = useCallback((): Promise<void> => {
    return new Promise((resolve, reject) => {
      const worker = getWorker(modelName);
      workerRef.current = worker;

      loadResolveRef.current = resolve;
      loadRejectRef.current = reject;
      expectingRef.current = "loaded";

      worker.postMessage({ type: "load", modelName });
    });
  }, [modelName]);

  const start = useCallback(async () => {
    setStatus("loading");
    try {
      await loadModel();

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { sampleRate: 16000, channelCount: 1 },
      });
      mediaStreamRef.current = stream;

      const audioContext = new AudioContext({ sampleRate: 16000 });
      audioContextRef.current = audioContext;

      const source = audioContext.createMediaStreamSource(stream);
      const processor = audioContext.createScriptProcessor(4096, 1, 1);
      processorRef.current = processor;

      processor.onaudioprocess = (e) => {
        const data = e.inputBuffer.getChannelData(0);
        chunksRef.current.push(new Float32Array(data));
      };

      source.connect(processor);
      processor.connect(audioContext.destination);
      setStatus("recording");
    } catch (e) {
      console.error("Failed to start recording:", e);
      setStatus("idle");
    }
  }, [loadModel]);

  const stop = useCallback(async () => {
    setStatus("transcribing");

    processorRef.current?.disconnect();
    mediaStreamRef.current?.getTracks().forEach((t) => t.stop());
    audioContextRef.current?.close();

    // Combine audio chunks
    const totalLength = chunksRef.current.reduce((acc, c) => acc + c.length, 0);
    const audioData = new Float32Array(totalLength);
    let offset = 0;
    for (const chunk of chunksRef.current) {
      audioData.set(chunk, offset);
      offset += chunk.length;
    }
    chunksRef.current = [];

    // Send to worker
    const worker = workerRef.current;
    if (!worker || audioData.length === 0) {
      setStatus("idle");
      return;
    }

    expectingRef.current = "result";
    worker.postMessage({ type: "transcribe", audioData }, [audioData.buffer]);
  }, []);

  const toggle = useCallback(() => {
    if (status === "recording") {
      stop();
    } else if (status === "idle") {
      start();
    }
  }, [status, start, stop]);

  return { status, transcript, partialTranscript, toggle, setTranscript } as const;
}
