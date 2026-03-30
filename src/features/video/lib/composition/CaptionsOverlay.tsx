import React from "react";
import { useCurrentFrame, useVideoConfig, parseSrt } from "@open-motion/core";
import { BASE, scaled } from "./constants";

export function CaptionsOverlay({
  srt,
  scale: s,
}: {
  srt: string;
  scale: number;
}) {
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
        zIndex: 30,
      }}
    >
      {activeSubtitle.text}
    </div>
  );
}
