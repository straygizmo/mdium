import React from "react";
import { Lottie } from "@open-motion/components";
import type { LottiePreset } from "../../types";

export function LottieBackground({ preset }: { preset: LottiePreset }) {
  const url = `/lottie/${preset}.json`;

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 10,
        pointerEvents: "none",
        opacity: 0.4,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Lottie url={url} style={{ width: "60%", height: "60%" }} />
    </div>
  );
}
