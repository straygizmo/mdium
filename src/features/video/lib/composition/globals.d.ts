export {};

declare global {
  interface Window {
    __TAURI_INTERNALS__?: {
      convertFileSrc: (path: string, protocol: string) => string;
    };
  }
}
