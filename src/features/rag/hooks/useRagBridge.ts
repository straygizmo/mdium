import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useLocalEmbedding } from "./useLocalEmbedding";
import { useSettingsStore } from "@/stores/settings-store";
import { useTabStore } from "@/stores/tab-store";
import { useChatUIStore } from "@/features/opencode-config/hooks/useOpencodeChat";
import { showConfirm } from "@/stores/dialog-store";
import type { RagBridgeRequest } from "@/shared/types/rag-bridge";
import { handleRagBridgeRequest } from "../lib/bridge-handlers";

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

  // Keep the Rust ActiveFolderState in sync so the folder_glob/folder_grep
  // bridge endpoints always scan the folder of the currently active tab.
  useEffect(() => {
    invoke("set_active_folder", { path: activeFolderPath ?? null }).catch((e) =>
      console.warn("[fs-bridge] set_active_folder failed:", e)
    );
  }, [activeFolderPath]);

  useEffect(() => {
    let disposed = false;

    const handle = async (req: RagBridgeRequest) => {
      const respond = (payload: unknown) =>
        invoke("rag_bridge_respond", { id: req.id, payload }).catch((e) =>
          console.error("[rag-bridge] respond failed:", e)
        );

      const work = handleRagBridgeRequest(req, useTabStore.getState().activeFolderPath, {
        embedding: { load, embed },
        confirm: (m, signal) => showConfirm(m, { kind: "warning", signal }),
      });

      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        // Only search gets a hard timeout (shorter than the Rust-side 180s
        // block so the message reaches the tool). Convert/update wait on the
        // user's approval, which has its own timeout in the handler.
        const payload =
          req.kind === "search"
            ? await Promise.race([
                work,
                new Promise<never>((_, reject) => {
                  timer = setTimeout(
                    () => reject(new Error("RAG search timed out in mdium (model load or search took too long).")),
                    120_000
                  );
                }),
              ])
            : await work;
        await respond(payload);
      } catch (e: any) {
        console.error("[rag-bridge] failed:", e);
        await respond({ ok: false, error: "internal", message: e?.message ?? String(e) });
      } finally {
        clearTimeout(timer);
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
