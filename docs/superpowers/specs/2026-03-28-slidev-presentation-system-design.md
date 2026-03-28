# Slidev Presentation System Design

## Overview

Enable Slidev-format Markdown creation, preview, and PPTX export within mdium, with AI-powered image generation via a built-in MCP server and an opencode custom SKILL for guided presentation generation.

## Scope

### In Scope
1. opencode chat generates Slidev Markdown (with AI image generation)
2. Slidev slide preview in mdium preview panel (`slidev dev` iframe)
3. Slidev -> PPTX export (Slidev built-in `slidev export --format pptx`)
4. Image generation MCP server (built-in, provider-agnostic)
5. opencode custom SKILL for Slidev generation guidelines
6. Context menu "Insert -> Generate Image" for manual image insertion
7. Built-in MCP server / SKILL selection UI in opencode settings

### Out of Scope (Future)
- Slidev -> MP4 video export with narration
- TTS API settings (Google, VOICEVOX)
- open-motion integration

## Architecture

```
+---------------------------------------------------+
|  mdium (Tauri + React)                            |
|                                                   |
|  +----------------+  +-------------------------+  |
|  | opencode       |  | Editor                  |  |
|  | Chat           |  | (Slidev Markdown)       |  |
|  |                |  |                          |  |
|  | SKILL applied -+->| Context menu            |  |
|  | Image gen   ---+->| "Insert -> Gen Image" --+-+|
|  +-------+--------+  +-------------------------+  |
|          |                                         |
|          | opencode SDK                            |
|          v                                         |
|  +----------------+  +-------------------------+  |
|  | MCP Server     |  | Preview Panel           |  |
|  | (image-gen)    |  | (Slidev dev iframe)     |  |
|  +----------------+  +-------------------------+  |
|                                                    |
|  +------------------------------------------------+
|  | Tauri Backend (Rust)                            |
|  |  - Slidev dev process management                |
|  |  - Slidev export execution                      |
|  |  - Temp project management                      |
|  +------------------------------------------------+
+----------------------------------------------------+
```

## Component 1: Slidev Process Management (Tauri Backend)

### Bundled Slidev Environment

Slidev dependencies are pre-installed and shipped with the app via Tauri's `resources` feature. No `npm install` required at runtime.

```
mdium install directory/
+-- mdium.exe
+-- resources/
    +-- slidev-env/
    |   +-- package.json
    |   +-- node_modules/      <- pre-installed slidev + dependencies
    |   +-- template/
    |       +-- slides.md      <- default template
    +-- mcp-servers/
        +-- image-generator/
            +-- index.js
            +-- package.json
            +-- node_modules/
```

### Temp Project Structure

When a Slidev Markdown file is opened, a temporary project directory is created:

```
<temp_dir>/mdium-slidev-<hash>/
+-- slides.md                      <- synced from editor
+-- node_modules -> symlink to resources/slidev-env/node_modules
+-- package.json -> copy from resources/slidev-env/package.json
+-- public/
    +-- images/                    <- generated images saved here
```

- `node_modules` is a symlink to the bundled environment (no copy, fast startup)
- Node.js runtime is the only prerequisite on the user's system

### Process Lifecycle

1. **Start**: When a Slidev Markdown file is opened or preview is shown -> create temp dir + symlinks + start `slidev dev`
2. **Sync**: Editor content changes -> write to `slides.md` (debounced) -> Slidev hot-reloads
3. **Export**: Toolbar "Export as PPTX" -> execute `slidev export --format pptx` -> save dialog
4. **Stop**: File closed or preview hidden -> kill process + delete temp directory

### Tauri Commands (Rust)

- `slidev_start(markdown: String) -> Result<u16>` — Start dev server, return port number
- `slidev_sync(markdown: String) -> Result<()>` — Update slides.md
- `slidev_export(format: "pptx" | "pdf" | "png") -> Result<String>` — Run export, return output path
- `slidev_stop() -> Result<()>` — Kill process + cleanup

## Component 2: MCP Server (Image Generation)

### Tool Definition

```typescript
{
  name: "generate_image",
  description: "Generate an image from a text description and save it to disk",
  parameters: {
    prompt: string,         // Description of the image to generate
    width: number,          // Default 1024
    height: number,         // Default 768
    filename: string        // Output filename (e.g. "architecture-diagram.png")
  }
}
// Returns: { path: "relative/path/to/image.png", absolutePath: "..." }
```

### Provider Abstraction

The MCP server uses environment variables for provider configuration. Initially supports OpenAI (DALL-E 3), with a provider interface abstracted for future additions.

### opencode.jsonc Registration

```jsonc
{
  "mcp": {
    "image-generator": {
      "command": "node",
      "args": ["<resources_path>/mcp-servers/image-generator/index.js"],
      "env": {
        "IMAGE_PROVIDER": "openai",
        "IMAGE_API_KEY": "",
        "IMAGE_MODEL": "dall-e-3",
        "IMAGE_OUTPUT_DIR": ""
      }
    }
  }
}
```

## Component 3: Built-In MCP Server / SKILL Selection UI

### MCP Settings Tab

Add an "Add Built-In MCP Server" dropdown to the existing MCP settings UI, alongside the existing "Import from JSON" option.

