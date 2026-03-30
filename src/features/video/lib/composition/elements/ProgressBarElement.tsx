import { useCurrentFrame, interpolate } from "@open-motion/core";
import { ProgressBar } from "@open-motion/components";
import { BASE, ANIM, scaled } from "../constants";

export function ProgressBarElement({
  element,
  index,
  scale: s,
}: {
  element: { progress: number; color?: string; label?: string; animation: string };
  index: number;
  scale: number;
}) {
  const frame = useCurrentFrame();
  const delay = index * ANIM.staggerDelay;

  let displayProgress = element.progress;

  if (element.animation === "grow") {
    const raw = interpolate(
      frame,
      [delay, delay + ANIM.fadeInDuration * 2],
      [0, 1],
      { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
    );
    displayProgress = element.progress * raw;
  }

  return (
    <div>
      {element.label && (
        <div style={{ fontSize: scaled(BASE.fontText * 0.75, s), marginBottom: scaled(8, s), color: "#e0e0e0" }}>
          {element.label}
        </div>
      )}
      <ProgressBar
        progress={displayProgress}
        color={element.color ?? "#3b82f6"}
        height={scaled(16, s)}
      />
    </div>
  );
}
