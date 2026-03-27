import { useCallback } from "react";

export function useDividerDrag(
  containerRef: React.RefObject<HTMLDivElement | null>,
  ratio: number,
  setRatio: (ratio: number) => void,
  min = 15,
  max = 85
) {
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const container = containerRef.current;
      if (!container) return;
      const startX = e.clientX;
      const containerRect = container.getBoundingClientRect();
      const startRatio = ratio;

      const handleMouseMove = (ev: MouseEvent) => {
        const deltaX = ev.clientX - startX;
        const newRatio = startRatio + (deltaX / containerRect.width) * 100;
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
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [ratio, containerRef, setRatio, min, max]
  );

  return handleMouseDown;
}
