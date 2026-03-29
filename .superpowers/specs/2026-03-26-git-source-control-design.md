# Git Source Control Panel Design

## Overview

Add a VS Code-style Source Control panel to mdium, enabling file-level staging, commit, push, branch switching, and AI-powered commit message generation using the configured AI provider or OpenCode SDK.

**Minimum Git version required: 2.23+** (for `git restore` and `git switch` commands).

## Architecture

### Backend (Rust — `src-tauri/src/commands/git.rs`)

Extend the existing `run_git()` helper with additional Tauri commands:

| Command | Purpose | Git args |
|---|---|---|
| `git_status_porcelain(path)` | Machine-parseable file status | `status --porcelain=v1` |
| `git_add(path, files: Vec<String>)` | Stage specific files | `add -- <files...>` |
| `git_restore_staged(path, files: Vec<String>)` | Unstage specific files | `restore --staged -- <files...>` |
| `git_diff_staged(path)` | Staged diff (AI input) | `diff --staged` |
| `git_log_oneline(path, count: u32)` | Recent commit messages | `log --oneline -n <count>` |
| `git_branch_list(path)` | Branch list with current branch | `branch -a` |
| `git_switch(path, branch)` | Switch branches | `switch <branch>` |
| `git_discard(path, files: Vec<String>)` | Discard working tree changes | `restore -- <files...>` |
| `git_remove_untracked(path, files: Vec<String>)` | Delete untracked files | `clean -f -- <files...>` |

Note on `--`: all file-argument commands use `--` separator to prevent path/flag ambiguity.

Existing commands (`git_init`, `git_status`, `git_add_all`, `git_commit`, `git_push`, `git_get_remote_url`, `git_set_remote_url`) remain unchanged.

#### Edge cases

- **Unstaging new files** (files with no prior commit): `git restore --staged` fails for these. The `git_restore_staged` command should detect this case and fall back to `git rm --cached -- <files>`.
- **Push with no upstream**: `git_push` currently runs `git push` with no args. When this fails due to missing upstream, the store's `push()` action should retry with `git push -u origin <currentBranch>`. A new command `git_push_upstream(path, branch)` is added for this: `push -u origin <branch>`.

### Frontend State (`src/stores/git-store.ts`)

Zustand store managing all git state:

```typescript
interface GitFileEntry {
  path: string;       // Relative path
  status: string;     // Porcelain status code ("M", "A", "D", "??", "R", etc.)
  staged: boolean;    // Whether in staging area
}

interface GitState {
  files: GitFileEntry[];
  currentBranch: string;
  branches: string[];
  commitMessage: string;
  loading: boolean;
  generating: boolean;        // AI generation in progress
  error: string | null;       // Last error message for inline display

  refresh: (folderPath: string) => Promise<void>;
  stageFiles: (folderPath: string, files: string[]) => Promise<void>;
  unstageFiles: (folderPath: string, files: string[]) => Promise<void>;
  commit: (folderPath: string) => Promise<void>;
  push: (folderPath: string) => Promise<void>;
  switchBranch: (folderPath: string, branch: string) => Promise<void>;
  discardFiles: (folderPath: string, files: string[]) => Promise<void>;
  generateCommitMessage: (folderPath: string, settings: AiSettings, language: Language) => Promise<void>;
  setCommitMessage: (msg: string) => void;
  clearError: () => void;
}
```

#### `commit()` behavior

1. Validate that `state.commitMessage` is non-empty (set error if empty, return early)
2. Call `invoke("git_commit", { path, message: state.commitMessage })`
3. On success: clear `commitMessage`, call `refresh()`
4. On failure: set `error` with the git error message

#### `push()` behavior

1. Attempt `invoke("git_push", { path })`
2. If fails with "no upstream branch" error: retry with `invoke("git_push_upstream", { path, branch: state.currentBranch })`
3. On success: call `refresh()`
4. On failure: set `error`

#### Porcelain status parsing (`src/features/git/lib/parse-status.ts`)

Parse `git status --porcelain=v1` output. Each line has the format `XY path` (or `XY old -> new` for renames/copies):

- Column 1 (X): staging area status — non-space means staged
- Column 2 (Y): working tree status — non-space means unstaged
- **Partial staging**: when both X and Y are non-space, emit **two** `GitFileEntry` objects for the same path — one with `staged: true` (status from X) and one with `staged: false` (status from Y)
- **Renames (`R`) and copies (`C`)**: parse the `old -> new` path format, use the new path as `path`
- **Merge conflict codes** (`UU`, `AA`, `DD`, etc.): display with a `U` (Conflict) status. No special merge UI in this iteration, but they should render gracefully
- **Untracked (`??`)**: always `staged: false`

#### Branch list parsing

Parse `git branch -a` output:
- Lines starting with `* ` indicate the current branch
- Lines containing `remotes/origin/` are remote branches — strip the prefix for display
- Lines containing `->` (e.g., `remotes/origin/HEAD -> origin/main`) are HEAD references — skip these

### AI Commit Message Generation

#### Prompt

Added to `src/shared/lib/constants.ts`:

```typescript
export const COMMIT_MESSAGE_PROMPT =
  "You are a commit message generator. " +
  "Based on the staged diff and recent commit history provided, generate a concise and descriptive commit message. " +
  "Follow the style of the recent commits if available. " +
  "Output ONLY the commit message, no explanations or code fences.";
```

