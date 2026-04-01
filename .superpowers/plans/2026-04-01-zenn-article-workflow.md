# Zenn Article Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable Zenn article creation, preview, and GitHub push workflow within MDium, leveraging the existing command system and Git panel to minimize Zenn-specific code.

**Architecture:** Settings dialog gets an "Other" tab for Zenn folder initialization (git init + directory scaffolding). Zenn mode is auto-detected via `detect_zenn_project` Tauri command (articles/ + books/ + images/ AND condition). Two builtin commands handle article scaffolding and proofreading. A third command handles deploying from work/ to articles/ + images/. PreviewPanel auto-applies Zenn syntax preprocessing and shows ZennFrontmatterForm when in Zenn mode.

**Tech Stack:** React 19, TypeScript, Zustand, Tauri 2 (Rust backend), i18next

---

### Task 1: Update `detect_zenn_project` to AND condition + `has_images` field

The existing Rust command uses OR logic (`has_articles || has_books`). Update it to require all three directories AND add `has_images` field.

**Files:**
- Modify: `src-tauri/src/commands/file.rs:238-286`

- [ ] **Step 1: Update `ZennProjectInfo` struct**

In `src-tauri/src/commands/file.rs`, add `has_images` field to the struct at line 239:

```rust
/// Zenn project detection result
#[derive(Debug, Serialize, Deserialize)]
pub struct ZennProjectInfo {
    pub is_zenn_project: bool,
    pub project_root: String,
    pub has_articles: bool,
    pub has_books: bool,
    pub has_images: bool,
}
```

- [ ] **Step 2: Update `detect_zenn_project` function**

Replace the function body at lines 258-286:

```rust
#[tauri::command]
pub fn detect_zenn_project(dir_path: String) -> Result<ZennProjectInfo, String> {
    let path = Path::new(&dir_path);
    if !path.exists() || !path.is_dir() {
        return Err("Directory does not exist".to_string());
    }

    let articles_path = path.join("articles");
    let books_path = path.join("books");
    let images_path = path.join("images");
    let has_articles = articles_path.exists() && articles_path.is_dir();
    let has_books = books_path.exists() && books_path.is_dir();
    let has_images = images_path.exists() && images_path.is_dir();

    let is_zenn = has_articles && has_books && has_images;

    Ok(ZennProjectInfo {
        is_zenn_project: is_zenn,
        project_root: dir_path,
        has_articles,
        has_books,
        has_images,
    })
}
```

- [ ] **Step 3: Build and verify**

Run: `cd src-tauri && cargo check`
Expected: compiles without errors

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands/file.rs
git commit -m "refactor: update detect_zenn_project to AND condition with has_images"
```

---

### Task 2: Add `isZennMode` to UI store + folder detection

Add Zenn mode state that's checked when folders are opened/switched.

**Files:**
- Modify: `src/stores/ui-store.ts`

- [ ] **Step 1: Read current ui-store**

Read `src/stores/ui-store.ts` to understand the current interface and state shape.

- [ ] **Step 2: Add `isZennMode` state and setter**

Add to the UiState interface and initial state in `src/stores/ui-store.ts`:

```typescript
// Add to interface
isZennMode: boolean;
setZennMode: (mode: boolean) => void;

// Add to create()
isZennMode: false,
setZennMode: (mode) => set({ isZennMode: mode }),
```

- [ ] **Step 3: Add Zenn detection call to folder open/switch in App.tsx**

Read `src/app/App.tsx` to find where `openFolder` and `switchFolder` are called, then add a `detect_zenn_project` invoke after folder changes. The detection should call:

```typescript
import { invoke } from "@tauri-apps/api/core";

