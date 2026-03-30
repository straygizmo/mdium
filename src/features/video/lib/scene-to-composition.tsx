import React from "react";
import {
  Sequence,
  Audio,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
  parseSrt,
} from "@open-motion/core";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { VideoProject, Scene, SceneElement } from "../types";

/** Convert a local file path to a URL the webview can load. */
function toPlayableSrc(filePath: string): string {
  if (!filePath || filePath.startsWith("http") || filePath.startsWith("blob:") || filePath.startsWith("data:")) {
    return filePath;
  }
  try {
    return convertFileSrc(filePath);
  } catch {
    return filePath;
  }
}

// ─── Public Exports ───────────────────────────────────────────────────────────

export function calculateTotalDuration(project: VideoProject): number {
  const scenes = project.scenes;
  if (scenes.length === 0) return 0;

  let total = scenes.reduce(
    (sum, scene) => sum + (scene.durationInFrames ?? 150),
    0
  );

  // Subtract transition overlap between adjacent scenes
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
}): React.JSX.Element {
  const { bgm } = project.audio;

  // Build frame offsets accounting for transition overlaps
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

  return (
    <div style={{ width: "100%", height: "100%", position: "relative" }}>
      {/* Background music */}
      {bgm && <Audio src={toPlayableSrc(bgm.src)} volume={bgm.volume} />}

      {/* Scenes */}
      {project.scenes.map((scene, i) => {
        const duration = scene.durationInFrames ?? 150;
        return (
          <Sequence
            key={scene.id}
            from={frameOffsets[i]}
            durationInFrames={duration}
          >
            <SceneRenderer scene={scene} />
            {scene.narrationAudio && (
              <Audio
                src={toPlayableSrc(scene.narrationAudio)}
                volume={project.audio.tts?.volume ?? 1}
              />
            )}
            {scene.captions?.enabled && scene.captions.srt && (
              <CaptionsOverlay srt={scene.captions.srt} />
            )}
          </Sequence>
        );
      })}
    </div>
  );
}

// ─── SceneRenderer (internal) ─────────────────────────────────────────────────

function SceneRenderer({ scene }: { scene: Scene }): React.JSX.Element {
  const frame = useCurrentFrame();
  const { transition, elements } = scene;
  const transitionFrames = transition?.durationInFrames ?? 15;
  const transitionType = transition?.type ?? "none";

  let opacity = 1;
  let transform = "none";

  switch (transitionType) {
    case "fade": {
      opacity = interpolate(frame, [0, transitionFrames], [0, 1], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
      });
      break;
    }
    case "slide-left": {
      const tx = interpolate(frame, [0, transitionFrames], [100, 0], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
      });
      transform = `translateX(${tx}%)`;
      break;
    }
    case "slide-right": {
      const tx = interpolate(frame, [0, transitionFrames], [-100, 0], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
      });
      transform = `translateX(${tx}%)`;
      break;
    }
    case "slide-up": {
      const ty = interpolate(frame, [0, transitionFrames], [100, 0], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
      });
      transform = `translateY(${ty}%)`;
      break;
    }
    case "none":
    default:
      break;
  }

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        backgroundColor: "#1a1a2e",
        color: "#ffffff",
        padding: "60px 80px",
        fontFamily: '"Noto Sans JP", sans-serif',
        boxSizing: "border-box",
        display: "flex",
        flexDirection: "column",
        gap: "24px",
        opacity,
        transform,
        overflow: "hidden",
        position: "absolute",
        inset: 0,
      }}
    >
      {elements.map((element, i) => (
        <ElementRenderer key={i} element={element} index={i} />
      ))}
    </div>
  );
}

// ─── ElementRenderer (internal) ──────────────────────────────────────────────

