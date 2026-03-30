import React from "react";
import { SlideInItem } from "@open-motion/components";
import { BASE, ANIM, scaled } from "../constants";

export function BulletListElement({
  element,
  index,
  scale: s,
}: {
  element: { items: string[]; animation: string; delayPerItem: number };
  index: number;
  scale: number;
}) {
  const delay = index * ANIM.staggerDelay;

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
        if (element.animation === "none") {
          return (
            <li key={itemIndex} style={{ marginBottom: scaled(8, s) }}>
              {item}
            </li>
          );
        }

        return (
          <SlideInItem
            key={itemIndex}
            index={itemIndex}
            delay={delay}
            stagger={element.delayPerItem}
            distance={scaled(ANIM.slideDistance, s)}
            style={{ marginBottom: scaled(8, s), listStyle: "disc" }}
          >
            {item}
          </SlideInItem>
        );
      })}
    </ul>
  );
}
