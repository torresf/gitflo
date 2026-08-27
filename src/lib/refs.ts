/**
 * Commit decorations (`%D`).
 *
 * Read with `--decorate=full`, so refs arrive fully qualified
 * (`refs/heads/…`, `refs/remotes/…`, `refs/tags/…`). The short form is
 * ambiguous: a local `feature/login` and a remote `origin/login` both
 * look like "something/something", and there is no way to tell which badge is
 * the branch you can actually check out.
 */
import type { Branch } from "../types";
import { roleForName, type BranchRole } from "./pinned";

export type RefKind = "local" | "tag" | "remote";

export interface ParsedRef {
  raw: string;
  kind: RefKind;
  label: string;
  /** This ref is where HEAD points, i.e. the checked-out branch. */
  isHead: boolean;
}

const HEADS = "refs/heads/";
const REMOTES = "refs/remotes/";
const TAGS = "refs/tags/";
/** git decorates tags as "tag: refs/tags/v1", prefix included. */
const TAG_MARKER = "tag: ";

/**
 * Parse one decoration entry, or return null for entries not worth a badge.
 *
 * `refs/remotes/*​/HEAD` is dropped: it is a symbolic pointer recording which
 * branch the remote considers default (what a fresh `git clone` checks out).
 * It always duplicates another badge on the same commit and never tells you
 * anything about this commit.
 */
export function parseRef(raw: string): ParsedRef | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // "HEAD -> refs/heads/develop"
  const arrow = trimmed.indexOf(" -> ");
  if (arrow !== -1) {
    const target = trimmed.slice(arrow + 4).trim();
    const parsed = parseRef(target);
    return parsed ? { ...parsed, isHead: true, raw: trimmed } : null;
  }

  if (trimmed.startsWith(TAG_MARKER)) {
    const rest = trimmed.slice(TAG_MARKER.length).trim();
    const label = rest.startsWith(TAGS) ? rest.slice(TAGS.length) : rest;
    return { raw: trimmed, kind: "tag", label, isHead: false };
  }

  // A detached HEAD decorates as a bare "HEAD".
  if (trimmed === "HEAD") {
    return { raw: trimmed, kind: "local", label: "HEAD détaché", isHead: true };
  }

  if (trimmed.startsWith(TAGS)) {
    return {
      raw: trimmed,
      kind: "tag",
      label: trimmed.slice(TAGS.length),
      isHead: false,
    };
  }

  if (trimmed.startsWith(REMOTES)) {
    const label = trimmed.slice(REMOTES.length);
    if (label.endsWith("/HEAD")) return null;
    return { raw: trimmed, kind: "remote", label, isHead: false };
  }

  if (trimmed.startsWith(HEADS)) {
    return {
      raw: trimmed,
      kind: "local",
      label: trimmed.slice(HEADS.length),
      isHead: false,
    };
  }

  // Unqualified (a repo read without --decorate=full, or an exotic ref
  // namespace): show it rather than swallowing it.
  return { raw: trimmed, kind: "local", label: trimmed, isHead: false };
}

/**
 * One badge as drawn on a row.
 *
 * A branch that exists both locally and on a remote at the same commit is ONE
 * badge carrying both icons, not two badges: `master` + `origin/master` said
 * the same thing twice and pushed the useful refs into the "+N" overflow. The
 * remote prefix is dropped for the same reason — the cloud icon already says
 * "remote", and `origin/` costs seven characters on every row.
 */
export interface RefBadgeModel {
  key: string;
  /** Bare name: no `refs/…`, no `origin/` prefix. */
  label: string;
  isTag: boolean;
  hasLocal: boolean;
  hasRemote: boolean;
  isHead: boolean;
  role: BranchRole;
  /** Remotes carrying this branch, for the tooltip. */
  remotes: string[];
}

/** Bare branch name: strip the leading remote, keeping any slashes after it. */
function bareName(parsed: ParsedRef): string {
  if (parsed.kind !== "remote") return parsed.label;
  return parsed.label.split("/").slice(1).join("/");
}

const remoteOf = (parsed: ParsedRef): string => parsed.label.split("/")[0] ?? "";

/** Ordering rank: the refs you act on must never be the ones truncated away. */
function badgeRank(badge: RefBadgeModel): number {
  if (badge.isHead) return 0;
  if (badge.isTag) return badge.hasLocal || badge.hasRemote ? 2 : 3;
  return badge.hasLocal ? 1 : 4;
}

export function groupRefs(refs: string[]): RefBadgeModel[] {
  const parsed = refs
    .map(parseRef)
    .filter((r): r is ParsedRef => r !== null);

  const byKey = new Map<string, RefBadgeModel>();
  const order: string[] = [];

  for (const ref of parsed) {
    const bare = bareName(ref);
    // Tags share a namespace of their own: a tag "v1" and a branch "v1" are
    // different things and must not merge into one badge.
    const key = ref.kind === "tag" ? `tag:${bare}` : `branch:${bare}`;

    let badge = byKey.get(key);
    if (!badge) {
      badge = {
        key,
        label: bare,
        isTag: ref.kind === "tag",
        hasLocal: false,
        hasRemote: false,
        isHead: false,
        role: "other",
        remotes: [],
      };
      byKey.set(key, badge);
      order.push(key);
    }

    if (ref.kind === "local") badge.hasLocal = true;
    if (ref.kind === "remote") {
      badge.hasRemote = true;
      const remote = remoteOf(ref);
      if (remote && !badge.remotes.includes(remote)) badge.remotes.push(remote);
    }
    if (ref.isHead) badge.isHead = true;
  }

  const badges = order.map((key) => {
    const badge = byKey.get(key)!;
    return {
      ...badge,
      role: badge.isTag ? "other" : roleForName(badge.label),
    } as RefBadgeModel;
  });

  return badges
    .map((badge, index) => ({ badge, index }))
    .sort((a, b) => {
      const byRank = badgeRank(a.badge) - badgeRank(b.badge);
      // Stable within a rank: keep git's ordering.
      return byRank !== 0 ? byRank : a.index - b.index;
    })
    .map(({ badge }) => badge);
}

/**
 * Resolve a badge back to the branch it stands for, so a badge can drive the
 * same actions as the branch list.
 *
 * A badge merges a local branch with its remote copies, so prefer the local
 * one: that is what `git checkout <name>` and `git merge <name>` act on. A
 * remote-only badge resolves to the remote ref, which the checkout path knows
 * how to track.
 */
export function resolveBadgeBranch(
  badge: RefBadgeModel,
  branches: Branch[],
): Branch | null {
  if (badge.isTag) return null;

  if (badge.hasLocal) {
    const local = branches.find(
      (b) => b.kind === "local" && b.short === badge.label,
    );
    if (local) return local;
  }

  for (const remote of badge.remotes) {
    const found = branches.find(
      (b) => b.kind === "remote" && b.short === `${remote}/${badge.label}`,
    );
    if (found) return found;
  }

  // Last resort: any branch of that bare name (the branch list may lag a scan).
  return (
    branches.find((b) => b.kind === "local" && b.short === badge.label) ?? null
  );
}
