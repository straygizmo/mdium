import type { RawCommit } from "./parse-log";

export interface GraphLine {
  fromLane: number;
  toLane: number;
  type: "straight" | "merge-in" | "branch-out";
  colorIndex: number;
}

export interface GraphCommit extends RawCommit {
  lane: number;
  lines: GraphLine[];
}

const NUM_COLORS = 6;

/**
 * Compute graph lane positions and connection lines for a list of commits.
 * Commits must be in topological order (as returned by git log --topo-order).
 */
export function computeGraphLanes(rawCommits: RawCommit[]): GraphCommit[] {
  // activeLanes[i] = hash that is expected to appear in lane i
  const activeLanes: (string | null)[] = [];
  // Track color per lane
  const laneColors: number[] = [];
  let nextColor = 0;

  const result: GraphCommit[] = [];

  for (const raw of rawCommits) {
    const lines: GraphLine[] = [];

    // Find which lane this commit occupies. Prefer the lowest lane holding
    // this hash so parent-chain lanes consume first.
    let commitLane = activeLanes.indexOf(raw.hash);
    let commitColor: number;

    if (commitLane === -1) {
      // New branch — assign next free lane
      commitLane = activeLanes.indexOf(null);
      if (commitLane === -1) {
        commitLane = activeLanes.length;
        activeLanes.push(null);
        laneColors.push(nextColor);
        nextColor = (nextColor + 1) % NUM_COLORS;
      }
      activeLanes[commitLane] = raw.hash;
    }
    commitColor = laneColors[commitLane];

    // Collapse duplicate lanes: if the same hash is expected on multiple
    // lanes (e.g. a prior merge reserved a lane for a parent that is also
    // reachable via the first-parent chain), fold them into commitLane
    // so they don't continue drawing zombie straight lines.
    for (let i = commitLane + 1; i < activeLanes.length; i++) {
      if (activeLanes[i] === raw.hash) {
        lines.push({
          fromLane: i,
          toLane: commitLane,
          type: "merge-in",
          colorIndex: laneColors[i],
        });
        activeLanes[i] = null;
      }
    }

    // All active lanes that pass through this row draw a straight line,
    // except the commit's own lane (handled by parent assignment below)
    for (let i = 0; i < activeLanes.length; i++) {
      if (i !== commitLane && activeLanes[i] !== null) {
        lines.push({
          fromLane: i,
          toLane: i,
          type: "straight",
          colorIndex: laneColors[i],
        });
      }
    }

    if (raw.parents.length === 0) {
      // Root commit — free the lane
      activeLanes[commitLane] = null;
    } else {
      // First parent takes this commit's lane
      const firstParent = raw.parents[0];
      activeLanes[commitLane] = firstParent;
      lines.push({
        fromLane: commitLane,
        toLane: commitLane,
        type: "straight",
        colorIndex: commitColor,
      });

      // Additional parents (merge commits) get their own lanes
      for (let p = 1; p < raw.parents.length; p++) {
        const parentHash = raw.parents[p];
        // Check if parent is already in an active lane
        let parentLane = activeLanes.indexOf(parentHash);
        if (parentLane === -1) {
          // Assign new lane for the merge parent
          parentLane = activeLanes.indexOf(null);
          if (parentLane === -1) {
            parentLane = activeLanes.length;
            activeLanes.push(parentHash);
            laneColors.push(nextColor);
          } else {
            activeLanes[parentLane] = parentHash;
            laneColors[parentLane] = nextColor;
          }
          nextColor = (nextColor + 1) % NUM_COLORS;
        }
        lines.push({
          fromLane: commitLane,
          toLane: parentLane,
          type: "merge-in",
          colorIndex: laneColors[parentLane],
        });
      }
    }

    // Compact: trim trailing nulls
    while (activeLanes.length > 0 && activeLanes[activeLanes.length - 1] === null) {
      activeLanes.pop();
      laneColors.pop();
    }

    result.push({
      ...raw,
      lane: commitLane,
      lines,
    });
  }

  return result;
}

/**
 * Get the maximum lane count across all commits (for SVG width calculation).
 */
export function getMaxLaneCount(commits: GraphCommit[]): number {
  let max = 0;
  for (const c of commits) {
    if (c.lane + 1 > max) max = c.lane + 1;
    for (const l of c.lines) {
      const lineLane = Math.max(l.fromLane, l.toLane) + 1;
      if (lineLane > max) max = lineLane;
    }
  }
  return max;
}
