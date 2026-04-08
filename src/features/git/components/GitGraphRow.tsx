import { useMemo } from "react";
import type { GraphCommit } from "@/features/git/lib/graph-lanes";

const LANE_WIDTH = 16;
const ROW_HEIGHT = 24;
const NODE_RADIUS = 4;
const GRAPH_COLORS = [
  "var(--graph-color-0, #f97583)",
  "var(--graph-color-1, #79b8ff)",
  "var(--graph-color-2, #85e89d)",
  "var(--graph-color-3, #ffab70)",
  "var(--graph-color-4, #b392f0)",
  "var(--graph-color-5, #f692ce)",
];

function laneColor(index: number): string {
  return GRAPH_COLORS[index % GRAPH_COLORS.length];
}

function laneX(lane: number): number {
  return lane * LANE_WIDTH + LANE_WIDTH / 2;
}

interface GitGraphRowProps {
  commit: GraphCommit;
  maxLanes: number;
  onClick: () => void;
  expanded: boolean;
  isFirst?: boolean;
}

export function GitGraphRow({ commit, maxLanes, onClick, expanded, isFirst }: GitGraphRowProps) {
  const svgWidth = Math.max(maxLanes * LANE_WIDTH, LANE_WIDTH);
  const cy = ROW_HEIGHT / 2;

  const relativeDate = useMemo(() => {
    const now = Date.now();
    const then = new Date(commit.date).getTime();
    const diffSec = Math.floor((now - then) / 1000);
    if (diffSec < 60) return `${diffSec}s`;
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin}m`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h`;
    const diffDay = Math.floor(diffHr / 24);
    if (diffDay < 30) return `${diffDay}d`;
    const diffMon = Math.floor(diffDay / 30);
    if (diffMon < 12) return `${diffMon}mo`;
    return `${Math.floor(diffDay / 365)}y`;
  }, [commit.date]);

  return (
    <div
      className={`git-graph-row ${expanded ? "git-graph-row--expanded" : ""}`}
      onClick={onClick}
    >
      <svg
        className="git-graph-row__svg"
        width={svgWidth}
        height={ROW_HEIGHT}
        viewBox={`0 0 ${svgWidth} ${ROW_HEIGHT}`}
      >
        {commit.lines.map((line, i) => {
          const x1 = laneX(line.fromLane);
          const x2 = laneX(line.toLane);
          const color = laneColor(line.colorIndex);

          if (line.type === "straight") {
            return (
              <line
                key={i}
                x1={x1}
                y1={isFirst ? cy : 0}
                x2={x2}
                y2={ROW_HEIGHT}
                stroke={color}
                strokeWidth={2}
              />
            );
          }
          // merge-in or branch-out: bezier curve
          return (
            <path
              key={i}
              d={`M ${x1} ${cy} C ${x1} ${ROW_HEIGHT}, ${x2} ${cy}, ${x2} ${ROW_HEIGHT}`}
              stroke={color}
              strokeWidth={2}
              fill="none"
            />
          );
        })}
        {/* Commit node */}
        <circle
          cx={laneX(commit.lane)}
          cy={cy}
          r={NODE_RADIUS}
          fill={laneColor(commit.lines.find((l) => l.fromLane === commit.lane)?.colorIndex ?? 0)}
          stroke="var(--bg-surface, #1e1e1e)"
          strokeWidth={2}
        />
      </svg>
      <div className="git-graph-row__info">
        <span className="git-graph-row__message">{commit.message}</span>
        {commit.refs.map((ref) => {
          let badgeClass = "git-graph-row__ref";
          if (ref.includes("HEAD")) badgeClass += " git-graph-row__ref--head";
          else if (ref.includes("origin/")) badgeClass += " git-graph-row__ref--remote";
          else if (ref.startsWith("tag:")) badgeClass += " git-graph-row__ref--tag";
          return (
            <span key={ref} className={badgeClass}>
              {ref.replace("HEAD -> ", "")}
            </span>
          );
        })}
        <span className="git-graph-row__author">{commit.author}</span>
        <span className="git-graph-row__date">{relativeDate}</span>
      </div>
    </div>
  );
}
