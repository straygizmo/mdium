# Scope UI Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace global/project scope tabs in all opencode settings sections with unified item lists (color-coded by scope) and toggle-based scope selection in add/edit forms.

**Architecture:** Extract shared scope UI into reusable components (`ScopeToggle`, `ScopeFormWrapper`) and a hook (`useScopeItems`). Then update all 6 scoped sections to use the shared components, removing scope tabs and loading both scopes simultaneously. CSS uses `color-mix()` with `var(--primary)` for theme-aware scope coloring.

**Tech Stack:** React, TypeScript, CSS custom properties, Tauri IPC

---

### Task 1: Add scope CSS variables and classes

**Files:**
- Modify: `src/features/opencode-config/components/OpencodeConfigDialog.css`

- [ ] **Step 1: Add scope CSS variables after existing scope tab styles**

In `OpencodeConfigDialog.css`, add the following block after the scope tab styles (after line 379):

```css
/* Scope color variables */
.oc-dialog__body {
  --scope-global-bg: color-mix(in srgb, var(--primary) 25%, transparent);
  --scope-global-border: color-mix(in srgb, var(--primary) 50%, transparent);
  --scope-project-bg: rgba(234, 179, 8, 0.15);
  --scope-project-border: rgba(234, 179, 8, 0.5);
}

/* Scope-colored item backgrounds */
.oc-section__item--global {
  background: var(--scope-global-bg);
}

.oc-section__item--project {
  background: var(--scope-project-bg);
}

/* Scope form wrapper */
.oc-section__scope-form {
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 12px;
}

.oc-section__scope-form--global {
  border-color: var(--scope-global-border);
  background: var(--scope-global-bg);
}

.oc-section__scope-form--project {
  border-color: var(--scope-project-border);
  background: var(--scope-project-bg);
}

/* Scope toggle */
.oc-section__scope-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
}

.oc-section__scope-toggle-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--text);
}
```

- [ ] **Step 2: Verify the styles render correctly**

Open the app, navigate to Settings, and verify that the new CSS classes don't interfere with existing styles (no visual changes yet since no component uses these classes).

- [ ] **Step 3: Commit**

```bash
git add src/features/opencode-config/components/OpencodeConfigDialog.css
git commit -m "style: add scope color CSS variables and classes"
```

---

### Task 2: Create ScopeToggle component

**Files:**
- Create: `src/features/opencode-config/components/shared/ScopeToggle.tsx`

- [ ] **Step 1: Create the ScopeToggle component**

```tsx
import { useTranslation } from "react-i18next";

export type Scope = "global" | "project";

interface ScopeToggleProps {
  value: Scope;
  onChange: (scope: Scope) => void;
}

export function ScopeToggle({ value, onChange }: ScopeToggleProps) {
  const { t } = useTranslation("opencode-config");
  return (
    <label className="oc-section__scope-toggle">
      <span className="oc-section__scope-toggle-label">Global</span>
      <input
        type="checkbox"
        checked={value === "global"}
        onChange={(e) => onChange(e.target.checked ? "global" : "project")}
      />
    </label>
  );
}
```

Note: This reuses the existing `.oc-section__toggle input[type="checkbox"]` styling already defined in `OpencodeConfigDialog.css` (lines 186-233) for the switch appearance. The parent `.oc-section__scope-toggle` class provides the layout (flex row with label).

- [ ] **Step 2: Commit**

```bash
git add src/features/opencode-config/components/shared/ScopeToggle.tsx
git commit -m "feat: create ScopeToggle component"
```

---

### Task 3: Create ScopeFormWrapper component

**Files:**
- Create: `src/features/opencode-config/components/shared/ScopeFormWrapper.tsx`

- [ ] **Step 1: Create the ScopeFormWrapper component**

```tsx
import type { ReactNode } from "react";
import type { Scope } from "./ScopeToggle";

interface ScopeFormWrapperProps {
  scope: Scope;
  children: ReactNode;
}

export function ScopeFormWrapper({ scope, children }: ScopeFormWrapperProps) {
  return (
    <div className={`oc-section__scope-form oc-section__scope-form--${scope}`}>
      {children}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/features/opencode-config/components/shared/ScopeFormWrapper.tsx
git commit -m "feat: create ScopeFormWrapper component"
```