// After folder open/switch, detect Zenn mode:
const info = await invoke<{ is_zenn_project: boolean }>("detect_zenn_project", { dirPath: folderPath });
useUiStore.getState().setZennMode(info.is_zenn_project);
```

Find the appropriate location in App.tsx where `activeFolderPath` changes and add a `useEffect` that runs detection:

```typescript
useEffect(() => {
  if (!activeFolderPath) {
    useUiStore.getState().setZennMode(false);
    return;
  }
  invoke<{ is_zenn_project: boolean }>("detect_zenn_project", { dirPath: activeFolderPath })
    .then((info) => useUiStore.getState().setZennMode(info.is_zenn_project))
    .catch(() => useUiStore.getState().setZennMode(false));
}, [activeFolderPath]);
```

- [ ] **Step 4: Commit**

```bash
git add src/stores/ui-store.ts src/app/App.tsx
git commit -m "feat: add isZennMode state with auto-detection on folder open"
```

---

### Task 3: Add i18n keys for Zenn settings

**Files:**
- Modify: `src/shared/i18n/locales/en/settings.json`
- Modify: `src/shared/i18n/locales/ja/settings.json`

- [ ] **Step 1: Add English keys**

Add the following keys to `src/shared/i18n/locales/en/settings.json` (before the closing `}`):

```json
"tabOther": "Other",
"zennInit": "Initialize as Zenn folder",
"zennInitDescription": "Select an empty folder to set up as a Zenn article repository (git init, articles/, books/, images/, work/ directories)",
"zennInitSuccess": "Zenn folder initialized successfully",
"zennInitNotEmpty": "The selected folder is not empty. Please choose an empty folder.",
"zennInitFailed": "Failed to initialize Zenn folder"
```

- [ ] **Step 2: Add Japanese keys**

Add the following keys to `src/shared/i18n/locales/ja/settings.json` (before the closing `}`):

```json
"tabOther": "その他",
"zennInit": "Zennフォルダとして初期化",
"zennInitDescription": "空のフォルダを選択してZenn記事用リポジトリとして初期化します（git init、articles/、books/、images/、work/ ディレクトリを作成）",
"zennInitSuccess": "Zennフォルダを初期化しました",
"zennInitNotEmpty": "選択したフォルダが空ではありません。空のフォルダを選択してください。",
"zennInitFailed": "Zennフォルダの初期化に失敗しました"
```

- [ ] **Step 3: Commit**

```bash
git add src/shared/i18n/locales/en/settings.json src/shared/i18n/locales/ja/settings.json
git commit -m "feat: add i18n keys for Zenn settings tab"
```

---

### Task 4: Add "Other" tab with Zenn initialization to Settings dialog

**Files:**
- Modify: `src/features/settings/components/SettingsDialog.tsx`

- [ ] **Step 1: Update activeTab type**

In `SettingsDialog.tsx` line 64, add `"other"` to the union type:

```typescript
const [activeTab, setActiveTab] = useState<"general" | "ai" | "display" | "other">("general");
```

- [ ] **Step 2: Add "Other" tab button**

After the Display tab button (around line 280), add:

```tsx
<button
  className={`settings-dialog__tab ${activeTab === "other" ? "settings-dialog__tab--active" : ""}`}
  onClick={() => setActiveTab("other")}
>
  {t("tabOther")}
