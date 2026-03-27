# MDium

A modern, feature-rich document editor and workspace manager built with React, TypeScript, and Tauri.

MDium combines Markdown editing, AI assistance, mindmap visualization, office document support, and developer tools into a single desktop application.

[日本語版 README](README.ja.md)

## Features

### Markdown Editing

- Split-pane editor with real-time preview
- GitHub Flavored Markdown (GFM) support
- Mathematical expressions (KaTeX)
- Mermaid diagrams (flowcharts, sequence, ER, Gantt, class, state, pie)
- Code syntax highlighting (18+ languages)
- Search and replace (Ctrl+F / Ctrl+H)
- Scroll synchronization and auto-save
- Document outline view

### Multi-Format Document Support

- **Markdown** (.md) — primary editing format
- **Office documents** (.docx, .xlsx, .xlsm) — viewing and conversion
- **Mindmaps** (.km, .xmind) — interactive visual editing
- **PDF** (.pdf) — viewing and conversion to Markdown
- **Images** (.png, .jpg, .gif, .bmp, .svg, .webp, etc.) — preview and canvas editing
- Bidirectional DOCX/Markdown conversion
- Export to PDF

### AI Integration

- RAG (Retrieval-Augmented Generation) for document Q&A
- Semantic search with configurable embedding models (multilingual-e5-large, Ruri v3, etc.)
- Content generation via opencode-sdk (insert AI-generated text into editor)
- Multiple API providers: OpenAI, Anthropic, DeepSeek, Azure, Gemini, Grok, Groq, Ollama, custom endpoints
- Chat session management with history persistence
- UNC path support for network drives

### Speech-to-Text

- Whisper-based speech recognition (whisper-small, whisper-large-v3-turbo)
- Non-blocking Web Worker processing
- Direct transcript insertion into editor
- Model download with progress tracking

### Mindmap Editor

- Interactive node-based editing powered by ReactFlow
- Theme and layout customization
- Hyperlink and image insertion in nodes
- KM and XMind format support

### File Explorer

- File tree explorer with folder navigation
- Multi-folder workspace with tab support
- Drag-and-drop file operations (move/copy within tree)
- OS-to-tree file import (drag from system file manager)
- Cut/Copy/Paste operations (Ctrl+X / Ctrl+C / Ctrl+V)
- In-line file rename (F2)
- Open files in default application
- File filtering by type (images, .docx, .xls\*, .km/.xmind, .pdf) with "show all" mode
- File watching and auto-refresh
- Context menu (rename, delete, copy, cut, paste, open in default app)

### Git Source Control

- Integrated Git panel in left activity bar
- Repository initialization (with main branch)
- Staging and unstaging files
- Commit with message input
- AI-powered commit message generation
- Push to remote / remote URL management
- Branch listing and switching
- Discard changes (tracked and untracked)

### Integrated Terminal

- xterm.js-based terminal with PTY backend
- Folder-specific terminal sessions

### Developer Tool Integration

- opencode AI tool integration with chat, MCP server configuration, skill/agent/tool management
- Git operations (init, add, commit, push, branch)
- MCP server testing
- Zenn-formatted Markdown rendering in preview

### Themes & Customization

- Multiple built-in themes (light/dark)
- Customizable fonts, colors, and layout
- Theme synchronization with external tools
- Bilingual UI (English / Japanese)

## Tech Stack

