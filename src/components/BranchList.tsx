import { useMemo, useState } from "react";
import {
  Check,
  Loader2,
  Trash2,
  ChevronDown,
  ChevronRight,
  Cloud,
  GitBranch,
  Layers,
  Search,
  Unlink,
} from "lucide-react";
import type { Branch } from "../types";
import { relativeTime, stripRemote } from "../lib/format";
import { PINNED_GROUPS, branchRole, isPinnedBranch } from "../lib/pinned";
import { ROLE_TEXT_CLASS } from "../lib/laneColors";
import { showContextMenu } from "../lib/menu";
import { tip } from "../lib/tooltip";
import { branchTip } from "../lib/tips";

interface Props {
  branches: Branch[];
  selectedRef: string | null;
  currentBranch: string | null;
  worktreePath: string | null;
  onSelect: (branch: Branch | null) => void;
  onAction: (action: BranchAction, branch: Branch) => void;
  onPrune: () => void;
  /** An analysis is already running: show it on the button. */
  pruneBusy: boolean;
}

export type BranchAction =
  | "checkout"
  | "merge"
  | "merge-no-ff"
  | "rebase"
  | "branch-from"
  | "delete"
  | "delete-force";

interface TreeNode {
  /** Prefix segment, e.g. "feature". Empty for top-level branches. */
  prefix: string;
  branches: Branch[];
}

/**
 * Rank inside the un-prefixed group: trunk first, integration branch next,
 * everything else after, keeping git's committerdate order among equals.
 */
function pinnedRank(branch: Branch, strip: boolean): number {
  const name = strip ? stripRemote(branch.short) : branch.short;
  const group = PINNED_GROUPS.findIndex((names) => names.includes(name));
  return group === -1 ? PINNED_GROUPS.length : group;
}

/** Group by first path segment so `feature/*` collapses into one foldable row. */
function groupByPrefix(branches: Branch[], strip: boolean): TreeNode[] {
  const groups = new Map<string, Branch[]>();
  for (const branch of branches) {
    const name = strip ? stripRemote(branch.short) : branch.short;
    const slash = name.indexOf("/");
    const prefix = slash === -1 ? "" : name.slice(0, slash);
    const list = groups.get(prefix) ?? [];
    list.push(branch);
    groups.set(prefix, list);
  }
  const top = groups.get("");
  if (top) {
    // Stable: only the pinned ones move, the rest keep their date order.
    groups.set(
      "",
      [...top].sort((a, b) => pinnedRank(a, strip) - pinnedRank(b, strip)),
    );
  }

  return [...groups.entries()]
    .map(([prefix, list]) => ({ prefix, branches: list }))
    .sort((a, b) => {
      if (a.prefix === "") return -1;
      if (b.prefix === "") return 1;
      return a.prefix.localeCompare(b.prefix);
    });
}

