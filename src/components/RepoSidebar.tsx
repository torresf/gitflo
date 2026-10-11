import { useMemo } from "react";
import {
  ChevronDown,
  ChevronRight,
  EyeOff,
  FolderGit2,
  GitBranch,
  Layers,
  Plus,
  RefreshCw,
} from "lucide-react";
import type { RepoGroup, Worktree } from "../types";
import type { HiddenEntry } from "../lib/hidden";
import { showContextMenu } from "../lib/menu";
import { tip } from "../lib/tooltip";
import { worktreeTip } from "../lib/tips";
import { api } from "../api";

interface Props {
  repos: RepoGroup[];
  selectedPath: string | null;
  loading: boolean;
  hidden: HiddenEntry[];
  collapsedRepos: string[];
  onToggleCollapsed: (repoId: string) => void;
  onSelect: (repo: RepoGroup, worktree: Worktree) => void;
  onRefresh: () => void;
  onAddRoot: () => void;
  onHide: (key: string) => void;
  onUnhide: (key: string) => void;
  onUnhideAll: () => void;
  onRemoveWorktree: (repo: RepoGroup, worktree: Worktree) => void;
  /** Menu label of the chosen editor, e.g. "Ouvrir dans VS Code". */
  editorLabel: string;
  onOpenInEditor: (path: string) => void;
}

/** Compact dirty/ahead/behind summary shown on the right of each row. */
function StatusBadges({ wt }: { wt: Worktree }) {
  const changes = wt.dirtyFiles + wt.stagedFiles + wt.untrackedFiles;
  return (
    <span className="flex shrink-0 items-center gap-1.5 font-mono text-[10px] whitespace-nowrap">
      {wt.conflictedFiles > 0 && (
        <span className="text-danger" {...tip("fichiers en conflit")}>
          !{wt.conflictedFiles}
        </span>
      )}
      {changes > 0 && (
        <span className="text-behind" {...tip("modifications non commitées")}>
          ●{changes}
        </span>
      )}
      {wt.ahead > 0 && (
        <span className="text-ahead" {...tip("commits d'avance")}>
          ↑{wt.ahead}
        </span>
      )}
      {wt.behind > 0 && (
        <span className="text-accent" {...tip("commits de retard")}>
          ↓{wt.behind}
        </span>
      )}
    </span>
  );
}

function WorktreeRow({
  wt,
  repo,
  active,
  indented,
  onSelect,
  onHide,
  onRemoveWorktree,
  editorLabel,
  onOpenInEditor,
  trailing,
}: {
  wt: Worktree;
  repo: RepoGroup;
  active: boolean;
  indented: boolean;
  onSelect: () => void;
  onHide: (key: string) => void;
  onRemoveWorktree: (repo: RepoGroup, worktree: Worktree) => void;
  editorLabel: string;
  onOpenInEditor: (path: string) => void;
  trailing?: React.ReactNode;
}) {
  const onContext = (e: React.MouseEvent) => {
    e.preventDefault();
    showContextMenu([
      { text: editorLabel, action: () => onOpenInEditor(wt.path) },
      { text: "Révéler dans le Finder", action: () => api.revealInFinder(wt.path) },
      { separator: true },
      {
        text: `Masquer « ${repo.name} »`,
        action: () => onHide(repo.id),
      },
      {
        // Only meaningful when the repo would still have something to show.
        text: `Masquer seulement « ${wt.name} »`,
        enabled: repo.worktrees.length > 1,
        action: () => onHide(wt.path),
      },
      { separator: true },
      {
        text: "Copier le chemin",
        action: () => navigator.clipboard.writeText(wt.path),
      },
      {
        // git refuses to remove the main worktree; do not offer it.
        text: wt.isPrimary
          ? "Le dépôt principal ne peut pas être supprimé"
          : `Supprimer le worktree « ${wt.name} »…`,
        enabled: !wt.isPrimary,
        action: () => onRemoveWorktree(repo, wt),
      },
    ]);
  };

  return (
    <button
      onClick={onSelect}
      onContextMenu={onContext}
      {...tip(worktreeTip(wt, repo.name))}
      className={`flex w-full select-none items-center gap-2 rounded-md py-1 pr-2 text-left transition-colors ${
        indented ? "pl-7" : "pl-2"
      } ${
        active
          ? "bg-ink-700 text-ink-100"
          : "text-ink-300 hover:bg-ink-800 hover:text-ink-100"
      }`}
    >
      {indented ? (
        <Layers size={12} className="shrink-0 text-ink-500" />
      ) : (
        <FolderGit2 size={13} className="shrink-0 text-ink-400" />
      )}
      {/* Two lines, but tightened: name and branch each read on their own,
          while leading-none plus a small padding keeps the row short. */}
      <span className="min-w-0 flex-1 truncate">
        <span className="block truncate text-[12px] leading-tight">{wt.name}</span>
        <span className="mt-[1px] flex items-center gap-1 truncate text-[10px] leading-tight whitespace-nowrap text-ink-500">
          <GitBranch size={8} className="shrink-0" />
          {wt.branch ?? `détaché · ${wt.head ?? "?"}`}
        </span>
      </span>
      <StatusBadges wt={wt} />
      {trailing}
    </button>
  );
}

