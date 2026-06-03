import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useLocalEmbedding } from "./useLocalEmbedding";
import { useSettingsStore } from "@/stores/settings-store";
import { useTabStore } from "@/stores/tab-store";
import { useChatUIStore } from "@/features/opencode-config/hooks/useOpencodeChat";

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
  const connected = useChatUIStore((s) => s.connected);
  const activeFolderPath = useTabStore((s) => s.activeFolderPath);
  const warmedRef = useRef<string | null>(null);

  // Pre-warm the embedding model when opencode connects so the first rag_search
  // call from the agent doesn't pay the cold-load cost (which can exceed the
  // tool's request timeout). Only warm when an index exists for this folder.
  useEffect(() => {
    if (!connected || !activeFolderPath) return;
    const model = useSettingsStore.getState().ragSettings.embeddingModel;
    const key = `${activeFolderPath}::${model}`;
    if (warmedRef.current === key) return;
    warmedRef.current = key;
    (async () => {
      try {
        const status = await invoke<any>("rag_get_status", {
          folderPath: activeFolderPath,
          modelName: model,
        });
        if ((status?.total_chunks ?? 0) > 0) {
          console.info("[rag-bridge] pre-warming embedding model:", model);
          await load(model);
          console.info("[rag-bridge] embedding model ready");
        }
      } catch {
        // Best-effort pre-warm; the request path will load on demand otherwise.
      }
    })();
  }, [connected, activeFolderPath, load]);

  useEffect(() => {
    let disposed = false;

    const handle = async (req: RagBridgeRequest) => {
      // Read settings at request time so the latest configuration is used.
      const rag = useSettingsStore.getState().ragSettings;
      const model = rag.embeddingModel;
      const searchMode = req.searchMode ?? rag.searchMode;
      const bm25Weight = req.bm25Weight ?? rag.bm25Weight;
      const limit = req.limit ?? rag.retrieveTopK;
      // Use the folder mdium has open as the search root. opencode's
      // context.worktree (req.folderPath) is unreliable — it can be "/", which
      // makes rag_search recursively scan the entire filesystem for sub-indexes
      // (tens of seconds). The active folder is where the index actually lives.
      const folderPath = useTabStore.getState().activeFolderPath || req.folderPath;

      const respond = (payload: any) =>
        invoke("rag_bridge_respond", { id: req.id, payload }).catch((e) =>
          console.error("[rag-bridge] respond failed:", e)
        );

      const work = async (): Promise<BridgeResult[]> => {
        console.info("[rag-bridge] request:", req.query, "| model:", model, "| folder:", folderPath);
        // Guard against a missing/root folder, which would make rag_search walk
        // the whole filesystem looking for sub-indexes (tens of seconds).
        if (!folderPath || folderPath === "/" || folderPath === "\\" || /^[A-Za-z]:[\\/]?$/.test(folderPath)) {
          throw new Error("No document folder is open in mdium to search. Open the folder first.");
        }
        // Never trigger a network download from this invisible path — in a
        // blocked/offline env that can hang indefinitely. Fail fast instead.
        const t0 = performance.now();
        const exists = await invoke<boolean>("rag_check_model", { modelName: model });
        if (!exists) {
          throw new Error(
            `Embedding model "${model}" is not available locally. Open the mdium RAG panel and build the index first.`
          );
        }
        const t1 = performance.now();
        await load(model);
        const t2 = performance.now();
        const embedding = await embed(req.query, "query");
        const t3 = performance.now();
        const allResults = await invoke<any[]>("rag_search", {
          folderPath,
          embedding,
          queryText: req.query,
          limit,
          modelName: model,
          searchMode,
          bm25Weight,
        });
        const t4 = performance.now();
        // Per-phase timing. A large `load` here means the model was cold/reloaded.
        console.info(
          `[rag-bridge] timing(ms): check=${(t1 - t0) | 0} load=${(t2 - t1) | 0} embed=${(t3 - t2) | 0} search=${(t4 - t3) | 0}`
        );
        // In hybrid mode `score` is an RRF score (different scale from cosine),
        // so the cosine-based minScore threshold only applies to vector mode.
        const filtered =
          searchMode === "hybrid"
            ? allResults
            : allResults.filter((r: any) => (r.score ?? 0) >= rag.retrieveMinScore);

        return filtered.map((r: any) => ({
          file: r.file,
          heading: r.heading ?? "",
          content: r.text ?? "",
          line_number: r.line ?? 0,
          score: r.score ?? 0,
        }));
      };

      // Always resolve the bridge request: a hard timeout guarantees the agent
      // gets an answer even if model load or search stalls (shorter than the
      // Rust-side 180s block so the message reaches the tool).
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("RAG search timed out in mdium (model load or search took too long).")),
          120_000
        )
      );

      try {
        const results = await Promise.race([work(), timeout]);
        console.info("[rag-bridge] responding with", results.length, "results");
        await respond({ ok: true, results });
      } catch (e: any) {
        console.error("[rag-bridge] failed:", e);
        await respond({ ok: false, error: e?.message ?? String(e) });
      }
    };

    const unlistenPromise = listen<RagBridgeRequest>("rag-bridge-request", (event) => {
      if (disposed) return;
      // Fire and forget; each request resolves independently via its id.
      void handle(event.payload);
    });
    console.info("[rag-bridge] listener mounted");

    return () => {
      disposed = true;
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, [load, embed]);
}
