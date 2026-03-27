import { memo, useState, useRef, useEffect, useCallback } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { MindmapNodeData } from "../lib/layout";

const PROGRESS_LABELS = ["", "0%", "13%", "25%", "38%", "50%", "63%", "75%", "88%", "100%"];

function MindmapNode({ id, data, selected }: NodeProps) {
  const d = data as unknown as MindmapNodeData & { isDropTarget?: boolean };
  const { label, depth, themeColors, priority, progress, hyperlink, note, image, imageSize, isDropTarget } = d;

  const style = depth === 0 ? themeColors.root : depth === 1 ? themeColors.main : themeColors.sub;
  const depthClass = `mm-d${Math.min(depth, 2)}`;

  const [noteHover, setNoteHover] = useState(false);
  const noteTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const handleNoteEnter = useCallback(() => {
    clearTimeout(noteTimerRef.current);
    noteTimerRef.current = setTimeout(() => setNoteHover(true), 300);
  }, []);

  const handleNoteLeave = useCallback(() => {
    clearTimeout(noteTimerRef.current);
    noteTimerRef.current = setTimeout(() => setNoteHover(false), 300);
  }, []);

  useEffect(() => () => clearTimeout(noteTimerRef.current), []);

  return (
    <div
      className={`mm-node ${depthClass} ${selected ? "mm-selected" : ""} ${isDropTarget ? "mm-drop-target" : ""}`}
      style={{ background: style.bg, color: style.color, borderColor: style.border }}
    >
      {/* Markers */}
      {priority !== undefined && priority > 0 && (
        <span className="mm-badge mm-priority" data-priority={priority}>
          P{priority}
        </span>
      )}
      {progress !== undefined && progress > 0 && (
        <span className="mm-badge mm-progress">{PROGRESS_LABELS[progress] || ""}</span>
      )}

      {/* Text */}
      <span className="mm-text">{label || "\u00A0"}</span>

      {/* Icons */}
      {hyperlink && (
        <span
          className="mm-icon mm-link-icon"
          title={hyperlink}
          onClick={(e) => {
            e.stopPropagation();
            window.open(hyperlink, "_blank", "noopener,noreferrer");
          }}
        >
          🔗
        </span>
      )}
      {note && (
        <span
          className="mm-icon mm-note-icon"
          onMouseEnter={handleNoteEnter}
          onMouseLeave={handleNoteLeave}
          onDoubleClick={(e) => {
            e.stopPropagation();
            window.dispatchEvent(new CustomEvent("mindmap-open-note", { detail: id }));
          }}
        >
          📝
          {noteHover && (
            <div
              className="km-note-tooltip"
              onMouseEnter={handleNoteEnter}
              onMouseLeave={handleNoteLeave}
            >
              {note}
            </div>
          )}
        </span>
      )}

      {/* Image */}
      {image && (
        <img
          className="mm-node-image"
          src={image}
          alt=""
          style={{
            width: imageSize?.width || 200,
            height: imageSize?.height || 200,
          }}
        />
      )}

      {/* Collapse indicator */}
      {d.hasChildren && d.expandState === "collapse" && <span className="mm-collapse-dot" />}

      {/* Handles - all sides for flexible layout */}
      {depth > 0 && <Handle type="target" position={Position.Left} id="target-left" />}
      {depth > 0 && <Handle type="target" position={Position.Right} id="target-right" />}
      {depth > 0 && <Handle type="target" position={Position.Top} id="target-top" />}
      <Handle type="source" position={Position.Right} id="source-right" />
      <Handle type="source" position={Position.Left} id="source-left" />
      <Handle type="source" position={Position.Bottom} id="source-bottom" />
    </div>
  );
}

export default memo(MindmapNode);
