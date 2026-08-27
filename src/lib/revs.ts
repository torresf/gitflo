import type { Branch } from "../types";

/** A branch filter is only meaningful for the repo it was picked in. */
export interface BranchFilter {
  repoPath: string;
  branch: Branch;
}

/**
 * Revisions to pass to `git log`, given the active filter and the repo now
 * selected.
 *
 * The pairing is load-bearing. Selecting another repo changes `repoPath` before
 * any filter reset lands, so a filter carried over from the previous repo used
 * to reach git as `git log refs/heads/main` inside a repo that has no `main`
 * ("fatal: ambiguous argument"). Keying the filter to its repo makes the
 * mismatch unrepresentable instead of racing a reset.
 */
export function resolveRevs(
  filter: BranchFilter | null,
  repoPath: string | null,
): string[] {
  if (!filter || !repoPath) return [];
  if (filter.repoPath !== repoPath) return [];

  const { branch } = filter;
  const revs = [branch.refname];

  // Include the upstream alongside a local branch: they are one line of
  // development, and showing only the local side hides commits that exist on
  // the remote but have not been pulled — precisely what you filter a branch
  // to look at. A dead upstream (`gone`) is skipped: git would error on it.
  if (branch.kind === "local" && branch.upstream && !branch.gone) {
    revs.push(`refs/remotes/${branch.upstream}`);
  }

  return revs;
}

/** The filter to display, i.e. only when it belongs to the current repo. */
export function activeFilter(
  filter: BranchFilter | null,
  repoPath: string | null,
): Branch | null {
  if (!filter || !repoPath) return null;
  return filter.repoPath === repoPath ? filter.branch : null;
}
