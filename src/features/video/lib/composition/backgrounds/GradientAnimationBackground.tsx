import { useCurrentFrame } from "@open-motion/core";

export function GradientAnimationBackground({
  colors,
  speed = 0.5,
}: {
  colors: string[];
  speed?: number;
}) {
  const frame = useCurrentFrame();
  const angle = (frame * speed) % 360;
  const gradient = `linear-gradient(${angle}deg, ${colors.join(", ")})`;

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        background: gradient,
        zIndex: 10,
        pointerEvents: "none",
      }}
    />
  );
}
