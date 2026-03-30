import React from "react";
import { Transition } from "@open-motion/components";
import { BASE, scaled } from "../constants";

export function TextElement({
  element,
  index,
  scale: s,
}: {
  element: { content: string; animation: string };
  index: number;
  scale: number;
}) {
  const style: React.CSSProperties = {
    fontSize: scaled(BASE.fontText, s),
    lineHeight: BASE.lineHeightText,
    margin: 0,
  };

  if (element.animation === "none") {
    return <p style={style}>{element.content}</p>;
  }

  return (
    <Transition type="fade" style={style}>
      <p style={{ margin: 0 }}>{element.content}</p>
    </Transition>
  );
}
