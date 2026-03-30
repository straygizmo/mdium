import React from "react";

export function GradientBackground({
  colors,
  angle = 135,
}: {
  colors: string[];
  angle?: number;
}) {
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
