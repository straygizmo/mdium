import React from "react";
import { useCurrentFrame, interpolate } from "@open-motion/core";
import { Transition, SlideInItem, Typewriter } from "@open-motion/components";
import { BASE, ANIM, scaled } from "../constants";

export function TitleElement({
  element,
  index,
  scale: s,
}: {
  element: { text: string; level: 1 | 2 | 3; animation: string };
  index: number;
  scale: number;
}) {
  const baseFontSize =
    element.level === 1 ? BASE.fontH1 : element.level === 2 ? BASE.fontH2 : BASE.fontH3;
  const delay = index * ANIM.staggerDelay;

  const baseStyle: React.CSSProperties = {
    fontSize: scaled(baseFontSize, s),
    fontWeight: "bold",
    lineHeight: BASE.lineHeightHeading,
  };

  if (element.animation === "none") {
    return <div style={baseStyle}>{element.text}</div>;
  }

  if (element.animation === "typewriter") {
    return (
      <div style={baseStyle}>
        <Typewriter text={element.text} speed={2} delay={delay} />
      </div>
    );
  }

  if (element.animation === "slide-in") {
    return (
      <SlideInItem index={0} delay={delay} stagger={0} distance={ANIM.slideDistance} style={baseStyle}>
        {element.text}
      </SlideInItem>
    );
  }

  // Default: fade-in
  return (
    <Transition type="fade" style={baseStyle}>
      {element.text}
    </Transition>
  );
}