</button>
```

- [ ] **Step 3: Add Zenn initialization handler**

Add the following imports at the top of the file (if not already present):

```typescript
import { open } from "@tauri-apps/plugin-dialog";
```

Add this handler function inside the component, before the return statement:

```typescript
const handleZennInit = useCallback(async () => {
  const selected = await open({ directory: true, multiple: false });
  if (!selected) return;
  const folderPath = selected as string;

  // Check if folder is empty
  try {
    const entries = await invoke<Array<unknown>>("get_file_tree", {
      dirPath: folderPath,
      showAll: true,
      includeDocx: false,
      includeXls: false,
      includeKm: false,
      includeImages: false,
      includePdf: false,
      includeEmptyDirs: false,
    });
    if (entries.length > 0) {
      await message(t("zennInitNotEmpty"), { kind: "warning" });
      return;
    }
  } catch {
    // If get_file_tree fails, try to proceed
  }

  try {
    await invoke("git_init", { path: folderPath });
    await invoke("create_folder", { path: `${folderPath}/articles` });
    await invoke("create_folder", { path: `${folderPath}/books` });
    await invoke("create_folder", { path: `${folderPath}/images` });
    await invoke("create_folder", { path: `${folderPath}/work` });
    await invoke("write_text_file", {
      path: `${folderPath}/.gitignore`,
      content: "work/\n",
    });
    await message(t("zennInitSuccess"), { kind: "info" });
    setShowSettings(false);

    // Open the initialized folder as a workspace
    const { useTabStore } = await import("@/stores/tab-store");
    useTabStore.getState().openFolder(folderPath);
  } catch (e) {
    await message(`${t("zennInitFailed")}: ${e}`, { kind: "error" });
  }
}, [t, setShowSettings]);
```

- [ ] **Step 4: Add "Other" tab content**

After the Display tab content block (after the closing `</>` and `)}` around line 567), add:

```tsx
{activeTab === "other" && (
  <>
    <div className="settings-dialog__section-title">Zenn</div>
    <span className="settings-dialog__description">
      {t("zennInitDescription")}
    </span>
    <button
      className="settings-dialog__test-btn"
      onClick={handleZennInit}
    >
      {t("zennInit")}
    </button>
  </>
)}
```

- [ ] **Step 5: Verify it builds**

Run: `npm run build`
Expected: builds without errors

- [ ] **Step 6: Commit**

```bash
git add src/features/settings/components/SettingsDialog.tsx
git commit -m "feat: add Other tab with Zenn folder initialization to settings"
```

---

### Task 5: Add builtin commands (`create-zenn-article`, `proofread-zenn-article`, `deploy-zenn-article`)

**Files:**
- Modify: `src/features/opencode-config/lib/builtin-commands.ts`

- [ ] **Step 1: Add `create-zenn-article` command**

Append to the `BUILTIN_COMMANDS` object in `builtin-commands.ts` (before the closing `};`):

```typescript
  "create-zenn-article": {
    name: "create-zenn-article",
    description: "Create a new Zenn article with frontmatter in the work/ directory",
    template: `# Create Zenn Article

You are creating a new Zenn article in this workspace.

## Instructions

1. Ask the user for the following information interactively:
   - **slug**: URL-friendly identifier (12-50 chars, only lowercase alphanumeric, hyphens, underscores). Suggest a slug based on the topic if the user doesn't provide one.
   - **title**: Article title
   - **emoji**: A single emoji for the article
   - **type**: "tech" (technical article) or "idea" (opinion/essay)
   - **topics**: Up to 5 topic tags (lowercase alphanumeric + hyphens)

2. Create the directory \`work/{slug}/images/\` (the images subdirectory ensures the parent directory is also created).

3. Create the file \`work/{slug}/index.md\` with this frontmatter and a brief outline:

\`\`\`markdown
---
title: "{title}"
emoji: "{emoji}"
type: "{type}"
topics: [{topics as comma-separated quoted strings}]
published: false
---

{A brief article outline or starting template based on the title and type}
\`\`\`

4. After creating the file, inform the user of the created path and suggest they open it.

## Important Notes

- The \`work/\` directory is for drafting — it's excluded from git via .gitignore.
- Images should be placed in \`work/{slug}/images/\`.
- When ready to publish, the user will use the "deploy-zenn-article" command.
`,
  },
```

- [ ] **Step 2: Add `proofread-zenn-article` command**

Append to the `BUILTIN_COMMANDS` object:

```typescript
  "proofread-zenn-article": {
    name: "proofread-zenn-article",
    description: "Proofread and improve a Zenn article",
    template: `# Proofread Zenn Article

Read the Zenn article at \`$ARGUMENTS\` and provide proofreading feedback.

## Instructions

1. Read the entire article content at \`$ARGUMENTS\`.
2. Analyze the article for:
   - **Grammar and spelling** errors
   - **Technical accuracy** of code examples and explanations
   - **Readability** — sentence structure, paragraph flow, logical progression
   - **Zenn-specific formatting** — proper use of \`:::message\`, \`:::details\`, code blocks with filenames (\`\`\`lang:filename\`\`\`), image sizing syntax
   - **Frontmatter completeness** — title, emoji, type, topics (max 5), published flag
   - **Article structure** — introduction, main content, conclusion/summary

3. Present findings organized by category (errors, suggestions, style improvements).
4. For each issue, show the original text and your suggested revision.
5. Ask the user if they want you to apply the changes directly to the file.

## Important Notes

- Match the language of the article (write feedback in Japanese if the article is in Japanese).
- Preserve Zenn-specific syntax — do not convert \`:::\` blocks to standard Markdown.
- Be constructive and specific — explain why each change improves the article.
`,
  },
