import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { buildGraph } from "../graph";
import { type Commit } from "../../types";

/**
 * Runs the layout against a real repository. Opt-in, because it depends on a
 * checkout being present:
 *
 *   GITFLO_REAL_REPO=/path/to/repo npx vitest run graph.real
 */
const repo = process.env.GITFLO_REAL_REPO;

const FS = "\x1f";
const RS = "\x1e";

function readCommits(path: string, limit: number): Commit[] {
  const out = execFileSync(
    "git",
    [
      "log",
      `--pretty=format:%H${FS}%h${FS}%P${FS}%an${FS}%ae${FS}%aI${FS}%s${FS}%D${RS}`,
      `--max-count=${limit}`,
      "--date-order",
      "--all",
    ],
    { cwd: path, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );

  return out
    .split(RS)
    .map((record) => record.replace(/^\n/, ""))
    .filter((record) => record.trim().length > 0)
    .map((record) => {
      const f = record.split(FS);
      return {
        sha: f[0],
        shortSha: f[1],
        parents: f[2] ? f[2].split(" ").filter(Boolean) : [],
        author: f[3],
        email: f[4],
        date: f[5],
        subject: f[6],
        refs: (f[7] ?? "")
          .split(",")
          .map((r) => r.trim())
          .filter(Boolean),
      };
    });
}

/**
 * Shas of the pinned branches, exactly as the app resolves them. Passing these
 * matters: reserved lanes are a whole code path, and running the real-repo
 * check without them hid a duplicated merge stroke that only reserved lanes
 * could produce.
 */
function pinnedShas(path: string): string[] {
  const shas: string[] = [];
  for (const group of [["main", "master"], ["develop", "dev"]]) {
    for (const name of group) {
      try {
        const sha = execFileSync(
          "git",
          ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`],
          { cwd: path, encoding: "utf8" },
        ).trim();
        if (sha && !shas.includes(sha)) {
          shas.push(sha);
          break;
        }
      } catch {
        // Branch absent in this repo; try the next name in the group.
      }
    }
  }
  return shas;
}

describe.skipIf(!repo)("buildGraph against a real repository", () => {
  it("lays out 400 real commits without an orphan stroke", () => {
    const commits = readCommits(repo!, 400);
    expect(commits.length).toBeGreaterThan(50);

    const pinned = pinnedShas(repo!);
    console.log(`pinned lanes: ${pinned.length}`);
    const { rows, laneCount } = buildGraph(commits, pinned);
    expect(rows).toHaveLength(commits.length);

    const orphans: string[] = [];
    for (let i = 1; i < rows.length; i++) {
      for (const edge of rows[i].edges) {
        const leavesDot = edge.from === rows[i].column;
        const continues = rows[i - 1].edges.some((prev) => prev.to === edge.from);
        if (!leavesDot && !continues) {
          orphans.push(
            `row ${i} ${rows[i].commit.shortSha} "${rows[i].commit.subject.slice(0, 40)}" ` +
              `edge from lane ${edge.from} (dot on ${rows[i].column})`,
          );
        }
        expect(edge.from).toBeLessThan(laneCount);
        expect(edge.to).toBeLessThan(laneCount);
      }
    }

    const merges = rows.filter((r) => r.isMerge).length;
    console.log(
      `${rows.length} commits, ${merges} merges, ${laneCount} lanes, ${orphans.length} orphan strokes`,
    );
    if (orphans.length > 0) console.log(orphans.slice(0, 10).join("\n"));
    expect(orphans).toEqual([]);
  });

  it("gives every merge a stroke towards each of its parents", () => {
    const commits = readCommits(repo!, 400);
    const { rows } = buildGraph(commits, pinnedShas(repo!));
    const shaToRow = new Map(rows.map((r, i) => [r.commit.sha, i]));

    let checked = 0;
    for (let i = 0; i < rows.length - 1; i++) {
      const row = rows[i];
      if (!row.isMerge) continue;
      for (const parent of row.commit.parents) {
        // Only parents present in this page can be connected on screen.
        if (!shaToRow.has(parent)) continue;
        const lane = row.parentColumns.find((_, k) => row.commit.parents[k] === parent);
        if (lane === undefined) continue;
        const stroke = row.edges.find((e) => e.lane === lane);
        expect(stroke, `merge ${row.commit.shortSha} has no stroke for lane ${lane}`)
          .toBeDefined();
        // Every merge stroke must be anchored: at the dot, or continuing above.
        const anchored =
          stroke!.from === row.column ||
          (i > 0 && rows[i - 1].edges.some((p) => p.to === stroke!.from));
        expect(anchored, `merge ${row.commit.shortSha} stroke floats`).toBe(true);
        checked += 1;
      }
    }
    console.log(`${checked} merge-parent strokes verified`);
    expect(checked).toBeGreaterThan(0);
  });
});

describe.skipIf(!repo)("reserved lanes on a real repository", () => {
  it("never draws two strokes for one lane out of a single row", () => {
    // The duplicate showed as a short vertical stub beside a merge dot, drawn
    // on top of the diagonal that actually connects the merge to its parent.
    const commits = readCommits(repo!, 400);
    const { rows } = buildGraph(commits, pinnedShas(repo!));

    const offenders: string[] = [];
    for (const row of rows) {
      const seen = new Map<number, number>();
      for (const edge of row.edges) {
        seen.set(edge.lane, (seen.get(edge.lane) ?? 0) + 1);
      }
      for (const [lane, count] of seen) {
        // Two strokes are legitimate ONLY when the lane both passes the row and
        // receives a merge connector, i.e. it is an extra parent of this row.
        const legitimate = row.parentColumns.slice(1).includes(lane);
        if (count > 1 && !legitimate) {
          offenders.push(
            `${row.commit.shortSha} lane ${lane}: ${count} strokes`,
          );
        }
        if (count > 2) {
          offenders.push(`${row.commit.shortSha} lane ${lane}: ${count} strokes`);
        }
      }
    }
    if (offenders.length) console.log(offenders.slice(0, 8).join("\n"));
    expect(offenders).toEqual([]);
  });

  it("draws no stroke above the row that first claims a reserved lane", () => {
    const commits = readCommits(repo!, 400);
    const pinned = pinnedShas(repo!);
    const { rows, pinnedLanes } = buildGraph(commits, pinned);

    pinnedLanes.forEach((lane, k) => {
      if (lane < 0) return;
      const firstClaim = rows.findIndex(
        (r) => r.column === lane || r.parentColumns.includes(lane),
      );
      expect(firstClaim).toBeGreaterThanOrEqual(0);
      for (let i = 0; i < firstClaim; i++) {
        expect(
          rows[i].edges.some((e) => e.lane === lane),
          `pinned lane ${k} drawn on row ${i}, before its first claim at ${firstClaim}`,
        ).toBe(false);
      }
    });
  });
});
