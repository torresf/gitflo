import { describe, expect, it } from "vitest";
import { branchUrl, commitUrl, openOnLabel, publishedName } from "../webUrl";
import type { Branch, WebRemote } from "../../types";

const github: WebRemote = { base: "https://github.com/acme/app", kind: "github" };
const gitlab: WebRemote = { base: "https://gitlab.com/acme/team/app", kind: "gitlab" };
const bitbucket: WebRemote = { base: "https://bitbucket.org/acme/app", kind: "bitbucket" };
const gitea: WebRemote = { base: "https://git.acme.dev/acme/app", kind: "other" };

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
  subject: "feat",
  isHead: false,
  worktreePath: null,
  remote: null,
  ...over,
});

describe("commitUrl", () => {
  it("follows each host's path shape", () => {
    expect(commitUrl(github, "abc")).toBe("https://github.com/acme/app/commit/abc");
    expect(commitUrl(gitlab, "abc")).toBe("https://gitlab.com/acme/team/app/-/commit/abc");
    expect(commitUrl(bitbucket, "abc")).toBe("https://bitbucket.org/acme/app/commits/abc");
    expect(commitUrl(gitea, "abc")).toBe("https://git.acme.dev/acme/app/commit/abc");
  });
});

describe("branchUrl", () => {
  it("keeps the slashes of a prefixed branch and escapes the rest", () => {
    expect(branchUrl(github, "feature/a#b")).toBe(
      "https://github.com/acme/app/tree/feature/a%23b",
    );
    expect(branchUrl(gitlab, "feature/x")).toBe(
      "https://gitlab.com/acme/team/app/-/tree/feature/x",
    );
    expect(branchUrl(bitbucket, "main")).toBe("https://bitbucket.org/acme/app/branch/main");
  });
});

describe("publishedName", () => {
  it("uses the upstream's name, which may differ from the local one", () => {
    expect(publishedName(branch({ short: "x", upstream: "origin/feature/x" }))).toBe(
      "feature/x",
    );
  });

  it("strips the remote of a remote branch", () => {
    expect(
      publishedName(branch({ kind: "remote", short: "origin/feature/x", upstream: null })),
    ).toBe("feature/x");
  });

  it("is null for a branch the server does not have", () => {
    expect(publishedName(branch({ upstream: null }))).toBeNull();
    expect(publishedName(branch({ gone: true }))).toBeNull();
  });
});

describe("openOnLabel", () => {
  it("names the host when known", () => {
    expect(openOnLabel(github)).toBe("Ouvrir sur GitHub");
    expect(openOnLabel(gitea)).toBe("Ouvrir sur le web");
  });
});
