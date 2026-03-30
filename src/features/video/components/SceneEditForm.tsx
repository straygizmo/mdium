import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useVideoStore } from "@/stores/video-store";
import { splitNarration } from "@/features/video/lib/narration-splitter";
import type { Scene, TransitionType } from "@/features/video/types";
import type { BackgroundEffect } from "../types";

const TRANSITION_OPTIONS: { value: TransitionType; labelKey: string }[] = [
  { value: "fade", labelKey: "fade" },
  { value: "slide-left", labelKey: "slideLeft" },
  { value: "slide-right", labelKey: "slideRight" },
  { value: "slide-up", labelKey: "slideUp" },
  { value: "none", labelKey: "none" },
];

interface SceneEditFormProps {
  scene: Scene;
  onRegenerateAudio: (sceneId: string) => Promise<void>;
  audioGenerating: boolean;
}

export function SceneEditForm({ scene, onRegenerateAudio, audioGenerating }: SceneEditFormProps) {
  const { t } = useTranslation("video");
  const updateScene = useVideoStore((s) => s.updateScene);
  const markNarrationDirty = useVideoStore((s) => s.markNarrationDirty);

  const handleNarrationChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      updateScene(scene.id, { narration: e.target.value });
      markNarrationDirty(scene.id);
    },
    [scene.id, updateScene, markNarrationDirty]
  );

  const handleRegenerateAudio = useCallback(async () => {
    await onRegenerateAudio(scene.id);
  }, [scene.id, onRegenerateAudio]);

  const handleToggleCaptions = useCallback(() => {
    updateScene(scene.id, {
      captions: {
        ...scene.captions,
        enabled: !(scene.captions?.enabled ?? false),
      },
    });
  }, [scene.id, scene.captions, updateScene]);

  const handleTransitionChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      updateScene(scene.id, {
        transition: {
          ...scene.transition,
          type: e.target.value as TransitionType,
        },
      });
    },
    [scene.id, scene.transition, updateScene]
  );

  const captionsEnabled = scene.captions?.enabled ?? false;

  // Preview segments from current narration text
  const previewSegments = useMemo(
    () => splitNarration(scene.narration),
    [scene.narration]
  );

  return (
    <div className="scene-edit-form">
      <div className="scene-edit-form__header">
        <span>{scene.title ?? t("sceneUntitled")}</span>
        {scene.narrationDirty && (
          <span className="scene-edit-form__dirty">{t("narrationDirty")}</span>
        )}
      </div>

      <div className="scene-edit-form__field">
        <div className="scene-edit-form__label-row">
          <label>{t("narration")}</label>
          <button
            className="scene-edit-form__btn scene-edit-form__btn--small"
            onClick={handleRegenerateAudio}
            disabled={audioGenerating}
            title={t("regenerateTtsAudio")}
          >
            ↻
          </button>
        </div>
        <textarea
          value={scene.narration}
          onChange={handleNarrationChange}
          rows={4}
          placeholder={t("narrationPlaceholder")}
        />
        {previewSegments.length > 0 && (
          <div className="scene-edit-form__segments">
            <label className="scene-edit-form__segments-label">
              {t("segmentPreview")} ({previewSegments.length})
            </label>
            <ol className="scene-edit-form__segments-list">
              {previewSegments.map((seg, i) => {
                const generated = scene.narrationSegments?.[i];
                const hasAudio = !!generated?.audioPath && generated.text === seg;
                return (
                  <li key={i} className="scene-edit-form__segment-item">
                    <span className={`scene-edit-form__segment-status${hasAudio ? " scene-edit-form__segment-status--ok" : ""}`}>
                      {hasAudio ? "●" : "○"}
                    </span>
                    <span className="scene-edit-form__segment-text">{seg}</span>
                  </li>
                );
              })}
            </ol>
          </div>
        )}
      </div>

      <div className="scene-edit-form__row">
        <label>{t("captions")}</label>
        <button
          className={`scene-edit-form__toggle${captionsEnabled ? " scene-edit-form__toggle--on" : ""}`}
          onClick={handleToggleCaptions}
        >
          {captionsEnabled ? t("captionsOn") : t("captionsOff")}
        </button>
      </div>

      <div className="scene-edit-form__row">
        <label>{t("transition")}</label>
        <select value={scene.transition.type} onChange={handleTransitionChange}>
          {TRANSITION_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {t(opt.labelKey)}
            </option>
          ))}
          <option value="wipe-left">Wipe Left</option>
          <option value="wipe-right">Wipe Right</option>
          <option value="wipe-up">Wipe Up</option>
          <option value="wipe-down">Wipe Down</option>
        </select>
      </div>

      {/* Background Effect */}
      <div style={{ marginBottom: 12 }}>
        <label style={{ display: "block", fontWeight: 600, fontSize: 13, marginBottom: 4, color: "var(--foreground)" }}>
          背景エフェクト
        </label>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
          <label style={{ fontSize: 12, color: "var(--foreground-muted)" }}>
            <input
              type="checkbox"
              checked={!scene.backgroundEffect}
              onChange={(e) => {
                if (e.target.checked) {
                  updateScene(scene.id, { backgroundEffect: undefined });
                } else {
                  updateScene(scene.id, { backgroundEffect: { type: "none" } });
                }
              }}
            />
            {" "}プロジェクトデフォルト
          </label>
        </div>
        {scene.backgroundEffect && (
          <select
            value={scene.backgroundEffect.type}
            onChange={(e) => {
              const type = e.target.value;
              let effect: BackgroundEffect;
              switch (type) {
                case "gradient":
                  effect = { type: "gradient", colors: ["#1a1a2e", "#16213e"] };
                  break;
                case "gradient-animation":
                  effect = { type: "gradient-animation", colors: ["#1a1a2e", "#0f3460", "#533483"] };
                  break;
                case "particles":
                  effect = { type: "particles", preset: "stars" };
                  break;
                case "wave-visualizer":
                  effect = { type: "wave-visualizer" };
                  break;
                case "three-particles":
                  effect = { type: "three-particles", preset: "floating" };
                  break;
                case "three-geometry":
                  effect = { type: "three-geometry", preset: "wireframe-sphere" };
                  break;
                case "lottie":
                  effect = { type: "lottie", preset: "sparkle" };
                  break;
                default:
                  effect = { type: "none" };
              }
              updateScene(scene.id, { backgroundEffect: effect });
            }}
            style={{
              width: "100%",
              padding: "4px 8px",
              borderRadius: 4,
              border: "1px solid var(--border)",
              background: "var(--background)",
              color: "var(--foreground)",
              fontSize: 13,
            }}
          >
            <option value="none">なし</option>
            <option value="gradient">グラデーション</option>
            <option value="gradient-animation">アニメーショングラデーション</option>
            <option value="particles">パーティクル</option>
            <option value="wave-visualizer">波形ビジュアライザー</option>
            <option value="three-particles">3Dパーティクル</option>
            <option value="three-geometry">3Dジオメトリ</option>
            <option value="lottie">Lottieアニメーション</option>
          </select>
        )}
      </div>
    </div>
  );
}
