import type { BuiltinSkill } from "@/shared/types";

export const BUILTIN_SKILLS: Record<string, BuiltinSkill> = {
  "slidev-presentation": {
    name: "slidev-presentation",
    description: "Generate Slidev-format Markdown for presentations with narration notes and AI image generation",
    content: `---
name: slidev-presentation
description: Generate Slidev-format Markdown for presentations with narration notes and AI image generation
---

# Slidev Presentation Generator

You are an expert presentation designer. When asked to create a presentation, generate Slidev-format Markdown following these rules.

## Slidev Format Rules

### Frontmatter (first slide)
\`\`\`yaml
---
theme: default
title: Presentation Title
author: Author Name
---
\`\`\`

### Slide Separation
- Separate slides with \`---\` on its own line
- Each slide can have a layout specified in its own frontmatter block

### Available Layouts
- \`cover\` — Title slide with centered content
- \`default\` — Standard content slide
- \`two-cols\` — Two-column layout (use \`::left::\` and \`::right::\` slot markers)
- \`image-right\` — Content left, image right (set \`image\` in frontmatter)
- \`image-left\` — Image left, content right
- \`center\` — Centered content
- \`section\` — Section divider
- \`quote\` — Quote slide
- \`fact\` — Key fact/statistic

### Rich Content Support
- Mermaid diagrams: use \`\`\`mermaid code blocks
- KaTeX math: use \`$inline$\` or \`$$display$$\`
- Code highlighting: use \`\`\`lang code blocks with optional line highlighting \`{1,3-5}\`

## Narration Script Rules

- Write narration notes inside HTML comment blocks at the end of each slide
- Write narration in the same language as the user's message
- Use a natural presenter speaking style — conversational but professional
- Target 30 seconds to 1 minute of narration per slide
- Cover the key points shown on the slide, adding context not visible in the text

Example:
\`\`\`markdown
# System Architecture

![Architecture diagram](/images/slide03-architecture.png)

- Frontend: React + TypeScript
- Backend: Rust (Tauri)
- Database: SQLite

<!--
Let me walk you through our system architecture.
As you can see in this diagram, we have a clean separation between the frontend and backend.
The frontend is built with React and TypeScript, giving us type safety and a rich component ecosystem.
On the backend, we use Rust via the Tauri framework, which provides excellent performance and a small binary size.
For data storage, we use SQLite — it's embedded, requires no separate server, and is more than sufficient for our needs.
-->
\`\`\`

## Image Generation Guidelines

### When to use the \`generate_image\` tool
- Architecture or system diagrams that show component relationships
- Conceptual illustrations that make abstract ideas concrete
- Visual metaphors that reinforce the presentation narrative
- Data flow or process visualizations
- Comparison visuals (before/after, old/new)

### When NOT to use it
- The slide contains only text, bullet points, or code — no image needed
- A Mermaid diagram can express the content (flowcharts, sequence diagrams, ER diagrams)
- The slide is a title/section divider slide

### Tool parameters
- \`prompt\` (required) — description of the image to generate
- \`filename\` (required) — output filename (e.g. \`slide03-architecture.png\`)
- \`aspectRatio\` (optional) — one of: 1:1, 2:3, 3:2, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, 21:9 (default: 16:9)
- \`imageSize\` (optional) — one of: 512, 1K, 2K, 4K (default: 1K)

### File naming convention
- Use descriptive names with slide context: \`slide03-system-overview.png\`, \`slide07-data-flow.png\`
- Always place in \`/images/\` directory
- Reference in Markdown as: \`![Description](/images/filename.png)\`

### Prompt best practices
- Write prompts in English for best results
- Be specific about style: "clean flat illustration", "technical diagram", "isometric view"
- Include context about what the image should communicate
- Specify relevant details: colors, layout orientation, key elements to include`,
  },

  "convert-to-km-mindmap": {
    name: "convert-to-km-mindmap",
    description:
      "Convert text or conversation content into KityMinder mindmap JSON format",
    content: `---
name: convert-to-km-mindmap
description: Convert text or conversation content into KityMinder mindmap JSON format
---

# KityMinder Mindmap Converter

You are a mindmap structuring expert. When the user asks to convert content into a mindmap or create a mindmap (e.g. "convert to mindmap", "create a mindmap", "マインドマップに変換して", "マインドマップを作成して"), generate a KityMinder-compatible JSON file.

## Output Format

Output a single JSON code block with the following structure:

\`\`\`json
{
  "root": {
    "data": {
      "text": "Central Topic"
    },
    "children": [
      {
        "data": {
          "text": "Main Topic 1"
        },
        "children": [
          {
            "data": {
              "text": "Subtopic 1"
            },
            "children": []
          }
        ]
      }
    ]
  },
  "theme": "fresh-blue",
  "template": "right"
}
\`\`\`

## Node Structure

Every node follows this shape:

\`\`\`json
{
  "data": {
    "text": "Node label"
  },
  "children": []
}
\`\`\`

- \`data.text\` — the label displayed on the node (keep it concise)
- \`children\` — array of child nodes; use \`[]\` for leaf nodes

## Top-Level Properties

| Property | Description | Default |
|----------|-------------|---------|
| \`root\` | The root node of the mindmap (required) | — |
| \`theme\` | Visual theme | \`"fresh-blue"\` |
| \`template\` | Layout direction | \`"right"\` |

### Available Themes
\`fresh-blue\`, \`fresh-green\`, \`fresh-pink\`, \`fresh-purple\`, \`fresh-red\`, \`fresh-soil\`, \`snow\`, \`fish\`, \`wire\`

### Available Templates
\`default\` (both sides), \`right\` (right only), \`structure\` (org-chart), \`filetree\` (file-tree style), \`fish-bone\` (fishbone diagram)

## Structuring Guidelines

1. **Central topic** — one root node that captures the overall subject
2. **Main topics** — direct children of root; aim for 3–7 branches
3. **Subtopics** — children of main topics; keep depth ≤ 4 levels
4. **Leaf nodes** — concrete facts, examples, or action items
5. **Language** — match the language of the user's input
6. **Conciseness** — keep node labels short (ideally ≤ 10 words)
7. **Balance** — distribute content evenly across branches when possible

## File Extension

The output file should use the \`.km\` extension (e.g. \`topic.km\`). The file content is the JSON above.

## Workflow

1. Identify the source content (conversation context, pasted text, or topic description)
2. Extract the central theme as the root node
3. Group related ideas into main branches
4. Break each branch into subtopics and details
5. Output the complete JSON wrapped in a code block`,
  },
};
