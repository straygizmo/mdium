# Git Source Control Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a VS Code-style Source Control panel with file-level staging, commit, push, branch switching, and AI-powered commit message generation.

**Architecture:** Extend the existing Rust `git.rs` with new system git commands, add a Zustand store for git state, build React components for the Source Control panel in the left sidebar, and integrate AI commit message generation via the existing `ai_chat` Tauri command with OpenCode SDK fallback.

**Tech Stack:** Tauri 2 (Rust), React 19, TypeScript, Zustand, i18next, @opencode-ai/sdk

**Spec:** `docs/superpowers/specs/2026-03-26-git-source-control-design.md`

---

### Task 1: Add new Rust git commands

**Files:**
- Modify: `src-tauri/src/commands/git.rs`
- Modify: `src-tauri/src/lib.rs:96-169` (invoke_handler registration)

- [ ] **Step 1: Add `git_status_porcelain` command**

In `src-tauri/src/commands/git.rs`, add after the existing `git_status` function:

```rust
#[tauri::command]
pub fn git_status_porcelain(path: String) -> Result<String, String> {
    run_git(&path, &["status", "--porcelain=v1"])
}
```

- [ ] **Step 2: Add `git_add` command for file-level staging**

```rust
#[tauri::command]
pub fn git_add(path: String, files: Vec<String>) -> Result<String, String> {
    let mut args = vec!["add", "--"];
    let file_refs: Vec<&str> = files.iter().map(|s| s.as_str()).collect();
    args.extend(file_refs);
    run_git(&path, &args)
}
```

- [ ] **Step 3: Add `git_restore_staged` command**

This must handle the edge case where `restore --staged` fails on new files (no prior commit). Fall back to `git rm --cached`.

```rust
#[tauri::command]
pub fn git_restore_staged(path: String, files: Vec<String>) -> Result<String, String> {
    let mut args = vec!["restore", "--staged", "--"];
    let file_refs: Vec<&str> = files.iter().map(|s| s.as_str()).collect();
    args.extend(file_refs.iter().copied());
    run_git(&path, &args).or_else(|_| {
        let mut fallback = vec!["rm", "--cached", "--"];
        fallback.extend(file_refs);
        run_git(&path, &fallback)
    })
}
```

- [ ] **Step 4: Add `git_diff_staged` command**

```rust
#[tauri::command]
pub fn git_diff_staged(path: String) -> Result<String, String> {
    run_git(&path, &["diff", "--staged"])
}
```

- [ ] **Step 5: Add `git_log_oneline` command**

```rust
#[tauri::command]
pub fn git_log_oneline(path: String, count: u32) -> Result<String, String> {
    let n = format!("-{}", count);
    run_git(&path, &["log", "--oneline", &n])
}
```

- [ ] **Step 6: Add `git_branch_list` command**

```rust
#[tauri::command]
pub fn git_branch_list(path: String) -> Result<String, String> {
    run_git(&path, &["branch", "-a", "--no-color"])
}
```

- [ ] **Step 7: Add `git_switch` command**

```rust
#[tauri::command]
pub fn git_switch(path: String, branch: String) -> Result<String, String> {
    run_git(&path, &["switch", &branch])
}
```

- [ ] **Step 8: Add `git_discard` command**

```rust
#[tauri::command]
pub fn git_discard(path: String, files: Vec<String>) -> Result<String, String> {
    let mut args = vec!["restore", "--"];
    let file_refs: Vec<&str> = files.iter().map(|s| s.as_str()).collect();
    args.extend(file_refs);
    run_git(&path, &args)
}
```

- [ ] **Step 9: Add `git_remove_untracked` command**

```rust
#[tauri::command]
pub fn git_remove_untracked(path: String, files: Vec<String>) -> Result<String, String> {
    let mut args = vec!["clean", "-f", "--"];
    let file_refs: Vec<&str> = files.iter().map(|s| s.as_str()).collect();
    args.extend(file_refs);
    run_git(&path, &args)
}
```

- [ ] **Step 10: Add `git_push_upstream` command**

```rust
#[tauri::command]
pub fn git_push_upstream(path: String, branch: String) -> Result<String, String> {
    run_git(&path, &["push", "-u", "origin", &branch])
}
```

- [ ] **Step 11: Register all new commands in `lib.rs`**

