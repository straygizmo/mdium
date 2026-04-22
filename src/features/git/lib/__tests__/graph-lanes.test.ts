// @vitest-environment node
import { describe, it, expect } from "vitest";
import { computeGraphLanes } from "../graph-lanes";
import type { RawCommit } from "../parse-log";

function commit(hash: string, parents: string[]): RawCommit {
  return {
    hash,
    shortHash: hash.slice(0, 7),
    author: "test",
    date: "2026-01-01T00:00:00Z",
    message: `commit ${hash}`,
    parents,
    refs: [],
  };
}

describe("computeGraphLanes", () => {
  it("places linear history on lane 0 with no extra lanes", () => {
    const commits = [
      commit("D", ["C"]),
      commit("C", ["B"]),
      commit("B", ["A"]),
      commit("A", []),
    ];
    const result = computeGraphLanes(commits);
    expect(result.map((c) => c.lane)).toEqual([0, 0, 0, 0]);
    // No commit should render any line above lane 0
    for (const c of result) {
      for (const l of c.lines) {
        expect(l.fromLane).toBe(0);
        expect(l.toLane).toBe(0);
      }
    }
  });

  it("closes the merge-parent lane when the second parent is also reachable via first-parent chain (PR-style merge)", () => {
    // Topology:
    //   M -- F -- E -- D -- C -- B (root)
    //   |_______________________|
    //   M's second parent is C (already reachable from F)
    const commits = [
      commit("M", ["F", "C"]),
      commit("F", ["E"]),
      commit("E", ["D"]),
      commit("D", ["C"]),
      commit("C", ["B"]),
      commit("B", []),
    ];
    const result = computeGraphLanes(commits);

    // M is on lane 0, second parent lane 1 is allocated
    expect(result[0].lane).toBe(0);

    // Once C is processed, only lane 0 should remain active going forward.
    // Specifically, B (last commit) should have NO extra straight lines
    // from a zombie lane 1.
    const b = result[result.length - 1];
    expect(b.lane).toBe(0);
    const straightOnOtherLane = b.lines.filter(
      (l) => l.type === "straight" && l.fromLane !== 0,
    );
    expect(straightOnOtherLane).toEqual([]);

    // Also: C itself should not leave a stranded lane — all rows after C
    // must have max lane index 0.
    const cIdx = result.findIndex((c) => c.hash === "C");
    for (let i = cIdx + 1; i < result.length; i++) {
      for (const l of result[i].lines) {
        expect(l.fromLane).toBe(0);
        expect(l.toLane).toBe(0);
      }
    }
  });

  it("keeps both lanes active for a real side branch that does not rejoin", () => {
    // M has parents [F, X], X is an independent root, not reachable from F
    const commits = [
      commit("M", ["F", "X"]),
      commit("F", ["A"]),
      commit("A", []),
      commit("X", []),
    ];
    const result = computeGraphLanes(commits);
    expect(result[0].lane).toBe(0);
    // X should be on a non-zero lane (its own)
    const x = result.find((c) => c.hash === "X")!;
    expect(x.lane).toBeGreaterThan(0);
  });

  it("assigns sequential colors without skipping when allocating a new lane for a merge parent", () => {
    // M (lane 0) gets color 0. Second parent X needs a new lane;
    // that lane must get color 1, not color 2 (no double-increment).
    const commits = [
      commit("M", ["F", "X"]),
      commit("F", []),
      commit("X", []),
    ];
    const result = computeGraphLanes(commits);
    const mergeLine = result[0].lines.find((l) => l.type === "merge-in");
    expect(mergeLine).toBeDefined();
    expect(mergeLine!.colorIndex).toBe(1);
  });
});
