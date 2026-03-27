import type { ThemePreset } from "./types";

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
};

export function applyTheme(theme: ThemePreset): void {
  const root = document.documentElement;

  for (const [key, cssVar] of Object.entries(CSS_VAR_MAP)) {
    const value = theme.colors[key as keyof typeof theme.colors];
    if (value) {
      root.style.setProperty(cssVar, value);
    }
  }

  root.setAttribute("data-theme-type", theme.type);
  root.setAttribute("data-theme-id", theme.id);
}
