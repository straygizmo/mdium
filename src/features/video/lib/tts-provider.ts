import { invoke } from "@tauri-apps/api/core";
import type {
  TTSProvider,
  TTSOptions,
  TTSResult,
  Voice,
  TimingEntry,
} from "../types";

// ─── VOICEVOX API Response Types ─────────────────────────────────────────────

interface VoicevoxMora {
  text: string;
  consonant?: string;
  consonant_length?: number;
  vowel: string;
  vowel_length: number;
  pitch: number;
}

interface VoicevoxAccentPhrase {
  moras: VoicevoxMora[];
  accent: number;
  pause_mora?: VoicevoxMora;
  is_interrogative: boolean;
}

interface VoicevoxAudioQuery {
  accent_phrases: VoicevoxAccentPhrase[];
  speedScale: number;
  pitchScale: number;
  intonationScale: number;
  volumeScale: number;
  prePhonemeLength: number;
  postPhonemeLength: number;
  outputSamplingRate: number;
  outputStereo: boolean;
  kana?: string;
}

interface VoicevoxStyle {
  name: string;
  id: number;
  type?: string;
}

interface VoicevoxSpeaker {
  name: string;
  speaker_uuid: string;
  styles: VoicevoxStyle[];
  version?: string;
}

// ─── Timing Extraction ────────────────────────────────────────────────────────

function extractTimingData(
  audioQuery: VoicevoxAudioQuery,
  speedScale: number
): TimingEntry[] {
  const timingData: TimingEntry[] = [];
  let currentMs = 0;

  // pre-phoneme silence
  const preMs = (audioQuery.prePhonemeLength / speedScale) * 1000;
  currentMs += preMs;

  for (const phrase of audioQuery.accent_phrases) {
    let phraseText = "";
    let phraseDurationMs = 0;

    for (const mora of phrase.moras) {
      phraseText += mora.text;
      const consonantMs = ((mora.consonant_length ?? 0) / speedScale) * 1000;
      const vowelMs = (mora.vowel_length / speedScale) * 1000;
      phraseDurationMs += consonantMs + vowelMs;
    }

    if (phraseText.length > 0) {
      timingData.push({
        startMs: Math.round(currentMs),
        endMs: Math.round(currentMs + phraseDurationMs),
        text: phraseText,
      });
      currentMs += phraseDurationMs;
    }

    // pause between phrases
    if (phrase.pause_mora) {
      const pauseMs = (phrase.pause_mora.vowel_length / speedScale) * 1000;
      currentMs += pauseMs;
    }
  }

  return timingData;
}

// ─── VoicevoxProvider ─────────────────────────────────────────────────────────

export class VoicevoxProvider implements TTSProvider {
  name = "voicevox" as const;
  private host: string;

  constructor(host = "http://localhost:50021") {
    this.host = host;
  }

  async synthesize(text: string, options: TTSOptions = {}): Promise<TTSResult> {
    const speakerId = options.speaker ?? "1";
    const speedScale = options.speed ?? 1.0;

    // 1. POST to /audio_query to get synthesis parameters
    const queryRes = await fetch(
      `${this.host}/audio_query?text=${encodeURIComponent(text)}&speaker=${speakerId}`,
      { method: "POST" }
    );
    if (!queryRes.ok) {
      throw new Error(
        `VOICEVOX audio_query failed: ${queryRes.status} ${queryRes.statusText}`
      );
    }

    const audioQuery: VoicevoxAudioQuery = await queryRes.json();

    // 2. Apply speed / volume scale from options
    audioQuery.speedScale = speedScale;
    audioQuery.volumeScale = options.volume ?? audioQuery.volumeScale;

    // 3. Extract timing data from accent_phrases
    const timingData = extractTimingData(audioQuery, speedScale);

    // 4. POST audio_query JSON to /synthesis to get audio
    const synthRes = await fetch(
      `${this.host}/synthesis?speaker=${speakerId}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(audioQuery),
      }
    );
    if (!synthRes.ok) {
      throw new Error(
        `VOICEVOX synthesis failed: ${synthRes.status} ${synthRes.statusText}`
      );
    }

    // 5. Get audio as ArrayBuffer and save via Tauri backend
    const audioBuffer = await synthRes.arrayBuffer();
    const audioBytes = Array.from(new Uint8Array(audioBuffer));

    const result = await invoke<{ path: string; durationMs: number }>("video_save_audio", {
      audioBytes,
      mdPath: options.mdPath ?? null,
      filename: options.filename ?? null,
    });

    // 6. Use timing data for duration estimate, fall back to WAV header duration
    let durationMs = result.durationMs;
    if (timingData.length > 0) {
      durationMs = timingData[timingData.length - 1].endMs;
      const postMs = (audioQuery.postPhonemeLength / speedScale) * 1000;
      durationMs += Math.round(postMs);
    }

    return { audioPath: result.path, durationMs, timingData };
  }

  async listVoices(): Promise<Voice[]> {
    try {
      const res = await fetch(`${this.host}/speakers`);
      if (!res.ok) return [];

      const speakers: VoicevoxSpeaker[] = await res.json();
      const voices: Voice[] = [];

      for (const speaker of speakers) {
        for (const style of speaker.styles) {
          voices.push({
            id: String(style.id),
            name: `${speaker.name} (${style.name})`,
            language: "ja",
          });
        }
      }

      return voices;
    } catch {
      return [];
    }
  }
}

// ─── Factory ─────────────────────────────────────────────────────────────────

export function createTTSProvider(provider: string, host?: string): TTSProvider {
  switch (provider) {
    case "voicevox":
      return new VoicevoxProvider(host);
    default:
      throw new Error(`Unknown TTS provider: ${provider}`);
  }
}
