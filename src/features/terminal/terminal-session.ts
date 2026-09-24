export const TERMINAL_KINDS = [
  "claude-code",
  "codex",
  "github-copilot",
  "opencode",
  "terminal",
] as const;

export type TerminalKind = (typeof TERMINAL_KINDS)[number];

export interface TerminalSession {
  id: string;
  kind: TerminalKind;
  /** Working directory captured when the session was created. */
  folderPath: string;
}

export type TerminalThemeType = "light" | "dark";

const TERMINAL_COMMANDS: Record<TerminalKind, string | undefined> = {
  "claude-code": "claude",
  codex: "codex",
  "github-copilot": "copilot",
  opencode: "opencode",
  terminal: undefined,
};

export function getTerminalCommand(kind: TerminalKind): string | undefined {
  return TERMINAL_COMMANDS[kind];
}

// Codex renders panels with dark ANSI background colors, so a light terminal
// palette produces a visually split screen. Keep its terminal palette dark.
export function getTerminalThemeType(
  kind: TerminalKind,
  appThemeType: TerminalThemeType,
): TerminalThemeType {
  return kind === "codex" ? "dark" : appThemeType;
}