In `src-tauri/src/lib.rs`, add to the `invoke_handler` block after the existing git commands (line ~126):

```rust
commands::git::git_status_porcelain,
commands::git::git_add,
commands::git::git_restore_staged,
commands::git::git_diff_staged,
commands::git::git_log_oneline,
commands::git::git_branch_list,
commands::git::git_switch,
commands::git::git_discard,
commands::git::git_remove_untracked,
commands::git::git_push_upstream,
```

- [ ] **Step 12: Verify Rust compilation**

Run: `cd src-tauri && cargo check`
Expected: no errors

- [ ] **Step 13: Commit**

```bash
git add src-tauri/src/commands/git.rs src-tauri/src/lib.rs
git commit -m "feat(git): add Tauri commands for source control operations"
```

---

### Task 2: Add i18n translation files

**Files:**
- Create: `src/shared/i18n/locales/ja/git.json`
- Create: `src/shared/i18n/locales/en/git.json`
- Modify: `src/shared/i18n/index.ts`

- [ ] **Step 1: Create Japanese translation file**

Create `src/shared/i18n/locales/ja/git.json`:

```json
{
  "sourceControl": "ソース管理",
  "stagedChanges": "ステージ済みの変更",
  "changes": "変更",
  "commitMessage": "コミットメッセージ",
  "commitMessagePlaceholder": "メッセージを入力 (Enter でコミット)",
  "commit": "コミット",
  "push": "プッシュ",
  "generateAI": "AI生成",
  "generating": "生成中...",
  "stageAll": "すべてステージ",
  "unstageAll": "すべてアンステージ",
  "stageFile": "ファイルをステージ",
  "unstageFile": "ファイルをアンステージ",
  "discardChanges": "変更を破棄",
  "discardConfirmTitle": "変更を破棄しますか？",
  "discardConfirmMessage": "この操作は元に戻せません。選択したファイルの変更が失われます。",
  "discardConfirmOk": "破棄",
  "discardConfirmCancel": "キャンセル",
  "switchBranch": "ブランチを切り替え",
  "switchBranchWarning": "未コミットの変更があります。ブランチを切り替えますか？",
  "noChanges": "変更はありません",
  "noStagedChanges": "ステージ済みの変更がありません",
  "notGitRepo": "Gitリポジトリではありません",
  "errorNoApiKey": "AIプロバイダが設定されていません",
  "errorGeneration": "コミットメッセージの生成に失敗しました",
  "errorCommit": "コミットに失敗しました",
  "errorPush": "プッシュに失敗しました",
  "errorEmptyMessage": "コミットメッセージを入力してください"
}
```

- [ ] **Step 2: Create English translation file**

Create `src/shared/i18n/locales/en/git.json`:

```json
{
  "sourceControl": "Source Control",
  "stagedChanges": "Staged Changes",
  "changes": "Changes",
  "commitMessage": "Commit Message",
  "commitMessagePlaceholder": "Message (press Enter to commit)",
  "commit": "Commit",
  "push": "Push",
  "generateAI": "AI Generate",
  "generating": "Generating...",
  "stageAll": "Stage All",
  "unstageAll": "Unstage All",
  "stageFile": "Stage File",
  "unstageFile": "Unstage File",
  "discardChanges": "Discard Changes",
  "discardConfirmTitle": "Discard changes?",
  "discardConfirmMessage": "This cannot be undone. Changes to the selected files will be lost.",
  "discardConfirmOk": "Discard",
  "discardConfirmCancel": "Cancel",
  "switchBranch": "Switch Branch",
  "switchBranchWarning": "You have uncommitted changes. Switch branch anyway?",
  "noChanges": "No changes",
  "noStagedChanges": "No staged changes",
  "notGitRepo": "Not a git repository",
  "errorNoApiKey": "No AI provider configured",
  "errorGeneration": "Failed to generate commit message",
  "errorCommit": "Commit failed",
  "errorPush": "Push failed",
  "errorEmptyMessage": "Please enter a commit message"
}
```

- [ ] **Step 3: Register git namespace in i18n config**

In `src/shared/i18n/index.ts`, add imports and register:

```typescript
// Add imports after the existing ones:
import jaGit from "./locales/ja/git.json";
import enGit from "./locales/en/git.json";

// Add to resources.ja:
git: jaGit,

// Add to resources.en:
git: enGit,
```