---

### Task 4: Create useScopeItems hook

**Files:**
- Create: `src/features/opencode-config/hooks/useScopeItems.ts`

- [ ] **Step 1: Create the hook**

```ts
import { useMemo } from "react";
import type { Scope } from "../components/shared/ScopeToggle";

export interface ScopeItem<T> {
  scope: Scope;
  data: T;
}

export function useScopeItems<T>(
  globalItems: T[],
  projectItems: T[]
): ScopeItem<T>[] {
  return useMemo(
    () => [
      ...globalItems.map((data) => ({ scope: "global" as const, data })),
      ...projectItems.map((data) => ({ scope: "project" as const, data })),
    ],
    [globalItems, projectItems]
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/features/opencode-config/hooks/useScopeItems.ts
git commit -m "feat: create useScopeItems hook"
```

---

### Task 5: Update AgentsSection

**Files:**
- Modify: `src/features/opencode-config/components/sections/AgentsSection.tsx`

This section has two types of agents: **file-based** (markdown files in agents dir) and **config-based** (JSON in opencode.jsonc, global only). Both need to appear in the unified list.

- [ ] **Step 1: Add imports for shared components**

At the top of the file, add imports:

```ts
import { ScopeToggle, type Scope } from "../shared/ScopeToggle";
import { ScopeFormWrapper } from "../shared/ScopeFormWrapper";
import { useScopeItems, type ScopeItem } from "../../hooks/useScopeItems";
```

Remove the `AgentScope` type alias (line 14) since we now import `Scope` from `ScopeToggle`.

- [ ] **Step 2: Replace single-scope loading with dual-scope loading**

Replace the single `scope` state and `agentFiles` state with dual-scope state:

```ts
// Replace:
//   const [scope, setScope] = useState<AgentScope>("global");
//   const [agentFiles, setAgentFiles] = useState<AgentFileEntry[]>([]);
// With:
const [globalAgentFiles, setGlobalAgentFiles] = useState<AgentFileEntry[]>([]);
const [projectAgentFiles, setProjectAgentFiles] = useState<AgentFileEntry[]>([]);
```

Add a `formScope` state for the add/edit form:

```ts
const [formScope, setFormScope] = useState<Scope>("project");
```

- [ ] **Step 3: Update getAgentsDir to accept a scope parameter**

Change `getAgentsDir` from using the `scope` state to accepting an explicit parameter:

```ts
const getAgentsDir = useCallback(
  async (targetScope: Scope): Promise<string | null> => {
    if (targetScope === "global") {
      const home = await invoke<string>("get_home_dir");
      const sep = home.includes("\\") ? "\\" : "/";
      return `${home}${sep}.config${sep}opencode${sep}agents`;
    }
    if (activeFolderPath) {
      const sep = activeFolderPath.includes("\\") ? "\\" : "/";
      return `${activeFolderPath}${sep}.opencode${sep}agents`;
    }
    return null;
  },
  [activeFolderPath]
);
```

- [ ] **Step 4: Update loadAgentFiles to load both scopes**

Replace the single `loadAgentFiles` with a function that loads both:

```ts
const loadAllAgentFiles = useCallback(async () => {
  setLoading(true);
  try {
    // Load global
    const globalDir = await getAgentsDir("global");
    if (globalDir) {
      const files = await invoke<AgentFileEntry[]>("list_agent_files", { dir: globalDir });
      setGlobalAgentFiles(files);
    } else {
      setGlobalAgentFiles([]);
    }
    // Load project
    const projectDir = await getAgentsDir("project");
    if (projectDir) {
      const files = await invoke<AgentFileEntry[]>("list_agent_files", { dir: projectDir });
      setProjectAgentFiles(files);
    } else {
      setProjectAgentFiles([]);
    }
  } finally {
    setLoading(false);
  }
}, [getAgentsDir]);
```

- [ ] **Step 5: Update useEffect to load both scopes on mount**

Replace the scope-dependent effect with a mount-time + activeFolderPath effect:

```ts
useEffect(() => {
  loadAllAgentFiles();
}, [loadAllAgentFiles]);
```

