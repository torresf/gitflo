import { describe, expect, it } from "vitest";
import { buildGraph } from "../graph";
import type { Commit } from "../../types";

/** Minimal commit factory: `c("a", "b")` = sha "a" with parent "b". */
const c = (sha: string, ...parents: string[]): Commit => ({
  sha,
  shortSha: sha,
  parents,
  author: "Test",
  email: "t@example.com",
  date: "2026-08-25T10:00:00Z",
  subject: `commit ${sha}`,
  refs: [],
});

describe("buildGraph", () => {
  it("keeps a linear history in a single lane", () => {
    const { rows, laneCount } = buildGraph([c("d", "c"), c("c", "b"), c("b", "a"), c("a")]);
    expect(laneCount).toBe(1);
    expect(rows.map((r) => r.column)).toEqual([0, 0, 0, 0]);
    // Each row links straight down to the next.
    expect(rows[0].edges).toEqual([{ from: 0, to: 0, lane: 0 }]);
    expect(rows[3].edges).toEqual([]);
  });

  it("puts a diverged branch in its own lane and merges it back", () => {
    // m is a merge of the main line (b) and a side branch (s).
    const { rows, laneCount } = buildGraph([
      c("m", "b", "s"),
      c("s", "a"),
      c("b", "a"),
      c("a"),
    ]);

    expect(laneCount).toBe(2);
    expect(rows[0].isMerge).toBe(true);
    // The merge keeps lane 0; its second parent claims a fresh lane.
    expect(rows[0].column).toBe(0);
    expect(rows[0].parentColumns).toEqual([0, 1]);
    // Both lanes converge on "a", the shared ancestor.
    const lastCommitRow = rows[3];
    expect(lastCommitRow.commit.sha).toBe("a");
    expect(lastCommitRow.incoming.length).toBeGreaterThan(1);
  });

  it("routes a line onto the next row's dot when that row is its parent", () => {
    const { rows } = buildGraph([c("b", "a"), c("a")]);
    // Row 0's lane expects "a", which is exactly row 1: the edge lands on
    // row 1's column rather than staying in its own lane.
    expect(rows[0].edges).toEqual([{ from: 0, to: rows[1].column, lane: 0 }]);
  });

  it("reuses a freed lane instead of growing the gutter", () => {
    // Two independent tips that both end at "a": after the first is absorbed,
    // the second must not open a third lane.
    const { laneCount } = buildGraph([c("x", "a"), c("y", "a"), c("a")]);
    expect(laneCount).toBe(2);
  });

  it("handles orphan tips with no parents", () => {
    const { rows, laneCount } = buildGraph([c("solo1"), c("solo2")]);
    expect(laneCount).toBe(1);
    // solo1's lane empties immediately, so solo2 reuses lane 0.
    expect(rows.map((r) => r.column)).toEqual([0, 0]);
    expect(rows[0].edges).toEqual([]);
  });

  it("returns an empty layout for no commits", () => {
    const { rows, laneCount } = buildGraph([]);
    expect(rows).toEqual([]);
    expect(laneCount).toBe(1);
  });

  it("never emits an edge pointing at a lane it did not occupy", () => {
    const commits = [
      c("f", "e", "d"),
      c("e", "b"),
      c("d", "c"),
      c("c", "b"),
      c("b", "a"),
      c("a"),
    ];
    const { rows, laneCount } = buildGraph(commits);
    for (const row of rows) {
      for (const edge of row.edges) {
        expect(edge.from).toBeLessThan(laneCount);
        expect(edge.to).toBeLessThan(laneCount);
        expect(edge.from).toBeGreaterThanOrEqual(0);
        expect(edge.to).toBeGreaterThanOrEqual(0);
      }
    }
  });

  describe("priority lanes", () => {
    it("keeps the pinned trunk in lane 0 even when seen last", () => {
      // "side" is the newest commit, so without pinning it would take lane 0.
      const commits = [c("side", "base"), c("trunk", "base"), c("base")];
      const { rows } = buildGraph(commits, ["trunk"]);
      const byShaColumn = Object.fromEntries(
        rows.map((r) => [r.commit.sha, r.column]),
      );
      expect(byShaColumn.trunk).toBe(0);
      expect(byShaColumn.side).toBe(1);
    });

    it("orders two pinned branches left to right", () => {
      const commits = [c("feat", "dev"), c("dev", "main"), c("main")];
      const { rows } = buildGraph(commits, ["main", "dev"]);
      const col = Object.fromEntries(rows.map((r) => [r.commit.sha, r.column]));
      expect(col.main).toBe(0);
      expect(col.dev).toBe(1);
      // The feature sits on its parent's lane, to the right of the trunk.
      expect(col.feat).toBeGreaterThanOrEqual(1);
    });

    it("ignores a pinned sha absent from the loaded page", () => {
      // A lane reserved for a sha that never arrives would draw a dead line.
      const { rows, laneCount } = buildGraph([c("b", "a"), c("a")], ["not-loaded"]);
      expect(laneCount).toBe(1);
      expect(rows[0].column).toBe(0);
    });

    it("does not reserve two lanes for the same sha", () => {
      // main and develop pointing at the same commit is normal.
      const { laneCount } = buildGraph([c("x", "a"), c("a")], ["x", "x"]);
      expect(laneCount).toBe(1);
    });
  });

  describe("edge anchoring", () => {
    it("starts a merge's second-parent line at the merge dot", () => {
      // m merges the main line (b) and a side branch (s).
      const { rows } = buildGraph([c("m", "b", "s"), c("s", "a"), c("b", "a"), c("a")]);
      const merge = rows[0];
      const side = rows[1];
      expect(merge.commit.sha).toBe("m");
      expect(side.commit.sha).toBe("s");

      // The line reaching s must leave the merge's own column, otherwise it
      // renders as a floating vertical stub next to the merge.
      const toSide = merge.edges.find((e) => e.to === side.column);
      expect(toSide).toBeDefined();
      expect(toSide!.from).toBe(merge.column);
    });

    /**
     * The invariant behind the visual bug: a line entering row i must either
     * leave that row's commit dot, or continue a line that arrived at row i-1.
     * Anything else is a stroke starting from nowhere.
     */
    const assertNoOrphanEdges = (commits: Commit[], priority: string[] = []) => {
      const { rows } = buildGraph(commits, priority);
      for (let i = 1; i < rows.length; i++) {
        for (const edge of rows[i].edges) {
          const fromDot = edge.from === rows[i].column;
          const continues = rows[i - 1].edges.some((prev) => prev.to === edge.from);
          expect(
            fromDot || continues,
            `row ${i} (${rows[i].commit.sha}) has an edge from lane ${edge.from} ` +
              `that neither leaves its dot (lane ${rows[i].column}) nor continues row ${i - 1}`,
          ).toBe(true);
        }
      }
    };

    it("emits no orphan line on a merge-heavy history", () => {
      assertNoOrphanEdges([
        c("h", "g", "f"),
        c("g", "e"),
        c("f", "d"),
        c("e", "c"),
        c("d", "c"),
        c("c", "b", "a"),
        c("b", "a"),
        c("a"),
      ]);
    });

    it("emits no orphan line with several branches open at once", () => {
      assertNoOrphanEdges([
        c("tip1", "mid"),
        c("tip2", "mid"),
        c("tip3", "old"),
        c("merge", "mid", "tip3"),
        c("mid", "old"),
        c("old"),
      ]);
    });

    it("emits no orphan line with pinned lanes reserved", () => {
      assertNoOrphanEdges(
        [c("feat", "dev"), c("dev", "main"), c("main", "root"), c("root")],
        ["main", "dev"],
      );
    });

    it("emits no orphan line on an octopus merge", () => {
      assertNoOrphanEdges([
        c("octo", "a", "b", "c"),
        c("a", "base"),
        c("b", "base"),
        c("c", "base"),
        c("base"),
      ]);
    });
  });

  describe("reserved lanes before their commit", () => {
    it("draws nothing on a reserved lane above its own commit", () => {
      // main is reserved lane 0 but only appears on row 2: rows 0 and 1 must
      // not draw it, or the trunk shows as a line descending from the top of
      // the page towards nothing.
      const commits = [c("x", "y"), c("y"), c("main")];
      const { rows, pinnedLanes } = buildGraph(commits, ["main"]);
      const mainLane = pinnedLanes[0];
      expect(mainLane).toBeGreaterThanOrEqual(0);

      expect(rows[0].edges.some((e) => e.lane === mainLane)).toBe(false);
      expect(rows[1].edges.some((e) => e.lane === mainLane)).toBe(false);
      // Row 2 carries main's dot.
      expect(rows[2].column).toBe(mainLane);
    });

    it("still draws a reserved lane below its commit", () => {
      const commits = [c("main", "base"), c("side", "base"), c("base")];
      const { rows, pinnedLanes } = buildGraph(commits, ["main"]);
      const mainLane = pinnedLanes[0];
      // main is on row 0 and continues towards base.
      expect(rows[0].edges.some((e) => e.lane === mainLane)).toBe(true);
    });

    it("draws both pinned lanes only from their own commit down", () => {
      const commits = [
        c("feat", "dev"),
        c("main", "root"),
        c("dev", "root"),
        c("root"),
      ];
      const { rows, pinnedLanes } = buildGraph(commits, ["main", "dev"]);
      const [mainLane, devLane] = pinnedLanes;

      // Row 0 is the feature tip: neither pinned branch exists yet on screen.
      expect(rows[0].edges.some((e) => e.lane === mainLane)).toBe(false);
      // dev is row 2, so row 1 must not draw it either...
      expect(rows[1].edges.some((e) => e.lane === devLane)).toBe(false);
      // ...but main is row 1 and does continue.
      expect(rows[1].edges.some((e) => e.lane === mainLane)).toBe(true);
    });
  });

  describe("a merge claiming a reserved lane early", () => {
    /**
     * Real shape from api: master's merge of develop, with several
     * remote tips listed between the merge and develop's own commit.
     */
    const commits = [
      c("m1", "mg"), // master tip
      c("mg", "x", "dev"), // merge of x and develop
      c("r1", "old"), // remote tip
      c("r2", "old"), // remote tip
      c("dev", "x"), // develop
      c("x", "old"),
      c("old"),
    ];

    it("draws the merge's line to develop across the rows between", () => {
      const { rows, pinnedLanes } = buildGraph(commits, ["m1", "dev"]);
      const devLane = pinnedLanes[1];
      expect(devLane).toBeGreaterThanOrEqual(0);

      // The merge is row 1 and names develop as a parent, so the stroke must
      // exist on rows 1..3 — otherwise the line has a hole in it.
      for (const row of [1, 2, 3]) {
        expect(
          rows[row].edges.some((e) => e.lane === devLane),
          `row ${row} is missing the stroke towards develop`,
        ).toBe(true);
      }
    });

    it("still leaves the lane blank above the merge that claims it", () => {
      const { rows, pinnedLanes } = buildGraph(commits, ["m1", "dev"]);
      const devLane = pinnedLanes[1];
      // Row 0 precedes the merge: nothing has claimed develop's lane yet.
      expect(rows[0].edges.some((e) => e.lane === devLane)).toBe(false);
    });

    it("keeps that line unbroken all the way to its commit", () => {
      const { rows, pinnedLanes } = buildGraph(commits, ["m1", "dev"]);
      const devLane = pinnedLanes[1];
      // Follow the stroke from the merge down to develop's dot: every
      // intermediate row must hand it on.
      let lane = devLane;
      for (let i = 1; i < 4; i++) {
        const edge = rows[i].edges.find((e) => e.lane === lane);
        expect(edge, `row ${i} drops the stroke`).toBeDefined();
        lane = edge!.to;
      }
      expect(rows[4].column).toBe(lane);
      expect(rows[4].commit.sha).toBe("dev");
    });
  });

  describe("a merge claiming a RESERVED lane", () => {
    /** master merges develop; develop's lane was reserved from row 0. */
    const commits = [
      c("m1", "mg"),
      c("mg", "x", "dev"),
      c("r1", "old"),
      c("dev", "x"),
      c("x", "old"),
      c("old"),
    ];

    it("emits exactly one stroke for that lane, from the merge dot", () => {
      const { rows, pinnedLanes } = buildGraph(commits, ["m1", "dev"]);
      const devLane = pinnedLanes[1];
      const merge = rows[1];
      expect(merge.commit.sha).toBe("mg");

      const strokes = merge.edges.filter((e) => e.lane === devLane);
      // Two strokes would draw a detached vertical stub beside the merge dot,
      // on top of the diagonal that actually connects them.
      expect(strokes).toHaveLength(1);
      expect(strokes[0].from).toBe(merge.column);
    });

    it("does not treat a lane claimed on this very row as passing through", () => {
      const { rows, pinnedLanes } = buildGraph(commits, ["m1", "dev"]);
      const devLane = pinnedLanes[1];
      // No stroke may start in develop's own lane on the merge row: nothing
      // exists above it there.
      expect(
        rows[1].edges.some((e) => e.lane === devLane && e.from === devLane),
      ).toBe(false);
    });

    it("keeps the double stroke when the parent was already being followed", () => {
      // Here the second parent is awaited by a lane opened earlier, so the
      // merge owes it a connector IN ADDITION to that lane continuing.
      const withEarlierLane = [
        c("tip", "shared"),
        c("mg", "main", "shared"),
        c("main", "root"),
        c("shared", "root"),
        c("root"),
      ];
      const { rows } = buildGraph(withEarlierLane);
      const merge = rows[1];
      const sharedLane = merge.parentColumns[1];
      const strokes = merge.edges.filter((e) => e.lane === sharedLane);
      expect(strokes).toHaveLength(2);
      expect(strokes.some((e) => e.from === sharedLane)).toBe(true);
      expect(strokes.some((e) => e.from === merge.column)).toBe(true);
    });
  });

});
