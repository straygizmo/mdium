import React, { useMemo } from "react";
import { useCurrentFrame } from "@open-motion/core";

const PRESETS = {
  stars: { count: 60, color: "#ffffff", sizeRange: [1, 3] as const, speed: 0.2, opacity: 0.8 },
  snow: { count: 40, color: "#ffffff", sizeRange: [2, 6] as const, speed: 0.8, opacity: 0.6 },
  fireflies: { count: 25, color: "#ffdd44", sizeRange: [2, 5] as const, speed: 0.3, opacity: 0.7 },
  bubbles: { count: 20, color: "#88ccff", sizeRange: [4, 12] as const, speed: 0.4, opacity: 0.3 },
} as const;

function seededRandom(seed: number): number {
  const x = Math.sin(seed * 9301 + 49297) * 233280;
  return x - Math.floor(x);
}

export function ParticlesBackground({
  preset,
}: {
  preset: keyof typeof PRESETS;
}) {
  const frame = useCurrentFrame();
  const config = PRESETS[preset];

  const particles = useMemo(() => {
    return Array.from({ length: config.count }, (_, i) => ({
      x: seededRandom(i * 7 + 1) * 100,
      y: seededRandom(i * 13 + 2) * 100,
      size: config.sizeRange[0] + seededRandom(i * 17 + 3) * (config.sizeRange[1] - config.sizeRange[0]),
      phase: seededRandom(i * 23 + 4) * Math.PI * 2,
      speedX: (seededRandom(i * 29 + 5) - 0.5) * 0.5,
      speedY: (seededRandom(i * 31 + 6) - 0.5) * 0.5,
    }));
  }, [config]);

  return (
    <div style={{ position: "absolute", inset: 0, zIndex: 10, pointerEvents: "none", overflow: "hidden" }}>
      {particles.map((p, i) => {
        const x = (p.x + frame * p.speedX * config.speed) % 100;
        const y = (p.y + frame * p.speedY * config.speed) % 100;
        const flickerOpacity = config.opacity * (0.6 + 0.4 * Math.sin(frame * 0.05 + p.phase));

        return (
          <div
            key={i}
            style={{
              position: "absolute",
              left: `${((x % 100) + 100) % 100}%`,
              top: `${((y % 100) + 100) % 100}%`,
              width: p.size,
              height: p.size,
              borderRadius: "50%",
              backgroundColor: config.color,
              opacity: flickerOpacity,
            }}
          />
        );
      })}
    </div>
  );
}
