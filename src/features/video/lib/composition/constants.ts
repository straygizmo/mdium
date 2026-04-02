// ─── Resolution-based scaling ────────────────────────────────────────────────

export const BASE_WIDTH = 1920;
export const BASE_HEIGHT = 1080;

export function getScale(width: number, height: number): number {
  return Math.min(width / BASE_WIDTH, height / BASE_HEIGHT);
}

// Base sizes at 1920x1080
export const BASE = {
  fontH1: 112,
  fontH2: 84,
  fontH3: 64,
  fontText: 48,
  fontTable: 40,
  fontCode: 36,
  fontCaption: 48,
  paddingV: 80,
  paddingH: 120,
  gap: 40,
  bulletMarginLeft: 48,
  lineHeightHeading: 1.2,
  lineHeightText: 1.6,
  lineHeightCaption: 1.4,
};

export function scaled(base: number, scale: number): number {
  return Math.round(base * scale);
}

// ─── Animation constants ────────────────────────────────────────────────────

export const ANIM = {
  fadeInDuration: 30,
  staggerDelay: 20,
  slideDistance: 60,
  bulletDelay: 20,
  tableRowDuration: 20,
  tableRowDelay: 15,
  floatAmplitude: 3,
  floatPeriodFrames: 120,
  kenBurnsScale: 1.05,
  kenBurnsPanX: 15,
};

// ─── Asset URL helper ────────────────────────────────────────────────────────

/** Convert a local file path to a URL the webview can load. */
export function toPlayableSrc(filePath: string): string {
  if (
    !filePath ||
    filePath.startsWith("http") ||
    filePath.startsWith("blob:") ||
    filePath.startsWith("data:") ||
    filePath.startsWith("/")
  ) {
    return filePath;
  }
  try {
    const internals = window.__TAURI_INTERNALS__;
    if (internals?.convertFileSrc) {
      return internals.convertFileSrc(filePath, "asset");
    }
  } catch {
    // not in Tauri environment
  }
  return filePath;
}