```

- [ ] **Step 3: Add `deploy-zenn-article` command**

Append to the `BUILTIN_COMMANDS` object:

```typescript
  "deploy-zenn-article": {
    name: "deploy-zenn-article",
    description: "Deploy article from work/ to articles/ and images/ for Zenn publishing",
    template: `# Deploy Zenn Article

Deploy the work-in-progress article to the Zenn publishing directories.

## Instructions

1. Read the article at \`$ARGUMENTS\`.
2. Determine the slug from the file path. The file should be at \`work/{slug}/index.md\`.
3. Copy the article content to \`articles/{slug}.md\`.
4. Copy all image files from \`work/{slug}/images/\` to \`images/\` (flat copy, no subdirectories).
5. In the copied \`articles/{slug}.md\`, rewrite image paths:
   - Replace relative paths like \`images/img1.png\` or \`./images/img1.png\` with \`/images/img1.png\`
6. Report what was copied and any path transformations made.

## Important Notes

- The \`work/\` directory is excluded from git. Only files in \`articles/\` and \`images/\` will be committed and pushed.
- If \`articles/{slug}.md\` already exists, overwrite it (this is a re-deploy).
- If there are no images in \`work/{slug}/images/\`, skip the image copy step.
- Preserve the frontmatter exactly as-is.
`,
  },
```

- [ ] **Step 4: Verify it builds**

Run: `npm run build`
Expected: builds without errors

- [ ] **Step 5: Commit**

```bash
git add src/features/opencode-config/lib/builtin-commands.ts
git commit -m "feat: add create, proofread, and deploy Zenn article builtin commands"
```

---

### Task 6: PreviewPanel — auto-apply Zenn preprocessing + FrontmatterForm

**Files:**
- Modify: `src/features/preview/components/PreviewPanel.tsx`

- [ ] **Step 1: Read PreviewPanel for current Zenn handling**

Read `src/features/preview/components/PreviewPanel.tsx` lines 1-30 (imports), 580-596 (rendering pipeline), and 1060-1145 (toolbar JSX) to find the exact insertion points.

- [ ] **Step 2: Import ZennFrontmatterForm and useUiStore**

Add to the imports at the top of `PreviewPanel.tsx`:

```typescript
import { ZennFrontmatterForm } from "@/features/zenn/components/ZennFrontmatterForm";
import { useUiStore } from "@/stores/ui-store";
```

- [ ] **Step 3: Add isZennMode state and frontmatter parsing**

Inside the component, add:

```typescript
const isZennMode = useUiStore((s) => s.isZennMode);
```

Find the existing `extractFrontMatter` call in the rendering useEffect (around line 583). The `frontMatter` state already exists (set by `setFrontMatter(meta)`). Verify this state variable name and type to ensure compatibility with ZennFrontmatterForm.

The existing `preprocessZenn` is already called unconditionally at line 585. This is fine — Zenn syntax doesn't conflict with standard Markdown. No change needed to the rendering pipeline.

- [ ] **Step 4: Add frontmatter change handler**

Add a handler that updates the editor content when frontmatter is changed via the form:

```typescript
const handleZennFrontmatterChange = useCallback(
  (fm: { title: string; emoji: string; type: "tech" | "idea"; topics: string[]; published: boolean }) => {
    if (!activeTabId) return;
    const tab = useTabStore.getState().getActiveTab();
    if (!tab) return;
    const { body } = extractFrontMatter(tab.content);
    const topicsStr = fm.topics.map((t) => `"${t}"`).join(", ");
    const newFrontmatter = `---
title: "${fm.title}"
emoji: "${fm.emoji}"
type: "${fm.type}"
topics: [${topicsStr}]
published: ${fm.published}
---`;
    useTabStore.getState().updateTabContent(tab.id, `${newFrontmatter}\n${body}`);
  },
  [activeTabId]
);
```

Note: `extractFrontMatter` is already defined in the file. `useTabStore` is already imported. Verify these names by reading the actual imports.

- [ ] **Step 5: Add ZennFrontmatterForm to preview panel**

Find where the preview content is rendered (the `contentRef` div). Add the FrontmatterForm just before it, conditionally shown when:
- `isZennMode` is true
- The file is under `work/` or `articles/` directory
- The file is a `.md` file

```tsx
{isZennMode && filePath && (filePath.includes("/work/") || filePath.includes("\\work\\") || filePath.includes("/articles/") || filePath.includes("\\articles\\")) && filePath.endsWith(".md") && frontMatter && (
  <ZennFrontmatterForm
    frontmatter={{
      title: frontMatter.title ?? "",
      emoji: frontMatter.emoji ?? "",
      type: (frontMatter.type === "idea" ? "idea" : "tech") as "tech" | "idea",
      topics: Array.isArray(frontMatter.topics) ? frontMatter.topics : [],
      published: frontMatter.published ?? false,
    }}
    onChange={handleZennFrontmatterChange}
  />
)}
```

Find the exact location by reading the JSX structure around the preview body/content area.

- [ ] **Step 6: Verify it builds**

Run: `npm run build`
Expected: builds without errors

- [ ] **Step 7: Commit**

```bash
git add src/features/preview/components/PreviewPanel.tsx
git commit -m "feat: add Zenn frontmatter form to preview panel in Zenn mode"
```

---

### Task 7: Wire `isZennMode` into `useFileFilters`

The existing `useFileFilters` hook already accepts an `isZennMode` parameter but it's never passed from App.tsx.

**Files:**
- Modify: `src/app/App.tsx`

- [ ] **Step 1: Read the useFileFilters call in App.tsx**

Read `src/app/App.tsx` and find the line where `useFileFilters` is called (around line 188). It currently calls without the third argument.

- [ ] **Step 2: Pass isZennMode to useFileFilters**

Add `isZennMode` from ui-store and pass it:

```typescript
const isZennMode = useUiStore((s) => s.isZennMode);

