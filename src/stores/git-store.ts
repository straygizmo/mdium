import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { AiSettings } from "@/shared/types";
import type { Language } from "@/stores/settings-store";
import { COMMIT_MESSAGE_PROMPT } from "@/shared/lib/constants";
import { parseStatusPorcelain, parseBranchList } from "@/features/git/lib/parse-status";
import type { GitFileEntry } from "@/features/git/lib/parse-status";
import { parseLogOutput, parseDiffTree } from "@/features/git/lib/parse-log";
import { computeGraphLanes } from "@/features/git/lib/graph-lanes";
import type { GraphCommit } from "@/features/git/lib/graph-lanes";
import type { CommitFileEntry } from "@/features/git/lib/parse-log";
import { getOpencodeClient } from "@/features/opencode-config/hooks/useOpencodeChat";
import { useChatUIStore } from "@/features/opencode-config/hooks/useOpencodeChat";

const DIFF_TRUNCATE_LIMIT = 8000;

/** Helper: generate commit message via OpenCode SDK (ephemeral session + polling) */
async function generateViaOpencode(prompt: string): Promise<string | null> {
  const client = getOpencodeClient();
  if (!client || !useChatUIStore.getState().connected) return null;

  try {
    // Create ephemeral session (not stored in chat UI)
    const createRes = await client.session.create({
      body: { title: "commit-msg" },
    });
    const sessionData = createRes.data as any;
    const sessionId = sessionData?.id;
    if (!sessionId) return null;

    // Send prompt asynchronously
    await client.session.promptAsync({
      path: { id: sessionId },
      body: { parts: [{ type: "text", text: prompt }] },
    });

    // Poll session.messages until assistant response appears (max 30s)
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const msgRes = await client.session.messages({ path: { id: sessionId } });
      const msgs = msgRes.data as any;
      const msgArray = Array.isArray(msgs) ? msgs : [];
      // Find the last assistant message
      for (let j = msgArray.length - 1; j >= 0; j--) {
        const info = msgArray[j].info ?? msgArray[j];
        if (info.role === "assistant") {
          const parts = msgArray[j].parts ?? [];
          const text = parts
            .filter((p: any) => p.type === "text")
            .map((p: any) => p.text ?? "")
            .join("")
            .trim();
          if (text) return text;
        }
      }
    }
    return null;
  } catch {
    return null; // Fall through to ai_chat
  }
}

interface GitState {
  files: GitFileEntry[];
  currentBranch: string;
  branches: string[];
  commitMessage: string;
  loading: boolean;
  generating: boolean;
  error: string | null;
  isRepo: boolean;
  remoteUrl: string;
  commitsAhead: number;
  graphCommits: GraphCommit[];
  graphOutgoing: GraphCommit[];
  graphLoading: boolean;
  graphSkip: number;
  graphHasMore: boolean;
  expandedCommit: string | null;
  expandedFiles: CommitFileEntry[];

  refresh: (folderPath: string) => Promise<void>;
  initRepo: (folderPath: string) => Promise<void>;
  getRemoteUrl: (folderPath: string) => Promise<void>;
  setRemoteUrl: (folderPath: string, url: string) => Promise<void>;
  stageFiles: (folderPath: string, files: string[]) => Promise<void>;
  unstageFiles: (folderPath: string, files: string[]) => Promise<void>;
  commit: (folderPath: string) => Promise<void>;
  push: (folderPath: string) => Promise<void>;
  switchBranch: (folderPath: string, branch: string) => Promise<void>;
  discardFiles: (folderPath: string, files: string[], untracked: string[]) => Promise<void>;
  generateCommitMessage: (
    folderPath: string,
    settings: AiSettings,
    language: Language,
  ) => Promise<void>;
  setCommitMessage: (msg: string) => void;
  clearError: () => void;
  refreshGraph: (folderPath: string) => Promise<void>;
  loadMoreGraph: (folderPath: string) => Promise<void>;
  toggleCommitExpand: (folderPath: string, hash: string) => Promise<void>;
}

