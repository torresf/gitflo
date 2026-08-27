import type { Commit } from "../types";

export interface GraphEdge {
  /** Lane the line leaves from, on this row. */
  from: number;
  /** Lane the line arrives at, on the next row. */
  to: number;
  lane: number;
}

export interface GraphRow {
  commit: Commit;
  /** Lane holding the commit dot. */
  column: number;
  /** Lanes that were waiting for this commit and converge into it. */
  incoming: number[];
  /** Lanes the commit's parents continue on. */
  parentColumns: number[];
  /** Lines drawn between this row and the next one. */
  edges: GraphEdge[];
  isMerge: boolean;
}

export interface GraphLayout {
  rows: GraphRow[];
  laneCount: number;
  /**
   * Lane granted to each entry of `priorityShas`, in the same order, or -1 when
   * that sha is absent from this page and therefore got no lane. Callers must
   * read roles from here, not from the pinned list: a filtered page may show
   * neither the trunk nor the integration branch, and lane 0 then belongs to
   * some ordinary branch.
   */
  pinnedLanes: number[];
}

const firstFree = (lanes: (string | null)[]): number => {
  const idx = lanes.indexOf(null);
  return idx === -1 ? lanes.length : idx;
};

/**
 * Assign each commit a lane and compute the lines to draw between rows.
 *
 * Lanes listed in `priorityShas` are reserved up front, so the trunk keeps
 * column 0 for the whole page instead of moving with the first commit seen.
 *
 * Walks the list in the order git returned it (`--date-order`), keeping one
 * slot per "line of development still expecting a commit". A lane is claimed
 * when a commit's child announced it as a parent, which is what makes a branch
 * read as a continuous vertical line instead of jumping columns.
 */
export function buildGraph(
  commits: Commit[],
  priorityShas: string[] = [],
): GraphLayout {
  const lanes: (string | null)[] = [];

  // Reserve the leftmost lanes for the pinned branches (trunk, then the
  // integration branch) so feature work always renders to their right.
  // Only shas actually present in this page can be reserved: a lane holding a
  // sha that never arrives would draw a line going nowhere.
  if (priorityShas.length > 0) {
    const present = new Set(commits.map((c) => c.sha));
    priorityShas.forEach((sha, i) => {
      lanes[i] = present.has(sha) && !lanes.includes(sha) ? sha : null;
    });
    while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes.pop();
  }
  const pinnedLanes = priorityShas.map((sha) => lanes.indexOf(sha));
  const initialLanes = [...lanes];
  /**
   * Row at which each lane was first CLAIMED by a commit — as its own dot, or
   * as one of a commit's parents. A reserved lane holds its sha from row 0, but
   * the branch does not exist on screen until something claims it.
   */
  const claimedAt = new Map<number, number>();
  const rows: GraphRow[] = [];
  /** Lane occupancy right after each row was processed, per row. */
  const snapshots: (string | null)[][] = [];
  let laneCount = 0;

  for (const commit of commits) {
    // Every lane waiting for this sha converges here; the leftmost one wins
    // the dot so merges visually collapse to the left.
    const incoming: number[] = [];
    lanes.forEach((sha, i) => {
      if (sha === commit.sha) incoming.push(i);
    });

    let column: number;
    if (incoming.length > 0) {
      column = incoming[0];
      for (const lane of incoming.slice(1)) lanes[lane] = null;
    } else {
      // A tip nobody pointed at yet (branch head, or the first row).
      column = firstFree(lanes);
      lanes[column] = commit.sha;
    }

    // The first parent keeps the commit's own lane, so a branch stays straight.
    lanes[column] = commit.parents[0] ?? null;
    const parentColumns = [column];

    for (const parent of commit.parents.slice(1)) {
      let pc = lanes.indexOf(parent);
      if (pc === -1) {
        pc = firstFree(lanes);
        lanes[pc] = parent;
      }
      parentColumns.push(pc);
    }

    // Trim trailing empty lanes so the gutter narrows back down after a merge.
    while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes.pop();
    laneCount = Math.max(laneCount, lanes.length, column + 1);

    const rowIndex = rows.length;
    for (const lane of [column, ...parentColumns]) {
      if (!claimedAt.has(lane)) claimedAt.set(lane, rowIndex);
    }

    rows.push({
      commit,
      column,
      incoming,
      parentColumns,
      edges: [],
      isMerge: commit.parents.length > 1,
    });
    snapshots.push([...lanes]);
  }

  // Second pass: draw the strokes leaving each row.
  //
  // Where a stroke STARTS matters as much as where it lands. A lane still
  // waiting for the same sha simply passes the row, so it starts in its own
  // lane. A lane this commit just claimed — its first parent, or the extra
  // lane a merge opens for a second parent — must start at the commit's dot,
  // otherwise it renders as a vertical stub floating beside the merge with
  // nothing attached to it.
  for (let i = 0; i < rows.length - 1; i++) {
    const row = rows[i];
    const next = rows[i + 1];
    const before = i > 0 ? snapshots[i - 1] : initialLanes;
    const after = snapshots[i];

    after.forEach((sha, lane) => {
      if (!sha) return;
      // Not yet claimed by any commit: a reserved lane drawn this early would
      // fall from the top of the page towards nothing. Claiming covers BOTH a
      // commit reaching the lane and a merge naming it as a parent — keying
      // this on the lane's own commit instead left a gap between a merge and
      // the branch it merged, wherever other rows came in between.
      const claimed = claimedAt.get(lane);
      if (claimed === undefined || i < claimed) return;
      const to = sha === next.commit.sha ? next.column : lane;
      // A lane only PASSES a row if it was already live before it. A reserved
      // lane holds its sha from row 0, so comparing shas alone made the row
      // that first claims it look like a pass-through, drawing a detached
      // vertical stub beside the dot on top of the real connector.
      const passesThrough = before[lane] === sha && claimed < i;
      row.edges.push({ from: passesThrough ? lane : row.column, to, lane });
    });

    // A merge whose extra parent was ALREADY awaited by another lane is not
    // covered above (that lane's sha did not change), yet the merge still owes
    // it a stroke — without one the merge looks unconnected to that parent.
    for (const lane of row.parentColumns.slice(1)) {
      const sha = after[lane];
      if (!sha || before[lane] !== sha) continue;
      // Only when that lane genuinely passes this row; a lane first claimed
      // here is already anchored to the dot above, and adding this would
      // duplicate it.
      const claimed = claimedAt.get(lane);
      if (claimed === undefined || claimed >= i) continue;
      const to = sha === next.commit.sha ? next.column : lane;
      row.edges.push({ from: row.column, to, lane });
    }
  }

  return { rows, laneCount: Math.max(laneCount, 1), pinnedLanes };
}