// Update the useFileFilters call to pass isZennMode:
const { ... } = useFileFilters(activeFolderPath, setFileTree, isZennMode);
```

- [ ] **Step 3: Verify it builds**

Run: `npm run build`
Expected: builds without errors

- [ ] **Step 4: Commit**

```bash
git add src/app/App.tsx
git commit -m "feat: pass isZennMode to useFileFilters for Zenn-specific file filtering"
```

---

### Task 8: Delete unused Zenn components

**Files:**
- Delete: `src/features/zenn/components/ZennNewArticleDialog.tsx`
- Delete: `src/features/zenn/components/ZennNewArticleDialog.css`
- Delete: `src/features/zenn/components/ZennPublishPanel.tsx`
- Delete: `src/features/zenn/components/ZennPublishPanel.css`

- [ ] **Step 1: Search for imports of these components**

Search the codebase for any imports of `ZennNewArticleDialog` or `ZennPublishPanel`. If any imports exist, remove them.

```bash
grep -r "ZennNewArticleDialog\|ZennPublishPanel" src/
```

- [ ] **Step 2: Delete the files**

```bash
rm src/features/zenn/components/ZennNewArticleDialog.tsx
rm src/features/zenn/components/ZennNewArticleDialog.css
rm src/features/zenn/components/ZennPublishPanel.tsx
rm src/features/zenn/components/ZennPublishPanel.css
```

- [ ] **Step 3: Verify it builds**

Run: `npm run build`
Expected: builds without errors (no dangling imports)

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore: remove unused ZennNewArticleDialog and ZennPublishPanel components"
```

---

### Task 9: Final integration verification

- [ ] **Step 1: Full build check**

Run: `npm run build`
Expected: clean build with no errors or warnings

- [ ] **Step 2: Manual verification checklist**

Verify these scenarios work:
1. Settings → Other tab → "Initialize as Zenn folder" button visible
2. Click button → folder selection dialog opens
3. Select empty folder → articles/, books/, images/, work/ created, git init'd, .gitignore has work/
4. Select non-empty folder → error message shown
5. After initialization, folder opens as workspace → Zenn mode detected (isZennMode = true)
6. File filtering shows only images + empty dirs in Zenn mode
7. Command dropdown shows create-zenn-article, proofread-zenn-article, deploy-zenn-article
8. Open a .md in work/ → ZennFrontmatterForm appears in preview
9. Edit frontmatter via form → editor content updates
10. Zenn syntax (:::message, :::details, code filenames) renders correctly in preview

- [ ] **Step 3: Commit any final fixes**

If any issues found, fix and commit.
