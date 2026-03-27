export interface NodeStyle {
  bg: string;
  color: string;
  border: string;
}

export interface ThemeColors {
  root: NodeStyle;
  main: NodeStyle;
  sub: NodeStyle;
  connection: string;
}

export const MINDMAP_THEMES: Record<string, ThemeColors> = {
  "fresh-blue": {
    root: { bg: "#1976d2", color: "#fff", border: "#1565c0" },
    main: { bg: "#bbdefb", color: "#1a237e", border: "#90caf9" },
    sub: { bg: "#e3f2fd", color: "#0d47a1", border: "#bbdefb" },
    connection: "#64b5f6",
  },
  "fresh-green": {
    root: { bg: "#388e3c", color: "#fff", border: "#2e7d32" },
    main: { bg: "#c8e6c9", color: "#1b5e20", border: "#a5d6a7" },
    sub: { bg: "#e8f5e9", color: "#2e7d32", border: "#c8e6c9" },
    connection: "#66bb6a",
  },
  "fresh-red": {
    root: { bg: "#d32f2f", color: "#fff", border: "#c62828" },
    main: { bg: "#ffcdd2", color: "#b71c1c", border: "#ef9a9a" },
    sub: { bg: "#ffebee", color: "#c62828", border: "#ffcdd2" },
    connection: "#ef5350",
  },
  "fresh-purple": {
    root: { bg: "#7b1fa2", color: "#fff", border: "#6a1b9a" },
    main: { bg: "#e1bee7", color: "#4a148c", border: "#ce93d8" },
    sub: { bg: "#f3e5f5", color: "#6a1b9a", border: "#e1bee7" },
    connection: "#ab47bc",
  },
  "fresh-pink": {
    root: { bg: "#c2185b", color: "#fff", border: "#ad1457" },
    main: { bg: "#f8bbd0", color: "#880e4f", border: "#f48fb1" },
    sub: { bg: "#fce4ec", color: "#ad1457", border: "#f8bbd0" },
    connection: "#ec407a",
  },
  "fresh-soil": {
    root: { bg: "#5d4037", color: "#fff", border: "#4e342e" },
    main: { bg: "#d7ccc8", color: "#3e2723", border: "#bcaaa4" },
    sub: { bg: "#efebe9", color: "#4e342e", border: "#d7ccc8" },
    connection: "#8d6e63",
  },
  snow: {
    root: { bg: "#455a64", color: "#fff", border: "#37474f" },
    main: { bg: "#eceff1", color: "#263238", border: "#cfd8dc" },
    sub: { bg: "#fafafa", color: "#37474f", border: "#eceff1" },
    connection: "#90a4ae",
  },
  fish: {
    root: { bg: "#00838f", color: "#fff", border: "#006064" },
    main: { bg: "#b2ebf2", color: "#004d40", border: "#80deea" },
    sub: { bg: "#e0f7fa", color: "#00695c", border: "#b2ebf2" },
    connection: "#26c6da",
  },
  wire: {
    root: { bg: "#424242", color: "#fff", border: "#212121" },
    main: { bg: "#fafafa", color: "#212121", border: "#bdbdbd" },
    sub: { bg: "#fafafa", color: "#424242", border: "#e0e0e0" },
    connection: "#9e9e9e",
  },
};

export function getThemeColors(themeId: string): ThemeColors {
  return MINDMAP_THEMES[themeId] || MINDMAP_THEMES["fresh-blue"];
}