- [ ] **Step 4: Commit**

```bash
git add src/shared/i18n/locales/ja/git.json src/shared/i18n/locales/en/git.json src/shared/i18n/index.ts
git commit -m "feat(i18n): add git source control translations (ja/en)"
```

---

### Task 3: Add commit message prompt constant

**Files:**
- Modify: `src/shared/lib/constants.ts`

- [ ] **Step 1: Add COMMIT_MESSAGE_PROMPT**

Append to `src/shared/lib/constants.ts` (after `MERMAID_TEMPLATES`):

```typescript
export const COMMIT_MESSAGE_PROMPT =
  "You are a commit message generator. " +
  "Based on the staged diff and recent commit history provided, generate a concise and descriptive commit message. " +
  "Follow the style of the recent commits if available. " +
  "Output ONLY the commit message, no explanations or code fences.";
```

- [ ] **Step 2: Commit**

```bash
git add src/shared/lib/constants.ts
git commit -m "feat(git): add AI commit message generation prompt"
```

---

### Task 4: Create porcelain status parser

**Files:**
- Create: `src/features/git/lib/parse-status.ts`

- [ ] **Step 1: Create the parser module**

Create `src/features/git/lib/parse-status.ts`:

```typescript
export interface GitFileEntry {
  path: string;
  status: string;
  staged: boolean;
}

/**
 * Parse `git status --porcelain=v1` output into GitFileEntry[].
 *
 * Porcelain format: XY <path> or XY <old> -> <new> for renames/copies.
 * X = staging area status, Y = working tree status.
 * Space means unchanged in that area.
 */
export function parseStatusPorcelain(output: string): GitFileEntry[] {
  const entries: GitFileEntry[] = [];
  if (!output.trim()) return entries;

  for (const line of output.split("\n")) {
    if (line.length < 3) continue;

    const x = line[0]; // staging area
    const y = line[1]; // working tree
    let filePath = line.slice(3);

    // Handle renames/copies: "R  old -> new" or "C  old -> new"
    const arrowIdx = filePath.indexOf(" -> ");
    if (arrowIdx !== -1) {
      filePath = filePath.slice(arrowIdx + 4);
    }

    // Staged entry (X is non-space and not '?')
    if (x !== " " && x !== "?") {
      entries.push({ path: filePath, status: x, staged: true });
    }

    // Unstaged entry (Y is non-space)
    if (y !== " ") {
      // Untracked: both X and Y are '?'
      const status = x === "?" && y === "?" ? "??" : y;
      entries.push({ path: filePath, status, staged: false });
    }
  }

  return entries;
}

/**
 * Parse `git branch -a --no-color` output.
 * Returns { current, branches } where branches includes local and remote names.
 */
export function parseBranchList(output: string): {
  current: string;
  branches: string[];
} {
  let current = "";
  const branches: string[] = [];

  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Skip HEAD reference lines like "remotes/origin/HEAD -> origin/main"
    if (trimmed.includes("->")) continue;

    const isCurrent = trimmed.startsWith("* ");
    const name = isCurrent ? trimmed.slice(2) : trimmed;

    // Strip "remotes/origin/" prefix for remote branches
    const displayName = name.replace(/^remotes\/origin\//, "");

    if (isCurrent) {
      current = displayName;
    }

    // Avoid duplicates (local and remote with same name)
    if (!branches.includes(displayName)) {
      branches.push(displayName);
    }
  }

  return { current, branches };
}
```

- [ ] **Step 2: Commit**

```bash
git add src/features/git/lib/parse-status.ts
git commit -m "feat(git): add porcelain status and branch list parsers"
```

---

### Task 5: Extend ui-store with "git" panel type

**Files:**
- Modify: `src/stores/ui-store.ts:4`

- [ ] **Step 1: Add "git" to LeftPanel type**

In `src/stores/ui-store.ts`, change line 4:

From:
```typescript
type LeftPanel = "folder" | "outline" | "rag" | "opencode-config";
```
To:
```typescript
type LeftPanel = "folder" | "outline" | "rag" | "opencode-config" | "git";
```

- [ ] **Step 2: Commit**

```bash
git add src/stores/ui-store.ts
git commit -m "feat(ui): add git panel type to LeftPanel"
```

