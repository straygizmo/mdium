import React from "react";
import {
  Sequence,
  Audio,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
  parseSrt,
} from "@open-motion/core";
import type { VideoProject, Scene, SceneElement } from "../types";

/** Convert a local file path to a URL the webview can load.
 *  Uses Tauri's asset protocol when running inside the webview,
 *  falls back to the raw path in the Playwright render environment. */
function toPlayableSrc(filePath: string): string {
  if (!filePath || filePath.startsWith("http") || filePath.startsWith("blob:") || filePath.startsWith("data:")) {
    return filePath;
  }
  try {
    const internals = (window as any).__TAURI_INTERNALS__;
    if (internals?.convertFileSrc) {
      return internals.convertFileSrc(filePath, "asset");
    }
  } catch {
    // not in Tauri environment
  }
  return filePath;
}

// ─── Resolution-based scaling ────────────────────────────────────────────────

const BASE_WIDTH = 1920;
const BASE_HEIGHT = 1080;

function getScale(width: number, height: number): number {
  return Math.min(width / BASE_WIDTH, height / BASE_HEIGHT);
}

// Base sizes at 1920x1080
const BASE = {
  fontH1: 112,
  fontH2: 84,
  fontH3: 64,
  fontText: 48,
  fontTable: 40,
  fontCode: 36,
  fontCaption: 48,
  paddingV: 80,
  paddingH: 120,
  gap: 40,
  bulletMarginLeft: 48,
  lineHeightHeading: 1.2,
  lineHeightText: 1.6,
  lineHeightCaption: 1.4,
} as const;

function scaled(base: number, scale: number): number {
  return Math.round(base * scale);
}

// ─── Easing helpers ──────────────────────────────────────────────────────────

function outCubic(t: number): number {
  const t1 = t - 1;
  return t1 * t1 * t1 + 1;
}

function inOutCubic(t: number): number {
  return t < 0.5
    ? 4 * t * t * t
    : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

// ─── Animation constants ────────────────────────────────────────────────────

const ANIM = {
  fadeInDuration: 30,
  staggerDelay: 20,
  slideDistance: 60,
  bulletDelay: 20,
  tableRowDuration: 20,
  tableRowDelay: 15,
  // Subtle motion
  floatAmplitude: 3,
  floatPeriodFrames: 120, // 4 seconds at 30fps
  // Ken Burns
  kenBurnsScale: 1.05,
  kenBurnsPanX: 15,
} as const;

// ─── Public Exports ───────────────────────────────────────────────────────────

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
}): React.JSX.Element {
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
      {bgm && <Audio src={toPlayableSrc(bgm.src)} volume={bgm.volume} />}

      {project.scenes.map((scene, i) => {
        const duration = scene.durationInFrames ?? 150;
        return (
          <Sequence
            key={scene.id}
            from={frameOffsets[i]}
            durationInFrames={duration}
          >
            <SceneRenderer scene={scene} scale={s} />
            <SceneAudio scene={scene} ttsVolume={project.audio.tts?.volume ?? 1} fps={project.meta.fps} />
            {scene.captions?.enabled && scene.captions.srt && (
              <CaptionsOverlay srt={scene.captions.srt} scale={s} />
            )}
          </Sequence>
        );
      })}
    </div>
  );
}

// ─── SceneAudio ──────────────────────────────────────────────────────────────

function SceneAudio({
  scene,
  ttsVolume,
  fps,
}: {
  scene: Scene;
  ttsVolume: number;
  fps: number;
}): React.JSX.Element {
  // Segment-based audio: play each segment WAV sequentially
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
              <Audio src={toPlayableSrc(seg.audioPath)} volume={ttsVolume} />
            </Sequence>
          );
        })}
      </>
    );
  }

  // Legacy: single narrationAudio file
  if (scene.narrationAudio) {
    return <Audio src={toPlayableSrc(scene.narrationAudio)} volume={ttsVolume} />;
  }

  return <></>;
}

// ─── SceneRenderer (internal) ─────────────────────────────────────────────────

