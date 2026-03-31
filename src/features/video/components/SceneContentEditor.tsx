import { useCallback } from "react";
import { useVideoStore } from "@/stores/video-store";
import type { Scene, SceneElement, TitleElement, TextElement, BulletListElement, CodeBlockElement, TableElement } from "@/features/video/types";

interface SceneContentEditorProps {
  scene: Scene;
}

export function SceneContentEditor({ scene }: SceneContentEditorProps) {
  const updateElement = useVideoStore((s) => s.updateElement);

  const textElements = scene.elements
    .map((el, i) => ({ el, i }))
    .filter(
      (item): item is { el: TitleElement | TextElement | BulletListElement | CodeBlockElement | TableElement; i: number } =>
        item.el.type === "title" ||
        item.el.type === "text" ||
        item.el.type === "bullet-list" ||
        item.el.type === "code-block" ||
        item.el.type === "table"
    );

  if (textElements.length === 0) return null;

  return (
    <div className="scene-content-editor">
      <label className="scene-content-editor__title">コンテンツ ({textElements.length})</label>
      {textElements.map(({ el, i }) => (
        <ContentElementEditor
          key={i}
          sceneId={scene.id}
          element={el}
          elementIndex={i}
          onUpdate={updateElement}
        />
      ))}
    </div>
  );
}

function ContentElementEditor({
  sceneId,
  element,
  elementIndex,
  onUpdate,
}: {
  sceneId: string;
  element: SceneElement;
  elementIndex: number;
  onUpdate: (sceneId: string, elementIndex: number, updates: Partial<SceneElement>) => void;
}) {
  const handleChange = useCallback(
    (updates: Partial<SceneElement>) => {
      onUpdate(sceneId, elementIndex, updates);
    },
    [sceneId, elementIndex, onUpdate]
  );

  switch (element.type) {
    case "title":
      return <TitleEditor element={element} onChange={handleChange} />;
    case "text":
      return <TextEditor element={element} onChange={handleChange} />;
    case "bullet-list":
      return <BulletListEditor element={element} onChange={handleChange} />;
    case "code-block":
      return <CodeBlockEditor element={element} onChange={handleChange} />;
    case "table":
      return <TableEditor element={element} onChange={handleChange} />;
    default:
      return null;
  }
}

function TitleEditor({
  element,
  onChange,
}: {
  element: TitleElement;
  onChange: (u: Partial<TitleElement>) => void;
}) {
  return (
    <div className="scene-content-editor__item">
      <div className="scene-content-editor__item-header">
        <span className="scene-content-editor__type-badge">H{element.level}</span>
      </div>
      <input
        type="text"
        className="scene-content-editor__input"
        value={element.text}
        onChange={(e) => onChange({ text: e.target.value })}
      />
    </div>
  );
}

function TextEditor({
  element,
  onChange,
}: {
  element: TextElement;
  onChange: (u: Partial<TextElement>) => void;
}) {
  return (
    <div className="scene-content-editor__item">
      <div className="scene-content-editor__item-header">
        <span className="scene-content-editor__type-badge">Text</span>
      </div>
      <textarea
        className="scene-content-editor__textarea"
        value={element.content}
        onChange={(e) => onChange({ content: e.target.value })}
        rows={2}
      />
    </div>
  );
}

function BulletListEditor({
  element,
  onChange,
}: {
  element: BulletListElement;
  onChange: (u: Partial<BulletListElement>) => void;
}) {
  const handleItemChange = useCallback(
    (index: number, value: string) => {
      const newItems = [...element.items];
      newItems[index] = value;
      onChange({ items: newItems });
    },
    [element.items, onChange]
  );

  return (
    <div className="scene-content-editor__item">
      <div className="scene-content-editor__item-header">
        <span className="scene-content-editor__type-badge">List</span>
      </div>
      <div className="scene-content-editor__bullet-list">
        {element.items.map((item, idx) => (
          <div key={idx} className="scene-content-editor__bullet-row">
            <span className="scene-content-editor__bullet-marker">-</span>
            <input
              type="text"
              className="scene-content-editor__input"
              value={item}
              onChange={(e) => handleItemChange(idx, e.target.value)}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

function CodeBlockEditor({
  element,
  onChange,
}: {
  element: CodeBlockElement;
  onChange: (u: Partial<CodeBlockElement>) => void;
}) {
  return (
    <div className="scene-content-editor__item">
      <div className="scene-content-editor__item-header">
        <span className="scene-content-editor__type-badge">Code</span>
        <span className="scene-content-editor__lang">{element.language}</span>
      </div>
      <textarea
        className="scene-content-editor__textarea scene-content-editor__textarea--code"
        value={element.code}
        onChange={(e) => onChange({ code: e.target.value })}
        rows={3}
      />
    </div>
  );
}

function TableEditor({
  element,
  onChange,
}: {
  element: TableElement;
  onChange: (u: Partial<TableElement>) => void;
}) {
  const handleHeaderChange = useCallback(
    (index: number, value: string) => {
      const newHeaders = [...element.headers];
      newHeaders[index] = value;
      onChange({ headers: newHeaders });
    },
    [element.headers, onChange]
  );

  const handleCellChange = useCallback(
    (rowIndex: number, colIndex: number, value: string) => {
      const newRows = element.rows.map((row) => [...row]);
      newRows[rowIndex][colIndex] = value;
      onChange({ rows: newRows });
    },
    [element.rows, onChange]
  );

  return (
    <div className="scene-content-editor__item">
      <div className="scene-content-editor__item-header">
        <span className="scene-content-editor__type-badge">Table</span>
      </div>
      <div className="scene-content-editor__table-wrap">
        <table className="scene-content-editor__table">
          <thead>
            <tr>
              {element.headers.map((h, i) => (
                <th key={i}>
                  <input
                    type="text"
                    className="scene-content-editor__table-input"
                    value={h}
                    onChange={(e) => handleHeaderChange(i, e.target.value)}
                  />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {element.rows.map((row, ri) => (
              <tr key={ri}>
                {row.map((cell, ci) => (
                  <td key={ci}>
                    <input
                      type="text"
                      className="scene-content-editor__table-input"
                      value={cell}
                      onChange={(e) => handleCellChange(ri, ci, e.target.value)}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