export const useGitStore = create<GitState>()((set, get) => ({
  files: [],
  currentBranch: "",
  branches: [],
  commitMessage: "",
  loading: false,
  generating: false,
  error: null,
  isRepo: false,
  remoteUrl: "",
  commitsAhead: 0,
  graphCommits: [],
  graphOutgoing: [],
  graphLoading: false,
  graphSkip: 0,
  graphHasMore: true,
  expandedCommit: null,
  expandedFiles: [],

  refresh: async (folderPath) => {
    set({ loading: true, error: null });
    try {
      const [statusOut, branchOut] = await Promise.all([
        invoke<string>("git_status_porcelain", { path: folderPath }),
        invoke<string>("git_branch_list", { path: folderPath }).catch(() => ""),
      ]);
      const files = parseStatusPorcelain(statusOut);
      let { current, branches } = parseBranchList(branchOut);
      // git branch -a is empty before first commit; fall back to --show-current
      if (!current) {
        try {
          const name = await invoke<string>("git_current_branch", { path: folderPath });
          current = name.trim();
          if (current && !branches.includes(current)) {
            branches = [current, ...branches];
          }
        } catch { /* ignore */ }
      }
      set({ files, currentBranch: current, branches, isRepo: true });
      // Also fetch remote URL and commits ahead count
      get().getRemoteUrl(folderPath);
      invoke<number>("git_commits_ahead", { path: folderPath })
        .then((n) => {
          set({ commitsAhead: n });
          get().refreshGraph(folderPath);
        })
        .catch(() => set({ commitsAhead: 0 }));
    } catch (e: any) {
      set({ files: [], currentBranch: "", branches: [], isRepo: false, remoteUrl: "", commitsAhead: 0, graphCommits: [], graphOutgoing: [], graphHasMore: false });
    } finally {
      set({ loading: false });
    }
  },

  initRepo: async (folderPath) => {
    set({ error: null, loading: true });
    try {
      await invoke("git_init", { path: folderPath });
      set({ isRepo: true });
      await get().refresh(folderPath);
    } catch (e: any) {
      set({ error: String(e) });
    } finally {
      set({ loading: false });
    }
  },

  getRemoteUrl: async (folderPath) => {
    try {
      const url = await invoke<string>("git_get_remote_url", { path: folderPath });
      set({ remoteUrl: url.trim() });
    } catch {
      set({ remoteUrl: "" });
    }
  },

  setRemoteUrl: async (folderPath, url) => {
    set({ error: null });
    try {
      await invoke("git_set_remote_url", { path: folderPath, url });
      set({ remoteUrl: url });
    } catch (e: any) {
      set({ error: String(e) });
    }
  },

  stageFiles: async (folderPath, files) => {
    set({ error: null });
    try {
      await invoke("git_add", { path: folderPath, files });
      await get().refresh(folderPath);
    } catch (e: any) {
      set({ error: String(e) });
    }
  },

  unstageFiles: async (folderPath, files) => {
    set({ error: null });
    try {
      await invoke("git_restore_staged", { path: folderPath, files });
      await get().refresh(folderPath);
    } catch (e: any) {
      set({ error: String(e) });
    }
  },

  commit: async (folderPath) => {
    const { commitMessage, files } = get();
    if (!commitMessage.trim()) {
      set({ error: "errorEmptyMessage" });
      return;
    }
    set({ error: null, loading: true });
    try {
      // Auto-stage all changes if nothing is staged (VS Code behavior)
      const hasStaged = files.some((f) => f.staged);
      if (!hasStaged && files.length > 0) {
        await invoke("git_add_all", { path: folderPath });
      }
      await invoke("git_commit", { path: folderPath, message: commitMessage });
      set({ commitMessage: "" });
      await get().refresh(folderPath);
    } catch (e: any) {
      set({ error: String(e) });
    } finally {
      set({ loading: false });
    }
  },

  push: async (folderPath) => {
    set({ error: null, loading: true });
    try {
      try {
        await invoke("git_push", { path: folderPath });
      } catch (e: any) {
        const errMsg = String(e);
        // Retry with upstream if no tracking branch
        if (errMsg.includes("no upstream") || errMsg.includes("has no upstream")) {
          const { currentBranch } = get();
          await invoke("git_push_upstream", {
            path: folderPath,
            branch: currentBranch,
          });
        } else {
          throw e;
        }
      }
      await get().refresh(folderPath);
    } catch (e: any) {
      set({ error: String(e) });
    } finally {
      set({ loading: false });
    }
  },

  switchBranch: async (folderPath, branch) => {
    set({ error: null, loading: true });
    try {
      await invoke("git_switch", { path: folderPath, branch });
      await get().refresh(folderPath);
    } catch (e: any) {
      set({ error: String(e) });
    } finally {
      set({ loading: false });
    }
  },

  discardFiles: async (folderPath, files, untracked) => {
    set({ error: null });
    try {
      if (files.length > 0) {
        await invoke("git_discard", { path: folderPath, files });
      }
      if (untracked.length > 0) {
        await invoke("git_remove_untracked", { path: folderPath, files: untracked });
      }
      await get().refresh(folderPath);
    } catch (e: any) {
      set({ error: String(e) });
    }
  },

  generateCommitMessage: async (folderPath, settings, language) => {
    set({ generating: true, error: null });
    try {
      const [stagedDiff, unstagedDiff, logOut] = await Promise.all([
        invoke<string>("git_diff_staged", { path: folderPath }),
        invoke<string>("git_diff_unstaged", { path: folderPath }),
        invoke<string>("git_log_oneline", { path: folderPath, count: 10 }).catch(
          () => "",
        ),
      ]);

      const diffOut = stagedDiff.trim() ? stagedDiff : unstagedDiff;
      if (!diffOut.trim()) {
        set({ error: "noStagedChanges", generating: false });
        return;
      }

      let diff = diffOut;
      if (diff.length > DIFF_TRUNCATE_LIMIT) {
        diff =
          diff.slice(0, DIFF_TRUNCATE_LIMIT) +
          `\n... (truncated, ${diffOut.length} chars total)`;
      }

      const userMessage = [
        `Language: ${language}`,
        "Write the commit message in the above language.",
        "",
        "## Staged Diff",
        diff,
        "",
        "## Recent Commits",
        logOut || "(no commits yet)",
      ].join("\n");

      const fullPrompt = `${COMMIT_MESSAGE_PROMPT}\n\n${userMessage}`;

      // Try OpenCode first if connected, fall back to ai_chat
      let result = await generateViaOpencode(fullPrompt);

      if (!result) {
        result = await invoke<string>("ai_chat", {
          req: {
            baseUrl: settings.baseUrl,
            apiKey: settings.apiKey,
            model: settings.model,
            apiFormat: settings.apiFormat,
            azureApiVersion: settings.azureApiVersion ?? "",
            systemPrompt: COMMIT_MESSAGE_PROMPT,
            userMessage,
          },
        });
      }

      if (result) {
        set({ commitMessage: result.trim() });
      }
    } catch (e: any) {
      set({ error: String(e) });
    } finally {
      set({ generating: false });
    }
  },

  setCommitMessage: (msg) => set({ commitMessage: msg }),
  clearError: () => set({ error: null }),

  refreshGraph: async (folderPath) => {
    set({ graphLoading: true });
    try {
      // Fetch latest remote refs before loading the graph
      await invoke<string>("git_fetch", { path: folderPath }).catch(() => {});
      // Re-query commitsAhead since fetch may have updated tracking refs
      const commitsAhead = await invoke<number>("git_commits_ahead", {
        path: folderPath,
      }).catch(() => 0);
      set({ commitsAhead });
      const logOut = await invoke<string>("git_log_graph", {
        path: folderPath,
        count: 100,
        skip: 0,
      });
      const raw = parseLogOutput(logOut);
      const all = computeGraphLanes(raw);

      // Split into outgoing (unpushed) and history
      const outgoing = all.slice(0, commitsAhead);
      const history = all.slice(commitsAhead);

      set({
        graphCommits: history,
        graphOutgoing: outgoing,
        graphSkip: 100,
        graphHasMore: raw.length >= 100,
        expandedCommit: null,
        expandedFiles: [],
      });
    } catch {
      set({ graphCommits: [], graphOutgoing: [], graphHasMore: false });
    } finally {
      set({ graphLoading: false });
    }
  },

  loadMoreGraph: async (folderPath) => {
    const { graphSkip, graphCommits, graphOutgoing } = get();
    set({ graphLoading: true });
    try {
      const logOut = await invoke<string>("git_log_graph", {
        path: folderPath,
        count: 100,
        skip: graphSkip,
      });
      const raw = parseLogOutput(logOut);
      // Recompute lanes for the full list
      const existingRaw = [...graphOutgoing, ...graphCommits].map((c) => ({
        hash: c.hash,
        shortHash: c.shortHash,
        author: c.author,
        date: c.date,
        message: c.message,
        parents: c.parents,
        refs: c.refs,
      }));
      const allRaw = [...existingRaw, ...raw];
      const all = computeGraphLanes(allRaw);

      const { commitsAhead } = get();
      const outgoing = all.slice(0, commitsAhead);
      const history = all.slice(commitsAhead);

      set({
        graphCommits: history,
        graphOutgoing: outgoing,
        graphSkip: graphSkip + 100,
        graphHasMore: raw.length >= 100,
      });
    } catch {
      set({ graphHasMore: false });
    } finally {
      set({ graphLoading: false });
    }
  },

  toggleCommitExpand: async (folderPath, hash) => {
    const { expandedCommit } = get();
    if (expandedCommit === hash) {
      set({ expandedCommit: null, expandedFiles: [] });
      return;
    }
    try {
      const out = await invoke<string>("git_diff_commit", {
        path: folderPath,
        hash,
      });
      set({ expandedCommit: hash, expandedFiles: parseDiffTree(out) });
    } catch {
      set({ expandedCommit: null, expandedFiles: [] });
    }
  },
}));
