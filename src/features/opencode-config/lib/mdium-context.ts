const MACRO_EXTENSIONS = [".xlsm", ".xlam"];

export function isMacroWorkbookPath(path: string | null | undefined): path is string {
  if (!path) return false;
  const lower = path.toLowerCase();
  return MACRO_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * Prefix a user message with the workbook the user is looking at so the LLM
 * can pass it to vba_list / vba_pull / vba_push without asking for a path.
 */
export function wrapWithMdiumContext(text: string, activeFilePath: string | null | undefined): string {
  if (!isMacroWorkbookPath(activeFilePath)) return text;
  const escaped = activeFilePath.replace(/"/g, '\\"');
  return `<mdium_context>\nactive_file="${escaped}"\n</mdium_context>\n\n${text}`;
}

/**
 * Drop the wrapper `wrapWithMdiumContext` prepends. opencode stores and echoes
 * the wrapped prompt, so anything shown to the user goes through this first.
 */
export function stripMdiumContext(text: string): string {
  const m = text.match(/^\s*<mdium_context>[\s\S]*?<\/mdium_context>\s*/);
  return m ? text.slice(m[0].length) : text;
}
