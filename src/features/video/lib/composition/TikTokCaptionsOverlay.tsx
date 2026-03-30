import React from "react";
import { parseSrt } from "@open-motion/core";
import { Captions, TikTokCaption } from "@open-motion/components";
import { scaled } from "./constants";

export function TikTokCaptionsOverlay({
  srt,
  scale: s,
}: {
  srt: string;
  scale: number;
}) {
  const subtitles = React.useMemo(() => parseSrt(srt), [srt]);

  return (
    <div
      style={{
        position: "absolute",
        bottom: scaled(48, s),
        left: "10%",
        width: "80%",
        pointerEvents: "none",
        zIndex: 30,
        display: "flex",
        justifyContent: "center",
      }}
    >
      <Captions
        subtitles={subtitles}
        renderCaption={(text, active) => (
          <TikTokCaption
            text={text}
            active={active}
            style={{ fontSize: scaled(60, s) }}
          />
        )}
      />
    </div>
  );
}
