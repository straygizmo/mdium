# MDium

**A Markdown-centric document foundation designed for the AI era.**

MDium is built on the premise that Markdown — the format most naturally understood by AI — should be at the heart of every document workflow. By converting traditional Office documents (Word, Excel, PDF) into Markdown and providing rich editing capabilities on top of it, MDium achieves an "AI & human-friendly" document experience.
Furthermore, by converting Markdown back to DOCX, PDF, and other formats, it ensures seamless interoperability with existing workflows, aiming to become the central tool in day-to-day business operations.

Each workspace (folder) runs its own opencode-sdk instance, enabling not only conventional RAG (Retrieval-Augmented Generation) but also **Agentic RAG** — an AI agent that reads, reasons over, and references all data within a folder to generate documents contextually grounded in your project's knowledge.

![MDium_img](MDium_img.png)

```mermaid
graph LR
    subgraph Workspace["Workspace (per folder)"]

        subgraph Input
            W_IN[Word .docx]
            E_IN["Excel .xlsx/.xlsm"]
            P_IN[PDF .pdf]
            X_IN[XMind .xmind]
        end

        subgraph OC["opencode GUI"]
            F_CHAT[Agentic RAG]
            F_MCP[buit-in MCP]
            F_SKL[buit-in Skills]
        end

        R[RAG]
        V_IN[Voice recognition]
        M((MDium))

        subgraph Output
            W_OUT[Word .docx]
            P_OUT[PDF .pdf]
            S_OUT["PowerPoint .pptx<br/>(Slidev)"]
            K_OUT["MindMap .km<br/>(KityMinder)"]
            V_OUT["Excel .xlsm<br/>(VBA)"]
        end

        F_CHAT <--> M
        F_MCP<--> M
        F_SKL<--> M
        R <--> M
        W_IN --> M
        E_IN --> M
        P_IN --> M
        X_IN --> M
        M --> W_OUT
        M --> P_OUT
        M --> S_OUT
        M --> K_OUT
        M --> V_OUT
        V_IN --> M

    end

    style Input fill:#f3e5f5,stroke:#7b1fa2
    style Output fill:#e8f5e9,stroke:#2e7d32
    style OC fill:#e3f2fd,stroke:#1565c0
```

[日本語版 README](README.ja.md)

## Features

### Markdown Editing

- Split-pane editor with real-time preview
- GitHub Flavored Markdown (GFM) support
- Mathematical expressions (KaTeX)
- Mermaid diagrams (flowcharts, sequence, ER, Gantt, class, state, pie)
- Code syntax highlighting (18+ languages)
- Image paste from clipboard (Ctrl+V) with preview dialog and AI-powered alt text generation
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
- Excel to Markdown conversion powered by [xlsx2md](https://github.com/igapyon/xlsx2md) (table detection, narrative extraction, images/charts/shapes, rich text)
- Excel VBA macro extraction and injection (.xlsm)
- Export to PDF

### Code Editor

- Monaco Editor integration for code files with syntax highlighting
- Language auto-detection based on file extension

### AI Integration

- RAG (Retrieval-Augmented Generation) for document Q&A
- Semantic search with configurable embedding models (multilingual-e5-large, Ruri v3, etc.)
- Content generation via opencode-sdk (insert AI-generated text into editor)
- Multiple API providers: OpenAI, Anthropic, DeepSeek, Azure, Gemini, Grok, Groq, Ollama, custom endpoints
- Chat session management with history persistence
- UNC path support for network drives

### Speech-to-Text

- Whisper-based speech recognition (whisper-small, whisper-large-v3-turbo, moonshine)
- Non-blocking Web Worker processing
- Direct transcript insertion into editor
- Model download with progress tracking

### AI Image Generation

- Built-in MCP server (Nano Banana 2) for AI image generation powered by Gemini
- Generate images from text prompts directly in the editor (right-click → Insert → Image → Generate with MCP)
- Generated images are automatically saved to the `images/` directory and inserted as Markdown

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

See [docs/keyboard-shortcuts.md](docs/keyboard-shortcuts.md) for the full list of keyboard shortcuts.

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

## Credits

MDium is built on the shoulders of many outstanding open-source projects. Special thanks to:

| Project | Description |
| ------- | ----------- |
| [opencode](https://github.com/nicepkg/opencode) | AI coding tool that powers MDium's chat, MCP server, and agentic RAG capabilities |
| [Slidev](https://github.com/slidevjs/slidev) | Presentation slides engine used for Markdown-to-PPTX export |
| [open-motion](https://github.com/jsongo/open-motion) | Programmatic video engine enabling Markdown-to-video generation |
| [Tauri](https://github.com/tauri-apps/tauri) | Desktop application framework providing the native shell |
| [React](https://github.com/facebook/react) | UI library powering the entire frontend |
| [Vite](https://github.com/vitejs/vite) | Build tool and dev server |
| [Monaco Editor](https://github.com/microsoft/monaco-editor) | Code editor component for source file editing |
| [ReactFlow](https://github.com/xyflow/xyflow) | Node-based graph library for the mindmap editor |
| [KityMinder](https://github.com/nicepkg/kityminder) | Mindmap format support (.km) |
| [xlsx2md](https://github.com/igapyon/xlsx2md) | Excel-to-Markdown converter with table detection and rich text extraction |
| [marked](https://github.com/markedjs/marked) / [remark](https://github.com/remarkjs/remark) | Markdown parsing and transformation |
| [KaTeX](https://github.com/KaTeX/KaTeX) | Mathematical expression rendering |
| [Mermaid](https://github.com/mermaid-js/mermaid) | Diagram and chart rendering from text definitions |
| [Fabric.js](https://github.com/fabricjs/fabric.js) | HTML5 canvas library for the image editor |
| [xterm.js](https://github.com/xtermjs/xterm.js) | Terminal emulator for the integrated terminal |
| [Hugging Face Transformers.js](https://github.com/huggingface/transformers.js) | ML inference for speech-to-text and embedding models |
| [Tesseract.js](https://github.com/naptha/tesseract.js) | OCR engine for image text recognition |
| [Zustand](https://github.com/pmndrs/zustand) | Lightweight state management |
| [mammoth](https://github.com/mwilliamson/mammoth.js) / [docx](https://github.com/dolanmiu/docx) | Word document reading and writing |
| [highlight.js](https://github.com/highlightjs/highlight.js) | Syntax highlighting for code blocks |

…and all the other libraries listed in `package.json` and `Cargo.toml`.

## License

[MIT](LICENSE) - Copyright (c) 2025 straygizmo
