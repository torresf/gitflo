import { describe, expect, it } from "vitest";
import { branchTip, refBadgeTip, wipTip, worktreeTip } from "../tips";
import { groupRefs } from "../refs";
import type { Branch, Worktree } from "../../types";

const branch = (over: Partial<Branch> = {}): Branch => ({
  refname: "refs/heads/feature/x",
  short: "feature/x",
  kind: "local",
  sha: "abc1234def",
  shortSha: "abc1234",
  upstream: "origin/feature/x",
  ahead: 0,
  behind: 0,
  gone: false,
  date: "2026-08-25T10:00:00Z",
  author: "Dev One",
  subject: "feat: quelque chose",
  isHead: false,
  worktreePath: null,
  remote: null,
  ...over,
});

const labels = (badges?: { label: string }[]) => (badges ?? []).map((b) => b.label);

describe("branchTip", () => {
  it("explains the gone state instead of just showing an icon", () => {
    const tip = branchTip(branch({ gone: true }), "develop");
    expect(tip.warning).toContain("n'existe plus sur le distant");
    // The upstream that vanished must be named.
    expect(tip.warning).toContain("origin/feature/x");
  });

  it("does not show a stale upstream row for a gone branch", () => {
    const rows = branchTip(branch({ gone: true }), "develop").rows ?? [];
    expect(rows.some((r) => r.label === "Suit")).toBe(false);
  });

  it("shows the upstream when it is alive", () => {
    const rows = branchTip(branch(), "develop").rows ?? [];
    expect(rows.find((r) => r.label === "Suit")?.value).toBe("origin/feature/x");
  });

  it("spells out ahead and behind", () => {
    const tip = branchTip(branch({ ahead: 2, behind: 3 }), "develop");
    expect(labels(tip.badges)).toEqual(
      expect.arrayContaining(["locale", "↑ 2 à pousser", "↓ 3 à récupérer"]),
    );
  });

  it("flags the current branch", () => {
    const tip = branchTip(branch({ short: "develop" }), "develop");
    expect(labels(tip.badges)).toContain("branche courante");
  });

  it("explains a branch held by another worktree", () => {
    const tip = branchTip(
      branch({ worktreePath: "/p/api-wip" }),
      "develop",
    );
    expect(tip.warning).toContain("api-wip");
  });

  it("prefers the gone warning over the worktree one", () => {
    // Both can be true; the dead upstream is the actionable fact.
    const tip = branchTip(
      branch({ gone: true, worktreePath: "/p/other" }),
      "develop",
    );
    expect(tip.warning).toContain("n'existe plus");
  });
});

describe("worktreeTip", () => {
  const worktree = (over: Partial<Worktree> = {}): Worktree => ({
    path: "/p/api",
    name: "api",
    branch: "develop",
    head: "abc1234",
    upstream: "origin/develop",
    ahead: 0,
    behind: 0,
    dirtyFiles: 0,
    stagedFiles: 0,
    untrackedFiles: 0,
    conflictedFiles: 0,
    isPrimary: true,
    ...over,
  });

  it("says clean when there is nothing to report", () => {
    expect(labels(worktreeTip(worktree(), "api").badges)).toContain("propre");
  });

  it("never says clean when files are pending", () => {
    const tip = worktreeTip(worktree({ dirtyFiles: 3 }), "api");
    expect(labels(tip.badges)).toContain("3 modifs");
    expect(labels(tip.badges)).not.toContain("propre");
  });

  it("distinguishes a linked worktree from the primary checkout", () => {
    expect(labels(worktreeTip(worktree({ isPrimary: false }), "api").badges))
      .toContain("worktree lié");
  });

  it("names the parent repo when the folder differs", () => {
    const tip = worktreeTip(worktree({ name: "api-wip" }), "api");
    expect(tip.subtitle).toBe("dépôt api");
  });
});

describe("refBadgeTip", () => {
  it("describes a branch present on both sides", () => {
    const [badge] = groupRefs(["refs/heads/master", "refs/remotes/origin/master"]);
    const tip = refBadgeTip(badge, false);
    expect(labels(tip.badges)).toEqual(["locale", "distante · origin"]);
    expect(tip.hint).toContain("Double-clic");
  });

  it("offers no action on a tag or on the current branch", () => {
    const [tag] = groupRefs(["tag: refs/tags/v1"]);
    expect(refBadgeTip(tag, false).hint).toBeUndefined();

    const [head] = groupRefs(["refs/heads/develop"]);
    expect(refBadgeTip(head, true).hint).toBeUndefined();
  });
});

describe("wipTip", () => {
  it("lists only the non-empty categories", () => {
    const tip = wipTip({ staged: 0, unstaged: 2, untracked: 5, conflicted: 0 });
    expect(labels(tip.badges)).toEqual(["2 modifiés", "5 non suivis"]);
  });

  it("leads with conflicts", () => {
    const tip = wipTip({ staged: 1, unstaged: 1, untracked: 1, conflicted: 2 });
    expect(labels(tip.badges)[0]).toBe("2 en conflit");
  });
});

describe("branchTip hints", () => {
  it("advertises double-click on a checkoutable branch", () => {
    expect(branchTip(branch(), "develop").hint).toContain("Double-clic");
  });

  it("does not offer checkout on the current branch", () => {
    expect(branchTip(branch({ short: "develop" }), "develop").hint).not.toContain(
      "Double-clic",
    );
  });

  it("does not offer checkout on a branch held by a worktree", () => {
    // git would refuse it; the context menu says why.
    const tip = branchTip(branch({ worktreePath: "/p/wip" }), "develop");
    expect(tip.hint).not.toContain("Double-clic");
  });
});