function BranchRow({
  branch,
  selected,
  currentBranch,
  worktreePath,
  displayName,
  onSelect,
  onAction,
}: {
  branch: Branch;
  selected: boolean;
  currentBranch: string | null;
  worktreePath: string | null;
  displayName: string;
  onSelect: () => void;
  onAction: (action: BranchAction, branch: Branch) => void;
}) {
  const isRemote = branch.kind === "remote";
  // git refuses to check out a branch already held by another worktree.
  const heldElsewhere =
    !!branch.worktreePath && branch.worktreePath !== worktreePath;
  const isCurrent = !isRemote && branch.short === currentBranch;
  const role = branchRole(branch);
  const roleClass = role === "other" ? "text-ink-500" : ROLE_TEXT_CLASS[role];

  const onContext = (e: React.MouseEvent) => {
    e.preventDefault();
    const target = isRemote ? stripRemote(branch.short) : branch.short;
    showContextMenu([
      {
        text: isRemote
          ? `Checkout ${target} (suit ${branch.short})`
          : `Checkout ${branch.short}`,
        enabled: !isCurrent && !heldElsewhere,
        action: () => onAction("checkout", branch),
      },
      {
        text: heldElsewhere
          ? `Occupée par ${branch.worktreePath?.split("/").pop()}`
          : "Créer une branche depuis…",
        enabled: !heldElsewhere,
        action: () => onAction("branch-from", branch),
      },
      { separator: true },
      {
        text: `Merger ${branch.short} dans ${currentBranch ?? "HEAD"}`,
        enabled: !isCurrent && !!currentBranch,
        action: () => onAction("merge", branch),
      },
      {
        text: `Merger ${branch.short} sans fast-forward`,
        enabled: !isCurrent && !!currentBranch,
        action: () => onAction("merge-no-ff", branch),
      },
      {
        text: `Rebaser ${currentBranch ?? "HEAD"} sur ${branch.short}`,
        enabled: !isCurrent && !!currentBranch,
        action: () => onAction("rebase", branch),
      },
      { separator: true },
      {
        text: "Copier le nom",
        action: () => navigator.clipboard.writeText(branch.short),
      },
      {
        text: "Supprimer la branche",
        enabled: !isRemote && !isCurrent && !heldElsewhere,
        action: () => onAction("delete", branch),
      },
    ]);
  };

  return (
    <button
      onClick={onSelect}
      onDoubleClick={() => {
        // Same gesture as on a commit badge. Blocked cases are left to the
        // context menu, which explains why rather than failing silently.
        if (isCurrent || heldElsewhere) return;
        onAction("checkout", branch);
      }}
      onContextMenu={onContext}
      {...tip(branchTip(branch, currentBranch))}
      className={`group flex w-full select-none items-center gap-1.5 rounded-md py-[3px] pr-2 pl-2 text-left transition-colors ${
        selected
          ? "bg-ink-700 text-ink-100"
          : "text-ink-300 hover:bg-ink-800 hover:text-ink-100"
      }`}
    >
      {/* Same colour language as the graph lanes: trunk green, integration
          blue, checked-out branch orange, anything else neutral. */}
      {isRemote ? (
        <Cloud size={12} className={`shrink-0 ${roleClass}`} />
      ) : (
        <GitBranch size={12} className={`shrink-0 ${roleClass}`} />
      )}

      <span
        className={`min-w-0 flex-1 truncate ${
          isCurrent
            ? "font-semibold text-ink-100"
            : isPinnedBranch(branch)
              ? "font-medium text-ink-200"
              : ""
        }`}
      >
        {displayName}
      </span>

      {isCurrent && <Check size={11} className="shrink-0 text-ahead" />}
      {heldElsewhere && (
        <span
          className="shrink-0 text-ink-500"
          {...tip({
            title: "Occupée par un autre worktree",
            subtitle: branch.worktreePath ?? undefined,
            hint: "git refuse de checkouter la même branche deux fois",
          })}
        >
          <Layers size={11} />
        </span>
      )}
      {branch.gone && (
        <span
          className="shrink-0 text-danger"
          {...tip({
            title: "Upstream disparu",
            subtitle: branch.upstream ?? undefined,
            badges: [{ label: "gone", tone: "danger" }],
            warning:
              "La branche distante qu'elle suit n'existe plus (supprimée après merge, en général). Cette copie locale peut sans doute être supprimée.",
          })}
        >
          <Unlink size={10} />
        </span>
      )}

      <span className="flex shrink-0 items-center gap-1 font-mono text-[10px] whitespace-nowrap">
        {branch.ahead > 0 && <span className="text-ahead">↑{branch.ahead}</span>}
        {branch.behind > 0 && <span className="text-accent">↓{branch.behind}</span>}
      </span>

      <span className="w-11 shrink-0 text-right font-mono text-[10px] whitespace-nowrap text-ink-500">
        {relativeTime(branch.date)}
      </span>
    </button>
  );
}