#### User message format

```
Language: {ja|en}
Write the commit message in the above language.

## Staged Diff
{git diff --staged output, truncated to first 8000 characters if larger}

## Recent Commits
{git log --oneline -10 output}
```

The language value is read from `useSettingsStore.language`.

**Diff truncation**: if the staged diff exceeds 8000 characters, truncate and append `\n... (truncated, {total} chars total)` to stay within AI context limits.

#### Routing: ai_chat vs OpenCode

Automatic routing with no UI toggle:

- **OpenCode connected** → use the raw SDK client directly via `getOpencodeClient()` (exported from `useOpencodeChat.ts`). Create an ephemeral session, call the prompt, extract the raw text response. This bypasses the chat UI store entirely to avoid polluting the conversation history with commit generation messages.
- **OpenCode not connected** → send via `ai_chat` Tauri command (existing infrastructure)
- **Fallback**: if OpenCode call fails, automatically fall back to `ai_chat`

The OpenCode path must extract plain text (not HTML) from the response, since the existing `useOpencodeChat` converts responses to HTML via `marked`.

### UI Components

#### File structure

```
src/features/git/
├── components/
│   ├── GitPanel.tsx          # Main Source Control panel
│   ├── GitPanel.css
│   ├── GitFileList.tsx       # File list (shared for Staged/Changes sections)
│   └── GitBranchSelect.tsx   # Branch switching dropdown
└── lib/
    └── parse-status.ts       # Porcelain output parser
```

#### Panel layout (inside LeftPanel as a new tab)

```
┌─────────────────────────────┐
│ branch-name ▼               │
├─────────────────────────────┤
│ [Commit message input]      │
│ [✨ AI] [✓ Commit] [↑ Push] │
├─────────────────────────────┤
│ ▸ Staged Changes (n)     [−]│
│   M  src/app/App.tsx     [−]│
│   A  src/stores/new.ts   [−]│
├─────────────────────────────┤
│ ▸ Changes (n)            [+]│
│   M  src/main.tsx      [+ ↩]│
│   ?? new-file.ts       [+ ↩]│
│   D  old-file.ts       [+ ↩]│
│   U  conflict.ts          []│
├─────────────────────────────┤
│ [Error message if any]      │
└─────────────────────────────┘
```

#### Interactions

| Action | Behavior |
|---|---|
| `+` button on file row | Stage file (`git_add`) |
| `−` button on staged file | Unstage file (`git_restore_staged`) |
| `↩` button on unstaged file | Discard changes — confirmation dialog required. For tracked files: `git_discard`. For untracked files (`??`): `git_remove_untracked` |
| Section header `+`/`−` | Bulk stage/unstage all files in section |
| AI generate button | Fetch staged diff → AI generates message → populate input. Disabled when no staged files or no AI provider configured |
| Commit button | `git_commit` → auto refresh. Disabled when `commitMessage` is empty or no staged files |
| Push button | `git_push` (with upstream fallback) |
| Branch name click | Branch switch dropdown. **Warn if uncommitted changes exist** before switching |

#### Error display

Errors are shown inline at the bottom of the panel (not as toasts) and auto-clear on the next successful operation or via `clearError()`. Covers: commit failures, push failures (auth, network, no upstream), AI generation failures (no API key, rate limit, network).

#### Status icons and colors

| Status | Color | Meaning |
|---|---|---|
| `M` | Orange | Modified |
| `A` | Green | Added |
| `D` | Red | Deleted |
| `??` | Green | Untracked |
| `R` | Blue | Renamed |
| `U` | Red | Conflict |

### Refresh strategy

- **Initial load**: `refresh()` fires on panel mount and on `folderPath` change
- **After mutations**: auto-refresh after every mutating action (stage, unstage, commit, push, switchBranch, discard)
- **External changes**: no polling or file watcher integration in this iteration. Users can manually refresh by switching away from and back to the panel, or after any mutating action. File watcher integration is a future extension.

### Integration points

- **LeftPanel.tsx**: Add Source Control tab alongside File Tree and Outline tabs
- **ui-store.ts**: Extend `LeftPanel` type to `"folder" | "outline" | "rag" | "opencode-config" | "git"`
- **lib.rs**: Register new Tauri commands (`git_status_porcelain`, `git_add`, `git_restore_staged`, `git_diff_staged`, `git_log_oneline`, `git_branch_list`, `git_switch`, `git_discard`, `git_remove_untracked`, `git_push_upstream`) in the handler builder
- **i18n**: Add `git` namespace with translation files:
  - `src/shared/i18n/locales/ja/git.json`
  - `src/shared/i18n/locales/en/git.json`
  - Register in `src/shared/i18n/index.ts`
  - Key translation keys: `stagedChanges`, `changes`, `commitMessage`, `commitMessagePlaceholder`, `commit`, `push`, `generateAI`, `generating`, `discardConfirmTitle`, `discardConfirmMessage`, `switchBranchWarning`, `noChanges`, `noStagedChanges`, `pushSuccess`, `commitSuccess`, `errorNoApiKey`, `errorGeneration`

### Future extensions (out of scope for initial implementation)

- Inline diff viewer (file click → diff tab)
- Stash management (stash/pop/list)
- Merge conflict resolution UI
- Commit history viewer with graph
- PR description generation
- File watcher integration for auto-refresh
- Partial staging (hunk-level) via `git add -p`
