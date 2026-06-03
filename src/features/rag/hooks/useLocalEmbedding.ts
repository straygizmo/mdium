import { useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { configureLocalWasm } from "@/shared/lib/ort-wasm";

type EmbedFn = (input: string) => Promise<Float32Array>;

let embedFn: EmbedFn | null = null;
let loadedModelName: string | null = null;
let pipelinePromise: Promise<void> | null = null;
let manualPlacementInfo: { dir: string; files: string[] } | null = null;

function getPrefix(modelName: string | null, type: "query" | "passage"): string {
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
      manualPlacementInfo = null;
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
        // Check if model exists locally, download if not. When download is
        // unavailable (offline / blocked network), surface the exact folder and
        // files so the user can place the model manually.
        const modelExists = await invoke<boolean>("rag_check_model", { modelName });
        if (!modelExists) {
          setStatus("downloading");
          setProgress(0);
          try {
            await invoke("rag_download_model", { modelName });
          } catch (dlErr) {
            console.warn("[RAG] model download failed, falling back to manual placement:", dlErr);
            const dir = await invoke<string>("rag_get_model_dir", { modelName });
            const files = await invoke<string[]>("rag_model_required_files", { modelName });
            manualPlacementInfo = { dir, files };
            throw new Error("MODEL_MISSING");
          }
        }

        setStatus("loading");
        setProgress(10);

        const transformers = await import("@huggingface/transformers");
        const { pipeline, env } = transformers;
        configureLocalWasm(env);

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

        const pipe = await pipeline(
          "feature-extraction",
          modelName,
          {
            dtype: "q8",
            revision: "",
            progress_callback: progressCallback,
          } as any
        );
        // ModernBERT models (e.g. ruri-v3) declare model_max_length = 8192. The
        // feature-extraction pipeline truncates only at that limit, so a long
        // chunk can become a multi-thousand-token sequence. On the heavier
        // ruri-v3-130m the global-attention layers then allocate an N^2 buffer
        // that overruns the 32-bit WASM heap inside WebView2 and aborts with an
        // opaque numeric error. Cap the sequence length to the e5 baseline (512),
        // which is known to stay within the memory envelope. Only ever lower an
        // existing limit, never raise it.
        const MAX_SEQUENCE_LENGTH = 512;
        const tokenizer = (pipe as any).tokenizer;
        if (tokenizer && typeof tokenizer.model_max_length === "number") {
          tokenizer.model_max_length = Math.min(
            tokenizer.model_max_length,
            MAX_SEQUENCE_LENGTH
          );
        }

        embedFn = async (input) => {
          const r = await pipe(input, { pooling: "mean", normalize: true });
          return r.data as Float32Array;
        };

        loadedModelName = modelName;
        setStatus("ready");
        setProgress(100);
      } catch (e: any) {
        console.error("[RAG] Model load failed:", e, "typeof:", typeof e, "stack:", e?.stack);
        const msg = e?.message ?? String(e);
        if (msg === "MODEL_MISSING" || msg.includes("MODEL_MISSING")) {
          setError("MODEL_MISSING");
        } else if (msg.includes("NETWORK_ERROR:")) {
          setError("NETWORK_ERROR");
        } else if (msg.includes("DOWNLOAD_ERROR:")) {
          setError("DOWNLOAD_ERROR");
        } else if (typeof e === "number") {
          // A bare numeric throw is a WASM (onnxruntime-web) abort/heap address.
          setError(`ENGINE_CRASH:${e}`);
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

  const getManualPlacement = useCallback(() => manualPlacementInfo, []);
  return { status, progress, error, load, embed, embedBatch, getManualPlacement } as const;
}