function Section({
  label,
  branches,
  strip,
  ...rowProps
}: {
  label: string;
  branches: Branch[];
  strip: boolean;
  selectedRef: string | null;
  currentBranch: string | null;
  worktreePath: string | null;
  onSelect: (b: Branch) => void;
  onAction: (action: BranchAction, branch: Branch) => void;
}) {
  const [folded, setFolded] = useState<Record<string, boolean>>({});
  const groups = useMemo(() => groupByPrefix(branches, strip), [branches, strip]);

  if (branches.length === 0) return null;

  return (
    <section className="mb-2">
      <h3 className="px-2 py-1 text-[10px] font-semibold tracking-wider text-ink-500 uppercase">
        {label} · {branches.length}
      </h3>

      {groups.map(({ prefix, branches: list }) => {
        const naked = (b: Branch) => (strip ? stripRemote(b.short) : b.short);

        if (prefix === "") {
          return list.map((branch) => (
            <BranchRow
              key={branch.refname}
              branch={branch}
              displayName={naked(branch)}
              selected={rowProps.selectedRef === branch.refname}
              currentBranch={rowProps.currentBranch}
              worktreePath={rowProps.worktreePath}
              onSelect={() => rowProps.onSelect(branch)}
              onAction={rowProps.onAction}
            />
          ));
        }

        const isFolded = folded[prefix] ?? list.length > 6;
        return (
          <div key={prefix}>
            <button
              onClick={() => setFolded((f) => ({ ...f, [prefix]: !isFolded }))}
              className="flex w-full items-center gap-1 rounded px-2 py-[3px] text-left text-ink-400 hover:bg-ink-800 hover:text-ink-200"
            >
              {isFolded ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
              <span className="truncate font-medium">{prefix}/</span>
              <span className="font-mono text-[10px] text-ink-500">
                {list.length}
              </span>
            </button>
            {!isFolded && (
              <div className="ml-3 border-l border-ink-800 pl-1">
                {list.map((branch) => (
                  <BranchRow
                    key={branch.refname}
                    branch={branch}
                    displayName={naked(branch).slice(prefix.length + 1)}
                    selected={rowProps.selectedRef === branch.refname}
                    currentBranch={rowProps.currentBranch}
                    worktreePath={rowProps.worktreePath}
                          onSelect={() => rowProps.onSelect(branch)}
                    onAction={rowProps.onAction}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </section>
  );
}

export function BranchList({
  branches,
  selectedRef,
  currentBranch,
  worktreePath,
  onSelect,
  onAction,
  onPrune,
  pruneBusy,
}: Props) {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return branches;
    return branches.filter((b) => b.short.toLowerCase().includes(q));
  }, [branches, query]);

  const locals = filtered.filter((b) => b.kind === "local");
  const remotes = filtered.filter((b) => b.kind === "remote");
  const remoteNames = [...new Set(remotes.map((b) => b.remote ?? "origin"))].sort();

  const shared = {
    selectedRef,
    currentBranch,
    worktreePath,
    onSelect,
    onAction,
  };

  return (
    <aside className="flex h-full w-[300px] shrink-0 flex-col border-r border-ink-800 bg-ink-900">
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-ink-800 px-2">
        <Search size={12} className="shrink-0 text-ink-500" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filtrer les branches"
          className="w-full bg-transparent text-[12px] text-ink-100 placeholder:text-ink-500 focus:outline-none"
        />
        <button
          onClick={onPrune}
          disabled={pruneBusy}
          {...tip({
            title: "Nettoyer les branches",
            subtitle: "Locales dont la distante a disparu, ou déjà fusionnées",
            hint: "Sélection, puis suppression en lot",
          })}
          className="shrink-0 rounded p-1 text-ink-400 hover:bg-ink-700 hover:text-ink-100"
        >
          {pruneBusy ? (
            <Loader2 size={12} className="animate-spin" />
          ) : (
            <Trash2 size={12} />
          )}
        </button>
        {selectedRef && (
          <button
            onClick={() => onSelect(null)}
            {...tip("Voir toutes les branches")}
            className="shrink-0 rounded px-1.5 py-0.5 text-[10px] text-ink-400 hover:bg-ink-700 hover:text-ink-100"
          >
            tout
          </button>
        )}
      </header>

      <div className="flex-1 overflow-y-auto p-1">
        <Section label="Locales" branches={locals} strip={false} {...shared} />
        {remoteNames.map((remote) => (
          <Section
            key={remote}
            label={remote}
            branches={remotes.filter((b) => (b.remote ?? "origin") === remote)}
            strip
            {...shared}
          />
        ))}
      </div>
    </aside>
  );
}