function ElementRenderer({
  element,
  index,
}: {
  element: SceneElement;
  index: number;
}): React.JSX.Element {
  const frame = useCurrentFrame();
  const delay = index * 10;

  switch (element.type) {
    case "title": {
      const fontSize = element.level === 1 ? 56 : element.level === 2 ? 42 : 32;

      const opacity =
        element.animation === "none"
          ? 1
          : interpolate(frame, [delay, delay + 20], [0, 1], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
            });

      const translateY =
        element.animation === "slide-in"
          ? interpolate(frame, [delay, delay + 20], [40, 0], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
            })
          : 0;

      return (
        <div
          style={{
            fontSize,
            fontWeight: "bold",
            opacity,
            transform: `translateY(${translateY}px)`,
          }}
        >
          {element.text}
        </div>
      );
    }

    case "text": {
      const opacity =
        element.animation === "none"
          ? 1
          : interpolate(frame, [delay, delay + 20], [0, 1], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
            });

      return (
        <p style={{ fontSize: 24, margin: 0, opacity }}>
          {element.content}
        </p>
      );
    }

    case "bullet-list": {
      return (
        <ul style={{ fontSize: 24, paddingLeft: 32, margin: 0 }}>
          {element.items.map((item, itemIndex) => {
            const itemDelay = delay + itemIndex * (element.delayPerItem ?? 10);
            const opacity =
              element.animation === "none"
                ? 1
                : interpolate(frame, [itemDelay, itemDelay + 20], [0, 1], {
                    extrapolateLeft: "clamp",
                    extrapolateRight: "clamp",
                  });

            return (
              <li key={itemIndex} style={{ opacity, marginBottom: 8 }}>
                {item}
              </li>
            );
          })}
        </ul>
      );
    }

    case "image": {
      const opacity =
        element.animation === "none"
          ? 1
          : interpolate(frame, [delay, delay + 20], [0, 1], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
            });

      const scale =
        element.animation === "zoom-in"
          ? interpolate(frame, [delay, delay + 20], [0.85, 1], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
            })
          : 1;

      return (
        <img
          src={element.src}
          alt={element.alt ?? ""}
          style={{
            maxWidth: "80%",
            maxHeight: 400,
            borderRadius: 8,
            opacity,
            transform: `scale(${scale})`,
            display: "block",
            margin: element.position === "center" ? "0 auto" : undefined,
          }}
        />
      );
    }

    case "table": {
      return (
        <table
          style={{
            borderCollapse: "collapse",
            width: "100%",
            fontSize: 20,
          }}
        >
          <thead>
            <tr>
              {element.headers.map((header, hi) => (
                <th
                  key={hi}
                  style={{
                    backgroundColor: "#2d2d5e",
                    color: "#ffffff",
                    padding: "10px 16px",
                    textAlign: "left",
                    border: "1px solid #444",
                  }}
                >
                  {header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {element.rows.map((row, rowIndex) => {
              const rowDelay = delay + rowIndex * 10;
              const opacity =
                element.animation === "none"
                  ? 1
                  : interpolate(frame, [rowDelay, rowDelay + 15], [0, 1], {
                      extrapolateLeft: "clamp",
                      extrapolateRight: "clamp",
                    });

              return (
                <tr key={rowIndex} style={{ opacity }}>
                  {row.map((cell, ci) => (
                    <td
                      key={ci}
                      style={{
                        padding: "8px 16px",
                        border: "1px solid #333",
                        color: "#e0e0e0",
                      }}
                    >
                      {cell}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      );
    }

    case "code-block": {
      const opacity =
        element.animation === "none"
          ? 1
          : interpolate(frame, [delay, delay + 20], [0, 1], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
            });

      return (
        <pre
          style={{
            backgroundColor: "#0d1117",
            padding: "20px 24px",
            borderRadius: 8,
            overflow: "auto",
            opacity,
            margin: 0,
          }}
        >
          <code
            style={{
              fontFamily: '"Fira Code", "Cascadia Code", monospace',
              fontSize: 18,
              color: "#e6edf3",
              whiteSpace: "pre",
            }}
          >
            {element.code}
          </code>
        </pre>
      );
    }

    default: {
      return <></>;
    }
  }
}

// ─── CaptionsOverlay (internal) ──────────────────────────────────────────────

function CaptionsOverlay({ srt }: { srt: string }): React.JSX.Element | null {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const subtitles = React.useMemo(() => parseSrt(srt), [srt]);

  const currentTimeSeconds = frame / fps;

  const activeSubtitle = subtitles.find(
    (sub) =>
      currentTimeSeconds >= sub.startInSeconds &&
      currentTimeSeconds < sub.endInSeconds
  );

  if (!activeSubtitle) return null;

  return (
    <div
      style={{
        position: "absolute",
        bottom: 48,
        left: "10%",
        width: "80%",
        backgroundColor: "rgba(0, 0, 0, 0.7)",
        color: "#ffffff",
        textAlign: "center",
        padding: "12px 20px",
        borderRadius: 6,
        fontSize: 28,
        fontFamily: '"Noto Sans JP", sans-serif',
        lineHeight: 1.4,
        pointerEvents: "none",
      }}
    >
      {activeSubtitle.text}
    </div>
  );
}
