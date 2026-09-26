import type { ThemeColors, ThemePreset } from "./types";

const CSS_VAR_MAP: Record<string, string> = {
  primary: "--primary",
  primaryHover: "--primary-hover",
  secondary: "--secondary",
  bgBase: "--bg-base",
  bgSurface: "--bg-surface",
  bgOverlay: "--bg-overlay",
  bgInput: "--bg-input",
  border: "--border",
  borderHover: "--border-hover",
  text: "--text",
  textSecondary: "--text-secondary",
  textMuted: "--text-muted",
  accentBlue: "--accent-blue",
  accentGreen: "--accent-green",
  accentRed: "--accent-red",
  codeBg: "--code-bg",
  codeText: "--code-text",
  inlineCodeBg: "--inline-code-bg",
  inlineCodeText: "--inline-code-text",
  shadow: "--shadow",
  shadowStrong: "--shadow-strong",
  toolbarText: "--toolbar-text",
  selection: "--selection",
  cellSelected: "--cell-selected",
  cellEditing: "--cell-editing",
  taskStatusInboxBackground: "--task-status-inbox-background",
  taskStatusRunningBackground: "--task-status-running-background",
  taskStatusAwaitingUserBackground: "--task-status-awaiting-user-background",
  taskStatusAttentionBackground: "--task-status-attention-background",
  taskStatusOnHoldBackground: "--task-status-on-hold-background",
  taskStatusCompletedBackground: "--task-status-completed-background",
  taskStatusCancelledBackground: "--task-status-cancelled-background",
};

type TaskStatusColorKey =
  | "taskStatusInboxBackground"
  | "taskStatusRunningBackground"
  | "taskStatusAwaitingUserBackground"
  | "taskStatusAttentionBackground"
  | "taskStatusOnHoldBackground"
  | "taskStatusCompletedBackground"
  | "taskStatusCancelledBackground";

function tint(accent: string, percent: number, surface: string): string {
  return `color-mix(in srgb, ${accent} ${percent}%, ${surface})`;
}

/** Derives the task status backgrounds from a preset's existing tokens. */
export function taskStatusDefaults(colors: ThemeColors): Required<Pick<ThemeColors, TaskStatusColorKey>> {
  const surface = colors.bgSurface;
  return {
    taskStatusInboxBackground: tint(colors.textMuted, 10, surface),
    taskStatusRunningBackground: tint(colors.accentBlue, 18, surface),
    taskStatusAwaitingUserBackground: tint(colors.primary, 18, surface),
    taskStatusAttentionBackground: tint(colors.accentRed, 20, surface),
    taskStatusOnHoldBackground: tint(colors.textSecondary, 12, surface),
    taskStatusCompletedBackground: tint(colors.accentGreen, 18, surface),
    taskStatusCancelledBackground: tint(colors.textMuted, 6, surface),
  };
}

export function applyTheme(theme: ThemePreset): void {
  const root = document.documentElement;
  // Explicit preset values win over the derived task status defaults.
  const defaults: Partial<ThemeColors> = taskStatusDefaults(theme.colors);

  for (const [key, cssVar] of Object.entries(CSS_VAR_MAP)) {
    const value = theme.colors[key as keyof ThemeColors] || defaults[key as keyof ThemeColors];
    if (value) {
      root.style.setProperty(cssVar, value);
    }
  }

  root.setAttribute("data-theme-type", theme.type);
  root.setAttribute("data-theme-id", theme.id);
}