---

### Task 6: Create git Zustand store

**Files:**
- Create: `src/stores/git-store.ts`

- [ ] **Step 1: Create the git store**

Create `src/stores/git-store.ts`:

```typescript
import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { AiSettings } from "@/shared/types";
import type { Language } from "@/stores/settings-store";
import { COMMIT_MESSAGE_PROMPT } from "@/shared/lib/constants";
import { parseStatusPorcelain, parseBranchList } from "@/features/git/lib/parse-status";
import type { GitFileEntry } from "@/features/git/lib/parse-status";
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

  refresh: (folderPath: string) => Promise<void>;
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
}

export const useGitStore = create<GitState>()((set, get) => ({
  files: [],
  currentBranch: "",
  branches: [],
  commitMessage: "",
  loading: false,
  generating: false,
  error: null,

  refresh: async (folderPath) => {
    set({ loading: true, error: null });
    try {
      const [statusOut, branchOut] = await Promise.all([
        invoke<string>("git_status_porcelain", { path: folderPath }),
        invoke<string>("git_branch_list", { path: folderPath }),
      ]);
      const files = parseStatusPorcelain(statusOut);
      const { current, branches } = parseBranchList(branchOut);
      set({ files, currentBranch: current, branches });
    } catch (e: any) {
      set({ files: [], currentBranch: "", branches: [], error: String(e) });
    } finally {
      set({ loading: false });
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
    const { commitMessage } = get();
    if (!commitMessage.trim()) {
      set({ error: "errorEmptyMessage" });
      return;
    }
    set({ error: null, loading: true });
    try {
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
      const [diffOut, logOut] = await Promise.all([
        invoke<string>("git_diff_staged", { path: folderPath }),
        invoke<string>("git_log_oneline", { path: folderPath, count: 10 }).catch(
          () => "",
        ),
      ]);

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
}));
```

- [ ] **Step 2: Commit**

```bash
git add src/stores/git-store.ts
git commit -m "feat(git): add Zustand git store with staging, commit, push, and AI generation"
```

---

### Task 7: Build GitPanel UI components

**Files:**
- Create: `src/features/git/components/GitPanel.tsx`
- Create: `src/features/git/components/GitPanel.css`
- Create: `src/features/git/components/GitFileList.tsx`
- Create: `src/features/git/components/GitBranchSelect.tsx`

- [ ] **Step 1: Create GitBranchSelect component**

Create `src/features/git/components/GitBranchSelect.tsx`:

```tsx
import { useState, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { ask } from "@tauri-apps/plugin-dialog";
import { useGitStore } from "@/stores/git-store";

interface GitBranchSelectProps {
  folderPath: string;
  hasUncommitted: boolean;
}

export function GitBranchSelect({ folderPath, hasUncommitted }: GitBranchSelectProps) {
  const { t } = useTranslation("git");
  const currentBranch = useGitStore((s) => s.currentBranch);
  const branches = useGitStore((s) => s.branches);
  const switchBranch = useGitStore((s) => s.switchBranch);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const handleSwitch = async (branch: string) => {
    if (branch === currentBranch) {
      setOpen(false);
      return;
    }
    if (hasUncommitted) {
      const ok = await ask(t("switchBranchWarning"), {
        title: t("switchBranch"),
        kind: "warning",
      });
      if (!ok) {
        setOpen(false);
        return;
      }
    }
    setOpen(false);
    await switchBranch(folderPath, branch);
  };

  return (
    <div className="git-branch-select" ref={ref}>
      <button
        className="git-branch-select__trigger"
        onClick={() => setOpen(!open)}
        title={t("switchBranch")}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="6" y1="3" x2="6" y2="15" />
          <circle cx="18" cy="6" r="3" />
          <circle cx="6" cy="18" r="3" />
          <path d="M18 9a9 9 0 0 1-9 9" />
        </svg>
        <span className="git-branch-select__name">{currentBranch || "—"}</span>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {open && (
        <div className="git-branch-select__dropdown">
          {branches.map((b) => (
            <button
              key={b}
              className={`git-branch-select__item ${b === currentBranch ? "git-branch-select__item--active" : ""}`}
              onClick={() => handleSwitch(b)}
            >
              {b}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Create GitFileList component**

Create `src/features/git/components/GitFileList.tsx`:

```tsx
import { useTranslation } from "react-i18next";
import type { GitFileEntry } from "@/features/git/lib/parse-status";

