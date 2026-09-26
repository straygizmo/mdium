export interface ThemeColors {
  primary: string;
  primaryHover: string;
  secondary: string;
  bgBase: string;
  bgSurface: string;
  bgOverlay: string;
  bgInput: string;
  border: string;
  borderHover: string;
  text: string;
  textSecondary: string;
  textMuted: string;
  accentBlue: string;
  accentGreen: string;
  accentRed: string;
  codeBg: string;
  codeText: string;
  inlineCodeBg: string;
  inlineCodeText: string;
  shadow: string;
  shadowStrong: string;
  toolbarText: string;
  selection: string;
  cellSelected: string;
  cellEditing: string;
  // Workflow task status backgrounds; derived from accent tokens when omitted.
  taskStatusInboxBackground?: string;
  taskStatusRunningBackground?: string;
  taskStatusAwaitingUserBackground?: string;
  taskStatusAttentionBackground?: string;
  taskStatusOnHoldBackground?: string;
  taskStatusCompletedBackground?: string;
  taskStatusCancelledBackground?: string;
}

export type ThemeType = "light" | "dark";

export interface ThemePreset {
  id: string;
  name: string;
  type: ThemeType;
  colors: ThemeColors;
}
