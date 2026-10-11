import type { Branch, WebRemote } from "../types";
import { stripRemote } from "./format";

const HOST_NAME: Record<WebRemote["kind"], string> = {
  github: "GitHub",
  gitlab: "GitLab",
  bitbucket: "Bitbucket",
  other: "le web",
};

/** Menu label, e.g. "Ouvrir sur GitHub". */
export const openOnLabel = (remote: WebRemote) => `Ouvrir sur ${HOST_NAME[remote.kind]}`;

/** Keep the slashes of `feature/login`, escape everything else. */
const encodePath = (name: string) => name.split("/").map(encodeURIComponent).join("/");

export function commitUrl(remote: WebRemote, sha: string): string {
  switch (remote.kind) {
    case "gitlab":
      return `${remote.base}/-/commit/${sha}`;
    case "bitbucket":
      return `${remote.base}/commits/${sha}`;
    default:
      // GitHub's shape, which GitHub Enterprise, Gitea and Forgejo share.
      return `${remote.base}/commit/${sha}`;
  }
}

export function branchUrl(remote: WebRemote, branch: string): string {
  const path = encodePath(branch);
  switch (remote.kind) {
    case "gitlab":
      return `${remote.base}/-/tree/${path}`;
    case "bitbucket":
      return `${remote.base}/branch/${path}`;
    default:
      return `${remote.base}/tree/${path}`;
  }
}

/**
 * Name of the branch as the server knows it, or null when it has no copy
 * there: a local branch never pushed, or whose upstream was deleted.
 */
export function publishedName(branch: Branch): string | null {
  if (branch.kind === "remote") return stripRemote(branch.short);
  if (!branch.upstream || branch.gone) return null;
  return stripRemote(branch.upstream);
}
