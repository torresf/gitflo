import type { DeleteOutcome, RemoteBranchState, StaleBranch } from "../types";

/**
 * Whether a candidate can be deleted at all, and why not when it cannot.
 *
 * git itself refuses these, but finding out through a failed batch is a poor
 * experience: the checkbox is simply disabled with the reason shown.
 */
export function deletionBlocker(branch: StaleBranch): string | null {
  if (branch.isHead) return "branche courante";
  if (branch.worktreePath) {
    const name = branch.worktreePath.split("/").filter(Boolean).pop();
    return `ouverte dans ${name}`;
  }
  return null;
}

/**
 * Deleting this branch would actually lose work.
 *
 * Keyed on `contributesNothing` (does merging it change anything at all?), not
 * on the commit count. A branch merged through a squashed or rebased request
 * keeps commits nothing else has, yet every line of it already shipped —
 * counting those made the app warn "2 commits lost forever" about branches
 * that were fully delivered.
 */
export const needsForce = (branch: StaleBranch): boolean =>
  !branch.contributesNothing;

export interface PrunePlan {
  /** Safe to delete with `git branch -d`. */
  safe: StaleBranch[];
  /** Deletable, but only with `-D`: unique commits would be lost. */
  risky: StaleBranch[];
  /** Cannot be deleted at all right now. */
  blocked: StaleBranch[];
}

/**
 * Split candidates into what can be deleted safely, what needs a force, and
 * what git will refuse. Order within each group is preserved.
 */
export function planPrune(branches: StaleBranch[]): PrunePlan {
  const plan: PrunePlan = { safe: [], risky: [], blocked: [] };
  for (const branch of branches) {
    if (deletionBlocker(branch)) plan.blocked.push(branch);
    else if (needsForce(branch)) plan.risky.push(branch);
    else plan.safe.push(branch);
  }
  return plan;
}

/** Default selection: everything safe, nothing that loses work. */
export const defaultSelection = (branches: StaleBranch[]): Set<string> =>
  new Set(planPrune(branches).safe.map((b) => b.name));

export const REASON_LABEL: Record<StaleBranch["reason"], string> = {
  gone: "distante supprimée",
  merged: "déjà fusionnée",
};

/**
 * Failures worth retrying with `-D`, after a batch delete.
 *
 * `git branch -d` refuses anything not merged into HEAD, which is stricter
 * than "would deleting this lose commits": a branch whose work lives on a
 * remote, or was merged into a base other than the current branch, is refused
 * even though nothing would be lost. Retrying those forced is safe, and the
 * caller still gets told when it is not.
 */
export function retryableFailures(
  outcomes: DeleteOutcome[],
  branches: StaleBranch[],
): { names: string[]; losingWork: string[] } {
  const byName = new Map(branches.map((b) => [b.name, b]));
  const names: string[] = [];
  const losingWork: string[] = [];

  for (const outcome of outcomes) {
    if (outcome.deleted) continue;
    if (!outcome.message.includes("not fully merged")) continue;
    names.push(outcome.name);
    if ((byName.get(outcome.name)?.unmergedCommits ?? 0) > 0) {
      losingWork.push(outcome.name);
    }
  }

  return { names, losingWork };
}

/** A remote branch whose work is provably already in the base. */
export const isRemoteSafe = (branch: RemoteBranchState): boolean =>
  branch.merged || branch.equivalentMerged || branch.contributesNothing;

export type RemoteState = "merged" | "applied" | "ahead";

/**
 * How a remote branch stands against the base.
 *
 * `applied` is the one worth surfacing: a squashed or rebased merge request
 * leaves commits that `--merged` does not recognise, even though the change
 * itself shipped. Treating those as unmerged would keep dead branches around
 * forever.
 */
export function remoteState(branch: RemoteBranchState): RemoteState {
  if (branch.merged) return "merged";
  // `contributesNothing` also covers the squash/rebase case, and more besides:
  // a branch whose change reached the base by any route at all.
  if (branch.equivalentMerged || branch.contributesNothing) return "applied";
  return "ahead";
}

export const REMOTE_STATE_LABEL: Record<RemoteState, string> = {
  merged: "fusionnée",
  applied: "déjà appliquée",
  ahead: "non fusionnée",
};

/** Preselect only what is provably safe to delete from the server. */
export const defaultRemoteSelection = (branches: RemoteBranchState[]): Set<string> =>
  new Set(branches.filter(isRemoteSafe).map((b) => b.name));
