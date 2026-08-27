import { describe, expect, it } from "vitest";
import { activeFilter, resolveRevs, type BranchFilter } from "../revs";
import type { Branch } from "../../types";

const branch = (short: string, over: Partial<Branch> = {}): Branch => ({
  refname: `refs/heads/${short}`,
  short,
  kind: "local",
  sha: "abc",
  shortSha: "abc",
  upstream: null,
  ahead: 0,
  behind: 0,
  gone: false,
  date: "2026-08-25T10:00:00Z",
  author: "Test",
  subject: "s",
  isHead: false,
  worktreePath: null,
  remote: null,
  ...over,
});

const filter = (
  repoPath: string,
  name: string,
  over: Partial<Branch> = {},
): BranchFilter => ({
  repoPath,
  branch: branch(name, over),
});

describe("resolveRevs", () => {
  it("passes the ref when the filter belongs to the selected repo", () => {
    expect(resolveRevs(filter("/repo/a", "develop"), "/repo/a")).toEqual([
      "refs/heads/develop",
    ]);
  });

  it("drops a filter left over from another repo", () => {
    // The regression: /repo/b has no `main`, and git failed with
    // "fatal: ambiguous argument 'refs/heads/main'".
    expect(resolveRevs(filter("/repo/a", "main"), "/repo/b")).toEqual([]);
  });

  it("returns no revs without a filter or without a repo", () => {
    expect(resolveRevs(null, "/repo/a")).toEqual([]);
    expect(resolveRevs(filter("/repo/a", "main"), null)).toEqual([]);
  });
});

describe("activeFilter", () => {
  it("shows the filter only for its own repo", () => {
    const f = filter("/repo/a", "develop");
    expect(activeFilter(f, "/repo/a")?.short).toBe("develop");
    expect(activeFilter(f, "/repo/b")).toBeNull();
    expect(activeFilter(null, "/repo/a")).toBeNull();
  });
});

describe("resolveRevs with an upstream", () => {
  it("includes the upstream so remote-only commits show up", () => {
    // Filtering on develop must reveal what origin/develop has and you do not.
    const revs = resolveRevs(
      filter("/repo/a", "develop", { upstream: "origin/develop" }),
      "/repo/a",
    );
    expect(revs).toEqual(["refs/heads/develop", "refs/remotes/origin/develop"]);
  });

  it("skips a dead upstream", () => {
    // git errors on a ref that no longer exists.
    const revs = resolveRevs(
      filter("/repo/a", "old", { upstream: "origin/old", gone: true }),
      "/repo/a",
    );
    expect(revs).toEqual(["refs/heads/old"]);
  });

  it("passes a remote branch through alone", () => {
    const revs = resolveRevs(
      filter("/repo/a", "origin/feature", {
        kind: "remote",
        refname: "refs/remotes/origin/feature",
      }),
      "/repo/a",
    );
    expect(revs).toEqual(["refs/remotes/origin/feature"]);
  });

  it("passes a branch with no upstream through alone", () => {
    expect(resolveRevs(filter("/repo/a", "local-only"), "/repo/a")).toEqual([
      "refs/heads/local-only",
    ]);
  });
});
