import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { open } from "@tauri-apps/plugin-dialog";
import { useVideoStore } from "@/stores/video-store";
import type { AspectRatio } from "@/features/video/types";

interface VideoSettingsBarProps {
  onGenerateAudio: () => void;
  generating: boolean;
  generatingStatus: string;
}

const RESOLUTION_OPTIONS = [
  { label: "1920x1080 (16:9)", width: 1920, height: 1080, aspectRatio: "16:9" as AspectRatio },
  { label: "1080x1920 (9:16)", width: 1080, height: 1920, aspectRatio: "9:16" as AspectRatio },
  { label: "1280x720 (16:9)", width: 1280, height: 720, aspectRatio: "16:9" as AspectRatio },
  { label: "1080x1080 (1:1)", width: 1080, height: 1080, aspectRatio: "1:1" as AspectRatio },
];

export function VideoSettingsBar({ onGenerateAudio, generating, generatingStatus }: VideoSettingsBarProps) {
  const { t } = useTranslation("video");
  const videoProject = useVideoStore((s) => s.videoProject);
  const updateMeta = useVideoStore((s) => s.updateMeta);
  const updateAudioConfig = useVideoStore((s) => s.updateAudioConfig);

  const meta = videoProject?.meta;
  const audio = videoProject?.audio;

  const handleResolutionChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const idx = parseInt(e.target.value, 10);
      const opt = RESOLUTION_OPTIONS[idx];
      if (opt) {
        updateMeta({ width: opt.width, height: opt.height, aspectRatio: opt.aspectRatio });
      }
    },
    [updateMeta]
  );

  const currentResolutionIndex = RESOLUTION_OPTIONS.findIndex(
    (o) => o.width === meta?.width && o.height === meta?.height
  );

  const handleBgmSelect = useCallback(async () => {
    const path = await open({
      multiple: false,
      filters: [{ name: t("audioFiles"), extensions: ["mp3", "wav", "ogg", "flac", "aac"] }],
    });
    if (typeof path === "string") {
      updateAudioConfig({ bgm: { src: path, volume: audio?.bgm?.volume ?? 0.5 } });
    }
  }, [audio?.bgm?.volume, t, updateAudioConfig]);

  const handleBgmVolumeChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const volume = parseFloat(e.target.value);
      updateAudioConfig({ bgm: { src: audio?.bgm?.src ?? "", volume } });
    },
    [audio?.bgm?.src, updateAudioConfig]
  );

  const handleTtsSpeakerChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      updateAudioConfig({
        tts: {
          provider: audio?.tts?.provider ?? "voicevox",
          volume: audio?.tts?.volume ?? 1.0,
          speed: audio?.tts?.speed,
          speaker: e.target.value,
        },
      });
    },
    [audio?.tts, updateAudioConfig]
  );

  if (!videoProject) return null;

  return (
    <div className="video-settings-bar">
      <span className="video-settings-bar__title">{t("globalSettings")}</span>

      <div className="video-settings-bar__row">
        <label>{t("resolution")}</label>
        <select
          value={currentResolutionIndex >= 0 ? currentResolutionIndex : ""}
          onChange={handleResolutionChange}
        >
          {RESOLUTION_OPTIONS.map((opt, idx) => (
            <option key={opt.label} value={idx}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>

      <div className="video-settings-bar__row">
        <label>{t("bgm")}</label>
        <button className="video-settings-bar__btn" onClick={handleBgmSelect}>
          {audio?.bgm?.src ? audio.bgm.src.split(/[\\/]/).pop() : t("bgmSelect")}
        </button>
        {audio?.bgm && (
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={audio.bgm.volume}
            onChange={handleBgmVolumeChange}
            title={t("bgmVolume")}
          />
        )}
      </div>

      <div className="video-settings-bar__row">
        <label>{t("ttsProvider")}</label>
        <select value={audio?.tts?.provider ?? "voicevox"} disabled>
          <option value="voicevox">VoiceVox</option>
        </select>
      </div>

      <div className="video-settings-bar__row">
        <label>{t("ttsSpeaker")}</label>
        <input
          type="text"
          value={audio?.tts?.speaker ?? ""}
          onChange={handleTtsSpeakerChange}
          placeholder={t("ttsSpeakerPlaceholder")}
        />
      </div>

      <button
        className="video-settings-bar__generate-btn"
        onClick={onGenerateAudio}
        disabled={generating}
      >
        {generating
          ? generatingStatus || t("generatingAudio")
          : t("generateAudio")}
      </button>
    </div>
  );
}
