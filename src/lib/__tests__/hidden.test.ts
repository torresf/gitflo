import { describe, expect, it } from "vitest";
import { hiddenEntries, visibleRepos } from "../hidden";
import type { RepoGroup, Worktree } from "../../types";

const wt = (name: string, path: string, isPrimary = false): Worktree => ({
  path,
  name,
  branch: "main",
  head: "abc1234",
  upstream: null,
  ahead: 0,
  behind: 0,
  dirtyFiles: 0,
  stagedFiles: 0,
  untrackedFiles: 0,
  conflictedFiles: 0,
  isPrimary,
});

const repo = (name: string, worktrees: Worktree[]): RepoGroup => ({
  id: `/Users/flo/Projects/${name}/.git`,
  name,
  primaryPath: worktrees[0].path,
  worktrees,
});

const api = repo("api", [
  wt("api", "/p/api", true),
  wt("api-wip", "/p/api-wip"),
]);
const front = repo("web", [wt("web", "/p/web", true)]);
const render = repo("worker", [wt("worker", "/p/worker", true)]);
const all = [api, front, render];

describe("visibleRepos", () => {
  it("returns everything when nothing is hidden", () => {
    expect(visibleRepos(all, [])).toBe(all);
  });

  it("removes a hidden repo by id", () => {
    const visible = visibleRepos(all, [render.id]);
    expect(visible.map((r) => r.name)).toEqual(["api", "web"]);
  });

  it("removes a single hidden worktree, keeping its repo", () => {
    const visible = visibleRepos(all, ["/p/api-wip"]);
    const found = visible.find((r) => r.name === "api");
    expect(found!.worktrees.map((w) => w.name)).toEqual(["api"]);
  });

  it("drops a repo whose every worktree is hidden", () => {
    // An empty group would render as a header with nothing under it.
    const visible = visibleRepos(all, ["/p/api", "/p/api-wip"]);
    expect(visible.map((r) => r.name)).toEqual(["web", "worker"]);
  });

  it("ignores an entry matching nothing", () => {
    expect(visibleRepos(all, ["/gone"]).length).toBe(all.length);
  });

  it("does not mutate the input", () => {
    visibleRepos(all, ["/p/api-wip"]);
    expect(api.worktrees).toHaveLength(2);
  });
});

describe("hiddenEntries", () => {
  it("labels a hidden repo by its name", () => {
    expect(hiddenEntries(all, [render.id])).toEqual([
      { key: render.id, label: "worker", kind: "repo" },
    ]);
  });

  it("labels a hidden worktree with its repo", () => {
    expect(hiddenEntries(all, ["/p/api-wip"])).toEqual([
      { key: "/p/api-wip", label: "api › api-wip", kind: "worktree" },
    ]);
  });

  it("sorts by label", () => {
    const labels = hiddenEntries(all, [render.id, front.id]).map((e) => e.label);
    expect(labels).toEqual(["web", "worker"]);
  });

  it("still names an entry absent from the current scan", () => {
    // Hiding a repo then switching tab must not make it un-unhideable.
    const entries = hiddenEntries([], ["/Users/flo/Projects/ghost/.git", "/p/some-worktree"]);
    // Sorted by label, so "ghost" comes before "some-worktree".
    expect(entries).toEqual([
      { key: "/Users/flo/Projects/ghost/.git", label: "ghost", kind: "repo" },
      { key: "/p/some-worktree", label: "some-worktree", kind: "worktree" },
    ]);
  });
});