export function RepoSidebar({
  repos,
  selectedPath,
  loading,
  hidden,
  collapsedRepos,
  onToggleCollapsed,
  onSelect,
  onRefresh,
  onAddRoot,
  onHide,
  onUnhide,
  onUnhideAll,
  onRemoveWorktree,
  editorLabel,
  onOpenInEditor,
}: Props) {
  const collapsed = useMemo(() => new Set(collapsedRepos), [collapsedRepos]);

  const openHiddenMenu = () => {
    showContextMenu([
      ...hidden.map((entry) => ({
        text: `Réafficher ${entry.label}`,
        action: () => onUnhide(entry.key),
      })),
      { separator: true as const },
      { text: "Tout réafficher", action: onUnhideAll },
    ]);
  };

  return (
    <aside className="flex h-full w-[272px] shrink-0 flex-col border-r border-ink-800 bg-ink-900">
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-ink-800 px-3">
        <span className="flex-1 text-[11px] font-semibold tracking-wide text-ink-400 uppercase">
          Dépôts · {repos.length}
        </span>
        {hidden.length > 0 && (
          <button
            onClick={openHiddenMenu}
            {...tip(
              `${hidden.length} élément(s) masqué(s)\nCliquer pour les réafficher`,
            )}
            className="flex items-center gap-1 rounded px-1.5 py-1 text-ink-400 hover:bg-ink-700 hover:text-ink-100"
          >
            <EyeOff size={12} />
            <span className="font-mono text-[10px]">{hidden.length}</span>
          </button>
        )}
        <button
          onClick={onAddRoot}
          {...tip("Ajouter un dossier à scanner")}
          className="rounded p-1 text-ink-400 hover:bg-ink-700 hover:text-ink-100"
        >
          <Plus size={13} />
        </button>
        <button
          onClick={onRefresh}
          {...tip("Rescanner")}
          className="rounded p-1 text-ink-400 hover:bg-ink-700 hover:text-ink-100"
        >
          <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
        </button>
      </header>

      <div className="flex-1 overflow-y-auto p-1.5">
        {repos.length === 0 && !loading && (
          <p className="p-3 text-[12px] leading-relaxed text-ink-500">
            {hidden.length > 0
              ? "Tous les dépôts de cet onglet sont masqués."
              : "Aucun dépôt trouvé. Ajoute un dossier avec le +."}
          </p>
        )}

        {repos.map((repo) => {
          const multi = repo.worktrees.length > 1;
          const isCollapsed = collapsed.has(repo.id);
          const [primary, ...linked] = repo.worktrees;

          return (
            <div key={repo.id}>
              {/* The expand arrow sits on the RIGHT so every repo name starts
                  at the same x: a left-hand arrow made single-worktree repos
                  look like a different kind of row. */}
              <div className="flex items-center">
                <div className="min-w-0 flex-1">
                  <WorktreeRow
                    wt={primary}
                    repo={repo}
                    active={primary.path === selectedPath}
                    indented={false}
                    onSelect={() => onSelect(repo, primary)}
                    onHide={onHide}
                    onRemoveWorktree={onRemoveWorktree}
                    editorLabel={editorLabel}
                    onOpenInEditor={onOpenInEditor}
                    trailing={
                      multi ? (
                        <span
                          role="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onToggleCollapsed(repo.id);
                          }}
                          className="shrink-0 rounded p-0.5 text-ink-500 hover:text-ink-200"
                          {...tip(
                            isCollapsed
                              ? `Déplier ${repo.worktrees.length} worktrees`
                              : "Replier",
                          )}
                        >
                          {isCollapsed ? (
                            <ChevronRight size={12} />
                          ) : (
                            <ChevronDown size={12} />
                          )}
                        </span>
                      ) : null
                    }
                  />
                </div>
              </div>

              {multi && !isCollapsed && (
                <div>
                  {linked.map((wt) => (
                    <WorktreeRow
                      key={wt.path}
                      wt={wt}
                      repo={repo}
                      active={wt.path === selectedPath}
                      indented
                      onSelect={() => onSelect(repo, wt)}
                      onHide={onHide}
                      onRemoveWorktree={onRemoveWorktree}
                      editorLabel={editorLabel}
                      onOpenInEditor={onOpenInEditor}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </aside>
  );
}