| Layer         | Technologies                                                                                                                                                                                                                                     |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Frontend      | [React](https://github.com/facebook/react) 19, [TypeScript](https://github.com/microsoft/TypeScript) 5.9, [Vite](https://github.com/vitejs/vite) 7                                                                                                        |
| State         | [Zustand](https://github.com/pmndrs/zustand)                                                                                                                                                                                                        |
| Desktop       | [Tauri](https://github.com/tauri-apps/tauri) 2                                                                                                                                                                                                      |
| Backend       | [Rust](https://github.com/rust-lang/rust) ([Tokio](https://github.com/tokio-rs/tokio), [rusqlite](https://github.com/rusqlite/rusqlite), [reqwest](https://github.com/seanmonstar/reqwest), [portable-pty](https://github.com/wez/wezterm/tree/main/pty))       |
| Markdown      | [marked](https://github.com/markedjs/marked), [remark](https://github.com/remarkjs/remark), [KaTeX](https://github.com/KaTeX/KaTeX), [Mermaid](https://github.com/mermaid-js/mermaid), [highlight.js](https://github.com/highlightjs/highlight.js)              |
| AI/ML         | [Hugging Face Transformers](https://github.com/huggingface/transformers.js), [Tesseract.js](https://github.com/naptha/tesseract.js)                                                                                                                    |
| Office        | [docx](https://github.com/dolanmiu/docx), [mammoth](https://github.com/mwilliamson/mammoth.js), [xlsx](https://github.com/SheetJS/sheetjs), [pdfjs-dist](https://github.com/nicolo-ribaudo/pdfjs-dist), [html2pdf.js](https://github.com/eKoopmans/html2pdf.js) |
| Visualization | [ReactFlow](https://github.com/xyflow/xyflow), [d3-hierarchy](https://github.com/d3/d3-hierarchy), [Fabric.js](https://github.com/fabricjs/fabric.js)                                                                                                     |
| Terminal      | [xterm.js](https://github.com/xtermjs/xterm.js)                                                                                                                                                                                                     |

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) (v18+)
- [Rust](https://www.rust-lang.org/tools/install)
- npm

### Installation

```bash
git clone https://github.com/straygizmo/mdium.git
cd mdium
npm install
```

### Development

```bash
# Start Vite dev server
npm run dev

# Run Tauri desktop app in dev mode
npm run tauri dev
```

### Build

```bash
# Build for production
npm run build

# Create distributable desktop app
npm run tauri build
```

### Testing

```bash
npm run test          # Run tests once
npm run test:watch    # Watch mode
```

## Keyboard Shortcuts

### Global

| Shortcut         | Action                    |
| ---------------- | ------------------------- |
| Ctrl+S           | Save                      |
| Ctrl+Shift+S     | Save As                   |
| Ctrl+Z           | Undo                      |
| Ctrl+Y           | Redo                      |
| Ctrl+F           | Find                      |
| Ctrl+H           | Replace                   |
| Ctrl+T           | Toggle terminal           |
| Ctrl+D           | Open folder               |
| Ctrl+O           | Open opencode config      |
| Ctrl+W           | Close tab                 |
| Ctrl+\\          | Toggle editor panel       |
| Ctrl+\`          | Toggle terminal           |
| Ctrl+Shift+R     | Toggle RAG panel          |
| Ctrl+Shift+C     | Copy as rich text         |
| Ctrl+B           | Bold (preview mode)       |
| Ctrl+I           | Italic (preview mode)     |

### Search & Replace

| Shortcut     | Action                        |
| ------------ | ----------------------------- |
| F3           | Next search result            |
| Shift+F3     | Previous search result        |
| Enter        | Next result (in search input) |
| Ctrl+Enter   | Replace all                   |
| Escape       | Close search panel            |

### File Explorer

| Shortcut | Action |
| -------- | ------ |
| F2       | Rename |
| Delete   | Delete |
| Ctrl+X   | Cut    |
| Ctrl+C   | Copy   |
| Ctrl+V   | Paste  |

### Table Editor

| Shortcut                 | Action                |
| ------------------------ | --------------------- |
| Arrow keys               | Navigate cells        |
| Tab / Shift+Tab          | Next / previous column|
| Enter / F2               | Start editing cell    |
| Escape                   | Cancel cell edit      |
| Delete                   | Clear cell content    |
| Ctrl+Z / Ctrl+Y         | Undo / Redo           |
| Ctrl+C / Ctrl+X / Ctrl+V| Copy / Cut / Paste    |
| Ctrl+B                   | Bold                  |
| Ctrl+I                   | Italic                |
| Ctrl+5                   | Strikethrough         |
| Ctrl+\`                  | Code                  |

### Image Canvas Editor

| Shortcut               | Action                |
| ---------------------- | --------------------- |
| Ctrl+Z                 | Undo                  |
| Ctrl+Y / Ctrl+Shift+Z | Redo                  |
| Delete / Backspace     | Delete selected items |

### Editor

| Shortcut | Action           |
| -------- | ---------------- |
| Tab      | Insert 2 spaces  |

### AI Generate Modal

| Shortcut   | Action      |
| ---------- | ----------- |
| Ctrl+Enter | Generate    |
| Escape     | Close modal |

## Project Structure

```
mdium/
├── src/
│   ├── app/               # Main app component, toolbar, tabs, status bar
│   ├── features/          # Feature modules
│   │   ├── ai/            # AI generation
│   │   ├── claude-config/  # Claude Code configuration
│   │   ├── editor/        # Markdown editor
│   │   ├── export/        # DOCX/PDF export
│   │   ├── file-tree/     # File explorer & left panel
│   │   ├── git/           # Git source control panel
│   │   ├── image/         # Image canvas editor
│   │   ├── mindmap/       # Mindmap editor
│   │   ├── opencode-config/ # opencode AI tool configuration
│   │   ├── preview/       # Markdown preview
│   │   ├── rag/           # RAG Q&A panel
│   │   ├── search/        # Find/Replace
│   │   ├── settings/      # Settings dialog
│   │   ├── speech/        # Speech-to-text
│   │   ├── table/         # Table editor
│   │   ├── terminal/      # Integrated terminal
│   │   └── zenn/          # Zenn platform support
│   ├── shared/            # Types, hooks, utilities, themes, i18n
│   └── stores/            # Zustand state stores
├── src-tauri/             # Tauri/Rust backend
│   └── src/commands/      # Backend commands (file, AI, PTY, git, RAG, speech, MCP)
├── public/                # Static assets and theme files
└── scripts/               # Build and import scripts
```

## License

[MIT](LICENSE) - Copyright (c) 2025 straygizmo
