import { Transition } from "@open-motion/components";
import type { Scene, VideoProject, BackgroundEffect, TransitionType } from "../../types";
import { BASE, scaled } from "./constants";
import { ElementRenderer } from "./ElementRenderer";
import { BackgroundEffectRenderer } from "./BackgroundEffectRenderer";
import { CaptionsOverlay } from "./CaptionsOverlay";
import { TikTokCaptionsOverlay } from "./TikTokCaptionsOverlay";

function mapTransition(t: TransitionType): {
  type: "fade" | "slide" | "wipe";
  direction: "left" | "right" | "top" | "bottom";
} | null {
  switch (t) {
    case "fade":
      return { type: "fade", direction: "left" };
    case "slide-left":
      return { type: "slide", direction: "left" };
    case "slide-right":
      return { type: "slide", direction: "right" };
    case "slide-up":
      return { type: "slide", direction: "top" };
    case "wipe-left":
      return { type: "wipe", direction: "left" };
    case "wipe-right":
      return { type: "wipe", direction: "right" };
    case "wipe-up":
      return { type: "wipe", direction: "top" };
    case "wipe-down":
      return { type: "wipe", direction: "bottom" };
    case "none":
    default:
      return null;
  }
}

export function SceneRenderer({
  scene,
  project,
  scale: s,
}: {
  scene: Scene;
  project: VideoProject;
  scale: number;
}) {
  const effect: BackgroundEffect =
    scene.backgroundEffect ?? project.theme?.backgroundEffect ?? { type: "none" };
  const captionStyle = project.theme?.captionStyle ?? "default";
  const transition = mapTransition(scene.transition?.type ?? "none");

  const content = (
    <div
      style={{
        width: "100%",
        height: "100%",
        backgroundColor: "#1a1a2e",
        color: "#ffffff",
        fontFamily: '"Noto Sans JP", sans-serif',
        boxSizing: "border-box",
        overflow: "hidden",
        position: "absolute",
        inset: 0,
      }}
    >
      {/* Background effect layer */}
      {effect.type !== "none" && <BackgroundEffectRenderer effect={effect} />}

      {/* Elements layer */}
      <div
        style={{
          position: "relative",
          zIndex: 20,
          width: "100%",
          height: "100%",
          padding: `${scaled(BASE.paddingV, s)}px ${scaled(BASE.paddingH, s)}px`,
          boxSizing: "border-box",
          display: "flex",
          flexDirection: "column",
          gap: `${scaled(BASE.gap, s)}px`,
        }}
      >
        {scene.elements.map((element, i) => (
          <ElementRenderer key={i} element={element} index={i} scale={s} />
        ))}
      </div>

      {/* Captions layer */}
      {scene.captions?.enabled && scene.captions.srt && (
        captionStyle === "tiktok" ? (
          <TikTokCaptionsOverlay srt={scene.captions.srt} scale={s} />
        ) : (
          <CaptionsOverlay srt={scene.captions.srt} scale={s} />
        )
      )}
    </div>
  );

  if (!transition) {
    return content;
  }

  return (
    <Transition
      type={transition.type}
      direction={transition.direction}
      durationInFrames={scene.transition?.durationInFrames ?? 30}
      style={{ position: "absolute", inset: 0 }}
    >
      {content}
    </Transition>
  );
}
