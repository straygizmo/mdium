import { useCallback } from "react";

/**
 * Vertical splitter drag hook.
 * `ratio` represents the percentage of the container height occupied by the TOP panel.
 * Dragging down increases the ratio (top panel grows, bottom shrinks).
 */
export function useDividerDragVertical(
  containerRef: React.RefObject<HTMLDivElement | null>,
  ratio: number,
  setRatio: (ratio: number) => void,
  min = 20,
  max = 85
) {
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const container = containerRef.current;
      if (!container) return;
      const startY = e.clientY;
      const containerRect = container.getBoundingClientRect();
      const startRatio = ratio;

      const handleMouseMove = (ev: MouseEvent) => {
        const deltaY = ev.clientY - startY;
        const newRatio = startRatio + (deltaY / containerRect.height) * 100;
        setRatio(Math.max(min, Math.min(max, newRatio)));
      };

      const handleMouseUp = () => {
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseup", handleMouseUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };

      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "row-resize";
      document.body.style.userSelect = "none";
    },
    [ratio, containerRef, setRatio, min, max]
  );

  return handleMouseDown;
}
