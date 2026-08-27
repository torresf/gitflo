export interface Worktree {
  path: string;
  name: string;
  branch: string | null;
  head: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  dirtyFiles: number;
  stagedFiles: number;
  untrackedFiles: number;
  conflictedFiles: number;
  isPrimary: boolean;
}

export interface RepoGroup {
  id: string;
  name: string;
  primaryPath: string;
  worktrees: Worktree[];
}

export interface Branch {
  refname: string;
  short: string;
  kind: "local" | "remote";
  sha: string;
  shortSha: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  gone: boolean;
  date: string;
  author: string;
  subject: string;
  isHead: boolean;
  worktreePath: string | null;
  remote: string | null;
}

export interface Commit {
  sha: string;
  shortSha: string;
  parents: string[];
  author: string;
  email: string;
  date: string;
  subject: string;
  refs: string[];
}

export interface ChangedFile {
  path: string;
  oldPath: string | null;
  status: string;
  additions: number;
  deletions: number;
  binary: boolean;
}

export interface CommitDetail {
  sha: string;
  shortSha: string;
  parents: string[];
  author: string;
  email: string;
  authorDate: string;
  committer: string;
  committerDate: string;
  subject: string;
  body: string;
  refs: string[];
  files: ChangedFile[];
}

export interface WorkingTree {
  files: ChangedFile[];
  stagedCount: number;
  unstagedCount: number;
  untrackedCount: number;
  conflictedCount: number;
}

export interface ActionResult {
  ok: boolean;
  output: string;
}

export interface StaleBranch {
  name: string;
  sha: string;
  shortSha: string;
  upstream: string | null;
  date: string;
  subject: string;
  /** "gone" (upstream deleted) or "merged" (contained in the base branch). */
  reason: "gone" | "merged";
  unmergedCommits: number;
  /** Merging it into the base would produce no change at all. */
  contributesNothing: boolean;
  worktreePath: string | null;
  isHead: boolean;
}

export interface DeleteOutcome {
  name: string;
  deleted: boolean;
  message: string;
}

export interface RemoteBranchState {
  /** Short ref as git shows it, e.g. "origin/fix/x". */
  name: string;
  remote: string;
  /** Branch name on the remote, i.e. what `push --delete` takes. */
  branch: string;
  shortSha: string;
  date: string;
  subject: string;
  author: string;
  merged: boolean;
  unmergedCommits: number;
  /** Every change already exists in the base, patch-wise (squash/rebase). */
  equivalentMerged: boolean;
  unappliedCommits: number;
  /** Merging it into the base would produce no change at all. */
  contributesNothing: boolean;
  hasLocal: boolean;
}
