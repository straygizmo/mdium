import { Sequence, Audio } from "@open-motion/core";
import type { Scene } from "../../types";
import { toPlayableSrc } from "./constants";

export function SceneAudio({
  scene,
  ttsVolume,
  fps,
}: {
  scene: Scene;
  ttsVolume: number;
  fps: number;
}) {
  if (scene.narrationSegments?.length) {
    let frameOffset = 0;
    return (
      <>
        {scene.narrationSegments.map((seg, i) => {
          if (!seg.audioPath) return null;
          const from = frameOffset;
          const segFrames = seg.durationMs
            ? Math.ceil((seg.durationMs / 1000) * fps)
            : 0;
          frameOffset += segFrames;
          return (
            <Sequence key={i} from={from} durationInFrames={segFrames || 9999}>
              <Audio src={toPlayableSrc(seg.audioPath)} volume={Math.min(ttsVolume, 1)} />
            </Sequence>
          );
        })}
      </>
    );
  }

  if (scene.narrationAudio) {
    return <Audio src={toPlayableSrc(scene.narrationAudio)} volume={Math.min(ttsVolume, 1)} />;
  }

  return <></>;
}
