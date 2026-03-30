import type { BackgroundEffect } from "../../types";
import { GradientBackground } from "./backgrounds/GradientBackground";
import { GradientAnimationBackground } from "./backgrounds/GradientAnimationBackground";
import { ParticlesBackground } from "./backgrounds/ParticlesBackground";
import { ThreeParticlesBackground } from "./backgrounds/ThreeParticlesBackground";
import { ThreeGeometryBackground } from "./backgrounds/ThreeGeometryBackground";
import { WaveVisualizerBackground } from "./backgrounds/WaveVisualizerBackground";
import { LottieBackground } from "./backgrounds/LottieBackground";

export function BackgroundEffectRenderer({
  effect,
}: {
  effect: BackgroundEffect;
}) {
  switch (effect.type) {
    case "gradient":
      return <GradientBackground colors={effect.colors} angle={effect.angle} />;
    case "gradient-animation":
      return <GradientAnimationBackground colors={effect.colors} speed={effect.speed} />;
    case "particles":
      return <ParticlesBackground preset={effect.preset} />;
    case "three-particles":
      return <ThreeParticlesBackground preset={effect.preset} />;
    case "three-geometry":
      return <ThreeGeometryBackground preset={effect.preset} />;
    case "wave-visualizer":
      return <WaveVisualizerBackground bars={effect.bars} color={effect.color} />;
    case "lottie":
      return <LottieBackground preset={effect.preset} />;
    case "none":
    default:
      return null;
  }
}