const STATUS_COLORS: Record<string, string> = {
  M: "var(--git-modified, #e2a438)",
  A: "var(--git-added, #73c991)",
  D: "var(--git-deleted, #f44747)",
  "??": "var(--git-untracked, #73c991)",
  R: "var(--git-renamed, #6eb5ff)",
  C: "var(--git-copied, #6eb5ff)",
  U: "var(--git-conflict, #f44747)",
};

function statusColor(status: string): string {
  return STATUS_COLORS[status] || "var(--text-muted)";
}

function statusLabel(status: string): string {
  // Keep "??" as display — distinct from "U" (conflict)
  return status;
}

interface GitFileListProps {
  title: string;
  files: GitFileEntry[];
  staged: boolean;
  onStage?: (files: string[]) => void;
  onUnstage?: (files: string[]) => void;
  onDiscard?: (files: string[]) => void;
}

export function GitFileList({
  title,
  files,
  staged,
  onStage,
  onUnstage,
  onDiscard,
}: GitFileListProps) {
  const { t } = useTranslation("git");

  if (files.length === 0) return null;

  const allPaths = files.map((f) => f.path);

  return (
    <div className="git-file-list">
      <div className="git-file-list__header">
        <span className="git-file-list__title">
          {title} ({files.length})
        </span>
        <div className="git-file-list__header-actions">
          {staged && onUnstage && (
            <button
              className="git-file-list__action-btn"
              onClick={() => onUnstage(allPaths)}
              title={t("unstageAll")}
            >
              −
            </button>
          )}
          {!staged && onStage && (
            <button
              className="git-file-list__action-btn"
              onClick={() => onStage(allPaths)}
              title={t("stageAll")}
            >
              +
            </button>
          )}
        </div>
      </div>
      <div className="git-file-list__items">
        {files.map((f) => (
          <div className="git-file-list__row" key={`${f.path}-${f.staged}`}>
            <span
              className="git-file-list__status"
              style={{ color: statusColor(f.status) }}
            >
              {statusLabel(f.status)}
            </span>
            <span className="git-file-list__path" title={f.path}>
              {f.path.split("/").pop()}
              <span className="git-file-list__dir">
                {f.path.includes("/")
                  ? f.path.slice(0, f.path.lastIndexOf("/"))
                  : ""}
              </span>
            </span>
            <div className="git-file-list__row-actions">
              {staged && onUnstage && (
                <button
                  className="git-file-list__action-btn"
                  onClick={() => onUnstage([f.path])}
                  title={t("unstageFile")}
                >
                  −
                </button>
              )}
              {!staged && onStage && (
                <button
                  className="git-file-list__action-btn"
                  onClick={() => onStage([f.path])}
                  title={t("stageFile")}
                >
                  +
                </button>
              )}
              {!staged && onDiscard && (
                <button
                  className="git-file-list__action-btn"
                  onClick={() => onDiscard([f.path])}
                  title={t("discardChanges")}
                >
                  ↩
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Create GitPanel component**

Create `src/features/git/components/GitPanel.tsx`:

```tsx
import { useEffect, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useGitStore } from "@/stores/git-store";
import { useTabStore } from "@/stores/tab-store";
import { useSettingsStore } from "@/stores/settings-store";
import { GitBranchSelect } from "./GitBranchSelect";
import { GitFileList } from "./GitFileList";
import { ask } from "@tauri-apps/plugin-dialog";
import "./GitPanel.css";

export function GitPanel() {
  const { t } = useTranslation("git");
  const activeFolderPath = useTabStore((s) => s.activeFolderPath);
  const { aiSettings, language } = useSettingsStore();

  const files = useGitStore((s) => s.files);
  const commitMessage = useGitStore((s) => s.commitMessage);
  const loading = useGitStore((s) => s.loading);
  const generating = useGitStore((s) => s.generating);
  const error = useGitStore((s) => s.error);
  const refresh = useGitStore((s) => s.refresh);
  const stageFiles = useGitStore((s) => s.stageFiles);
  const unstageFiles = useGitStore((s) => s.unstageFiles);
  const commitAction = useGitStore((s) => s.commit);
  const pushAction = useGitStore((s) => s.push);
  const discardFiles = useGitStore((s) => s.discardFiles);
  const generateCommitMessage = useGitStore((s) => s.generateCommitMessage);
  const setCommitMessage = useGitStore((s) => s.setCommitMessage);
  const clearError = useGitStore((s) => s.clearError);

  useEffect(() => {
    if (activeFolderPath) {
      refresh(activeFolderPath);
    }
  }, [activeFolderPath, refresh]);

  const stagedFiles = useMemo(() => files.filter((f) => f.staged), [files]);
  const unstagedFiles = useMemo(() => files.filter((f) => !f.staged), [files]);
  const hasUncommitted = files.length > 0;

  const handleStage = useCallback(
    (paths: string[]) => {
      if (activeFolderPath) stageFiles(activeFolderPath, paths);
    },
    [activeFolderPath, stageFiles],
  );

  const handleUnstage = useCallback(
    (paths: string[]) => {
      if (activeFolderPath) unstageFiles(activeFolderPath, paths);
    },
    [activeFolderPath, unstageFiles],
  );

  const handleDiscard = useCallback(
    async (paths: string[]) => {
      const ok = await ask(t("discardConfirmMessage"), {
        title: t("discardConfirmTitle"),
        kind: "warning",
        okLabel: t("discardConfirmOk"),
        cancelLabel: t("discardConfirmCancel"),
      });
      if (!ok || !activeFolderPath) return;

      // Separate tracked and untracked files
      const trackedPaths: string[] = [];
      const untrackedPaths: string[] = [];
      for (const p of paths) {
        const entry = unstagedFiles.find((f) => f.path === p);
        if (entry?.status === "??") {
          untrackedPaths.push(p);
        } else {
          trackedPaths.push(p);
        }
      }
      discardFiles(activeFolderPath, trackedPaths, untrackedPaths);
    },
    [activeFolderPath, unstagedFiles, discardFiles, t],
  );

  const handleCommit = useCallback(() => {
    if (activeFolderPath) commitAction(activeFolderPath);
  }, [activeFolderPath, commitAction]);

  const handlePush = useCallback(() => {
    if (activeFolderPath) pushAction(activeFolderPath);
  }, [activeFolderPath, pushAction]);

  const handleGenerate = useCallback(() => {
    if (activeFolderPath) {
      generateCommitMessage(activeFolderPath, aiSettings, language);
    }
  }, [activeFolderPath, aiSettings, language, generateCommitMessage]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleCommit();
      }
    },
    [handleCommit],
  );

  if (!activeFolderPath) {
    return (
      <div className="git-panel git-panel--empty">
        <span className="git-panel__placeholder">{t("notGitRepo")}</span>
      </div>
    );
  }

  // Translate error keys from the store (they can be i18n keys or raw messages)
  const errorMessage = error
    ? t(error, { defaultValue: error })
    : null;

  return (
    <div className="git-panel">
      <GitBranchSelect
        folderPath={activeFolderPath}
        hasUncommitted={hasUncommitted}
      />

      <div className="git-panel__commit-area">
        <textarea
          className="git-panel__message-input"
          placeholder={t("commitMessagePlaceholder")}
          value={commitMessage}
          onChange={(e) => {
            setCommitMessage(e.target.value);
            if (error) clearError();
          }}
          onKeyDown={handleKeyDown}
          rows={3}
        />
        <div className="git-panel__actions">
          <button
            className="git-panel__action-btn git-panel__action-btn--ai"
            onClick={handleGenerate}
            disabled={generating || stagedFiles.length === 0}
            title={t("generateAI")}
          >
            {generating ? t("generating") : t("generateAI")}
          </button>
          <button
            className="git-panel__action-btn git-panel__action-btn--commit"
            onClick={handleCommit}
            disabled={loading || !commitMessage.trim() || stagedFiles.length === 0}
            title={t("commit")}
          >
            {t("commit")}
          </button>
          <button
            className="git-panel__action-btn git-panel__action-btn--push"
            onClick={handlePush}
            disabled={loading}
            title={t("push")}
          >
            {t("push")}
          </button>
        </div>
      </div>

      {errorMessage && (
        <div className="git-panel__error">{errorMessage}</div>
      )}

      <div className="git-panel__file-lists">
        <GitFileList
          title={t("stagedChanges")}
          files={stagedFiles}
          staged={true}
          onUnstage={handleUnstage}
        />
        <GitFileList
          title={t("changes")}
          files={unstagedFiles}
          staged={false}
          onStage={handleStage}
          onDiscard={handleDiscard}
        />
        {files.length === 0 && !loading && (
          <div className="git-panel__no-changes">{t("noChanges")}</div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Create GitPanel.css**

Create `src/features/git/components/GitPanel.css`:

```css
.git-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
  font-size: 13px;
}

.git-panel--empty {
  align-items: center;
  justify-content: center;
}

.git-panel__placeholder {
  color: var(--text-muted);
  font-size: 12px;
}

/* ── Branch selector ── */
.git-branch-select {
  position: relative;
  padding: 6px 8px;
  border-bottom: 1px solid var(--border);
}

.git-branch-select__trigger {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 4px 8px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg-base);
  color: var(--text);
  cursor: pointer;
  font-size: 12px;
}

.git-branch-select__trigger:hover {
  background: var(--bg-overlay);
}

.git-branch-select__name {
  flex: 1;
  text-align: left;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.git-branch-select__dropdown {
  position: absolute;
  top: 100%;
  left: 8px;
  right: 8px;
  max-height: 200px;
  overflow-y: auto;
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: 4px;
  z-index: 100;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
}

.git-branch-select__item {
  display: block;
  width: 100%;
  padding: 6px 10px;
  border: none;
  background: none;
  color: var(--text);
  cursor: pointer;
  text-align: left;
  font-size: 12px;
}

.git-branch-select__item:hover {
  background: var(--bg-overlay);
}

.git-branch-select__item--active {
  color: var(--primary);
  font-weight: 600;
}

/* ── Commit area ── */
.git-panel__commit-area {
  padding: 8px;
  border-bottom: 1px solid var(--border);
}

.git-panel__message-input {
  width: 100%;
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg-base);
  color: var(--text);
  font-size: 12px;
  font-family: inherit;
  resize: vertical;
  min-height: 60px;
  box-sizing: border-box;
}

.git-panel__message-input::placeholder {
  color: var(--text-muted);
}

.git-panel__message-input:focus {
  outline: none;
  border-color: var(--primary);
}

.git-panel__actions {
  display: flex;
  gap: 4px;
  margin-top: 6px;
}

.git-panel__action-btn {
  flex: 1;
  padding: 4px 8px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg-base);
  color: var(--text);
  cursor: pointer;
  font-size: 11px;
  white-space: nowrap;
}

.git-panel__action-btn:hover:not(:disabled) {
  background: var(--bg-overlay);
}

.git-panel__action-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.git-panel__action-btn--commit {
  background: var(--primary);
  color: var(--on-primary, #fff);
  border-color: var(--primary);
}

.git-panel__action-btn--commit:hover:not(:disabled) {
  opacity: 0.9;
}

/* ── Error ── */
.git-panel__error {
  padding: 6px 8px;
  font-size: 11px;
  color: var(--git-deleted, #f44747);
  background: var(--bg-base);
  border-bottom: 1px solid var(--border);
}

/* ── File lists ── */
.git-panel__file-lists {
  flex: 1;
  overflow-y: auto;
}

.git-panel__no-changes {
  padding: 20px;
  text-align: center;
  color: var(--text-muted);
  font-size: 12px;
}

.git-file-list__header {
  display: flex;
  align-items: center;
  padding: 4px 8px;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-muted);
  letter-spacing: 0.3px;
  user-select: none;
}

.git-file-list__title {
  flex: 1;
}

.git-file-list__header-actions {
  display: flex;
  gap: 2px;
}

.git-file-list__row {
  display: flex;
  align-items: center;
  padding: 2px 8px 2px 12px;
  gap: 6px;
  cursor: default;
}

.git-file-list__row:hover {
  background: var(--bg-overlay);
}

.git-file-list__row:hover .git-file-list__row-actions {
  visibility: visible;
}

.git-file-list__status {
  font-size: 11px;
  font-weight: 700;
  width: 16px;
  text-align: center;
  flex-shrink: 0;
}

.git-file-list__path {
  flex: 1;
  font-size: 12px;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.git-file-list__dir {
  margin-left: 6px;
  font-size: 11px;
  color: var(--text-muted);
}

.git-file-list__row-actions {
  display: flex;
  gap: 2px;
  visibility: hidden;
  flex-shrink: 0;
}

.git-file-list__action-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border: none;
  background: none;
  color: var(--text-muted);
  cursor: pointer;
  border-radius: 3px;
  font-size: 14px;
  font-weight: 700;
  padding: 0;
}

.git-file-list__action-btn:hover {
  background: var(--bg-overlay);
  color: var(--text);
}
```

- [ ] **Step 5: Commit**

```bash
git add src/features/git/
git commit -m "feat(git): add GitPanel, GitFileList, and GitBranchSelect components"
```

---

### Task 8: Integrate GitPanel into LeftPanel

**Files:**
- Modify: `src/features/file-tree/components/LeftPanel.tsx`

- [ ] **Step 1: Add git activity bar button**

In `src/features/file-tree/components/LeftPanel.tsx`:

1. Add imports at top:
```typescript
import { GitPanel } from "@/features/git/components/GitPanel";
import { useGitStore } from "@/stores/git-store";
```

2. Add the git button in `left-panel__activity-bar-top`, after the opencode button (before `</div>` of `activity-bar-top`):
```tsx
<button
  className={`left-panel__activity-btn ${leftPanel === "git" ? "left-panel__activity-btn--active" : ""}`}
  onClick={() => setLeftPanel("git")}
  title={t("sourceControl", { ns: "git" })}
>
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="18" cy="18" r="3" />
    <circle cx="6" cy="6" r="3" />
    <path d="M6 21V9a9 9 0 0 0 9 9" />
  </svg>
</button>
```

3. Add panel content in `left-panel__content`, after the `OpencodeConfigPanel` block:
```tsx
{leftPanel === "git" && <GitPanel />}
```

4. Add the section header title for git panel, inside the `left-panel__section-header-title` span:
```tsx
{leftPanel === "git" && t("sourceControl", { ns: "git" }).toUpperCase()}
```

- [ ] **Step 2: Add refresh header action for git panel**

After the section header title, add a refresh button that shows only when `leftPanel === "git"`:
```tsx
{leftPanel === "git" && (
  <div className="left-panel__section-header-actions">
    <button
      className="left-panel__header-action"
      onClick={() => {
        if (activeFolderPath) {
          useGitStore.getState().refresh(activeFolderPath);
        }
      }}
      title={t("refresh", { ns: "fileTree" })}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="23 4 23 10 17 10" />
        <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
      </svg>
    </button>
  </div>
)}
```

- [ ] **Step 3: Commit**

```bash
git add src/features/file-tree/components/LeftPanel.tsx
git commit -m "feat(git): integrate GitPanel into LeftPanel with activity bar button"
```

---

### Task 9: Manual integration test

- [ ] **Step 1: Build and run the app**

Run: `npm run tauri dev`

- [ ] **Step 2: Verify git panel renders**

1. Open a folder that is a git repository
2. Click the git icon in the activity bar (branch icon)
3. Verify: Source Control header shows, branch name displays, file list populates

- [ ] **Step 3: Test staging/unstaging**

1. Modify a file in the open folder
2. Click refresh or re-open git panel
3. File should appear in "Changes" section
4. Click `+` to stage — file moves to "Staged Changes"
5. Click `−` to unstage — file moves back to "Changes"

- [ ] **Step 4: Test commit and push**

1. Stage a file
2. Type a commit message
3. Click "Commit" — message clears, file disappears from lists
4. Click "Push" — verify no error

- [ ] **Step 5: Test AI commit message generation**

1. Stage some changes
2. Click "AI Generate"
3. Verify: generating state shows, then commit message field populates
4. Verify the message is in the configured language (ja/en per settings)

- [ ] **Step 6: Test branch switching**

1. Click the branch name
2. Dropdown shows available branches
3. Click a different branch — branch switches, file list refreshes

- [ ] **Step 7: Test discard**

1. Modify a file
2. Click `↩` on the file in Changes
3. Confirmation dialog appears
4. Confirm — file disappears from list, changes are reverted

- [ ] **Step 8: Fix any issues found during testing and commit**

```bash
git add -A
git commit -m "fix(git): address issues found during integration testing"
```
