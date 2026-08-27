import type { RepoGroup } from "../types";

export interface HiddenEntry {
  /** Repo id or worktree path, as stored in the workspace. */
  key: string;
  label: string;
  /** A whole repo, or a single linked worktree. */
  kind: "repo" | "worktree";
}

/**
 * Apply a tab's hidden list to the scan result.
 *
 * Hiding every worktree of a repo hides the repo: leaving an empty group behind
 * would show a header with nothing under it.
 */
export function visibleRepos(repos: RepoGroup[], hidden: string[]): RepoGroup[] {
  if (hidden.length === 0) return repos;
  const hiddenSet = new Set(hidden);

  return repos
    .filter((repo) => !hiddenSet.has(repo.id))
    .map((repo) => ({
      ...repo,
      worktrees: repo.worktrees.filter((w) => !hiddenSet.has(w.path)),
    }))
    .filter((repo) => repo.worktrees.length > 0);
}

const basename = (path: string) =>
  path.split("/").filter(Boolean).pop() ?? path;

/**
 * Human-readable list of what a tab hides, for the unhide menu.
 *
 * Labels are resolved against the current scan, falling back to the path's last
 * segment so an entry whose folder has since disappeared can still be unhidden
 * rather than being stuck in the list forever.
 */
export function hiddenEntries(repos: RepoGroup[], hidden: string[]): HiddenEntry[] {
  const repoById = new Map(repos.map((r) => [r.id, r]));
  const worktreeByPath = new Map(
    repos.flatMap((r) => r.worktrees.map((w) => [w.path, { repo: r, worktree: w }])),
  );

  return hidden
    .map((key): HiddenEntry => {
      const repo = repoById.get(key);
      if (repo) return { key, label: repo.name, kind: "repo" };

      const found = worktreeByPath.get(key);
      if (found) {
        return {
          key,
          label: `${found.repo.name} › ${found.worktree.name}`,
          kind: "worktree",
        };
      }

      // Unknown to this scan: a repo id points at a `.git` dir, so name it
      // after the checkout that owns it rather than after ".git".
      const segments = key.split("/").filter(Boolean);
      const isGitDir = segments[segments.length - 1] === ".git";
      return {
        key,
        label: isGitDir ? (segments[segments.length - 2] ?? key) : basename(key),
        kind: isGitDir ? "repo" : "worktree",
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
}