When a built-in server is selected (e.g. "image-generator"), the form fields (SERVER NAME, COMMAND, ARGUMENTS, ENVIRONMENT VARIABLES) are auto-populated with default values. The user can then edit values (e.g. set their API key) before saving.

### Built-In Server Registry (Frontend)

```typescript
const BUILTIN_MCP_SERVERS = {
  "image-generator": {
    serverName: "image-generator",
    command: "node",
    args: ["<resources_path>/mcp-servers/image-generator/index.js"],
    env: {
      IMAGE_PROVIDER: "openai",
      IMAGE_API_KEY: "",
      IMAGE_MODEL: "dall-e-3",
      IMAGE_OUTPUT_DIR: ""
    }
  }
  // Future: add more built-in servers here
};
```

### Skills Tab

Similarly, add an "Add Built-In Skill" dropdown to the Skills settings tab. Selecting "slidev-presentation" populates the skill definition form with the default content.

## Component 4: opencode Custom SKILL

### SKILL Definition

```yaml
name: slidev-presentation
description: Generate Slidev-format Markdown for presentations
```

### SKILL Content (in English)

The SKILL instructs the LLM on three areas:

**1. Slidev Format Rules**
- Use frontmatter for `theme`, `title`, `author`, `background`, etc.
- Separate slides with `---`
- Specify layout per slide (`layout: cover`, `layout: two-cols`, `layout: image-right`, etc.)
- Support Mermaid diagrams, KaTeX math, and code highlighting

**2. Narration Script Rules**
- Write narration notes inside `<!-- ... -->` comment blocks at the end of each slide
- Write narration in the same language as the user's message
- Use a natural presenter speaking style
- Target 30 seconds to 1 minute of narration per slide
- Example:
  ```markdown
  # Architecture Overview

  ![System diagram](/images/architecture.png)

  <!--
  Let me walk you through the system architecture.
  This diagram shows the overall structure.
  The frontend is built with React, and the backend uses Rust.
  -->
  ```

**3. Image Generation Guidelines**
- USE `generate_image` tool when:
  - Conceptual or architecture diagrams are needed
  - Metaphors or imagery would reinforce the explanation
  - Visualizing data relationships or flows would be effective
- DO NOT use when:
  - Text or code alone is sufficient
  - Mermaid can express the diagram adequately
- Name files descriptively with slide context (e.g. `slide03-system-overview.png`)

## Component 5: Preview Panel Integration

### Slidev Detection

A Markdown file is identified as Slidev format when:
- Frontmatter contains Slidev-specific keys (`theme`, `layout`, `class`, `drawings`, etc.)
- OR the file contains 2 or more `---` slide separators

### Preview Panel Behavior

| File Type | Preview Behavior |
|-----------|-----------------|
| Regular Markdown | Existing HTML preview (no change) |
| Slidev Markdown | iframe loading Slidev dev server |

### UI Flow

1. Slidev Markdown detected -> show "Slidev Preview" label on preview panel
2. First display triggers Tauri backend `slidev_start` (takes a few seconds)
3. Loading spinner until dev server is ready
4. iframe loads `http://localhost:<port>`
5. Editor changes -> `slidev_sync` -> Slidev hot-reload -> preview auto-updates
6. File closed or switched -> `slidev_stop`

### Export UI

Add Slidev-specific export options to the existing export menu:
- "Export as PPTX (Slidev)"
- "Export as PDF (Slidev)"

These options are visible only when editing a Slidev Markdown file.

## Component 6: Context Menu "Insert -> Generate Image"

### Menu Structure

```
Insert
+-- ... (existing items)
+-- Generate Image
```

### UI Flow

1. User right-clicks in editor -> "Insert" -> "Generate Image"
2. Dialog appears with fields:
   - **Prompt**: textarea for image description
   - **Filename**: text input (e.g. `architecture-diagram.png`)
   - **Size**: width x height inputs (default 1024 x 768)
3. "Generate" -> call `generate_image` via opencode SDK -> MCP server
4. Show spinner during generation
5. On completion -> show generated image preview -> "Insert" / "Regenerate" / "Cancel"
6. "Insert" -> insert `![prompt](/images/filename.png)` at cursor position

### Prerequisites
- opencode server must be running
- image-generator MCP server must be configured
- If not configured, show error message with link to settings

## Dependencies

### User's System
- Node.js runtime (required)

### Bundled with App
- Slidev CLI + dependencies (in `resources/slidev-env/`)
- image-generator MCP server (in `resources/mcp-servers/image-generator/`)

### npm Packages (for MCP server)
- `@modelcontextprotocol/sdk` — MCP server framework
- `openai` — OpenAI API client (for DALL-E)
- Provider-specific SDKs as needed

## Future Considerations

- **MP4 export**: Slidev dev server frame capture + TTS narration audio -> FFmpeg -> MP4
- **TTS providers**: Google TTS, VOICEVOX API settings
- **open-motion integration**: Use open-motion's renderer/encoder pipeline for video output
- **Additional MCP servers**: Add more built-in servers to the registry
- **Additional image providers**: Stability AI, Google Imagen, local Stable Diffusion
