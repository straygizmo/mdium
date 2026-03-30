import { useCallback } from "react";
import { useVideoConfig } from "@open-motion/core";
import { ThreeCanvas } from "@open-motion/components";
import * as THREE from "three";

export function ThreeGeometryBackground({
  preset,
}: {
  preset: "wireframe-sphere" | "rotating-cube" | "wave-mesh";
}) {
  const { width, height } = useVideoConfig();

  const init = useCallback(
    (scene: THREE.Scene, camera: THREE.Camera) => {
      (camera as THREE.PerspectiveCamera).position.z = 5;
      scene.background = null;

      const material = new THREE.MeshBasicMaterial({
        color: 0x4488ff,
        wireframe: true,
        transparent: true,
        opacity: 0.3,
      });

      let geometry: THREE.BufferGeometry;

      switch (preset) {
        case "wireframe-sphere":
          geometry = new THREE.SphereGeometry(2, 32, 32);
          break;
        case "rotating-cube":
          geometry = new THREE.BoxGeometry(2, 2, 2);
          break;
        case "wave-mesh":
        default:
          geometry = new THREE.PlaneGeometry(10, 10, 40, 40);
          break;
      }

      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = "geometry";
      scene.add(mesh);
    },
    [preset]
  );

  const renderScene = useCallback(
    (scene: THREE.Scene, _camera: THREE.Camera, frame: number) => {
      const mesh = scene.getObjectByName("geometry") as THREE.Mesh;
      if (!mesh) return;

      if (preset === "wave-mesh") {
        const positions = mesh.geometry.attributes.position as THREE.BufferAttribute;
        for (let i = 0; i < positions.count; i++) {
          const x = positions.getX(i);
          const y = positions.getY(i);
          const z = Math.sin(x * 0.5 + frame * 0.03) * Math.cos(y * 0.5 + frame * 0.02) * 0.5;
          positions.setZ(i, z);
        }
        positions.needsUpdate = true;
      } else {
        mesh.rotation.x = frame * 0.01;
        mesh.rotation.y = frame * 0.015;
      }
    },
    [preset]
  );

  return (
    <div style={{ position: "absolute", inset: 0, zIndex: 10, pointerEvents: "none" }}>
      <ThreeCanvas width={width} height={height} init={init} renderScene={renderScene} />
    </div>
  );
}
