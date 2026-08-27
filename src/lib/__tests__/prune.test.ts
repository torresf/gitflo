import { describe, expect, it } from "vitest";
import {
  defaultRemoteSelection,
  defaultSelection,
  isRemoteSafe,
  remoteState,
  deletionBlocker,
  needsForce,
  planPrune,
  retryableFailures,
} from "../prune";
import type { RemoteBranchState, StaleBranch } from "../../types";

const stale = (over: Partial<StaleBranch> = {}): StaleBranch => ({
  name: "fix/x",
  sha: "abc",
  shortSha: "abc",
  upstream: "origin/fix/x",
  date: "2026-08-25T10:00:00Z",
  subject: "s",
  reason: "gone",
  unmergedCommits: 0,
  contributesNothing: true,
  worktreePath: null,
  isHead: false,
  ...over,
});

describe("deletionBlocker", () => {
  it("blocks the current branch", () => {
    expect(deletionBlocker(stale({ isHead: true }))).toBe("branche courante");
  });

  it("blocks a branch open in a worktree, naming it", () => {
    expect(deletionBlocker(stale({ worktreePath: "/p/api-wip" }))).toBe(
      "ouverte dans api-wip",
    );
  });

  it("allows an ordinary candidate", () => {
    expect(deletionBlocker(stale())).toBeNull();
  });
});

describe("planPrune", () => {
  it("separates safe, risky and blocked", () => {
    const plan = planPrune([
      stale({ name: "safe" }),
      stale({ name: "risky", unmergedCommits: 2, contributesNothing: false }),
      stale({ name: "blocked", isHead: true }),
    ]);
    expect(plan.safe.map((b) => b.name)).toEqual(["safe"]);
    expect(plan.risky.map((b) => b.name)).toEqual(["risky"]);
    expect(plan.blocked.map((b) => b.name)).toEqual(["blocked"]);
  });

  it("counts a blocked branch as blocked even when it holds unique work", () => {
    // Blocked wins: git refuses it whatever the commit count.
    const plan = planPrune([stale({ isHead: true, unmergedCommits: 5, contributesNothing: false })]);
    expect(plan.risky).toHaveLength(0);
    expect(plan.blocked).toHaveLength(1);
  });
});

describe("defaultSelection", () => {
  it("preselects only what deletes without losing work", () => {
    const selection = defaultSelection([
      stale({ name: "safe" }),
      stale({ name: "risky", unmergedCommits: 1, contributesNothing: false }),
      stale({ name: "blocked", worktreePath: "/p/w" }),
    ]);
    expect([...selection]).toEqual(["safe"]);
  });

  it("selects nothing when every candidate carries unique commits", () => {
    expect(defaultSelection([stale({ unmergedCommits: 3, contributesNothing: false })]).size).toBe(0);
  });
});

describe("retryableFailures", () => {
  const refused = (name: string) => ({
    name,
    deleted: false,
    message: `error: the branch '${name}' is not fully merged`,
  });

  it("collects branches git refused for not being merged", () => {
    const result = retryableFailures(
      [refused("a"), { name: "b", deleted: true, message: "" }],
      [stale({ name: "a" })],
    );
    expect(result.names).toEqual(["a"]);
    expect(result.losingWork).toEqual([]);
  });

  it("flags the ones that would actually lose commits", () => {
    // -d refuses both, but only this one holds unique work.
    const result = retryableFailures(
      [refused("safe"), refused("risky")],
      [stale({ name: "safe" }), stale({ name: "risky", unmergedCommits: 3, contributesNothing: false })],
    );
    expect(result.names).toEqual(["safe", "risky"]);
    expect(result.losingWork).toEqual(["risky"]);
  });

  it("ignores failures that forcing would not fix", () => {
    const result = retryableFailures(
      [{ name: "held", deleted: false, message: "used by worktree at /p/x" }],
      [stale({ name: "held" })],
    );
    expect(result.names).toEqual([]);
  });

  it("treats an unknown branch as losing nothing", () => {
    const result = retryableFailures([refused("ghost")], []);
    expect(result.names).toEqual(["ghost"]);
    expect(result.losingWork).toEqual([]);
  });
});

describe("remote branch state", () => {
  const remote = (over: Partial<RemoteBranchState> = {}): RemoteBranchState => ({
    name: "origin/fix/x",
    remote: "origin",
    branch: "fix/x",
    shortSha: "abc",
    date: "2026-08-25T10:00:00Z",
    subject: "s",
    author: "T",
    merged: false,
    unmergedCommits: 0,
    equivalentMerged: true,
    unappliedCommits: 0,
    contributesNothing: true,
    hasLocal: false,
    ...over,
  });

  it("recognises a plain merge", () => {
    expect(remoteState(remote({ merged: true }))).toBe("merged");
  });

  it("recognises a squashed merge as applied", () => {
    // git --merged says no (different shas), git cherry says the change is in.
    const branch = remote({
      merged: false,
      unmergedCommits: 3,
      equivalentMerged: true,
      unappliedCommits: 0,
    });
    expect(remoteState(branch)).toBe("applied");
    expect(isRemoteSafe(branch)).toBe(true);
  });

  it("keeps a genuinely unmerged branch out of the safe set", () => {
    const branch = remote({
      unmergedCommits: 4,
      equivalentMerged: false,
      unappliedCommits: 4,
      contributesNothing: false,
    });
    expect(remoteState(branch)).toBe("ahead");
    expect(isRemoteSafe(branch)).toBe(false);
  });

  it("preselects merged and applied branches only", () => {
    const selection = defaultRemoteSelection([
      remote({ name: "origin/a", merged: true }),
      remote({ name: "origin/b", equivalentMerged: true, unmergedCommits: 2 }),
      remote({
        name: "origin/c",
        equivalentMerged: false,
        unappliedCommits: 1,
        contributesNothing: false,
      }),
    ]);
    expect([...selection].sort()).toEqual(["origin/a", "origin/b"]);
  });
});

describe("contribution beats the commit count", () => {
  it("treats a squash-merged branch as safe despite unique commits", () => {
    // Real case on api: 2 commits nothing else has, yet every line
    // already shipped through a rewritten merge request.
    const branch = stale({ unmergedCommits: 2, contributesNothing: true });
    expect(needsForce(branch)).toBe(false);
    expect([...defaultSelection([branch])]).toEqual([branch.name]);
  });

  it("still protects a branch that genuinely contributes", () => {
    const branch = stale({ unmergedCommits: 2, contributesNothing: false });
    expect(needsForce(branch)).toBe(true);
    expect(defaultSelection([branch]).size).toBe(0);
  });
});
