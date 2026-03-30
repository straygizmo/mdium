import React from "react";
import { WaveVisualizer } from "@open-motion/components";
import { useVideoConfig } from "@open-motion/core";

export function WaveVisualizerBackground({
  bars = 30,
  color = "#3b82f6",
}: {
  bars?: number;
  color?: string;
}) {
  const { height } = useVideoConfig();

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 10,
        pointerEvents: "none",
        display: "flex",
        alignItems: "flex-end",
        justifyContent: "center",
        opacity: 0.3,
        padding: "0 5%",
      }}
    >
      <WaveVisualizer bars={bars} color={color} height={Math.round(height * 0.4)} />
    </div>
  );
}
