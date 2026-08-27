import type { Branch } from "../types";

/**
 * Lane order for the graph gutter, left to right. The trunk should read as the
 * leftmost vertical line, the integration branch next to it, and every feature
 * branch to their right.
 */
export const PINNED_GROUPS: string[][] = [
  ["main", "master"],
  ["develop", "dev"],
];

/**
 * Resolve the pinned groups to commit shas, in lane order.
 *
 * Reserves the sha of whichever tip is AHEAD, local or remote. Reserving the
 * local tip while `origin/develop` sits one commit further along means nothing
 * awaits that remote commit when the walk reaches it, so it opens a lane of its
 * own off to the right — the same line of development drawn twice. Reserving
 * the leading tip puts both on one lane, the local one landing on it as an
 * ancestor.
 *
 * When the two have diverged (each holds commits the other lacks) they cannot
 * share a lane; the local tip wins, since that is the one being worked on.
 *
 * Groups that resolve to nothing are dropped rather than leaving a hole, so
 * `develop` still lands leftmost in a repo with no `main`.
 */
export function pinnedShas(branches: Branch[]): string[] {
  const shas: string[] = [];

  for (const group of PINNED_GROUPS) {
    const local = branches.find(
      (b) => b.kind === "local" && group.includes(b.short),
    );
    const remote = branches.find(
      (b) => b.kind === "remote" && group.includes(b.short.split("/").slice(1).join("/")),
    );

    // behind > 0 means the upstream holds commits this branch does not; with
    // no local commits of its own, the remote tip is strictly ahead.
    const remoteLeads =
      !!local && !!remote && local.behind > 0 && local.ahead === 0;
    const chosen = remoteLeads ? remote : (local ?? remote);

    // Two pinned groups can point at the same commit (develop not yet ahead of
    // main); a sha may only claim one lane.
    if (chosen?.sha && !shas.includes(chosen.sha)) shas.push(chosen.sha);
  }

  return shas;
}

/** True for a branch that should be listed above the others. */
export function isPinnedBranch(branch: Branch): boolean {
  if (branch.kind !== "local") return false;
  return PINNED_GROUPS.some((group) => group.includes(branch.short));
}

export type BranchRole = "trunk" | "integration" | "other";

/**
 * Role of a bare branch name, for colouring.
 *
 * Being checked out is NOT a role: the current branch keeps its own colour and
 * is marked by other means (filled badge, halo, check mark). Colouring it
 * specially meant a branch changed colour as soon as you switched to it.
 */
export function roleForName(bare: string): BranchRole {
  const group = PINNED_GROUPS.findIndex((names) => names.includes(bare));
  if (group === 0) return "trunk";
  if (group === 1) return "integration";
  return "other";
}

/**
 * Role of a branch, matching the graph lanes exactly: the trunk and the
 * integration branch keep their colour whether they are local or the remote
 * copy, so `master` and `origin/master` read as the same thing.
 */
export function branchRole(branch: Branch): BranchRole {
  const bare =
    branch.kind === "remote"
      ? branch.short.split("/").slice(1).join("/")
      : branch.short;
  return roleForName(bare);
}
