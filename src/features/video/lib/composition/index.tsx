import { Sequence, Audio } from "@open-motion/core";
import type { VideoProject } from "../../types";
import { getScale, toPlayableSrc } from "./constants";
import { SceneRenderer } from "./SceneRenderer";
import { SceneAudio } from "./SceneAudio";

export function calculateTotalDuration(project: VideoProject): number {
  const scenes = project.scenes;
  if (scenes.length === 0) return 0;

  let total = scenes.reduce(
    (sum, scene) => sum + (scene.durationInFrames ?? 150),
    0
  );

  for (let i = 1; i < scenes.length; i++) {
    const prevTransition = scenes[i - 1].transition;
    total -= prevTransition?.durationInFrames ?? 0;
  }

  return Math.max(total, 0);
}

export function VideoComposition({
  project,
}: {
  project: VideoProject;
}) {
  const { bgm } = project.audio;

  const frameOffsets: number[] = [];
  let offset = 0;
  for (let i = 0; i < project.scenes.length; i++) {
    frameOffsets.push(offset);
    const scene = project.scenes[i];
    const duration = scene.durationInFrames ?? 150;
    const nextOverlap =
      i < project.scenes.length - 1
        ? (scene.transition?.durationInFrames ?? 0)
        : 0;
    offset += duration - nextOverlap;
  }

  const s = getScale(project.meta.width, project.meta.height);

  return (
    <div style={{ width: "100%", height: "100%", position: "relative" }}>
      {bgm && <Audio src={toPlayableSrc(bgm.src)} volume={bgm.volume} loop />}

      {project.scenes.map((scene, i) => {
        const duration = scene.durationInFrames ?? 150;
        return (
          <Sequence
            key={scene.id}
            from={frameOffsets[i]}
            durationInFrames={duration}
          >
            <SceneRenderer scene={scene} project={project} scale={s} />
            <SceneAudio
              scene={scene}
              ttsVolume={project.audio.tts?.volume ?? 1}
              fps={project.meta.fps}
            />
          </Sequence>
        );
      })}
    </div>
  );
}
