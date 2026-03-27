import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { makeHeadingId } from "@/shared/lib/markdown/heading-id";
import "./OutlinePanel.css";

interface OutlinePanelProps {
  content: string;
  previewRef: React.RefObject<HTMLDivElement | null>;
}

interface HeadingItem {
  depth: number;
  text: string;
  id: string;
}

export function OutlinePanel({ content, previewRef }: OutlinePanelProps) {
  const { t } = useTranslation("toolbar");

  const headings = useMemo<HeadingItem[]>(() => {
    const items: HeadingItem[] = [];
    const lines = content.split("\n");
    let inFrontMatter = false;

    for (const line of lines) {
      if (line.trim() === "---") {
        inFrontMatter = !inFrontMatter;
        continue;
      }
      if (inFrontMatter) continue;

      const match = line.match(/^(#{1,4})\s+(.+)/);
      if (match) {
        const text = match[2].trim();
        items.push({
          depth: match[1].length,
          text,
          id: makeHeadingId(text),
        });
      }
    }
    return items;
  }, [content]);

  const handleClick = (id: string) => {
    const el = previewRef.current?.querySelector(`#${id}`);
    el?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  if (headings.length === 0) {
    return (
      <div className="outline-panel__empty">
        {t("outline")}
      </div>
    );
  }

  return (
    <div className="outline-panel">
      {headings.map((h, i) => (
        <div
          key={i}
          className="outline-panel__item"
          style={{ paddingLeft: `${(h.depth - 1) * 16 + 8}px` }}
          onClick={() => handleClick(h.id)}
        >
          {h.text}
        </div>
      ))}
    </div>
  );
}