Update `displayPath` to derive from `formScope` instead of `scope`:

```ts
const [displayPath, setDisplayPath] = useState("");

useEffect(() => {
  (async () => {
    const dir = await getAgentsDir(formScope);
    if (dir) {
      setDisplayPath(`${dir}${dir.includes("\\") ? "\\" : "/"}<name>.md`);
    } else {
      setDisplayPath("");
    }
  })();
}, [formScope, getAgentsDir]);
```

- [ ] **Step 6: Create merged items list using useScopeItems**

Use `useScopeItems` to merge file-based agents from both scopes. Config-based agents are always global:

```ts
const scopedFileAgents = useScopeItems(globalAgentFiles, projectAgentFiles);
```

- [ ] **Step 7: Update save/edit handlers to use formScope**

In `handleSaveFile`, use `formScope` to determine the save directory. Add scope-change (move) logic for editing:

```ts
const handleSaveFile = async () => {
  const name = fileFormName.trim();
  if (!name) return;
  const dir = await getAgentsDir(formScope);
  if (!dir) return;
  const sep = dir.includes("\\") ? "\\" : "/";
  const filePath = `${dir}${sep}${name}.md`;
  await invoke("write_text_file_with_dirs", { path: filePath, content: fileFormContent });

  // If editing and scope changed, delete from old scope
  if (editingFile && editingFileScope && editingFileScope !== formScope) {
    const oldDir = await getAgentsDir(editingFileScope);
    if (oldDir) {
      const oldPath = `${oldDir}${sep}${editingFile}`;
      await invoke("delete_file", { path: oldPath });
    }
  }

  await loadAllAgentFiles();
  await loadGlobalAgentFiles();
  setEditingFile(null);
  setAddingFile(false);
};
```

Add `editingFileScope` state to track the original scope when editing:

```ts
const [editingFileScope, setEditingFileScope] = useState<Scope | null>(null);
```

Update `startEditFile` to set both `editingFileScope` and `formScope`:

```ts
const startEditFile = (entry: AgentFileEntry, entryScope: Scope) => {
  setEditingFile(entry.file_name);
  setEditingFileScope(entryScope);
  setFormScope(entryScope);
  setFileFormName(entry.agent_name);
  setFileFormContent(entry.content);
  setFileSavedContent(entry.content);
  setFileViewTab("editor");
};
```

- [ ] **Step 8: Update startAddFile to set default scope**

```ts
const startAddFile = () => {
  setAddingFile(true);
  setFormScope("project");
  setFileFormName("");
  setFileFormContent("");
  setFileSavedContent("");
  setFileViewTab("editor");
};
```

- [ ] **Step 9: Update handleAddBuiltin to default to global scope**

```ts
const handleAddBuiltin = async (name: string) => {
  setFormScope("global");
  // ... existing builtin add logic, but use getAgentsDir("global")
  const dir = await getAgentsDir("global");
  // ... rest of logic
};
```

- [ ] **Step 10: Remove scope tabs from JSX, add scope coloring to items**

Remove the scope tabs block (the `oc-section__scope-tabs` div). Replace the item list rendering to iterate over `scopedFileAgents` and add scope class:

```tsx
{scopedFileAgents.map(({ scope: itemScope, data: entry }) => (
  <div
    key={`${itemScope}-${entry.file_name}`}
    className={`oc-section__item oc-section__item--${itemScope}`}
  >
    <div className="oc-section__item-info">
      <span className="oc-section__item-name">
        {entry.agent_name}
        {isBuiltinAgent(entry.agent_name) && (
          <span className="oc-section__builtin-badge">built-in</span>
        )}
      </span>
      <span className="oc-section__item-detail">{entry.description}</span>
    </div>
    <div className="oc-section__item-actions">
      <button className="oc-section__edit-btn" onClick={() => startEditFile(entry, itemScope)}>
        {t("edit")}
      </button>
      <button className="oc-section__delete-btn" onClick={() => handleDeleteFile(entry.file_name, itemScope)}>
        {t("delete")}
      </button>
    </div>
  </div>
))}
```

Config-based agents (global only) keep their existing rendering but add `oc-section__item--global` class.

- [ ] **Step 11: Add ScopeToggle and ScopeFormWrapper to add/edit forms**

