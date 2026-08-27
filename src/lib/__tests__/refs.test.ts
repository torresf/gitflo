import { describe, expect, it } from "vitest";
import { groupRefs, parseRef, resolveBadgeBranch } from "../refs";
import type { Branch } from "../../types";

describe("parseRef", () => {
  it("classifies each namespace", () => {
    expect(parseRef("refs/heads/master")).toEqual({
      raw: "refs/heads/master",
      kind: "local",
      label: "master",
      isHead: false,
    });
    expect(parseRef("refs/tags/v2.8.7")?.kind).toBe("tag");
    expect(parseRef("refs/tags/v2.8.7")?.label).toBe("v2.8.7");
    expect(parseRef("refs/remotes/origin/develop")?.kind).toBe("remote");
    expect(parseRef("refs/remotes/origin/develop")?.label).toBe("origin/develop");
  });

  it("keeps a slash-bearing local branch local", () => {
    // The whole point of --decorate=full: this is NOT a remote.
    const parsed = parseRef("refs/heads/feature/login");
    expect(parsed?.kind).toBe("local");
    expect(parsed?.label).toBe("feature/login");
  });

  it("marks the checked-out branch", () => {
    const parsed = parseRef("HEAD -> refs/heads/develop");
    expect(parsed?.isHead).toBe(true);
    expect(parsed?.kind).toBe("local");
    expect(parsed?.label).toBe("develop");
  });

  it("names a detached HEAD", () => {
    expect(parseRef("HEAD")?.label).toBe("HEAD détaché");
  });

  it("drops origin/HEAD", () => {
    // A symbolic pointer to the remote's default branch: always duplicates
    // another badge on the same commit.
    expect(parseRef("refs/remotes/origin/HEAD")).toBeNull();
    expect(parseRef("refs/remotes/upstream/HEAD")).toBeNull();
  });

  it("keeps a real branch that merely ends in HEAD-like text", () => {
    expect(parseRef("refs/remotes/origin/fix/HEADER")?.label).toBe(
      "origin/fix/HEADER",
    );
  });

  it("ignores empty entries", () => {
    expect(parseRef("   ")).toBeNull();
  });

  it("passes through an unqualified ref rather than dropping it", () => {
    expect(parseRef("master")?.label).toBe("master");
  });
});

describe("parseRef with git's tag prefix", () => {
  it("reads a tag decorated as \"tag: refs/tags/x\"", () => {
    // git puts the marker BEFORE the qualified path; missing it showed the
    // badge as the raw string "tag: refs/tags/v2.8.7", coloured as a branch.
    const parsed = parseRef("tag: refs/tags/v2.8.7");
    expect(parsed).toEqual({
      raw: "tag: refs/tags/v2.8.7",
      kind: "tag",
      label: "v2.8.7",
      isHead: false,
    });
  });

  it("still reads a bare tag path", () => {
    expect(parseRef("refs/tags/v1")?.label).toBe("v1");
  });

  it("tolerates a tag marker with an unqualified name", () => {
    expect(parseRef("tag: v1")?.label).toBe("v1");
  });
});

describe("groupRefs", () => {
  // The real decoration of the MEP v2.8.7 commit.
  const mep = [
    "tag: refs/tags/v2.8.7",
    "refs/remotes/origin/master",
    "refs/remotes/origin/HEAD",
    "refs/heads/master",
  ];

  it("merges a branch present locally and on a remote into one badge", () => {
    const badges = groupRefs(mep);
    expect(badges).toHaveLength(2);
    const master = badges.find((b) => b.label === "master")!;
    expect(master.hasLocal).toBe(true);
    expect(master.hasRemote).toBe(true);
    expect(master.remotes).toEqual(["origin"]);
    // Trunk colour, not the generic local one.
    expect(master.role).toBe("trunk");
  });

  it("puts the branch before the tag", () => {
    expect(groupRefs(mep).map((b) => b.label)).toEqual(["master", "v2.8.7"]);
  });

  it("drops the remote prefix from the label", () => {
    const badges = groupRefs(["refs/remotes/origin/fix/crash"]);
    expect(badges[0].label).toBe("fix/crash");
    expect(badges[0].hasLocal).toBe(false);
    expect(badges[0].hasRemote).toBe(true);
  });

  it("collects several remotes under one badge", () => {
    const badges = groupRefs([
      "refs/remotes/origin/master",
      "refs/remotes/upstream/master",
    ]);
    expect(badges).toHaveLength(1);
    expect(badges[0].remotes).toEqual(["origin", "upstream"]);
    expect(badges[0].hasLocal).toBe(false);
  });

  it("leads with the checked-out branch and marks it", () => {
    const badges = groupRefs([
      "refs/remotes/origin/develop",
      "tag: refs/tags/v9",
      "HEAD -> refs/heads/develop",
    ]);
    expect(badges[0].label).toBe("develop");
    expect(badges[0].isHead).toBe(true);
    // Merged with its remote copy despite arriving separately.
    expect(badges[0].hasLocal && badges[0].hasRemote).toBe(true);
    expect(badges[0].role).toBe("integration");
  });

  it("never merges a tag with a branch of the same name", () => {
    const badges = groupRefs(["refs/heads/v1", "tag: refs/tags/v1"]);
    expect(badges).toHaveLength(2);
    expect(badges.filter((b) => b.isTag)).toHaveLength(1);
  });

  it("gives a tag no branch role", () => {
    // A tag named "master" must not be painted as the trunk.
    const badges = groupRefs(["tag: refs/tags/master"]);
    expect(badges[0].isTag).toBe(true);
    expect(badges[0].role).toBe("other");
  });

  it("ignores origin/HEAD entirely", () => {
    expect(groupRefs(["refs/remotes/origin/HEAD"])).toEqual([]);
  });

  it("ranks local-only above remote-only", () => {
    const badges = groupRefs([
      "refs/remotes/origin/other",
      "refs/heads/mine",
    ]);
    expect(badges.map((b) => b.label)).toEqual(["mine", "other"]);
  });
});

describe("resolveBadgeBranch", () => {
  const branch = (short: string, kind: "local" | "remote"): Branch => ({
    refname: kind === "local" ? `refs/heads/${short}` : `refs/remotes/${short}`,
    short,
    kind,
    sha: "abc",
    shortSha: "abc",
    upstream: null,
    ahead: 0,
    behind: 0,
    gone: false,
    date: "2026-08-25T10:00:00Z",
    author: "T",
    subject: "s",
    isHead: false,
    worktreePath: null,
    remote: kind === "remote" ? short.split("/")[0] : null,
  });

  const branches = [
    branch("master", "local"),
    branch("origin/master", "remote"),
    branch("origin/only-remote", "remote"),
  ];

  it("prefers the local branch of a merged badge", () => {
    const [badge] = groupRefs(["refs/heads/master", "refs/remotes/origin/master"]);
    expect(resolveBadgeBranch(badge, branches)?.kind).toBe("local");
  });

  it("resolves a remote-only badge to its remote ref", () => {
    const [badge] = groupRefs(["refs/remotes/origin/only-remote"]);
    const found = resolveBadgeBranch(badge, branches);
    expect(found?.kind).toBe("remote");
    expect(found?.short).toBe("origin/only-remote");
  });

  it("returns nothing for a tag", () => {
    const [badge] = groupRefs(["tag: refs/tags/v1"]);
    expect(resolveBadgeBranch(badge, branches)).toBeNull();
  });

  it("returns nothing when the branch is unknown", () => {
    const [badge] = groupRefs(["refs/remotes/origin/vanished"]);
    expect(resolveBadgeBranch(badge, branches)).toBeNull();
  });
});
