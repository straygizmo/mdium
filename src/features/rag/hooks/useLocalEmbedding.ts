import { useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";

type EmbedFn = (input: string) => Promise<Float32Array>;

let embedFn: EmbedFn | null = null;
let loadedModelName: string | null = null;
let pipelinePromise: Promise<void> | null = null;

const isHarrier = (name: string | null): boolean => !!name && name.includes("harrier");

function getDtype(_modelName: string): string {
  // q4f16 is not used because the Tauri WebView2 ONNX Runtime WASM backend fails on fp16 kernels.
  return "q8";
}

function getPrefix(modelName: string | null, type: "query" | "passage"): string {
  if (isHarrier(modelName)) {
    if (type === "query") {
      return "Instruct: Given a question, retrieve relevant markdown notes that answer it\nQuery: ";
    }
    return "";
  }
  if (modelName && modelName.includes("ruri")) {
    return type === "query" ? "Search query: " : "Search document: ";
  }
  return type === "query" ? "query: " : "passage: ";
}

export function useLocalEmbedding() {
  const [status, setStatus] = useState<
    "idle" | "downloading" | "loading" | "ready" | "error"
  >(embedFn ? "ready" : "idle");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (modelName: string = "Xenova/multilingual-e5-large") => {
    // If a different model is requested, clear the cached embed fn
    if (embedFn && loadedModelName !== modelName) {
      embedFn = null;
      pipelinePromise = null;
      loadedModelName = null;
    }

    if (embedFn) {
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

        const transformers = await import("@huggingface/transformers");
        const { pipeline, AutoModel, AutoTokenizer, env } = transformers;

        // Use custom "models" protocol registered in Rust to serve model files
        // On Windows: http://models.localhost/<path>
        env.remoteHost = "http://models.localhost/";
        env.remotePathTemplate = "{model}/";
        env.allowRemoteModels = true;
        env.allowLocalModels = false;
        env.useBrowserCache = false;

        const progressCallback = (p: any) => {
          if (p.status === "progress" && p.progress != null) {
            setProgress(10 + Math.round(p.progress * 0.9));
          }
        };

        if (isHarrier(modelName)) {
          const tokenizer = await AutoTokenizer.from_pretrained(modelName, {
            revision: "",
            progress_callback: progressCallback,
          } as any);
          const model = await AutoModel.from_pretrained(modelName, {
            dtype: getDtype(modelName),
            revision: "",
            progress_callback: progressCallback,
          } as any);
          embedFn = async (input) => {
            const inputs = tokenizer(input, { padding: true, truncation: true });
            const out: any = await (model as any)(inputs);
            // Harrier outputs `sentence_embedding` (last-token pooled + L2-normalized)
            return out.sentence_embedding.data as Float32Array;
          };
        } else {
          const pipe = await pipeline(
            "feature-extraction",
            modelName,
            {
              dtype: getDtype(modelName),
              revision: "",
              progress_callback: progressCallback,
            } as any
          );
          embedFn = async (input) => {
            const r = await pipe(input, { pooling: "mean", normalize: true });
            return r.data as Float32Array;
          };
        }

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
    if (!embedFn) throw new Error("Model not loaded");
    const prefix = getPrefix(loadedModelName, type);
    const data = await embedFn(`${prefix}${text}`);
    return Array.from(data);
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
