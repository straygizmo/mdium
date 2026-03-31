import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";
import { useVideoStore } from "@/stores/video-store";
import { splitNarration } from "@/features/video/lib/narration-splitter";
import { SceneContentEditor } from "./SceneContentEditor";
import type { Scene, TransitionType, ImageElement } from "@/features/video/types";
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
  const updateImageElement = useVideoStore((s) => s.updateImageElement);
  const sourceFilePath = useVideoStore((s) => s.sourceFilePath);

  // Extract image elements with their original indices
  const imageElements = useMemo(
    () =>
      scene.elements
        .map((el, i) => ({ el, i }))
        .filter((item): item is { el: ImageElement; i: number } => item.el.type === "image"),
    [scene.elements]
  );

  // Load image files as blob URLs for thumbnail display
  const [imageBlobUrls, setImageBlobUrls] = useState<Record<number, string>>({});
  const blobUrlsRef = useRef<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    const newUrls: Record<number, string> = {};
    const newBlobUrls: string[] = [];

    (async () => {
      for (const { el, i } of imageElements) {
        if (/^(https?:|data:|blob:)/i.test(el.src)) {
          newUrls[i] = el.src;
          continue;
        }
        try {
          const data = await readFile(el.src);
          const ext = el.src.split(".").pop()?.toLowerCase() ?? "";
          const mime =
            ext === "svg" ? "image/svg+xml" :
            ext === "png" ? "image/png" :
            ext === "gif" ? "image/gif" :
            ext === "webp" ? "image/webp" :
            "image/jpeg";
          const blob = new Blob([data], { type: mime });
          const url = URL.createObjectURL(blob);
          newBlobUrls.push(url);
          newUrls[i] = url;
        } catch {
          // skip if file not found
        }
      }
      if (!cancelled) {
        // Revoke old blob URLs
        for (const u of blobUrlsRef.current) URL.revokeObjectURL(u);
        blobUrlsRef.current = newBlobUrls;
        setImageBlobUrls(newUrls);
      }
    })();

    return () => { cancelled = true; };
  }, [imageElements]);

  // Cleanup blob URLs on unmount
  useEffect(() => {
    return () => {
      for (const u of blobUrlsRef.current) URL.revokeObjectURL(u);
    };
  }, []);

  const handleImageToggle = useCallback(
    (elementIndex: number, currentEnabled: boolean) => {
      updateImageElement(scene.id, elementIndex, { enabled: !currentEnabled });
    },
    [scene.id, updateImageElement]
  );

  const handleImagePositionChange = useCallback(
    (elementIndex: number, position: string) => {
      updateImageElement(scene.id, elementIndex, { position: position as ImageElement["position"] });
    },
    [scene.id, updateImageElement]
  );

  const handleImageAnimationChange = useCallback(
    (elementIndex: number, animation: string) => {
      updateImageElement(scene.id, elementIndex, { animation: animation as ImageElement["animation"] });
    },
    [scene.id, updateImageElement]
  );

  const handleImageReplace = useCallback(
    async (elementIndex: number) => {
      const defaultPath = sourceFilePath
        ? sourceFilePath.replace(/[\\/][^\\/]+$/, "")
        : undefined;
      const path = await open({
        multiple: false,
        defaultPath,
        filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp", "svg"] }],
      });
      if (typeof path === "string") {
        updateImageElement(scene.id, elementIndex, { src: path });
      }
    },
    [scene.id, updateImageElement, sourceFilePath]
  );

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

  // Check which segments have audio files on disk
  const [audioExists, setAudioExists] = useState<boolean[]>([]);
  useEffect(() => {
    const segments = scene.narrationSegments;
    if (!segments?.length) {
      setAudioExists([]);
      return;
    }
    let cancelled = false;
    Promise.all(
      segments.map((seg) =>
        seg.audioPath
          ? invoke<boolean>("video_file_exists", { path: seg.audioPath }).catch(() => false)
          : Promise.resolve(false),
      ),
    ).then((results) => {
      if (!cancelled) setAudioExists(results);
    });
    return () => { cancelled = true; };
  }, [scene.narrationSegments]);

  return (
    <div className="scene-edit-form">
      <SceneContentEditor scene={scene} />

      {imageElements.length > 0 && (
        <div className="scene-edit-form__images">
          <label className="scene-edit-form__images-title">画像 ({imageElements.length})</label>
          {imageElements.map(({ el, i }) => {
            const enabled = el.enabled !== false;
            const fileName = el.src.split(/[\\/]/).pop() ?? el.src;
            return (
              <div
                key={i}
                className={`scene-edit-form__image-item${enabled ? "" : " scene-edit-form__image-item--disabled"}`}
              >
                <img
                  className="scene-edit-form__image-thumb"
                  src={imageBlobUrls[i] ?? ""}
                  alt={el.alt ?? ""}
                />
                <div className="scene-edit-form__image-controls">
                  <div className="scene-edit-form__image-top-row">
                    <span
                      className={`scene-edit-form__switch${enabled ? " scene-edit-form__switch--on" : ""}`}
                      role="switch"
                      aria-checked={enabled}
                      tabIndex={0}
                      onClick={() => handleImageToggle(i, enabled)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          handleImageToggle(i, enabled);
                        }
                      }}
                    >
                      <span className="scene-edit-form__switch-thumb" />
                    </span>
                    <span className={`scene-edit-form__image-name${enabled ? "" : " scene-edit-form__image-name--disabled"}`}>
                      {fileName}
                    </span>
                    <button
                      className="scene-edit-form__btn scene-edit-form__btn--small"
                      onClick={() => handleImageReplace(i)}
                    >
                      入替
                    </button>
                  </div>
                  {enabled && (
                    <div className="scene-edit-form__image-selects">
                      <div className="scene-edit-form__image-select-group">
                        <label>配置</label>
                        <select
                          value={el.position}
                          onChange={(e) => handleImagePositionChange(i, e.target.value)}
                        >
                          <option value="center">center</option>
                          <option value="left">left</option>
                          <option value="right">right</option>
                          <option value="background">background</option>
                        </select>
                      </div>
                      <div className="scene-edit-form__image-select-group">
                        <label>アニメーション</label>
                        <select
                          value={el.animation}
                          onChange={(e) => handleImageAnimationChange(i, e.target.value)}
                        >
                          <option value="fade-in">fade-in</option>
                          <option value="zoom-in">zoom-in</option>
                          <option value="ken-burns">ken-burns</option>
                          <option value="none">none</option>
                        </select>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

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
          <label className="scene-edit-form__caption-switch">
            <span className="scene-edit-form__caption-switch-label">{t("captions")}</span>
            <span
              className={`scene-edit-form__switch${captionsEnabled ? " scene-edit-form__switch--on" : ""}`}
              role="switch"
              aria-checked={captionsEnabled}
              tabIndex={0}
              onClick={handleToggleCaptions}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handleToggleCaptions(); } }}
            >
              <span className="scene-edit-form__switch-thumb" />
            </span>
          </label>
        </div>
        <textarea
          value={scene.narration}
          onChange={handleNarrationChange}
          rows={4}
          placeholder={t("narrationPlaceholder")}
        />
        {captionsEnabled && previewSegments.length > 0 && (
          <div className="scene-edit-form__segments">
            <label className="scene-edit-form__segments-label">
              {t("segmentPreview")} ({previewSegments.length})
            </label>
            <ol className="scene-edit-form__segments-list">
              {previewSegments.map((seg, i) => {
                const hasAudio = audioExists[i] ?? false;
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