function SceneRenderer({ scene, scale: s }: { scene: Scene; scale: number }): React.JSX.Element {
  const frame = useCurrentFrame();
  const { transition, elements } = scene;
  const transitionFrames = transition?.durationInFrames ?? 30;
  const transitionType = transition?.type ?? "none";

  let opacity = 1;
  let transform = "none";

  switch (transitionType) {
    case "fade": {
      const raw = interpolate(frame, [0, transitionFrames], [0, 1], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
      });
      opacity = inOutCubic(raw);
      // Subtle scale for depth
      const scaleVal = interpolate(frame, [0, transitionFrames], [0.95, 1], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
      });
      transform = `scale(${scaleVal})`;
      break;
    }
    case "slide-left": {
      const raw = interpolate(frame, [0, transitionFrames], [0, 1], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
      });
      const tx = (1 - inOutCubic(raw)) * 100;
      opacity = inOutCubic(raw);
      transform = `translateX(${tx}%)`;
      break;
    }
    case "slide-right": {
      const raw = interpolate(frame, [0, transitionFrames], [0, 1], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
      });
      const tx = -(1 - inOutCubic(raw)) * 100;
      opacity = inOutCubic(raw);
      transform = `translateX(${tx}%)`;
      break;
    }
    case "slide-up": {
      const raw = interpolate(frame, [0, transitionFrames], [0, 1], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
      });
      const ty = (1 - inOutCubic(raw)) * 100;
      opacity = inOutCubic(raw);
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
        padding: `${scaled(BASE.paddingV, s)}px ${scaled(BASE.paddingH, s)}px`,
        fontFamily: '"Noto Sans JP", sans-serif',
        boxSizing: "border-box",
        display: "flex",
        flexDirection: "column",
        gap: `${scaled(BASE.gap, s)}px`,
        opacity,
        transform,
        overflow: "hidden",
        position: "absolute",
        inset: 0,
      }}
    >
      {elements.map((element, i) => (
        <ElementRenderer key={i} element={element} index={i} scale={s} />
      ))}
    </div>
  );
}

// ─── Subtle float motion helper ──────────────────────────────────────────────

function useSubtleFloat(frame: number, delay: number): number {
  const elapsed = Math.max(0, frame - delay - ANIM.fadeInDuration);
  if (elapsed <= 0) return 0;
  return Math.sin((elapsed / ANIM.floatPeriodFrames) * Math.PI * 2) * ANIM.floatAmplitude;
}

// ─── ElementRenderer (internal) ──────────────────────────────────────────────