Wrap the file-based agent form with the scope UI:

```tsx
{(addingFile || editingFile) && (
  <>
    <ScopeToggle value={formScope} onChange={setFormScope} />
    <ScopeFormWrapper scope={formScope}>
      {/* existing form fields (name, editor/preview tabs, textarea, etc.) */}
    </ScopeFormWrapper>
    {/* form actions (save/cancel) remain outside the wrapper */}
  </>
)}
```

- [ ] **Step 12: Update handleDeleteFile to accept scope parameter**

```ts
const handleDeleteFile = async (fileName: string, targetScope: Scope) => {
  const dir = await getAgentsDir(targetScope);
  if (!dir) return;
  const sep = dir.includes("\\") ? "\\" : "/";
  const confirmed = await ask(t("deleteConfirm"), { kind: "warning" });
  if (!confirmed) return;
  await invoke("delete_file", { path: `${dir}${sep}${fileName}` });
  await loadAllAgentFiles();
  await loadGlobalAgentFiles();
};
```

- [ ] **Step 13: Verify agents section works correctly**

Open the app → Settings → Agents tab. Verify:
1. No scope tabs visible
2. Global agents shown with purple background
3. Project agents shown with yellow background
4. Global agents listed first
5. Add form has toggle, defaults to Project
6. Built-in add defaults to Global
7. Edit shows toggle with current scope, can change scope (moves file)

- [ ] **Step 14: Commit**

```bash
git add src/features/opencode-config/components/sections/AgentsSection.tsx
git commit -m "feat(agents): replace scope tabs with unified list and toggle"
```

---

### Task 6: Update McpServersSection

**Files:**
- Modify: `src/features/opencode-config/components/sections/McpServersSection.tsx`

MCP servers are config-based (stored in opencode.jsonc). Global and project configs are separate files.

- [ ] **Step 1: Add imports for shared components**

```ts
import { ScopeToggle, type Scope } from "../shared/ScopeToggle";
import { ScopeFormWrapper } from "../shared/ScopeFormWrapper";
import { useScopeItems } from "../../hooks/useScopeItems";
```

- [ ] **Step 2: Replace scope state with dual loading**

Replace:
```ts
const [scope, setScope] = useState<Scope>("global");
```

With:
```ts
const [formScope, setFormScope] = useState<Scope>("project");
const [editingScope, setEditingScope] = useState<Scope | null>(null);
```

The store already has both `config.mcp` (global) and `projectMcpServers` (project). Use them directly.

- [ ] **Step 3: Create merged entries list**

```ts
const globalEntries = useMemo(
  () => Object.entries(config.mcp ?? {}).map(([name, server]) => ({ name, server })),
  [config.mcp]
);
const projectEntries = useMemo(
  () => Object.entries(projectMcpServers).map(([name, server]) => ({ name, server })),
  [projectMcpServers]
);
const scopedEntries = useScopeItems(globalEntries, projectEntries);
```

- [ ] **Step 4: Ensure both scopes load on mount**

Keep the existing `loadConfig()` and `loadProjectMcpServers()` calls but remove the scope-conditional loading. Both should always load:

```ts
useEffect(() => {
  loadConfig();
}, [loadConfig]);

useEffect(() => {
  if (activeFolderPath) {
    loadProjectMcpServers(activeFolderPath);
  }
}, [activeFolderPath, loadProjectMcpServers]);
```

- [ ] **Step 5: Update save handler for scope-aware saving**

```ts
const handleSave = async () => {
  // ... existing validation ...
  if (editing && editingScope && editingScope !== formScope) {
    // Scope changed: delete from old scope
    if (editingScope === "global") {
      await deleteMcpServer(editing);
    } else {
      await deleteProjectMcpServer(editing, activeFolderPath!);
    }
  }
  // Save to new scope
  if (formScope === "global") {
    await saveMcpServer(formName, serverObj);
  } else {
    await saveProjectMcpServer(formName, serverObj, activeFolderPath!);
  }
  // Reload both
  await loadConfig();
  if (activeFolderPath) await loadProjectMcpServers(activeFolderPath);
  // ... reset form state ...
};
```

- [ ] **Step 6: Update startAdd and startEdit**

