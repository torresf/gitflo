import type { Branch, Commit, Worktree } from "../types";
import type { RefBadgeModel } from "./refs";
import { absoluteTime, relativeTime } from "./format";
import type { TipBadge, TipContent } from "./tooltip";

const basename = (path: string) => path.split("/").filter(Boolean).pop() ?? path;

/** Ahead/behind, shown the same way everywhere. */
function syncBadges(ahead: number, behind: number): TipBadge[] {
  const badges: TipBadge[] = [];
  if (ahead > 0) badges.push({ label: `↑ ${ahead} à pousser`, tone: "ahead" });
  if (behind > 0) badges.push({ label: `↓ ${behind} à récupérer`, tone: "accent" });
  return badges;
}

export function branchTip(branch: Branch, currentBranch: string | null): TipContent {
  const isCurrent = branch.kind === "local" && branch.short === currentBranch;
  const badges: TipBadge[] = [];

  badges.push(
    branch.kind === "remote"
      ? { label: "distante", tone: "muted" }
      : { label: "locale", tone: "default" },
  );
  if (isCurrent) badges.push({ label: "branche courante", tone: "behind" });
  badges.push(...syncBadges(branch.ahead, branch.behind));

  const rows = [
    { label: "Dernier", value: branch.subject || "—" },
    { label: "Par", value: branch.author || "—" },
    { label: "Le", value: absoluteTime(branch.date) },
    { label: "SHA", value: branch.shortSha },
  ];

  if (branch.upstream && !branch.gone) {
    rows.push({ label: "Suit", value: branch.upstream });
  }

  // The whole point of the red broken-link icon, spelled out.
  const warning = branch.gone
    ? `Son upstream ${branch.upstream ?? ""} n'existe plus sur le distant — branche supprimée après merge, le plus souvent. Cette copie locale peut sans doute être supprimée.`.replace(
        "  ",
        " ",
      )
    : branch.worktreePath && !isCurrent
      ? `Déjà checkoutée dans le worktree « ${basename(branch.worktreePath)} » : git refuse de la sortir deux fois.`
      : undefined;

  return {
    title: branch.short,
    subtitle: relativeTime(branch.date),
    badges,
    rows,
    warning,
    hint: isCurrent
      ? "Clic : voir son dernier commit · Clic droit : merge, rebase…"
      : branch.worktreePath
        ? "Clic : voir son dernier commit · Clic droit : actions"
        : "Clic : dernier commit · Double-clic : checkout · Clic droit : actions",
  };
}

export function worktreeTip(worktree: Worktree, repoName: string): TipContent {
  const changes =
    worktree.stagedFiles + worktree.dirtyFiles + worktree.untrackedFiles;
  const badges: TipBadge[] = [];

  if (worktree.isPrimary) badges.push({ label: "dépôt principal", tone: "muted" });
  else badges.push({ label: "worktree lié", tone: "accent" });
  if (worktree.conflictedFiles > 0) {
    badges.push({ label: `${worktree.conflictedFiles} en conflit`, tone: "danger" });
  }
  if (changes > 0) badges.push({ label: `${changes} modifs`, tone: "behind" });
  badges.push(...syncBadges(worktree.ahead, worktree.behind));
  if (badges.length === 1 && changes === 0) {
    badges.push({ label: "propre", tone: "ahead" });
  }

  const rows = [
    { label: "Branche", value: worktree.branch ?? `détaché · ${worktree.head ?? "?"}` },
    { label: "Chemin", value: worktree.path },
  ];
  if (worktree.upstream) rows.push({ label: "Suit", value: worktree.upstream });

  return {
    title: worktree.name,
    subtitle: repoName !== worktree.name ? `dépôt ${repoName}` : undefined,
    badges,
    rows,
    hint: "Clic droit : masquer, ouvrir dans l'éditeur, révéler dans le Finder",
  };
}

export function commitAuthorTip(commit: Commit): TipContent {
  return {
    title: commit.author,
    subtitle: commit.email,
    rows: [
      { label: "Commit", value: commit.shortSha },
      { label: "Le", value: absoluteTime(commit.date) },
    ],
  };
}

export function commitTip(commit: Commit): TipContent {
  return {
    title: commit.subject,
    subtitle: `${commit.author} · ${relativeTime(commit.date)}`,
    badges:
      commit.parents.length > 1
        ? [{ label: `merge · ${commit.parents.length} parents`, tone: "behind" }]
        : undefined,
    rows: [{ label: "SHA", value: commit.shortSha }],
  };
}

export function refBadgeTip(badge: RefBadgeModel, isCurrent: boolean): TipContent {
  const badges: TipBadge[] = [];
  if (badge.isTag) badges.push({ label: "tag", tone: "ahead" });
  else {
    if (badge.hasLocal) badges.push({ label: "locale", tone: "default" });
    if (badge.hasRemote) {
      badges.push({
        label: `distante · ${badge.remotes.join(", ") || "remote"}`,
        tone: "muted",
      });
    }
    if (isCurrent) badges.push({ label: "branche courante", tone: "behind" });
  }

  return {
    title: badge.label,
    subtitle: badge.isTag ? "étiquette de version" : undefined,
    badges,
    hint:
      badge.isTag || isCurrent
        ? undefined
        : "Double-clic : checkout · Clic droit : checkout, merge",
  };
}

export function wipTip(counts: {
  staged: number;
  unstaged: number;
  untracked: number;
  conflicted: number;
}): TipContent {
  const badges: TipBadge[] = [];
  if (counts.conflicted > 0) {
    badges.push({ label: `${counts.conflicted} en conflit`, tone: "danger" });
  }
  if (counts.staged > 0) {
    badges.push({ label: `${counts.staged} indexés`, tone: "accent" });
  }
  if (counts.unstaged > 0) {
    badges.push({ label: `${counts.unstaged} modifiés`, tone: "behind" });
  }
  if (counts.untracked > 0) {
    badges.push({ label: `${counts.untracked} non suivis`, tone: "muted" });
  }

  return {
    title: "Modifications non commitées",
    subtitle: "Comparé à HEAD",
    badges,
    hint: "Clic : voir les fichiers et leurs diffs",
  };
}
