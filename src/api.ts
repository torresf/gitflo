import { invoke } from "@tauri-apps/api/core";
import type {
  ActionResult,
  Branch,
  Commit,
  CommitDetail,
  RepoGroup,
  DeleteOutcome,
  Editor,
  FetchOutcome,
  PullMode,
  RemoteBranchState,
  StaleBranch,
  WebRemote,
  WorkingTree,
} from "./types";

export const api = {
  scanWorkspace: (roots: string[], maxDepth = 4) =>
    invoke<RepoGroup[]>("scan_workspace", { roots, maxDepth }),

  defaultRoots: () => invoke<string[]>("default_roots"),

  listBranches: (repo: string) => invoke<Branch[]>("list_branches", { repo }),

  listCommits: (repo: string, revs: string[], limit = 300, skip = 0) =>
    invoke<Commit[]>("list_commits", { repo, revs, limit, skip }),

  commitDetail: (repo: string, sha: string) =>
    invoke<CommitDetail>("commit_detail", { repo, sha }),

  fileDiff: (repo: string, sha: string, file: string) =>
    invoke<string>("file_diff", { repo, sha, file }),

  workingTree: (repo: string) => invoke<WorkingTree>("working_tree", { repo }),

  workingTreeDiff: (repo: string, file: string, untracked: boolean) =>
    invoke<string>("working_tree_diff", { repo, file, untracked }),

  staleBranches: (repo: string, base: string | null) =>
    invoke<StaleBranch[]>("stale_branches", { repo, base }),

  deleteBranches: (repo: string, names: string[], force: boolean) =>
    invoke<DeleteOutcome[]>("delete_branches", { repo, names, force }),

  remoteBranchesState: (repo: string, base: string) =>
    invoke<RemoteBranchState[]>("remote_branches_state", { repo, base }),

  deleteRemoteBranches: (repo: string, remote: string, branches: string[]) =>
    invoke<DeleteOutcome[]>("delete_remote_branches", { repo, remote, branches }),

  unmergedCommitCount: (repo: string, branch: string) =>
    invoke<number>("unmerged_commit_count", { repo, branch }),

  branchContribution: (repo: string, branch: string, base: string) =>
    invoke<[boolean, number]>("branch_contribution", { repo, branch, base }),

  checkout: (repo: string, branch: string) =>
    invoke<ActionResult>("checkout", { repo, branch }),

  checkoutRemote: (repo: string, local: string, remoteRef: string) =>
    invoke<ActionResult>("checkout_remote", { repo, local, remoteRef }),

  createBranch: (repo: string, name: string, start: string) =>
    invoke<ActionResult>("create_branch", { repo, name, start }),

  merge: (repo: string, branch: string, noFf = false) =>
    invoke<ActionResult>("merge", { repo, branch, noFf }),

  rebase: (repo: string, onto: string) =>
    invoke<ActionResult>("rebase", { repo, onto }),

  deleteBranch: (repo: string, branch: string, force = false) =>
    invoke<ActionResult>("delete_branch", { repo, branch, force }),

  removeWorktree: (repo: string, path: string, force: boolean) =>
    invoke<ActionResult>("remove_worktree", { repo, path, force }),

  discardWorktreeDirectory: (repo: string, path: string) =>
    invoke<ActionResult>("discard_worktree_directory", { repo, path }),

  pruneWorktrees: (repo: string) =>
    invoke<ActionResult>("prune_worktrees", { repo }),

  fetch: (repo: string, prune = true) =>
    invoke<ActionResult>("fetch", { repo, prune }),

  pull: (repo: string, mode: PullMode) =>
    invoke<ActionResult>("pull", { repo, mode }),

  /** Background fetch of several repos; per-repo outcomes, never throws as a whole. */
  fetchMany: (repos: string[]) => invoke<FetchOutcome[]>("fetch_many", { repos }),

  push: (repo: string, setUpstream: boolean) =>
    invoke<ActionResult>("push", { repo, setUpstream }),

  /** Web URL of the repo's remote (upstream's remote, else origin), or null. */
  remoteWebUrl: (repo: string, remote?: string) =>
    invoke<WebRemote | null>("remote_web_url", { repo, remote: remote ?? null }),

  /** Unix seconds of the last fetch, or null before the first one. */
  lastFetch: (repo: string) => invoke<number | null>("last_fetch", { repo }),

  readSettings: () => invoke<string | null>("read_settings"),

  writeSettings: (content: string) =>
    invoke<void>("write_settings", { content }),

  revealInFinder: (path: string) => invoke<void>("reveal_in_finder", { path }),

  openInEditor: (path: string, editor: Editor) =>
    invoke<void>("open_in_editor", { path, editor }),
};
