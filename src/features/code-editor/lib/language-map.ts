// src/features/code-editor/lib/language-map.ts

const EXT_TO_LANGUAGE: Record<string, string> = {
  // VBA
  ".bas": "vb",
  ".cls": "vb",
  ".frm": "vb",
  // Web
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "javascript",
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "typescript",
  ".html": "html",
  ".htm": "html",
  ".css": "css",
  ".scss": "scss",
  ".less": "less",
  // Data
  ".json": "json",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "ini",
  ".xml": "xml",
  ".csv": "plaintext",
  // Systems
  ".rs": "rust",
  ".go": "go",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".hpp": "cpp",
  ".cs": "csharp",
  ".java": "java",
  ".kt": "kotlin",
  ".swift": "swift",
  ".dart": "dart",
  // Scripting
  ".py": "python",
  ".rb": "ruby",
  ".php": "php",
  ".lua": "lua",
  ".r": "r",
  ".pl": "perl",
  // Shell
  ".sh": "shell",
  ".bash": "shell",
  ".zsh": "shell",
  ".ps1": "powershell",
  ".bat": "bat",
  ".cmd": "bat",
  // Database
  ".sql": "sql",
  // Config
  ".ini": "ini",
  ".conf": "ini",
  ".cfg": "ini",
  ".env": "plaintext",
  ".properties": "ini",
  // Markup
  ".tex": "latex",
  ".rst": "restructuredtext",
  // Other
  ".dockerfile": "dockerfile",
  ".graphql": "graphql",
  ".gql": "graphql",
};

/**
 * Get Monaco Editor language ID from a file path.
 * Falls back to "plaintext" for unknown extensions.
 */
export function getMonacoLanguage(filePath: string): string {
  const lower = filePath.toLowerCase();

  // Handle special filenames (no extension)
  const fileName = lower.split(/[\\/]/).pop() ?? "";
  if (fileName === "dockerfile") return "dockerfile";
  if (fileName === "makefile") return "makefile";
  if (fileName === ".gitignore" || fileName === ".dockerignore") return "plaintext";

  // Match by extension
  const dotIndex = fileName.lastIndexOf(".");
  if (dotIndex === -1) return "plaintext";
  const ext = fileName.slice(dotIndex);
  return EXT_TO_LANGUAGE[ext] ?? "plaintext";
}
