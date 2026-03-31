// Global window properties used by open-motion runtime.
// Declaring these avoids `(window as any)` casts that break when
// TypeScript is not properly stripped before reaching the browser.
export {};

declare global {
  interface Window {
    __OPEN_MOTION_FRAME__?: number;
    __OPEN_MOTION_COMPOSITION_ID__?: string;
    __OPEN_MOTION_INPUT_PROPS__?: any;
    __OPEN_MOTION_READY__?: boolean;
    __OPEN_MOTION_VIDEO_FRAMES__?: Record<string, string>;
    __OPEN_MOTION_ERROR__?: string | null;
    __OPEN_MOTION_DELAY_RENDER_COUNT__?: number;
    __OPEN_MOTION_COMPOSITIONS__?: any[];
    __OPEN_MOTION_VIDEO_ASSETS__?: any[];
    __OPEN_MOTION_AUDIO_ASSETS__?: any[];
    __OPEN_MOTION_FONTS_READY__?: Promise<void>;
    __OPEN_MOTION_REAL_DATE__?: typeof Date;
    lottie?: any;
  }
}
