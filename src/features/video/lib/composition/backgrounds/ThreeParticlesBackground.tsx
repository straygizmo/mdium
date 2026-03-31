import React, { useCallback } from "react";
import { useVideoConfig } from "@open-motion/core";
import { ThreeCanvas } from "@open-motion/components";
import * as THREE from "three";
import { GradientBackground } from "./GradientBackground";

class WebGLErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false };
  static getDerivedStateFromError() { return { hasError: true }; }
  render() {
    if (this.state.hasError) {
      return <GradientBackground colors={["#1a1a2e", "#16213e"]} />;
    }
    return this.props.children;
  }
}

const PRESETS = {
  floating: { count: 200, speed: 0.3, size: 2, color: 0xffffff },
  galaxy: { count: 500, speed: 0.1, size: 1, color: 0x8888ff },
  rain: { count: 300, speed: 1.0, size: 1, color: 0xaaddff },
};

export function ThreeParticlesBackground({
  preset,
}: {
  preset: keyof typeof PRESETS;
}) {
  const { width, height } = useVideoConfig();
  const config = PRESETS[preset];

  const init = useCallback(
    (scene: THREE.Scene, camera: THREE.Camera) => {
      camera.position.z = 5;
      scene.background = null;

      const geometry = new THREE.BufferGeometry();
      const positions = new Float32Array(config.count * 3);
      for (let i = 0; i < config.count; i++) {
        positions[i * 3] = (Math.random() - 0.5) * 10;
        positions[i * 3 + 1] = (Math.random() - 0.5) * 10;
        positions[i * 3 + 2] = (Math.random() - 0.5) * 10;
      }
      geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));

      const material = new THREE.PointsMaterial({
        size: config.size * 0.02,
        color: config.color,
        transparent: true,
        opacity: 0.8,
      });

      const points = new THREE.Points(geometry, material);
      points.name = "particles";
      scene.add(points);
    },
    [config]
  );

  const renderScene = useCallback(
    (scene: THREE.Scene, _camera: THREE.Camera, frame: number) => {
      const points = scene.getObjectByName("particles");
      if (points) {
        points.rotation.y = frame * 0.002 * config.speed;
        points.rotation.x = frame * 0.001 * config.speed;
      }
    },
    [config]
  );

  return (
    <WebGLErrorBoundary>
      <div style={{ position: "absolute", inset: 0, zIndex: 10, pointerEvents: "none" }}>
        <ThreeCanvas width={width} height={height} init={init} renderScene={renderScene} />
      </div>
    </WebGLErrorBoundary>
  );
}