```ts
const startAdd = () => {
  setAdding(true);
  setFormScope("project");
  // ... existing field resets ...
};

const startEdit = (name: string, server: OpencodeMcpServer, itemScope: Scope) => {
  setEditing(name);
  setEditingScope(itemScope);
  setFormScope(itemScope);
  // ... existing field population ...
};
```

Update `handleAddBuiltin` to set `formScope` to `"global"`.

- [ ] **Step 7: Remove scope tabs, add scope coloring to item list**

Remove the `oc-section__scope-tabs` JSX block. Replace the item list with:

```tsx
{scopedEntries.map(({ scope: itemScope, data: { name, server } }) => {
  const isEnabled = server.disabled !== true;
  return (
    <div
      key={`${itemScope}-${name}`}
      className={`oc-section__item oc-section__item--${itemScope}${!isEnabled ? " oc-section__item--disabled" : ""}`}
    >
      {/* existing item content, but pass itemScope to startEdit */}
    </div>
  );
})}
```

- [ ] **Step 8: Add ScopeToggle and ScopeFormWrapper to form**

```tsx
{isEditing && (
  <>
    <ScopeToggle value={formScope} onChange={setFormScope} />
    <ScopeFormWrapper scope={formScope}>
      {/* existing form fields (type tabs, name, command/url, env, headers, etc.) */}
    </ScopeFormWrapper>
    {/* form actions outside wrapper */}
  </>
)}
```

- [ ] **Step 9: Verify MCP servers section works**

Open Settings → MCP tab. Verify unified list, scope colors, toggle in add/edit, scope move works.

- [ ] **Step 10: Commit**

```bash
git add src/features/opencode-config/components/sections/McpServersSection.tsx
git commit -m "feat(mcp): replace scope tabs with unified list and toggle"
```

---

### Task 7: Update CommandsSection

**Files:**
- Modify: `src/features/opencode-config/components/sections/CommandsSection.tsx`

Commands are config-based, similar to MCP servers.

- [ ] **Step 1: Add imports for shared components**

```ts
import { ScopeToggle, type Scope } from "../shared/ScopeToggle";
import { ScopeFormWrapper } from "../shared/ScopeFormWrapper";
import { useScopeItems } from "../../hooks/useScopeItems";
```

- [ ] **Step 2: Replace scope state with formScope + dual loading**

Replace:
```ts
const [scope, setScope] = useState<Scope>("global");
```

With:
```ts
const [formScope, setFormScope] = useState<Scope>("project");
const [editingScope, setEditingScope] = useState<Scope | null>(null);
```

- [ ] **Step 3: Create merged entries list**

The store has `config.commands` (global) and `projectCommands` (project):

```ts
const globalEntries = useMemo(
  () => Object.entries(config.commands ?? {}).map(([name, cmd]) => ({ name, cmd })),
  [config.commands]
);
const projectCmdEntries = useMemo(
  () => Object.entries(projectCommands).map(([name, cmd]) => ({ name, cmd })),
  [projectCommands]
);
const scopedEntries = useScopeItems(globalEntries, projectCmdEntries);
```

- [ ] **Step 4: Ensure both scopes load**

```ts
useEffect(() => {
  loadConfig();
}, [loadConfig]);

useEffect(() => {
  if (activeFolderPath) {
    loadProjectCommands(activeFolderPath);
  }
}, [activeFolderPath, loadProjectCommands]);
```

- [ ] **Step 5: Update save/edit/add/delete with scope awareness**

Same pattern as MCP: `startAdd` sets `formScope="project"`, `startEdit` accepts `itemScope`, `handleAddBuiltin` sets `formScope="global"`, save handles scope change by deleting from old + saving to new.

- [ ] **Step 6: Remove scope tabs, add scope coloring and ScopeToggle/Wrapper**

Same pattern as previous sections.

- [ ] **Step 7: Verify and commit**

```bash
git add src/features/opencode-config/components/sections/CommandsSection.tsx
git commit -m "feat(commands): replace scope tabs with unified list and toggle"
```

---

### Task 8: Update SkillsSection

**Files:**
- Modify: `src/features/opencode-config/components/sections/SkillsSection.tsx`

