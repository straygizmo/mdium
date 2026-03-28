import { useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";

let pipelineInstance: any = null;
let pipelinePromise: Promise<any> | null = null;
let loadedModelName: string | null = null;

function getPrefix(modelName: string | null, type: "query" | "passage"): string {
  if (modelName && modelName.includes("ruri")) {
    return type === "query" ? "Search query: " : "Search document: ";
  }
  return type === "query" ? "query: " : "passage: ";
}

export function useLocalEmbedding() {
  const [status, setStatus] = useState<
    "idle" | "downloading" | "loading" | "ready" | "error"
  >(pipelineInstance ? "ready" : "idle");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (modelName: string = "Xenova/multilingual-e5-large") => {
    // If a different model is requested, clear the cached pipeline
    if (pipelineInstance && loadedModelName !== modelName) {
      pipelineInstance = null;
      pipelinePromise = null;
      loadedModelName = null;
    }

    if (pipelineInstance) {
      setStatus("ready");
      return;
    }
    if (pipelinePromise) {
      await pipelinePromise;
      setStatus("ready");
      return;
    }

    setStatus("loading");
    setProgress(0);

    pipelinePromise = (async () => {
      try {
        // Check if model exists locally, download if not
        const modelExists = await invoke<boolean>("rag_check_model", { modelName });
        if (!modelExists) {
          setStatus("downloading");
          setProgress(0);
          await invoke("rag_download_model", { modelName });
        }

        setStatus("loading");
        setProgress(10);

        const { pipeline, env } = await import("@huggingface/transformers");

        // Use custom "models" protocol registered in Rust to serve model files
        // On Windows: http://models.localhost/<path>
        env.remoteHost = 'http://models.localhost/';
        env.remotePathTemplate = '{model}/';
        env.allowRemoteModels = true;
        env.allowLocalModels = false;
        env.useBrowserCache = false;

        pipelineInstance = await pipeline(
          "feature-extraction",
          modelName,
          {
            dtype: "q8",
            revision: '',
            progress_callback: (p: any) => {
              if (p.status === "progress" && p.progress != null) {
                setProgress(10 + Math.round(p.progress * 0.9));
              }
            },
          } as any
        );
        loadedModelName = modelName;
        setStatus("ready");
        setProgress(100);
      } catch (e: any) {
        console.error("[RAG] Model load failed:", e);
        const msg = e.message ?? String(e);
        if (msg.includes("NETWORK_ERROR:")) {
          setError("NETWORK_ERROR");
        } else if (msg.includes("DOWNLOAD_ERROR:")) {
          setError("DOWNLOAD_ERROR");
        } else {
          setError(msg);
        }
        setStatus("error");
        pipelinePromise = null;
        throw e;
      }
    })();

    await pipelinePromise;
  }, []);

  const embed = useCallback(async (text: string, type: "query" | "passage" = "query"): Promise<number[]> => {
    if (!pipelineInstance) throw new Error("Model not loaded");
    const prefix = getPrefix(loadedModelName, type);
    const result = await pipelineInstance(`${prefix}${text}`, {
      pooling: "mean",
      normalize: true,
    });
    return Array.from(result.data as Float32Array);
  }, []);

  const embedBatch = useCallback(
    async (texts: string[]): Promise<number[][]> => {
      const results: number[][] = [];
      for (const text of texts) {
        results.push(await embed(text));
      }
      return results;
    },
    [embed]
  );

  return { status, progress, error, load, embed, embedBatch } as const;
}
