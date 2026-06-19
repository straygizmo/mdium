import { useState, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { marked } from "marked";
import { useLocalEmbedding } from "./useLocalEmbedding";
import { useSettingsStore } from "@/stores/settings-store";
import type { AiSettings } from "@/shared/types";

interface RagStatus {
  totalChunks: number;
  totalFiles: number;
  state: "none" | "building" | "ready";
}

interface RagMessage {
  role: "user" | "assistant";
  content: string;
  sources?: { file: string; heading: string; score: number; line: number }[];
}

export interface ChatSession {
  id: string;
  folderPath: string;
  title: string;
  messages: RagMessage[];
  createdAt: string;
  updatedAt: string;
}

interface UseRagFeaturesParams {
  folderPath: string | null;
  aiSettings: AiSettings;
  onOpenFile?: (path: string) => void;
}

const STORAGE_KEY = "mdium-chat-history";

function loadAllSessions(): ChatSession[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveAllSessions(sessions: ChatSession[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions));
}

async function callAI(
  settings: AiSettings,
  systemPrompt: string,
  userMessage: string
): Promise<string> {
  return invoke<string>("ai_chat", {
    req: {
      baseUrl: settings.baseUrl,
      apiKey: settings.apiKey,
      model: settings.model,
      apiFormat: settings.apiFormat,
      azureApiVersion: settings.azureApiVersion ?? "",
      systemPrompt,
      userMessage,
    },
  });
}

interface BuildProgress {
  phase: "scanning" | "preparing" | "embedding" | "saving";
  current: number;
  total: number;
  currentFile: string;
}

export function useRagFeatures({ folderPath, aiSettings, onOpenFile }: UseRagFeaturesParams) {
  const [status, setStatus] = useState<RagStatus>({ totalChunks: 0, totalFiles: 0, state: "none" });
  const [messages, setMessages] = useState<RagMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [buildError, setBuildError] = useState<string | null>(null);
  const [buildProgress, setBuildProgress] = useState<BuildProgress | null>(null);
  const currentSessionId = useRef<string | null>(null);
  const { status: embedStatus, progress: embedProgress, error: embedError, load: loadEmbed, embed, embedBatch, getManualPlacement } = useLocalEmbedding();
  const ragSettings = useSettingsStore((s) => s.ragSettings);

  const persistSession = useCallback((msgs: RagMessage[]) => {
    if (!folderPath || !currentSessionId.current || msgs.length === 0) return;
    const sessions = loadAllSessions();
    const idx = sessions.findIndex((s) => s.id === currentSessionId.current);
    const firstUserMsg = msgs.find((m) => m.role === "user");
    const title = firstUserMsg ? firstUserMsg.content.slice(0, 50) : "";
    const now = new Date().toISOString();
    if (idx >= 0) {
      sessions[idx].messages = msgs;
      sessions[idx].title = title;
      sessions[idx].updatedAt = now;
    } else {
      sessions.push({
        id: currentSessionId.current,
        folderPath,
        title,
        messages: msgs,
        createdAt: now,
        updatedAt: now,
      });
    }
    saveAllSessions(sessions);
  }, [folderPath]);

  const checkStatus = useCallback(async () => {
    if (!folderPath) return;
    try {
      const result = await invoke<any>("rag_get_status", { folderPath, modelName: ragSettings.embeddingModel });
      setStatus({
        totalChunks: result.total_chunks ?? 0,
        totalFiles: result.total_files ?? 0,
        state: result.total_chunks > 0 ? "ready" : "none",
      });
    } catch {
      setStatus({ totalChunks: 0, totalFiles: 0, state: "none" });
    }
  }, [folderPath, ragSettings.embeddingModel]);

  const buildIndex = useCallback(async () => {
    if (!folderPath) return;
    setStatus((s) => ({ ...s, state: "building" }));
    setBuildError(null);

    let unlisten: UnlistenFn | null = null;
    try {
      await loadEmbed(ragSettings.embeddingModel);

      unlisten = await listen<{ current: number; total: number; file: string }>(
        "rag-scan-progress",
        (e) => {
          const { current, total, file } = e.payload;
          const fileName = file.split(/[\\/]/).pop() ?? "";
          // Once the final file is reached, `rag_scan_folder` still has to
          // finish the last file and serialize the entire chunk array back
          // over IPC — a stretch with no progress events. Flip to a
          // transitional "preparing" phase so the badge doesn't appear frozen
          // on "Scanning N/N" during that gap.
          setBuildProgress(
            current >= total
              ? { phase: "preparing", current, total, currentFile: "" }
              : { phase: "scanning", current, total, currentFile: fileName },
          );
        },
      );

      const chunks = await invoke<any[]>("rag_scan_folder", {
        folderPath,
        fileExtensions: ragSettings.fileExtensions,
        minChunkLength: ragSettings.minChunkLength,
        modelName: ragSettings.embeddingModel,
      });

      if (unlisten) {
        unlisten();
        unlisten = null;
      }

      if (chunks.length === 0) {
        console.log("RAG: No changed files to index");
        setBuildProgress(null);
        await checkStatus();
        return;
      }

      const embeddings: number[][] = [];
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const fileName = (chunk.file as string).split(/[\\/]/).pop() ?? "";
        setBuildProgress({ phase: "embedding", current: i + 1, total: chunks.length, currentFile: fileName });
        embeddings.push(await embed(chunk.text, "passage"));
      }

      setBuildProgress({ phase: "saving", current: chunks.length, total: chunks.length, currentFile: "" });

      const withEmbed = chunks.map((c: any, i: number) => ({
        ...c,
        embedding: embeddings[i],
      }));
      const saved = await invoke<number>("rag_save_chunks", { folderPath, chunks: withEmbed, modelName: ragSettings.embeddingModel });
      console.log(`RAG: Saved ${saved} chunks to index`);
      setBuildProgress(null);
      await checkStatus();
    } catch (e: any) {
      console.error("Build index failed:", e);
      // onnxruntime-web aborts surface as a bare number (a WASM heap address)
      // with no usable message. Tag those so the UI can show actionable guidance
      // instead of a meaningless code.
      const msg =
        e instanceof Error
          ? e.message
          : typeof e === "number"
            ? `ENGINE_CRASH:${e}`
            : String(e);
      setBuildError(msg);
      setStatus((s) => ({ ...s, state: "none" }));
      setBuildProgress(null);
    } finally {
      if (unlisten) unlisten();
    }
  }, [folderPath, loadEmbed, embedBatch, checkStatus, ragSettings]);

  const deleteIndex = useCallback(async () => {
    if (!folderPath) return;
    try {
      await invoke("rag_delete_index", { folderPath, modelName: ragSettings.embeddingModel });
      setStatus({ totalChunks: 0, totalFiles: 0, state: "none" });
      setMessages([]);
    } catch (e) {
      console.error("Delete index failed:", e);
    }
  }, [folderPath, ragSettings.embeddingModel]);

  const askQuestion = useCallback(
    async (question: string) => {
      if (!folderPath || !question.trim()) return;

      // Create session if needed
      if (!currentSessionId.current) {
        currentSessionId.current = crypto.randomUUID();
      }

      const newMessages: RagMessage[] = [...messages, { role: "user" as const, content: question }];
      setMessages(newMessages);
      setLoading(true);

      try {
        await loadEmbed(ragSettings.embeddingModel);
        const queryEmbed = await embed(question, "query");
        const allResults = await invoke<any[]>("rag_search", {
          folderPath,
          embedding: queryEmbed,
          queryText: question,
          limit: ragSettings.retrieveTopK,
          modelName: ragSettings.embeddingModel,
          searchMode: ragSettings.searchMode,
          bm25Weight: ragSettings.bm25Weight,
        });
        // In hybrid mode `score` is an RRF score (different scale from cosine),
        // so the cosine-based minScore threshold only applies to vector mode.
        const results =
          ragSettings.searchMode === "hybrid"
            ? allResults
            : allResults.filter((r: any) => (r.score ?? 0) >= ragSettings.retrieveMinScore);

        const context = results
          .map((r: any) => `[${r.file}#${r.heading}]\n${r.text}`)
          .join("\n\n---\n\n");

        const systemPrompt =
          "You are a helpful assistant. Answer the user's question based on the following context from their documents. " +
          "Respond in the same language as the question. Include relevant source references.\n\n" +
          context;

        const answer = await callAI(aiSettings, systemPrompt, question);

        const sources = results.map((r: any) => ({
          file: r.file,
          heading: r.heading ?? "",
          score: r.score ?? 0,
          line: r.line ?? 0,
        }));

        const html = await marked(answer);
        const finalMessages: RagMessage[] = [
          ...newMessages,
          { role: "assistant", content: html, sources },
        ];
        setMessages(finalMessages);
        persistSession(finalMessages);
      } catch (e: any) {
        const errorMessages: RagMessage[] = [
          ...newMessages,
          { role: "assistant", content: `Error: ${e.message ?? String(e)}` },
        ];
        setMessages(errorMessages);
        persistSession(errorMessages);
      } finally {
        setLoading(false);
      }
    },
    [folderPath, aiSettings, loadEmbed, embed, messages, persistSession, ragSettings]
  );

  const saveAndNewChat = useCallback(() => {
    if (messages.length > 0) {
      persistSession(messages);
    }
    setMessages([]);
    currentSessionId.current = null;
  }, [messages, persistSession]);

  const discardAndNewChat = useCallback(() => {
    setMessages([]);
    currentSessionId.current = null;
  }, []);

  const getChatHistory = useCallback((): ChatSession[] => {
    if (!folderPath) return [];
    return loadAllSessions()
      .filter((s) => s.folderPath === folderPath)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }, [folderPath]);

  const loadChat = useCallback((sessionId: string) => {
    const sessions = loadAllSessions();
    const session = sessions.find((s) => s.id === sessionId);
    if (session) {
      setMessages(session.messages);
      currentSessionId.current = session.id;
    }
  }, []);

  const deleteChatSession = useCallback((sessionId: string) => {
    const sessions = loadAllSessions();
    const filtered = sessions.filter((s) => s.id !== sessionId);
    saveAllSessions(filtered);
    // If deleting the currently loaded session, clear messages
    if (currentSessionId.current === sessionId) {
      setMessages([]);
      currentSessionId.current = null;
    }
  }, []);

  return {
    status,
    messages,
    loading,
    buildError,
    buildProgress,
    embedStatus,
    embedProgress,
    embedError,
    getManualPlacement,
    checkStatus,
    buildIndex,
    deleteIndex,
    askQuestion,
    saveAndNewChat,
    discardAndNewChat,
    getChatHistory,
    loadChat,
    deleteChatSession,
    onOpenFile,
  } as const;
}
