import type React from "react";
import { Transition } from "@open-motion/components";
import { BASE, scaled } from "../constants";

export function CodeBlockElement({
  element,
  index: _index,
  scale: s,
}: {
  element: { code: string; language: string; animation: string };
  index: number;
  scale: number;
}) {
  const codeStyle: React.CSSProperties = {
    fontFamily: '"Fira Code", "Cascadia Code", monospace',
    fontSize: scaled(BASE.fontCode, s),
    color: "#e6edf3",
    whiteSpace: "pre",
  };

  const preStyle: React.CSSProperties = {
    backgroundColor: "#0d1117",
    padding: `${scaled(20, s)}px ${scaled(24, s)}px`,
    borderRadius: scaled(8, s),
    overflow: "auto",
    margin: 0,
  };

  if (element.animation === "none") {
    return (
      <pre style={preStyle}>
        <code style={codeStyle}>{element.code}</code>
      </pre>
    );
  }

  return (
    <Transition type="fade">
      <pre style={preStyle}>
        <code style={codeStyle}>{element.code}</code>
      </pre>
    </Transition>
  );
}
