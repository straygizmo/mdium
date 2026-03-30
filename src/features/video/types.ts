// ─── VideoProject Core Types ────────────────────────────────────────────────

export interface VideoProject {
  meta: VideoMeta;
  audio: AudioConfig;
  scenes: Scene[];
}

// ─── VideoMeta ───────────────────────────────────────────────────────────────

export type AspectRatio = "16:9" | "9:16" | "4:3" | "1:1";

export interface VideoMeta {
  title: string;
  width: number;
  height: number;
  fps: number;
  aspectRatio: AspectRatio;
}

export const DEFAULT_META: VideoMeta = {
  title: "",
  width: 1920,
  height: 1080,
  fps: 30,
  aspectRatio: "16:9",
};

// ─── Audio ───────────────────────────────────────────────────────────────────

export interface BgmConfig {
  src: string;
  volume: number;
}

export interface AudioConfig {
  bgm?: BgmConfig;
  tts?: TTSConfig;
}

// ─── TTS ─────────────────────────────────────────────────────────────────────

export type TTSProviderName = "voicevox" | "openai" | "google";

export interface TTSConfig {
  provider: TTSProviderName;
  speaker?: string;
  volume: number;
  speed?: number;
}

export const DEFAULT_TTS_CONFIG: TTSConfig = {
  provider: "voicevox",
  speaker: "1",
  volume: 1.0,
  speed: 1.0,
};

// ─── TTS Provider Interfaces ─────────────────────────────────────────────────

export interface TimingEntry {
  startMs: number;
  endMs: number;
  text: string;
}

export interface TTSOptions {
  speaker?: string;
  volume?: number;
  speed?: number;
  language?: string;
  mdPath?: string;
  filename?: string;
}

export interface TTSResult {
  audioPath: string;
  durationMs: number;
  timingData?: TimingEntry[];
}

export interface Voice {
  id: string;
  name: string;
  language?: string;
  gender?: string;
}

export interface TTSProvider {
  name: TTSProviderName;
  synthesize(text: string, options?: TTSOptions): Promise<TTSResult>;
  listVoices?(): Promise<Voice[]>;
}

// ─── Transition ───────────────────────────────────────────────────────────────

export type TransitionType =
  | "fade"
  | "slide-left"
  | "slide-right"
  | "slide-up"
  | "none";

export interface TransitionConfig {
  type: TransitionType;
  durationInFrames: number;
}

export const DEFAULT_TRANSITION: TransitionConfig = {
  type: "fade",
  durationInFrames: 15,
};

// ─── Captions ────────────────────────────────────────────────────────────────

export interface CaptionsConfig {
  enabled: boolean;
  srt?: string;
}

// ─── Scene Elements ───────────────────────────────────────────────────────────

export interface TitleElement {
  type: "title";
  text: string;
  level: 1 | 2 | 3;
  animation: "fade-in" | "slide-in" | "typewriter" | "none";
}

export interface TextElement {
  type: "text";
  content: string;
  animation: "fade-in" | "none";
}

export interface BulletListElement {
  type: "bullet-list";
  items: string[];
  animation: "sequential" | "fade-in" | "none";
  delayPerItem: number;
}

export interface ImageElement {
  type: "image";
  src: string;
  alt?: string;
  position: "center" | "left" | "right" | "background";
  animation: "fade-in" | "zoom-in" | "ken-burns" | "none";
}

export interface TableElement {
  type: "table";
  headers: string[];
  rows: string[][];
  animation: "fade-in" | "row-by-row" | "none";
}

export interface CodeBlockElement {
  type: "code-block";
  code: string;
  language: string;
  animation: "fade-in" | "none";
}

export type SceneElement =
  | TitleElement
  | TextElement
  | BulletListElement
  | ImageElement
  | TableElement
  | CodeBlockElement;

// ─── Scene ────────────────────────────────────────────────────────────────────

export interface Scene {
  id: string;
  title?: string;
  durationInFrames?: number;
  narration: string;
  narrationAudio?: string;
  narrationDirty?: boolean;
  transition: TransitionConfig;
  elements: SceneElement[];
  captions?: CaptionsConfig;
}
