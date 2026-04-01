import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { open } from "@tauri-apps/plugin-dialog";
import { useVideoStore } from "@/stores/video-store";
import type { AspectRatio } from "@/features/video/types";

interface VideoSettingsBarProps {
  onGenerateAudio: () => void;
  generating: boolean;
  generatingStatus: string;
  onDecorateWithLLM: () => void;
  decorating: boolean;
}

const RESOLUTION_OPTIONS = [
  { label: "1920x1080 (16:9)", width: 1920, height: 1080, aspectRatio: "16:9" as AspectRatio },
  { label: "1080x1920 (9:16)", width: 1080, height: 1920, aspectRatio: "9:16" as AspectRatio },
  { label: "1280x720 (16:9)", width: 1280, height: 720, aspectRatio: "16:9" as AspectRatio },
  { label: "1080x1080 (1:1)", width: 1080, height: 1080, aspectRatio: "1:1" as AspectRatio },
];

export function VideoSettingsBar({ onGenerateAudio, generating, generatingStatus, onDecorateWithLLM, decorating }: VideoSettingsBarProps) {
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

  const handleTtsSpeedChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const speed = parseFloat(e.target.value);
      updateAudioConfig({
        tts: {
          provider: audio?.tts?.provider ?? "voicevox",
          volume: audio?.tts?.volume ?? 1.0,
          speaker: audio?.tts?.speaker,
          speed,
        },
      });
    },
    [audio?.tts, updateAudioConfig]
  );

  const handleTtsVolumeChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const volume = parseFloat(e.target.value);
      updateAudioConfig({
        tts: {
          provider: audio?.tts?.provider ?? "voicevox",
          speaker: audio?.tts?.speaker,
          speed: audio?.tts?.speed,
          volume,
        },
      });
    },
    [audio?.tts, updateAudioConfig]
  );

  const setAllCaptions = useVideoStore((s) => s.setAllCaptions);
  const allCaptionsEnabled = videoProject?.scenes.every((s) => s.captions?.enabled) ?? false;

  const handleToggleAllCaptions = useCallback(() => {
    setAllCaptions(!allCaptionsEnabled);
  }, [allCaptionsEnabled, setAllCaptions]);

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

      <fieldset className="video-settings-bar__narration-group">
        <legend className="video-settings-bar__narration-legend">{t("narrationSettings")}</legend>

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

        <div className="video-settings-bar__row">
          <label>{t("ttsSpeed")}</label>
          <input
            type="range"
            min={0.7}
            max={1.5}
            step={0.1}
            value={audio?.tts?.speed ?? 1.0}
            onChange={handleTtsSpeedChange}
          />
          <span style={{ fontSize: 11, minWidth: 28, textAlign: "right" }}>{(audio?.tts?.speed ?? 1.0).toFixed(1)}</span>
        </div>

        <div className="video-settings-bar__row">
          <label>{t("ttsVolume")}</label>
          <input
            type="range"
            min={0.0}
            max={2.0}
            step={0.1}
            value={audio?.tts?.volume ?? 1.0}
            onChange={handleTtsVolumeChange}
          />
          <span style={{ fontSize: 11, minWidth: 28, textAlign: "right" }}>{(audio?.tts?.volume ?? 1.0).toFixed(1)}</span>
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
      </fieldset>

      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <button
          className="video-settings-bar__decorate-btn"
          onClick={onDecorateWithLLM}
          disabled={decorating || generating}
          title={t("autoConfigWithLLMTooltip")}
          style={{ flex: 1 }}
        >
          {decorating ? t("autoConfiguring") : t("autoConfigWithLLM")}
        </button>
        <label style={{ fontSize: 12, color: "var(--text)", whiteSpace: "nowrap" }}>{t("captions")}</label>
        <span
          className={`scene-edit-form__switch${allCaptionsEnabled ? " scene-edit-form__switch--on" : ""}`}
          role="switch"
          aria-checked={allCaptionsEnabled}
          tabIndex={0}
          onClick={handleToggleAllCaptions}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              handleToggleAllCaptions();
            }
          }}
        >
          <span className="scene-edit-form__switch-thumb" />
        </span>
      </div>
    </div>
  );
}
