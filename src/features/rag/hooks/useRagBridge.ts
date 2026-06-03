import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useLocalEmbedding } from "./useLocalEmbedding";
import { useSettingsStore } from "@/stores/settings-store";

interface RagBridgeRequest {
  id: string;
  folderPath: string;
  query: string;
  limit: number | null;
  searchMode: string | null;
  bm25Weight: number | null;
}

interface BridgeResult {
  file: string;
  heading: string;
  content: string;
  line_number: number;
  score: number;
}

/**
 * Bridges the opencode rag_search tool to the app's embedding + search.
 *
 * The tool POSTs to the local HTTP bridge (/rag/search); the Rust side emits a
 * `rag-bridge-request` event and blocks. Here we embed the query with the user's
 * *configured* model and run the same hybrid search as the RAG panel, then reply
 * via `rag_bridge_respond`. Mount once near the app root.
 */
export function useRagBridge() {
  const { load, embed } = useLocalEmbedding();

  useEffect(() => {
    let disposed = false;

    const handle = async (req: RagBridgeRequest) => {
      // Read settings at request time so the latest configuration is used.
      const rag = useSettingsStore.getState().ragSettings;
      const model = rag.embeddingModel;
      const searchMode = req.searchMode ?? rag.searchMode;
      const bm25Weight = req.bm25Weight ?? rag.bm25Weight;
      const limit = req.limit ?? rag.retrieveTopK;

      try {
        await load(model);
        const embedding = await embed(req.query, "query");
        const allResults = await invoke<any[]>("rag_search", {
          folderPath: req.folderPath,
          embedding,
          queryText: req.query,
          limit,
          modelName: model,
          searchMode,
          bm25Weight,
        });
        // In hybrid mode `score` is an RRF score (different scale from cosine),
        // so the cosine-based minScore threshold only applies to vector mode.
        const filtered =
          searchMode === "hybrid"
            ? allResults
            : allResults.filter((r: any) => (r.score ?? 0) >= rag.retrieveMinScore);

        const results: BridgeResult[] = filtered.map((r: any) => ({
          file: r.file,
          heading: r.heading ?? "",
          content: r.text ?? "",
          line_number: r.line ?? 0,
          score: r.score ?? 0,
        }));

        await invoke("rag_bridge_respond", { id: req.id, payload: { ok: true, results } });
      } catch (e: any) {
        await invoke("rag_bridge_respond", {
          id: req.id,
          payload: { ok: false, error: e?.message ?? String(e) },
        });
      }
    };

    const unlistenPromise = listen<RagBridgeRequest>("rag-bridge-request", (event) => {
      if (disposed) return;
      // Fire and forget; each request resolves independently via its id.
      void handle(event.payload);
    });

    return () => {
      disposed = true;
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, [load, embed]);
}
