import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useVideoStore } from "@/stores/video-store";
import type { Scene, TransitionType } from "@/features/video/types";

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
        </select>
      </div>
    </div>
  );
}