Skills are file-based, similar to Agents.

- [ ] **Step 1: Add imports for shared components**

```ts
import { ScopeToggle, type Scope } from "../shared/ScopeToggle";
import { ScopeFormWrapper } from "../shared/ScopeFormWrapper";
import { useScopeItems } from "../../hooks/useScopeItems";
```

- [ ] **Step 2: Replace scope state with dual loading**

Replace:
```ts
const [scope, setScope] = useState<SkillScope>("global");
const [skillEntries, setSkillEntries] = useState<SkillEntry[]>([]);
```

With:
```ts
const [globalSkillEntries, setGlobalSkillEntries] = useState<SkillEntry[]>([]);
const [projectSkillEntries, setProjectSkillEntries] = useState<SkillEntry[]>([]);
const [formScope, setFormScope] = useState<Scope>("project");
const [editingScope, setEditingScope] = useState<Scope | null>(null);
```

- [ ] **Step 3: Update getSkillsDir to accept scope parameter**

```ts
const getSkillsDir = useCallback(
  async (targetScope: Scope): Promise<string | null> => {
    if (targetScope === "global") {
      const home = await invoke<string>("get_home_dir");
      const sep = home.includes("\\") ? "\\" : "/";
      return `${home}${sep}.config${sep}opencode${sep}skills`;
    }
    if (activeFolderPath) {
      const sep = activeFolderPath.includes("\\") ? "\\" : "/";
      return `${activeFolderPath}${sep}.opencode${sep}skills`;
    }
    return null;
  },
  [activeFolderPath]
);
```

- [ ] **Step 4: Update loadSkills to load both scopes**

```ts
const loadAllSkills = useCallback(async () => {
  setLoading(true);
  try {
    const globalDir = await getSkillsDir("global");
    if (globalDir) {
      const names = await invoke<string[]>("list_skills", { dir: globalDir });
      // ... parse each skill, set globalSkillEntries
    } else {
      setGlobalSkillEntries([]);
    }
    const projectDir = await getSkillsDir("project");
    if (projectDir) {
      const names = await invoke<string[]>("list_skills", { dir: projectDir });
      // ... parse each skill, set projectSkillEntries
    } else {
      setProjectSkillEntries([]);
    }
  } finally {
    setLoading(false);
  }
}, [getSkillsDir]);
```

- [ ] **Step 5: Create merged list and update item rendering**

```ts
const scopedSkills = useScopeItems(globalSkillEntries, projectSkillEntries);
```

Remove scope tabs. Add `oc-section__item--${itemScope}` class to items. Pass `itemScope` to startEdit and handleDelete.

- [ ] **Step 6: Add ScopeToggle and ScopeFormWrapper to form**

Add toggle above form, wrap form fields in ScopeFormWrapper. `startAdd` defaults to `"project"`, `handleAddBuiltin` defaults to `"global"`. Edit shows toggle with current scope, supports scope change (move skill directory between global/project).

- [ ] **Step 7: Implement scope move for skills**

When editing and scope changes, delete skill from old scope directory and write to new scope directory.

- [ ] **Step 8: Verify and commit**

```bash
git add src/features/opencode-config/components/sections/SkillsSection.tsx
git commit -m "feat(skills): replace scope tabs with unified list and toggle"
```

---

### Task 9: Update CustomToolsSection

**Files:**
- Modify: `src/features/opencode-config/components/sections/CustomToolsSection.tsx`

Custom tools are file-based, no builtin support.

- [ ] **Step 1: Add imports for shared components**

```ts
import { ScopeToggle, type Scope } from "../shared/ScopeToggle";
import { ScopeFormWrapper } from "../shared/ScopeFormWrapper";
import { useScopeItems } from "../../hooks/useScopeItems";
```

- [ ] **Step 2: Replace scope state with dual loading**

Replace:
```ts
const [scope, setScope] = useState<Scope>("global");
const [toolFiles, setToolFiles] = useState<ToolFileEntry[]>([]);
```

With:
```ts
const [globalToolFiles, setGlobalToolFiles] = useState<ToolFileEntry[]>([]);
const [projectToolFiles, setProjectToolFiles] = useState<ToolFileEntry[]>([]);
const [formScope, setFormScope] = useState<Scope>("project");
const [editingScope, setEditingScope] = useState<Scope | null>(null);
```

