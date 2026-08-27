import { describe, expect, it } from "vitest";
import { branchRole, isPinnedBranch, pinnedShas } from "../pinned";
import type { Branch } from "../../types";

const b = (
  short: string,
  kind: "local" | "remote",
  sha: string,
  sync: { ahead?: number; behind?: number } = {},
): Branch => ({
  refname: kind === "local" ? `refs/heads/${short}` : `refs/remotes/${short}`,
  short,
  kind,
  sha,
  shortSha: sha.slice(0, 8),
  upstream: null,
  ahead: sync.ahead ?? 0,
  behind: sync.behind ?? 0,
  gone: false,
  date: "2026-08-25T10:00:00Z",
  author: "Test",
  subject: "s",
  isHead: false,
  worktreePath: null,
  remote: kind === "remote" ? short.split("/")[0] : null,
});

describe("pinnedShas", () => {
  it("orders trunk then integration branch", () => {
    const branches = [
      b("feature/x", "local", "f1"),
      b("develop", "local", "d1"),
      b("master", "local", "m1"),
    ];
    expect(pinnedShas(branches)).toEqual(["m1", "d1"]);
  });

  it("accepts main as the trunk", () => {
    expect(pinnedShas([b("main", "local", "m1"), b("dev", "local", "d1")])).toEqual([
      "m1",
      "d1",
    ]);
  });

  it("drops a missing group instead of leaving a hole", () => {
    // No trunk: develop must take lane 0, not lane 1.
    expect(pinnedShas([b("develop", "local", "d1")])).toEqual(["d1"]);
  });

  it("prefers the local branch when the two are level", () => {
    const branches = [
      b("origin/master", "remote", "remote-sha"),
      b("master", "local", "local-sha"),
    ];
    expect(pinnedShas(branches)).toEqual(["local-sha"]);
  });

  it("reserves the REMOTE tip when it is ahead", () => {
    // Otherwise origin/develop opens a lane of its own to the right, drawing
    // the same line of development twice.
    const branches = [
      b("origin/develop", "remote", "remote-sha"),
      b("develop", "local", "local-sha", { behind: 1 }),
    ];
    expect(pinnedShas(branches)).toEqual(["remote-sha"]);
  });

  it("keeps the local tip when the branches have diverged", () => {
    // Both hold unique commits: they cannot share a lane, so follow the one
    // being worked on.
    const branches = [
      b("origin/develop", "remote", "remote-sha"),
      b("develop", "local", "local-sha", { ahead: 2, behind: 3 }),
    ];
    expect(pinnedShas(branches)).toEqual(["local-sha"]);
  });

  it("keeps the local tip when it is the one ahead", () => {
    const branches = [
      b("origin/develop", "remote", "remote-sha"),
      b("develop", "local", "local-sha", { ahead: 2 }),
    ];
    expect(pinnedShas(branches)).toEqual(["local-sha"]);
  });

  it("falls back to the remote when no local branch exists", () => {
    expect(pinnedShas([b("origin/main", "remote", "r1")])).toEqual(["r1"]);
  });

  it("never repeats a sha claimed by an earlier group", () => {
    // develop has not diverged from main yet.
    const branches = [b("main", "local", "same"), b("develop", "local", "same")];
    expect(pinnedShas(branches)).toEqual(["same"]);
  });

  it("returns nothing for a repo with no conventional branches", () => {
    expect(pinnedShas([b("wip", "local", "w1")])).toEqual([]);
  });
});

describe("isPinnedBranch", () => {
  it("matches local trunk and integration branches only", () => {
    expect(isPinnedBranch(b("main", "local", "x"))).toBe(true);
    expect(isPinnedBranch(b("develop", "local", "x"))).toBe(true);
    expect(isPinnedBranch(b("feature/y", "local", "x"))).toBe(false);
    // A remote copy is listed in its own section, never pinned.
    expect(isPinnedBranch(b("origin/main", "remote", "x"))).toBe(false);
  });
});

describe("branchRole", () => {
  it("colours the trunk and integration branch by name", () => {
    expect(branchRole(b("master", "local", "x"))).toBe("trunk");
    expect(branchRole(b("main", "local", "x"))).toBe("trunk");
    expect(branchRole(b("develop", "local", "x"))).toBe("integration");
  });

  it("gives a remote copy the same role as its local branch", () => {
    // origin/master must read as the same thing as master.
    expect(branchRole(b("origin/master", "remote", "x"))).toBe("trunk");
    expect(branchRole(b("origin/develop", "remote", "x"))).toBe("integration");
  });

  it("gives an ordinary branch no role, checked out or not", () => {
    // Being checked out is shown by the filled badge and the check mark, not
    // by a colour: otherwise a branch changed colour when you switched to it.
    expect(branchRole(b("feature/login", "local", "x"))).toBe("other");
    expect(branchRole(b("origin/feature/login", "remote", "x"))).toBe("other");
  });
});
