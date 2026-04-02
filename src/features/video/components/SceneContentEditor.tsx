import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useVideoStore } from "@/stores/video-store";
import type { Scene, SceneElement, TitleElement, TextElement, BulletListElement, CodeBlockElement, TableElement } from "@/features/video/types";

interface SceneContentEditorProps {
  scene: Scene;
}

export function SceneContentEditor({ scene }: SceneContentEditorProps) {
  const { t } = useTranslation("video");
  const updateElement = useVideoStore((s) => s.updateElement);
  const addElement = useVideoStore((s) => s.addElement);
  const removeElement = useVideoStore((s) => s.removeElement);

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

  const handleRemove = useCallback(
    (elementIndex: number) => {
      removeElement(scene.id, elementIndex);
    },
    [scene.id, removeElement]
  );

  return (
    <div className="scene-content-editor">
      <div className="scene-content-editor__header">
        <label className="scene-content-editor__title">{t("contents")} ({textElements.length})</label>
        <AddElementMenu sceneId={scene.id} onAdd={addElement} />
      </div>
      {textElements.map(({ el, i }) => (
        <ContentElementEditor
          key={i}
          sceneId={scene.id}
          element={el}
          elementIndex={i}
          onUpdate={updateElement}
          onRemove={handleRemove}
        />
      ))}
    </div>
  );
}

function AddElementMenu({
  sceneId,
  onAdd,
}: {
  sceneId: string;
  onAdd: (sceneId: string, element: SceneElement) => void;
}) {
  const { t } = useTranslation("video");
  const [open, setOpen] = useState(false);
  const [showListSub, setShowListSub] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const handleAdd = useCallback(
    (element: SceneElement) => {
      onAdd(sceneId, element);
      setOpen(false);
      setShowListSub(false);
    },
    [sceneId, onAdd]
  );

  const handleBlur = useCallback((e: React.FocusEvent) => {
    if (menuRef.current && !menuRef.current.contains(e.relatedTarget as Node)) {
      setOpen(false);
      setShowListSub(false);
    }
  }, []);

  return (
    <div className="scene-content-editor__add-wrap" ref={menuRef} onBlur={handleBlur}>
      <button
        className="scene-content-editor__add-btn"
        onClick={() => setOpen((v) => !v)}
        title={t("addElement")}
      >
        +
      </button>
      {open && (
        <div className="scene-content-editor__add-menu">
          <button
            className="scene-content-editor__add-menu-item"
            onClick={() =>
              handleAdd({ type: "title", text: "", level: 1, animation: "fade-in" })
            }
          >
            H1
          </button>
          <button
            className="scene-content-editor__add-menu-item"
            onClick={() =>
              handleAdd({ type: "text", content: "", animation: "fade-in" })
            }
          >
            Text
          </button>
          <div
            className="scene-content-editor__add-menu-item scene-content-editor__add-menu-item--sub"
            onMouseEnter={() => setShowListSub(true)}
            onMouseLeave={() => setShowListSub(false)}
          >
            <span>List</span>
            <span style={{ fontSize: 10, marginLeft: "auto" }}>▶</span>
            {showListSub && (
              <div className="scene-content-editor__add-submenu">
                {[2, 3, 4, 5, 6].map((n) => (
                  <button
                    key={n}
                    className="scene-content-editor__add-menu-item"
                    onClick={() =>
                      handleAdd({
                        type: "bullet-list",
                        items: Array.from({ length: n }, () => ""),
                        animation: "sequential",
                        delayPerItem: 5,
                      })
                    }
                  >
                    {t("addListItems", { count: n })}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ContentElementEditor({
  sceneId,
  element,
  elementIndex,
  onUpdate,
  onRemove,
}: {
  sceneId: string;
  element: SceneElement;
  elementIndex: number;
  onUpdate: (sceneId: string, elementIndex: number, updates: Partial<SceneElement>) => void;
  onRemove: (elementIndex: number) => void;
}) {
  const handleChange = useCallback(
    (updates: Partial<SceneElement>) => {
      onUpdate(sceneId, elementIndex, updates);
    },
    [sceneId, elementIndex, onUpdate]
  );

  const handleRemove = useCallback(() => {
    onRemove(elementIndex);
  }, [elementIndex, onRemove]);

  switch (element.type) {
    case "title":
      return <TitleEditor element={element} onChange={handleChange} onRemove={handleRemove} />;
    case "text":
      return <TextEditor element={element} onChange={handleChange} onRemove={handleRemove} />;
    case "bullet-list":
      return <BulletListEditor element={element} onChange={handleChange} onRemove={handleRemove} />;
    case "code-block":
      return <CodeBlockEditor element={element} onChange={handleChange} onRemove={handleRemove} />;
    case "table":
      return <TableEditor element={element} onChange={handleChange} onRemove={handleRemove} />;
    default:
      return null;
  }
}

function TitleEditor({
  element,
  onChange,
  onRemove,
}: {
  element: TitleElement;
  onChange: (u: Partial<TitleElement>) => void;
  onRemove: () => void;
}) {
  return (
    <div className="scene-content-editor__item">
      <div className="scene-content-editor__item-header">
        <span className="scene-content-editor__type-badge">H{element.level}</span>
        <input
          type="color"
          className="scene-content-editor__color-picker"
          value={element.color ?? "#ffffff"}
          onChange={(e) => onChange({ color: e.target.value })}
        />
        <span style={{ flex: 1 }} />
        <button className="scene-content-editor__delete-btn" onClick={onRemove}>🗑</button>
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
  onRemove,
}: {
  element: TextElement;
  onChange: (u: Partial<TextElement>) => void;
  onRemove: () => void;
}) {
  return (
    <div className="scene-content-editor__item">
      <div className="scene-content-editor__item-header">
        <span className="scene-content-editor__type-badge">Text</span>
        <input
          type="color"
          className="scene-content-editor__color-picker"
          value={element.color ?? "#ffffff"}
          onChange={(e) => onChange({ color: e.target.value })}
        />
        <span style={{ flex: 1 }} />
        <button className="scene-content-editor__delete-btn" onClick={onRemove}>🗑</button>
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
  onRemove,
}: {
  element: BulletListElement;
  onChange: (u: Partial<BulletListElement>) => void;
  onRemove: () => void;
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
        <input
          type="color"
          className="scene-content-editor__color-picker"
          value={element.color ?? "#ffffff"}
          onChange={(e) => onChange({ color: e.target.value })}
        />
        <span style={{ flex: 1 }} />
        <button className="scene-content-editor__delete-btn" onClick={onRemove}>🗑</button>
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
  onRemove,
}: {
  element: CodeBlockElement;
  onChange: (u: Partial<CodeBlockElement>) => void;
  onRemove: () => void;
}) {
  return (
    <div className="scene-content-editor__item">
      <div className="scene-content-editor__item-header">
        <span className="scene-content-editor__type-badge">Code</span>
        <span className="scene-content-editor__lang">{element.language}</span>
        <span style={{ flex: 1 }} />
        <button className="scene-content-editor__delete-btn" onClick={onRemove}>🗑</button>
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
  onRemove,
}: {
  element: TableElement;
  onChange: (u: Partial<TableElement>) => void;
  onRemove: () => void;
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
        <span style={{ flex: 1 }} />
        <button className="scene-content-editor__delete-btn" onClick={onRemove}>🗑</button>
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
