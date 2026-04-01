# Zenn Article Workflow

MDium provides an integrated workflow for creating, previewing, and publishing [Zenn](https://zenn.dev/) articles directly from the app.

## Overview

```
work/{slug}/index.md  --[edit]--> Preview (Zenn syntax)
work/{slug}/images/   --[edit]--> Preview (local images)
         |
         v  (deploy-zenn-article command)
articles/{slug}.md  + images/*.png
         |
         v  (Git panel: commit & push)
GitHub --> Zenn (auto-deploy)
```

## Setup

### 1. Initialize a Zenn Folder

1. Open **Settings** (gear icon in the left sidebar)
2. Go to the **Other** tab
3. Click **Initialize as Zenn folder**
4. Select an **empty** folder

This creates the following structure:

```
your-zenn-folder/
├── articles/       # Published articles (tracked by Git)
├── books/          # Published books (tracked by Git)
├── images/         # Published images (tracked by Git)
├── work/           # Drafts (excluded from Git via .gitignore)
└── .gitignore      # Contains "work/"
```

The folder is also initialized as a Git repository with the `main` branch.

### 2. Connect to GitHub

1. Open the **Git** panel (left sidebar)
2. Set the remote URL to your Zenn-connected GitHub repository
3. You can now commit and push from the Git panel

## Writing Articles

### Create a New Article

1. Open the preview toolbar's **command dropdown**
2. Select **create-zenn-article**
3. The AI will interactively ask for:
   - **slug** — URL identifier (12-50 chars, lowercase alphanumeric + hyphens/underscores)
   - **title** — Article title
   - **emoji** — A single emoji
   - **type** — `tech` (technical) or `idea` (opinion/essay)
   - **topics** — Up to 5 tags
4. The article is created at `work/{slug}/index.md` with proper frontmatter

### Folder Structure per Article

```
work/
└── my-article/
    ├── index.md        # Article content with frontmatter
    └── images/         # Images used in this article
        ├── screenshot.png
        └── diagram.svg
```

Reference images in your article with relative paths:

```markdown
![Screenshot](images/screenshot.png)
```

### Edit Frontmatter

When editing a Zenn article (in `work/` or `articles/`), the preview panel shows an interactive **frontmatter form** at the top:

- Emoji, title, type (tech/idea), published flag, and topic tags
- Changes are synced back to the editor in real time

### Zenn Syntax Support

The preview automatically renders Zenn-specific syntax:

**Message blocks:**
```markdown
:::message
Default info message
:::

:::message alert
Warning message
:::
```

**Collapsible details:**
```markdown
:::details Click to expand
Hidden content here
:::
```

**Code blocks with filename:**
````markdown
```js:src/index.js
console.log("hello");
```
````

**Image sizing:**
```markdown
![alt](url =250x)
```

### Proofread

1. Open your article in the editor
2. Select **proofread-zenn-article** from the command dropdown
3. The AI reads the article and provides:
   - Grammar and spelling corrections
   - Technical accuracy review
   - Readability improvements
   - Zenn-specific formatting suggestions

## Publishing

### Deploy to Publishing Directories

1. Open your article (`work/{slug}/index.md`) in the editor
2. Select **deploy-zenn-article** from the command dropdown
3. The command copies:
   - `work/{slug}/index.md` to `articles/{slug}.md`
   - `work/{slug}/images/*` to `images/` (flat)
4. Image paths in the copied `.md` are rewritten to `/images/filename.png`

### Push to GitHub

1. Open the **Git** panel
2. Stage the changes (`articles/` and `images/` files)
3. Enter a commit message
4. Click **Commit** then **Push**

Zenn automatically deploys from the connected GitHub repository.

## Zenn Mode

MDium automatically detects Zenn projects when all three directories (`articles/`, `books/`, `images/`) exist in the workspace folder. In Zenn mode:

- File tree filtering optimized for article writing (images shown, Office/PDF/mindmap hidden)
- Zenn syntax is rendered in the preview
- Frontmatter form is shown for articles
- Zenn-related commands appear in the command dropdown

## Commands Reference

| Command | Description | Input |
|---------|-------------|-------|
| `create-zenn-article` | Create a new article interactively | None (AI asks) |
| `proofread-zenn-article` | Proofread the current article | Current file path |
| `deploy-zenn-article` | Copy from work/ to articles/ + images/ | Current file path |
