import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useVideoStore } from "@/stores/video-store";
import type { Scene, TransitionType } from "@/features/video/types";
import { generateNarrationForScene } from "../lib/narration-generator";

const TRANSITION_OPTIONS: { value: TransitionType; labelKey: string }[] = [
  { value: "fade", labelKey: "transition.fade" },
  { value: "slide-left", labelKey: "transition.slideLeft" },
  { value: "slide-right", labelKey: "transition.slideRight" },
  { value: "slide-up", labelKey: "transition.slideUp" },
  { value: "none", labelKey: "transition.none" },
];

interface SceneEditFormProps {
  scene: Scene;
}

export function SceneEditForm({ scene }: SceneEditFormProps) {
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

  const handleRegenerateNarration = useCallback(async () => {
    const narration = await generateNarrationForScene(scene);
    updateScene(scene.id, { narration });
    markNarrationDirty(scene.id);
  }, [scene, updateScene, markNarrationDirty]);

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
        <span>{scene.title ?? t("scene.untitled")}</span>
        {scene.narrationDirty && (
          <span className="scene-edit-form__dirty">{t("scene.unsync")}</span>
        )}
      </div>

      <div className="scene-edit-form__field">
        <label>{t("scene.narration")}</label>
        <div className="scene-edit-form__narration-row">
          <textarea
            value={scene.narration}
            onChange={handleNarrationChange}
            rows={4}
            placeholder={t("scene.narrationPlaceholder")}
          />
          <button
            className="scene-edit-form__btn"
            onClick={handleRegenerateNarration}
            title={t("scene.regenerateNarration")}
          >
            ↻
          </button>
        </div>
      </div>

      <div className="scene-edit-form__row">
        <label>{t("scene.captions")}</label>
        <button
          className={`scene-edit-form__toggle${captionsEnabled ? " scene-edit-form__toggle--on" : ""}`}
          onClick={handleToggleCaptions}
        >
          {captionsEnabled ? t("scene.captionsOn") : t("scene.captionsOff")}
        </button>
      </div>

      <div className="scene-edit-form__row">
        <label>{t("scene.transition")}</label>
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
