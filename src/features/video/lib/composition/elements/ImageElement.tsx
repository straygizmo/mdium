import React from "react";
import {
  useCurrentFrame,
  useVideoConfig,
  interpolate,
} from "@open-motion/core";
import { Transition } from "@open-motion/components";
import { ANIM, scaled, toPlayableSrc } from "../constants";

export function ImageElement({
  element,
  index,
  scale: s,
}: {
  element: { src: string; alt?: string; position: string; animation: string };
  index: number;
  scale: number;
}) {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const delay = index * ANIM.staggerDelay;

  const kenProgress = interpolate(frame, [0, durationInFrames], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  let imgScale = 1;
  let imgTranslateX = 0;

  if (element.animation === "zoom-in") {
    const zoomRaw = interpolate(
      frame,
      [delay, delay + ANIM.fadeInDuration],
      [0, 1],
      { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
    );
    imgScale = 0.85 + zoomRaw * 0.15;
  } else if (
    element.animation === "ken-burns" ||
    element.animation === "fade-in"
  ) {
    imgScale = 1 + kenProgress * (ANIM.kenBurnsScale - 1);
    imgTranslateX =
      kenProgress * ANIM.kenBurnsPanX - ANIM.kenBurnsPanX / 2;
  }

  const imgStyle: React.CSSProperties = {
    maxWidth: "80%",
    maxHeight: scaled(400, s),
    borderRadius: scaled(8, s),
    transform: `scale(${imgScale}) translateX(${imgTranslateX}px)`,
    display: "block",
    margin: element.position === "center" ? "0 auto" : undefined,
  };

  if (element.animation === "none") {
    return <img src={toPlayableSrc(element.src)} alt={element.alt ?? ""} style={imgStyle} />;
  }

  return (
    <Transition type="fade">
      <img src={toPlayableSrc(element.src)} alt={element.alt ?? ""} style={imgStyle} />
    </Transition>
  );
}
