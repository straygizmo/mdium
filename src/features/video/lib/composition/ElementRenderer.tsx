import type { SceneElement } from "../../types";
import { TitleElement } from "./elements/TitleElement";
import { TextElement } from "./elements/TextElement";
import { BulletListElement } from "./elements/BulletListElement";
import { ImageElement } from "./elements/ImageElement";
import { TableElement } from "./elements/TableElement";
import { CodeBlockElement } from "./elements/CodeBlockElement";
import { ProgressBarElement } from "./elements/ProgressBarElement";

export function ElementRenderer({
  element,
  index,
  scale,
}: {
  element: SceneElement;
  index: number;
  scale: number;
}) {
  switch (element.type) {
    case "title":
      return <TitleElement element={element} index={index} scale={scale} />;
    case "text":
      return <TextElement element={element} index={index} scale={scale} />;
    case "bullet-list":
      return <BulletListElement element={element} index={index} scale={scale} />;
    case "image":
      if (element.enabled === false) return null;
      return <ImageElement element={element} index={index} scale={scale} />;
    case "table":
      return <TableElement element={element} index={index} scale={scale} />;
    case "code-block":
      return <CodeBlockElement element={element} index={index} scale={scale} />;
    case "progress-bar":
      return <ProgressBarElement element={element} index={index} scale={scale} />;
    default:
      return <></>;
  }
}