- [ ] **Step 3: Update getToolsDir to accept scope parameter and load both**

Same pattern as Skills: `getToolsDir(targetScope)`, `loadAllToolFiles()` loads both scopes.

- [ ] **Step 4: Create merged list, remove scope tabs, add scope coloring**

```ts
const scopedTools = useScopeItems(globalToolFiles, projectToolFiles);
```

Items get `oc-section__item--${itemScope}` class.

- [ ] **Step 5: Add ScopeToggle and ScopeFormWrapper to form**

No builtin support, so `startAdd` always defaults to `"project"`. Edit supports scope change.

- [ ] **Step 6: Verify and commit**

```bash
git add src/features/opencode-config/components/sections/CustomToolsSection.tsx
git commit -m "feat(custom-tools): replace scope tabs with unified list and toggle"
```

---

### Task 10: Update RulesSection

**Files:**
- Modify: `src/features/opencode-config/components/sections/RulesSection.tsx`

Rules is a special case: single text editor per scope, not an item list. Replace scope tabs with toggle, wrap editor in ScopeFormWrapper.

- [ ] **Step 1: Add imports for shared components**

```ts
import { ScopeToggle, type Scope } from "../shared/ScopeToggle";
import { ScopeFormWrapper } from "../shared/ScopeFormWrapper";
```

- [ ] **Step 2: Replace scope tabs with ScopeToggle**

Replace `RulesScope` type with imported `Scope`. The existing `scope` state stays (it controls which file is loaded/edited), but the UI changes from tabs to toggle:

```ts
const [scope, setScope] = useState<Scope>("global");
```

Remove the `oc-section__scope-tabs` JSX. Add ScopeToggle:

```tsx
<ScopeToggle value={scope} onChange={setScope} />
```

- [ ] **Step 3: Wrap editor panel in ScopeFormWrapper**

```tsx
<ScopeToggle value={scope} onChange={setScope} />
<ScopeFormWrapper scope={scope}>
  {/* existing editor panel (tabs, textarea, preview, save button) */}
</ScopeFormWrapper>
```

- [ ] **Step 4: Verify and commit**

Open Settings → Rules tab. Verify:
1. Toggle switch instead of scope tabs
2. Editor wrapped in colored border (purple for Global, yellow for Project)
3. Switching toggle loads different file content
4. Save writes to correct file

```bash
git add src/features/opencode-config/components/sections/RulesSection.tsx
git commit -m "feat(rules): replace scope tabs with toggle and scope-colored editor"
```

---

### Task 11: Clean up unused scope tab CSS

**Files:**
- Modify: `src/features/opencode-config/components/OpencodeConfigDialog.css`

- [ ] **Step 1: Remove scope tab styles**

Remove the now-unused `.oc-section__scope-tabs`, `.oc-section__scope-tab`, `.oc-section__scope-tab:not(:last-child)`, `.oc-section__scope-tab:hover`, and `.oc-section__scope-tab--active` CSS rules (approximately lines 345-379).

- [ ] **Step 2: Verify no visual regressions**

Check all 6 sections to confirm nothing is broken.

- [ ] **Step 3: Commit**

```bash
git add src/features/opencode-config/components/OpencodeConfigDialog.css
git commit -m "refactor: remove unused scope tab CSS"
```

---

### Task 12: Final verification

- [ ] **Step 1: Test all 6 sections end-to-end**

For each section (Rules, Agents, Commands, MCP, Skills, Custom Tools):
1. Verify unified list shows Global (purple bg) items first, then Project (yellow bg)
2. Verify Add form has Global toggle, defaults to Project (Global for builtins)
3. Verify Edit form has Global toggle showing current scope
4. Verify scope change on edit moves item between scopes
5. Verify delete works for both scopes

- [ ] **Step 2: Test edge cases**

1. No project open → Project items section empty, add with Project scope shows appropriate message
2. Toggle between Global/Project in add form → path hint updates
3. Multiple themes → scope colors adapt to primary color

- [ ] **Step 3: Commit any fixes**

```bash
git add -u
git commit -m "fix: address scope UI edge cases"
```