function ElementRenderer({
  element,
  index,
  scale: s,
}: {
  element: SceneElement;
  index: number;
  scale: number;
}): React.JSX.Element {
  const frame = useCurrentFrame();
  const delay = index * ANIM.staggerDelay;

  switch (element.type) {
    case "title": {
      const baseFontSize =
        element.level === 1 ? BASE.fontH1 : element.level === 2 ? BASE.fontH2 : BASE.fontH3;

      const raw =
        element.animation === "none"
          ? 1
          : interpolate(frame, [delay, delay + ANIM.fadeInDuration], [0, 1], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
            });
      const opacity = element.animation === "none" ? 1 : outCubic(raw);

      const slideRaw =
        element.animation === "slide-in"
          ? interpolate(frame, [delay, delay + ANIM.fadeInDuration], [0, 1], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
            })
          : 1;
      const translateY =
        element.animation === "slide-in"
          ? (1 - outCubic(slideRaw)) * ANIM.slideDistance
          : 0;

      const floatY = useSubtleFloat(frame, delay);

      return (
        <div
          style={{
            fontSize: scaled(baseFontSize, s),
            fontWeight: "bold",
            lineHeight: BASE.lineHeightHeading,
            opacity,
            transform: `translateY(${translateY + floatY}px)`,
          }}
        >
          {element.text}
        </div>
      );
    }

    case "text": {
      const raw =
        element.animation === "none"
          ? 1
          : interpolate(frame, [delay, delay + ANIM.fadeInDuration], [0, 1], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
            });
      const opacity = element.animation === "none" ? 1 : outCubic(raw);
      const floatY = useSubtleFloat(frame, delay);

      return (
        <p
          style={{
            fontSize: scaled(BASE.fontText, s),
            lineHeight: BASE.lineHeightText,
            margin: 0,
            opacity,
            transform: `translateY(${floatY}px)`,
          }}
        >
          {element.content}
        </p>
      );
    }

    case "bullet-list": {
      return (
        <ul
          style={{
            fontSize: scaled(BASE.fontText, s),
            lineHeight: BASE.lineHeightText,
            paddingLeft: scaled(BASE.bulletMarginLeft, s),
            margin: 0,
          }}
        >
          {element.items.map((item, itemIndex) => {
            const itemDelay = delay + itemIndex * ANIM.bulletDelay;
            const raw =
              element.animation === "none"
                ? 1
                : interpolate(frame, [itemDelay, itemDelay + ANIM.fadeInDuration], [0, 1], {
                    extrapolateLeft: "clamp",
                    extrapolateRight: "clamp",
                  });
            const opacity = element.animation === "none" ? 1 : outCubic(raw);

            // Slide in from left for each bullet
            const slideRaw =
              element.animation === "none"
                ? 1
                : interpolate(frame, [itemDelay, itemDelay + ANIM.fadeInDuration], [0, 1], {
                    extrapolateLeft: "clamp",
                    extrapolateRight: "clamp",
                  });
            const translateX =
              element.animation === "none"
                ? 0
                : -(1 - outCubic(slideRaw)) * scaled(ANIM.slideDistance, s);

            return (
              <li
                key={itemIndex}
                style={{
                  opacity,
                  marginBottom: scaled(8, s),
                  transform: `translateX(${translateX}px)`,
                }}
              >
                {item}
              </li>
            );
          })}
        </ul>
      );
    }

    case "image": {
      const raw =
        element.animation === "none"
          ? 1
          : interpolate(frame, [delay, delay + ANIM.fadeInDuration], [0, 1], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
            });
      const opacity = element.animation === "none" ? 1 : outCubic(raw);

      // Ken Burns: slow zoom + pan over the entire scene duration
      const { durationInFrames } = useVideoConfig();
      const kenProgress = interpolate(frame, [0, durationInFrames], [0, 1], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
      });

      let imgScale = 1;
      let imgTranslateX = 0;

      if (element.animation === "zoom-in") {
        const zoomRaw = interpolate(frame, [delay, delay + ANIM.fadeInDuration], [0, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        });
        imgScale = 0.85 + outCubic(zoomRaw) * 0.15;
      } else if (element.animation === "ken-burns" || element.animation === "fade-in") {
        // Enhanced Ken Burns for all image animations (except none/zoom-in)
        imgScale = 1 + kenProgress * (ANIM.kenBurnsScale - 1);
        imgTranslateX = kenProgress * ANIM.kenBurnsPanX - ANIM.kenBurnsPanX / 2;
      }

      return (
        <img
          src={element.src}
          alt={element.alt ?? ""}
          style={{
            maxWidth: "80%",
            maxHeight: scaled(400, s),
            borderRadius: scaled(8, s),
            opacity,
            transform: `scale(${imgScale}) translateX(${imgTranslateX}px)`,
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
            fontSize: scaled(BASE.fontTable, s),
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
                    padding: `${scaled(10, s)}px ${scaled(16, s)}px`,
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
              const rowDelay = delay + rowIndex * ANIM.tableRowDelay;
              const raw =
                element.animation === "none"
                  ? 1
                  : interpolate(frame, [rowDelay, rowDelay + ANIM.tableRowDuration], [0, 1], {
                      extrapolateLeft: "clamp",
                      extrapolateRight: "clamp",
                    });
              const opacity = element.animation === "none" ? 1 : outCubic(raw);

              return (
                <tr key={rowIndex} style={{ opacity }}>
                  {row.map((cell, ci) => (
                    <td
                      key={ci}
                      style={{
                        padding: `${scaled(8, s)}px ${scaled(16, s)}px`,
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
      const raw =
        element.animation === "none"
          ? 1
          : interpolate(frame, [delay, delay + ANIM.fadeInDuration], [0, 1], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
            });
      const opacity = element.animation === "none" ? 1 : outCubic(raw);

      return (
        <pre
          style={{
            backgroundColor: "#0d1117",
            padding: `${scaled(20, s)}px ${scaled(24, s)}px`,
            borderRadius: scaled(8, s),
            overflow: "auto",
            opacity,
            margin: 0,
          }}
        >
          <code
            style={{
              fontFamily: '"Fira Code", "Cascadia Code", monospace',
              fontSize: scaled(BASE.fontCode, s),
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

function CaptionsOverlay({ srt, scale: s }: { srt: string; scale: number }): React.JSX.Element | null {
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
        bottom: scaled(48, s),
        left: "10%",
        width: "80%",
        backgroundColor: "rgba(0, 0, 0, 0.7)",
        color: "#ffffff",
        textAlign: "center",
        padding: `${scaled(12, s)}px ${scaled(20, s)}px`,
        borderRadius: scaled(6, s),
        fontSize: scaled(BASE.fontCaption, s),
        fontFamily: '"Noto Sans JP", sans-serif',
        lineHeight: BASE.lineHeightCaption,
        pointerEvents: "none",
      }}
    >
      {activeSubtitle.text}
    </div>
  );
}
