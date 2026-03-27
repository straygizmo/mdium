import { useState, useCallback, useRef, useEffect } from "react";

let sharedWorker: Worker | null = null;
let sharedWorkerModelName: string | null = null;

function getWorker(modelName: string): Worker {
  if (sharedWorker && sharedWorkerModelName === modelName) {
    return sharedWorker;
  }
  // Terminate old worker if model changed
  if (sharedWorker) {
    sharedWorker.terminate();
    sharedWorker = null;
    sharedWorkerModelName = null;
  }
  sharedWorker = new Worker(
    new URL("../workers/speech-worker.ts", import.meta.url),
    { type: "module" },
  );
  sharedWorkerModelName = modelName;
  return sharedWorker;
}

export function useSpeechToText(modelName: string) {
  const [status, setStatus] = useState<"idle" | "loading" | "recording" | "transcribing">("idle");
  const [transcript, setTranscript] = useState("");
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const chunksRef = useRef<Float32Array[]>([]);
  const workerRef = useRef<Worker | null>(null);

  // Cleanup worker listener on unmount
  useEffect(() => {
    return () => {
      workerRef.current = null;
    };
  }, []);

  const loadModel = useCallback((): Promise<void> => {
    return new Promise((resolve, reject) => {
      const worker = getWorker(modelName);
      workerRef.current = worker;

      const handler = (e: MessageEvent) => {
        worker.removeEventListener("message", handler);
        if (e.data.type === "loaded") {
          resolve();
        } else if (e.data.type === "error") {
          reject(new Error(e.data.error));
        }
      };
      worker.addEventListener("message", handler);
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
    // Immediately stop recording and update UI
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

    // Send to worker — inference runs off the main thread
    const worker = workerRef.current;
    if (!worker) {
      setStatus("idle");
      return;
    }

    const handler = (e: MessageEvent) => {
      worker.removeEventListener("message", handler);
      if (e.data.type === "result") {
        setTranscript(e.data.text);
      } else if (e.data.type === "error") {
        console.error("Transcription failed:", e.data.error);
      }
      setStatus("idle");
    };
    worker.addEventListener("message", handler);
    worker.postMessage({ type: "transcribe", audioData }, [audioData.buffer]);
  }, []);

  const toggle = useCallback(() => {
    if (status === "recording") {
      stop();
    } else if (status === "idle") {
      start();
    }
  }, [status, start, stop]);

  return { status, transcript, toggle, setTranscript } as const;
}
