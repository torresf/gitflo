import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  ArrowUpFromLine,
  DownloadCloud,
  GitPullRequestArrow,
  Loader2,
  Palette,
  RefreshCw,
} from "lucide-react";
import { api } from "./api";
import type {
  Branch,
  Commit,
  CommitDetail,
  DeleteOutcome,
  RemoteBranchState,
  RepoGroup,
  StaleBranch,
  WorkingTree,
  Worktree,
} from "./types";
import { RepoSidebar } from "./components/RepoSidebar";
import { BranchList, type BranchAction } from "./components/BranchList";
import { CommitGraph, type WipSummary } from "./components/CommitGraph";
import { CommitDetailPanel } from "./components/CommitDetailPanel";
import { Toast, type ToastState } from "./components/Toast";
import { TooltipHost } from "./components/TooltipHost";
import { PromptDialog } from "./components/PromptDialog";
import { PruneModal, type PruneTab } from "./components/PruneModal";
import { ConfirmDialog, type ConfirmSpec } from "./components/ConfirmDialog";
import { WorkspaceTabs } from "./components/WorkspaceTabs";
import { WorkspaceSettings } from "./components/WorkspaceSettings";
import { absoluteTime, relativeTime, stripRemote } from "./lib/format";
import { tip } from "./lib/tooltip";
import { hiddenEntries, visibleRepos } from "./lib/hidden";
import { resolveBadgeBranch } from "./lib/refs";
import type { RefBadgeModel } from "./lib/refs";
import { PINNED_GROUPS, pinnedShas } from "./lib/pinned";
import { activeFilter, resolveRevs, type BranchFilter } from "./lib/revs";
import {
  activeWorkspace,
  clampGutterWidth,
  clearHidden,
  createWorkspace,
  nameFromPath,
  removeWorkspace,
  toggleHidden,
  upsertWorkspace,
  type Workspace,
  type WorkspaceState,
} from "./lib/workspaces";
import { flushSettings, loadSettings, persistSettings } from "./lib/settings";

const COMMIT_LIMIT = 400;

export default function App() {
  const [state, setState] = useState<WorkspaceState | null>(null);
  const [repos, setRepos] = useState<RepoGroup[]>([]);
  const [repoCounts, setRepoCounts] = useState<Record<string, number>>({});
  const [scanning, setScanning] = useState(false);

  const [selected, setSelected] = useState<{
    repo: RepoGroup;
    worktree: Worktree;
  } | null>(null);

  const [branches, setBranches] = useState<Branch[]>([]);
  const [filter, setFilter] = useState<BranchFilter | null>(null);
  const [commits, setCommits] = useState<Commit[]>([]);
  const [loadingCommits, setLoadingCommits] = useState(false);

  const [selectedSha, setSelectedSha] = useState<string | null>(null);
  const [detail, setDetail] = useState<CommitDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);

  /** The uncommitted-changes row is selected instead of a commit. */
  const [wipSelected, setWipSelected] = useState(false);
  const [wipTree, setWipTree] = useState<WorkingTree | null>(null);

  const [toast, setToast] = useState<ToastState | null>(null);
  /** Label of the git action currently running, for the header indicator. */
  const [busyAction, setBusyAction] = useState<string | null>(null);
  /** Unix seconds of the last fetch on the selected repo. */
  const [lastFetch, setLastFetch] = useState<number | null>(null);
  const [managed, setManaged] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<{
    title: string;
    hint?: string;
    initial: string;
    confirmLabel: string;
    onConfirm: (value: string) => void;
  } | null>(null);

  const [confirm, setConfirm] = useState<ConfirmSpec | null>(null);

  const [pruneOpen, setPruneOpen] = useState(false);
  const [staleBranches, setStaleBranches] = useState<StaleBranch[]>([]);
  const [remoteBranches, setRemoteBranches] = useState<RemoteBranchState[]>([]);
  const [pruneTab, setPruneTab] = useState<PruneTab>("local");
  const [pruneLoading, setPruneLoading] = useState(false);
  const [pruneRunning, setPruneRunning] = useState(false);
  const [pruneOutcomes, setPruneOutcomes] = useState<DeleteOutcome[] | null>(null);

  const [detailHeight, setDetailHeight] = useState(320);
  const dragging = useRef(false);
  /** Worktree path to re-select once the first scan returns. */
  const restoreTargetRef = useRef<string | null>(null);

  const repoPath = selected?.worktree.path ?? null;
  const workspace = state ? activeWorkspace(state) : null;
  const roots = workspace?.roots ?? [];

  // -- Workspace state ----------------------------------------------------

  useEffect(() => {
    // The fallback roots are only consulted on a truly first launch.
    api
      .defaultRoots()
      .then((defaults) => loadSettings(defaults))
      .then((loaded) => {
        restoreTargetRef.current = loaded.selectedPath;
        setState(loaded);
      });
  }, []);

  const updateState = useCallback((next: WorkspaceState) => {
    setState(next);
    persistSettings(next);
  }, []);

  // Remember what was open, so a restart lands back on the same repo.
  useEffect(() => {
    if (!state || repoPath === state.selectedPath) return;
    updateState({ ...state, selectedPath: repoPath });
  }, [repoPath, state, updateState]);

  const setGutterWidth = useCallback(
    (width: number | null) => {
      if (!state) return;
      const clamped = clampGutterWidth(width);
      if (clamped === state.gutterWidth) return;
      updateState({ ...state, gutterWidth: clamped });
    },
    [state, updateState],
  );

  // -- Workspace scan -----------------------------------------------------

  const rescan = useCallback(
    async (rootList: string[], workspaceId: string, hiddenKeys: string[]) => {
    if (rootList.length === 0) {
      setRepos([]);
      setRepoCounts((counts) => ({ ...counts, [workspaceId]: 0 }));
      return;
    }
    setScanning(true);
    try {
      const found = await api.scanWorkspace(rootList);
      setRepos(found);
      // Count what the tab shows, not what the disk holds.
      setRepoCounts((counts) => ({
        ...counts,
        [workspaceId]: visibleRepos(found, hiddenKeys).length,
      }));
      // Keep the current selection pointing at a live object after a rescan.
      setSelected((current) => {
        if (!current) return current;
        const repo = found.find((r) => r.id === current.repo.id);
        const worktree = repo?.worktrees.find((w) => w.path === current.worktree.path);
        return repo && worktree ? { repo, worktree } : null;
      });
    } catch (e) {
      setToast({ kind: "error", title: "Scan impossible", detail: String(e) });
    } finally {
      setScanning(false);
    }
    },
    [],
  );

  useEffect(() => {
    if (!workspace) return;
    rescan(workspace.roots, workspace.id, workspace.hidden);
  }, [workspace?.id, workspace?.roots, workspace?.hidden, rescan]);

  const shownRepos = useMemo(
    () => visibleRepos(repos, workspace?.hidden ?? []),
    [repos, workspace?.hidden],
  );
  const hiddenList = useMemo(
    () => hiddenEntries(repos, workspace?.hidden ?? []),
    [repos, workspace?.hidden],
  );

  const toggleCollapsed = useCallback(
    (repoId: string) => {
      if (!state) return;
      const collapsedRepos = state.collapsedRepos.includes(repoId)
        ? state.collapsedRepos.filter((id) => id !== repoId)
        : [...state.collapsedRepos, repoId];
      updateState({ ...state, collapsedRepos });
    },
    [state, updateState],
  );

  const hideEntry = useCallback(
    (key: string) => {
      if (!state || !workspace) return;
      updateState(upsertWorkspace(state, toggleHidden(workspace, key)));
      // Hiding what is currently open would leave a pane bound to nothing.
      setSelected((current) =>
        current && (current.repo.id === key || current.worktree.path === key)
          ? null
          : current,
      );
    },
    [state, workspace, updateState],
  );

  // -- Per-repo reads -----------------------------------------------------

  const reloadBranches = useCallback(async (path: string) => {
    try {
      setBranches(await api.listBranches(path));
    } catch (e) {
      setToast({ kind: "error", title: "Lecture des branches", detail: String(e) });
    }
  }, []);

  const reloadCommits = useCallback(async (path: string, revs: string[]) => {
    setLoadingCommits(true);
    try {
      setCommits(await api.listCommits(path, revs, COMMIT_LIMIT));
    } catch (e) {
      setCommits([]);
      setToast({ kind: "error", title: "Lecture de l'historique", detail: String(e) });
    } finally {
      setLoadingCommits(false);
    }
  }, []);

  useEffect(() => {
    if (!repoPath) {
      setBranches([]);
      setCommits([]);
      return;
    }
    setSelectedSha(null);
    setDetail(null);
    setWipSelected(false);
    setWipTree(null);
    reloadBranches(repoPath);
    api.lastFetch(repoPath).then(setLastFetch).catch(() => setLastFetch(null));
  }, [repoPath, reloadBranches]);

  // The filter carries the repo it was chosen in, so switching repos can never
  // send another repo's ref to git (see lib/revs.ts).
  const revs = useMemo(() => resolveRevs(filter, repoPath), [filter, repoPath]);
  const shownFilter = useMemo(() => activeFilter(filter, repoPath), [filter, repoPath]);

  useEffect(() => {
    if (!repoPath) return;
    reloadCommits(repoPath, revs);
  }, [repoPath, revs, reloadCommits]);

  useEffect(() => {
    if (!repoPath || !selectedSha) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setLoadingDetail(true);
    api
      .commitDetail(repoPath, selectedSha)
      .then((d) => !cancelled && setDetail(d))
      .catch((e) => {
        if (cancelled) return;
        setDetail(null);
        setToast({ kind: "error", title: "Détail du commit", detail: String(e) });
      })
      .finally(() => !cancelled && setLoadingDetail(false));
    return () => {
      cancelled = true;
    };
  }, [repoPath, selectedSha]);

  const selectCommit = useCallback((sha: string) => {
    setWipSelected(false);
    setSelectedSha(sha);
  }, []);

  const selectWip = useCallback(() => {
    setSelectedSha(null);
    setWipSelected(true);
  }, []);

  /**
   * Summary counts come from the scan the sidebar already did, so the row costs
   * nothing until it is clicked. The file list is only fetched on selection.
   */
  const wipSummary = useMemo<WipSummary | null>(() => {
    const w = selected?.worktree;
    if (!w) return null;
    const approxCount =
      w.stagedFiles + w.dirtyFiles + w.untrackedFiles + w.conflictedFiles;
    if (approxCount === 0) return null;
    return {
      // A file both staged and modified counts twice above; the loaded tree
      // knows the real number, so prefer it once available.
      fileCount: wipTree ? wipTree.files.length : approxCount,
      staged: w.stagedFiles,
      unstaged: w.dirtyFiles,
      untracked: w.untrackedFiles,
      conflicted: w.conflictedFiles,
    };
  }, [selected, wipTree]);

  useEffect(() => {
    if (!repoPath || !wipSelected) {
      setWipTree(null);
      return;
    }
    let cancelled = false;
    setLoadingDetail(true);
    api
      .workingTree(repoPath)
      .then((tree) => !cancelled && setWipTree(tree))
      .catch((e) => {
        if (cancelled) return;
        setWipTree(null);
        setToast({ kind: "error", title: "Lecture des modifications", detail: String(e) });
      })
      .finally(() => !cancelled && setLoadingDetail(false));
    return () => {
      cancelled = true;
    };
  }, [repoPath, wipSelected]);

  const headSha = useMemo(
    () => branches.find((b) => b.isHead)?.sha ?? null,
    [branches],
  );
  // Reserve the leftmost graph lanes for main/master, then develop.
  const priorityShas = useMemo(() => pinnedShas(branches), [branches]);

  // -- Actions ------------------------------------------------------------

  const afterWrite = useCallback(
    async (path: string) => {
      await reloadBranches(path);
      await reloadCommits(path, revs);
      if (workspace) await rescan(workspace.roots, workspace.id, workspace.hidden);
      if (wipSelected) {
        setWipTree(await api.workingTree(path).catch(() => null));
      }
      setLastFetch(await api.lastFetch(path).catch(() => null));
    },
    [reloadBranches, reloadCommits, revs, rescan, workspace, wipSelected],
  );

  const runAction = useCallback(
    async (label: string, fn: () => Promise<{ output: string }>, path: string) => {
      // Fetch, merge and rebase all talk to the network or rewrite the tree:
      // without a visible marker the window just looks frozen.
      setBusyAction(label);
      try {
        const result = await fn();
        setToast({ kind: "ok", title: label, detail: result.output || undefined });
        await afterWrite(path);
      } catch (e) {
        // git's own stderr is the useful part here (conflicts, dirty tree…).
        setToast({ kind: "error", title: `${label} — échec`, detail: String(e) });
        await afterWrite(path);
      } finally {
        setBusyAction(null);
      }
    },
    [afterWrite],
  );

  const onBranchAction = useCallback(
    (action: BranchAction, branch: Branch) => {
      if (!repoPath) return;
      const path = repoPath;
      const current = selected?.worktree.branch ?? "HEAD";

      switch (action) {
        case "checkout": {
          if (branch.kind === "remote") {
            const local = stripRemote(branch.short);
            const existing = branches.find(
              (b) => b.kind === "local" && b.short === local,
            );
            // A local branch of that name already exists: plain checkout,
            // otherwise git errors on the -b.
            if (existing) {
              runAction(`Checkout ${local}`, () => api.checkout(path, local), path);
            } else {
              runAction(
                `Checkout ${local} (suit ${branch.short})`,
                () => api.checkoutRemote(path, local, branch.short),
                path,
              );
            }
          } else {
            runAction(
              `Checkout ${branch.short}`,
              () => api.checkout(path, branch.short),
              path,
            );
          }
          break;
        }
        case "merge":
        case "merge-no-ff":
          runAction(
            `Merge ${branch.short} → ${current}`,
            () => api.merge(path, branch.short, action === "merge-no-ff"),
            path,
          );
          break;
        case "rebase":
          runAction(
            `Rebase ${current} sur ${branch.short}`,
            () => api.rebase(path, branch.short),
            path,
          );
          break;
        case "branch-from":
          setPrompt({
            title: "Créer une branche",
            hint: `Depuis ${branch.short}`,
            initial: "",
            confirmLabel: "Créer et checkout",
            onConfirm: (name) => {
              setPrompt(null);
              runAction(
                `Branche ${name}`,
                () => api.createBranch(path, name, branch.short),
                path,
              );
            },
          });
          break;
        case "delete":
        case "delete-force":
          deleteBranch(branch, action === "delete-force");
          break;
      }
    },
    [repoPath, selected, branches, runAction],
  );

  /** Base for the "already merged" test: the repo's integration branch. */
  const pruneBase = useMemo(() => {
    for (const group of [...PINNED_GROUPS].reverse()) {
      const found = branches.find(
        (b) => b.kind === "local" && group.includes(b.short),
      );
      if (found) return found.short;
    }
    return null;
  }, [branches]);

  /** Remote counterpart of the base, for the merge state of remote branches. */
  const remoteBase = useMemo(() => {
    if (!pruneBase) return null;
    const tracked = branches.find(
      (b) => b.kind === "remote" && b.short.endsWith(`/${pruneBase}`),
    );
    return tracked?.short ?? `origin/${pruneBase}`;
  }, [branches, pruneBase]);

  const openPrune = useCallback(async () => {
    if (!repoPath) return;
    setPruneOpen(true);
    setPruneOutcomes(null);
    setPruneLoading(true);
    try {
      // Both sides at once: switching tabs must not re-scan.
      const [local, remote] = await Promise.all([
        api.staleBranches(repoPath, pruneBase),
        remoteBase
          ? api.remoteBranchesState(repoPath, remoteBase)
          : Promise.resolve([] as RemoteBranchState[]),
      ]);
      setStaleBranches(local);
      setRemoteBranches(remote);
    } catch (e) {
      setStaleBranches([]);
      setRemoteBranches([]);
      setToast({ kind: "error", title: "Analyse des branches", detail: String(e) });
    } finally {
      setPruneLoading(false);
    }
  }, [repoPath, pruneBase, remoteBase]);

  /**
   * Delete branches on the remote. Confirmed separately from the local case:
   * this changes the server for everyone, and an unmerged branch deleted there
   * is only recoverable by whoever still holds its commits.
   */
  const runRemotePrune = useCallback(
    (branchNames: string[]) => {
      if (!repoPath || branchNames.length === 0) return;
      const path = repoPath;
      const remote = remoteBranches[0]?.remote ?? "origin";
      const unsafe = remoteBranches.filter(
        (b) => branchNames.includes(b.branch) && !b.merged && !b.equivalentMerged,
      );

      setConfirm({
        title: `Supprimer ${branchNames.length} branche(s) sur ${remote} ?`,
        message:
          "Elles disparaissent du serveur pour toute l'équipe. Les copies locales ne sont pas touchées.",
        rows: [
          { label: "Distant", value: remote },
          {
            label: "Branches",
            value:
              branchNames.slice(0, 6).join(", ") +
              (branchNames.length > 6 ? `, +${branchNames.length - 6}` : ""),
          },
        ],
        warning:
          unsafe.length > 0
            ? `${unsafe.length} d'entre elles portent des commits jamais appliqués ailleurs : ce travail deviendra inaccessible.`
            : undefined,
        confirmLabel: "Supprimer sur le serveur",
        danger: true,
        onConfirm: () => {
          void (async () => {
            setPruneRunning(true);
            try {
              const outcomes = await api.deleteRemoteBranches(
                path,
                remote,
                branchNames,
              );
              setPruneOutcomes(outcomes);
              const failed = outcomes.filter((o) => !o.deleted).length;
              setToast({
                kind: failed > 0 ? "error" : "ok",
                title: `${outcomes.length - failed} branche(s) supprimée(s) sur ${remote}${
                  failed > 0 ? `, ${failed} en échec` : ""
                }`,
              });
              await afterWrite(path);
            } catch (e) {
              setToast({ kind: "error", title: "Suppression distante", detail: String(e) });
            } finally {
              setPruneRunning(false);
            }
          })();
        },
      });
    },
    [repoPath, remoteBranches, afterWrite],
  );

  const runPrune = useCallback(
    async (names: string[], force: boolean) => {
      if (!repoPath) return;
      setPruneRunning(true);
      try {
        const outcomes = await api.deleteBranches(repoPath, names, force);
        setPruneOutcomes(outcomes);
        const failed = outcomes.filter((o) => !o.deleted).length;
        setToast({
          kind: failed > 0 ? "error" : "ok",
          title: `${outcomes.length - failed} branche(s) supprimée(s)${
            failed > 0 ? `, ${failed} en échec` : ""
          }`,
        });
        await afterWrite(repoPath);
      } catch (e) {
        setToast({ kind: "error", title: "Suppression", detail: String(e) });
      } finally {
        setPruneRunning(false);
      }
    },
    [repoPath, afterWrite],
  );

  const onBadgeAction = useCallback(
    (action: "checkout" | "merge" | "merge-no-ff", badge: RefBadgeModel) => {
      const branch = resolveBadgeBranch(badge, branches);
      if (!branch) {
        setToast({
          kind: "error",
          title: `Branche ${badge.label} introuvable`,
          detail: "Rescanne le dépôt (⌘R) puis réessaie.",
        });
        return;
      }
      onBranchAction(action, branch);
    },
    [branches, onBranchAction],
  );

  /**
   * Delete a branch, and when git refuses because it is not fully merged,
   * offer the forced delete with the number of commits it would destroy.
   *
   * `git branch -d` is the right default, but its refusal is a dead end in a
   * GUI: the hint tells you to run -D in a terminal.
   */
  const deleteBranch = useCallback(
    async (branch: Branch, force: boolean) => {
      if (!repoPath) return;
      const path = repoPath;
      const label = `Suppression ${branch.short}`;
      try {
        const result = await api.deleteBranch(path, branch.short, force);
        setToast({ kind: "ok", title: label, detail: result.output || undefined });
        await afterWrite(path);
      } catch (e) {
        const message = String(e);
        if (force || !message.includes("not fully merged")) {
          setToast({ kind: "error", title: `${label} — échec`, detail: message });
          return;
        }
        // What would actually be lost. The commit count alone lies: a branch
        // merged through a squashed request keeps commits nothing else has,
        // while every line of it already shipped.
        const contribution = pruneBase
          ? await api.branchContribution(path, branch.short, pruneBase).catch(() => null)
          : null;
        const [contributesNothing, lost] = contribution ?? [false, 0];

        setToast({
          kind: "error",
          title: `${branch.short} n'est pas entièrement fusionnée`,
          detail: !contribution
            ? "Impossible de vérifier ce qu'elle apporte : prudence."
            : contributesNothing
              ? `La fusionner dans ${pruneBase} ne changerait rien : tout son contenu y est déjà${
                  lost > 0
                    ? ` (ses ${lost} commit(s) propres viennent d'une requête squashée ou rebasée)`
                    : ""
                }. La suppression ne perd rien.`
              : `Elle apporte du contenu absent de ${pruneBase}. Le supprimer le rend inaccessible.`,
          action: {
            label: "Supprimer quand même (-D)",
            danger: !contributesNothing,
            run: () => void deleteBranch(branch, true),
          },
        });
      }
    },
    [repoPath, afterWrite],
  );

  /** Bin a worktree directory git could not remove, then prune registrations. */
  const discardLeftovers = useCallback(
    async (repo: RepoGroup, worktree: Worktree) => {
      try {
        const result = await api.discardWorktreeDirectory(
          repo.primaryPath,
          worktree.path,
        );
        setToast({
          kind: "ok",
          title: `Dossier « ${worktree.name} » mis à la corbeille`,
          detail: result.output || undefined,
        });
        setSelected((current) =>
          current?.worktree.path === worktree.path ? null : current,
        );
        if (workspace) await rescan(workspace.roots, workspace.id, workspace.hidden);
      } catch (e) {
        setToast({ kind: "error", title: "Mise à la corbeille", detail: String(e) });
      }
    },
    [workspace, rescan],
  );

  /**
   * Remove a linked worktree. This deletes its directory on disk, so it is
   * confirmed up front with what is at stake, and a refusal for uncommitted
   * work offers the forced removal rather than dead-ending.
   */
  const removeWorktree = useCallback(
    async (repo: RepoGroup, worktree: Worktree, force = false) => {
      const changes =
        worktree.stagedFiles + worktree.dirtyFiles + worktree.untrackedFiles;

      const run = async () => {
        try {
          const result = await api.removeWorktree(
            repo.primaryPath,
            worktree.path,
            force,
          );
          setToast({
            kind: "ok",
            title: `Worktree « ${worktree.name} » supprimé`,
            detail: result.output || undefined,
          });
          // The pane would otherwise point at a directory that no longer exists.
          setSelected((current) =>
            current?.worktree.path === worktree.path ? null : current,
          );
          if (workspace) await rescan(workspace.roots, workspace.id, workspace.hidden);
        } catch (e) {
          const message = String(e);
          // Files git ignores (node_modules, .venv, a Finder .DS_Store) are
          // left behind, so its final rmdir fails even though the worktree
          // itself was removed. Offer to bin the leftovers.
          const leftovers = message.includes("Directory not empty");
          const retryable =
            !force &&
            (message.includes("contains modified or untracked files") ||
              message.includes("is dirty"));

          setToast({
            kind: "error",
            title: leftovers
              ? `Dossier de « ${worktree.name} » non vide`
              : `Suppression de « ${worktree.name} » refusée`,
            detail: leftovers
              ? "Le worktree est bien retiré de git, mais des fichiers ignorés (node_modules, .venv, .DS_Store…) restent dans le dossier."
              : message,
            action: leftovers
              ? {
                  label: "Mettre le dossier à la corbeille",
                  danger: true,
                  run: () => void discardLeftovers(repo, worktree),
                }
              : retryable
                ? {
                    label: "Supprimer quand même (--force)",
                    danger: true,
                    run: () => void removeWorktree(repo, worktree, true),
                  }
                : undefined,
          });
        }
      };

      if (force) return run();

      setConfirm({
        title: `Supprimer le worktree « ${worktree.name} » ?`,
        message:
          "Son dossier est effacé du disque. La branche elle-même n'est pas supprimée et le dépôt n'est pas touché.",
        rows: [
          { label: "Dossier", value: worktree.path },
          { label: "Branche", value: worktree.branch ?? `détaché · ${worktree.head ?? "?"}` },
        ],
        warning:
          changes > 0
            ? `${changes} fichier(s) non commité(s) dans ce worktree seront perdus.`
            : undefined,
        confirmLabel: "Supprimer le worktree",
        danger: true,
        onConfirm: () => void run(),
      });
    },
    [workspace, rescan],
  );

  const onBranchFromCommit = useCallback(
    (sha: string) => {
      if (!repoPath) return;
      const path = repoPath;
      setPrompt({
        title: "Créer une branche",
        hint: `Depuis le commit ${sha.slice(0, 9)}`,
        initial: "",
        confirmLabel: "Créer et checkout",
        onConfirm: (name) => {
          setPrompt(null);
          runAction(`Branche ${name}`, () => api.createBranch(path, name, sha), path);
        },
      });
    },
    [repoPath, runAction],
  );

  // -- Workspace actions --------------------------------------------------

  const addFolderTo = useCallback(
    async (target: Workspace) => {
      const picked = await openDialog({ directory: true, multiple: false });
      if (typeof picked !== "string" || !state) return;
      if (target.roots.includes(picked)) return;
      updateState(
        upsertWorkspace(state, { ...target, roots: [...target.roots, picked] }),
      );
    },
    [state, updateState],
  );

  const createTab = useCallback(async () => {
    if (!state) return;
    const picked = await openDialog({ directory: true, multiple: false });
    // A tab with no folder would be an empty pane; ask for one up front.
    if (typeof picked !== "string") return;
    updateState(
      upsertWorkspace(state, createWorkspace(nameFromPath(picked), [picked])),
    );
  }, [state, updateState]);

  const renameTab = useCallback(
    (target: Workspace) => {
      setPrompt({
        title: "Renommer l'onglet",
        initial: target.name,
        confirmLabel: "Renommer",
        onConfirm: (name) => {
          setPrompt(null);
          if (state) updateState(upsertWorkspace(state, { ...target, name }));
        },
      });
    },
    [state, updateState],
  );

  // -- Chrome -------------------------------------------------------------

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setSelectedSha(null);
        setWipSelected(false);
        setPrompt(null);
        setManaged(null);
        setPruneOpen(false);
        setConfirm(null);
      }
      if (e.key === "r" && e.metaKey && workspace) {
        e.preventDefault();
        rescan(workspace.roots, workspace.id, workspace.hidden);
        if (repoPath) reloadBranches(repoPath);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rescan, workspace, repoPath, reloadBranches]);

  // A pending coalesced write must not be lost when the window goes away.
  useEffect(() => {
    const onLeave = () => void flushSettings();
    window.addEventListener("beforeunload", onLeave);
    window.addEventListener("blur", onLeave);
    return () => {
      window.removeEventListener("beforeunload", onLeave);
      window.removeEventListener("blur", onLeave);
    };
  }, []);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      const fromBottom = window.innerHeight - e.clientY;
      setDetailHeight(Math.min(Math.max(fromBottom, 140), window.innerHeight - 220));
    };
    const onUp = () => {
      dragging.current = false;
      document.body.style.cursor = "";
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  /**
   * Which sync button is running, matched on the label runAction was given.
   * Putting the spinner IN the button is what tells you which one you pressed;
   * the header indicator alone leaves that ambiguous.
   */
  const busyIs = (prefix: string) => !!busyAction?.startsWith(prefix);

  /** A branch with no upstream can always be published; otherwise, ahead > 0. */
  const needsUpstream = !!selected && !selected.worktree.upstream;
  const canPush = !!selected && (needsUpstream || selected.worktree.ahead > 0);

  const dirtyRepos = shownRepos.reduce(
    (acc, r) =>
      acc +
      r.worktrees.filter((w) => w.dirtyFiles + w.stagedFiles + w.untrackedFiles > 0)
        .length,
    0,
  );

  const managedWorkspace =
    state?.workspaces.find((w) => w.id === managed) ?? null;

  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-ink-950">
      <header
        data-tauri-drag-region
        className="flex h-11 shrink-0 items-center gap-3 border-b border-ink-800 bg-ink-900 pr-3 pl-[86px]"
      >
        <span className="text-[13px] font-semibold whitespace-nowrap text-ink-100">
          {selected ? selected.worktree.name : "gitflo"}
        </span>
        {selected && (
          <span className="truncate font-mono text-[11px] text-ink-400">
            {selected.worktree.branch ?? `détaché · ${selected.worktree.head}`}
          </span>
        )}
        {/* One slot, right-aligned, wide enough for either message: swapping
            a short label for a longer one moved the buttons after it. */}
        <span className="ml-auto flex min-w-[220px] justify-end truncate text-[11px]">
          {busyAction ? (
            <span className="flex items-center gap-1.5 whitespace-nowrap text-accent">
              <Loader2 size={12} className="animate-spin" />
              {busyAction}…
            </span>
          ) : (
            <span className="whitespace-nowrap text-ink-500">
              {shownRepos.length} dépôts · {dirtyRepos} avec des modifs
            </span>
          )}
        </span>

        <button
          disabled={!repoPath || !!busyAction}
          onClick={() =>
            repoPath &&
            runAction("Fetch --all --prune", () => api.fetch(repoPath), repoPath)
          }
          {...tip({
            title: "Fetch --all --prune",
            subtitle: selected ? `Sur ${selected.worktree.name} seulement` : undefined,
            hint: "N'agit pas sur les autres dépôts de la liste",
          })}
          className="flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-[11px] whitespace-nowrap text-ink-300 hover:bg-ink-700 hover:text-ink-100 disabled:cursor-default disabled:opacity-30"
        >
          {busyIs("Fetch") ? (
            <Loader2 size={13} className="animate-spin" />
          ) : (
            <DownloadCloud size={13} />
          )}{" "}
          Fetch
        </button>
        <button
          disabled={!repoPath || !!busyAction}
          onClick={() =>
            repoPath && runAction("Pull --ff-only", () => api.pull(repoPath), repoPath)
          }
          {...tip({
            title: "Pull --ff-only",
            subtitle: selected ? `Sur ${selected.worktree.name} seulement` : undefined,
            hint: "N'agit pas sur les autres dépôts de la liste",
          })}
          className="flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-[11px] whitespace-nowrap text-ink-300 hover:bg-ink-700 hover:text-ink-100 disabled:cursor-default disabled:opacity-30"
        >
          {busyIs("Pull") ? (
            <Loader2 size={13} className="animate-spin" />
          ) : (
            <GitPullRequestArrow size={13} />
          )}{" "}
          Pull
        </button>
        <button
          onClick={() => {
            if (workspace) rescan(workspace.roots, workspace.id, workspace.hidden);
            if (repoPath) reloadBranches(repoPath);
          }}
          {...tip("Rescanner (⌘R)")}
          className="cursor-pointer rounded-md p-1.5 text-ink-300 hover:bg-ink-700 hover:text-ink-100"
        >
          <RefreshCw size={13} className={scanning ? "animate-spin" : ""} />
        </button>
      </header>

      {state && (
        <WorkspaceTabs
          workspaces={state.workspaces}
          activeId={state.activeId}
          repoCounts={repoCounts}
          onActivate={(id) => updateState({ ...state, activeId: id })}
          onCreate={createTab}
          onRename={renameTab}
          onRemove={(w) => updateState(removeWorkspace(state, w.id))}
          onManage={(w) => setManaged(w.id)}
          onAddFolder={addFolderTo}
        />
      )}

      <div className="flex min-h-0 flex-1">
        <RepoSidebar
          repos={shownRepos}
          selectedPath={repoPath}
          loading={scanning}
          hidden={hiddenList}
          collapsedRepos={state?.collapsedRepos ?? []}
          onToggleCollapsed={toggleCollapsed}
          onSelect={(repo, worktree) => setSelected({ repo, worktree })}
          onRefresh={() =>
            workspace && rescan(workspace.roots, workspace.id, workspace.hidden)
          }
          onAddRoot={() => workspace && addFolderTo(workspace)}
          onHide={hideEntry}
          onUnhide={hideEntry}
          onRemoveWorktree={(repo, worktree) => removeWorktree(repo, worktree)}
          onUnhideAll={() => {
            if (state && workspace) {
              updateState(upsertWorkspace(state, clearHidden(workspace)));
            }
          }}
        />

        {selected ? (
          <>
            <BranchList
              branches={branches}
              selectedRef={shownFilter?.refname ?? null}
              currentBranch={selected.worktree.branch}
              worktreePath={selected.worktree.path}
              onSelect={(branch) =>
                setFilter(branch ? { repoPath: selected.worktree.path, branch } : null)
              }
              onAction={onBranchAction}
              onPrune={openPrune}
              pruneBusy={pruneLoading || pruneRunning}
            />

            <main className="flex min-w-0 flex-1 flex-col">
              <div className="flex h-8 shrink-0 items-center gap-2 border-b border-ink-800 px-3 text-[11px] whitespace-nowrap text-ink-400">
                <span className="font-medium text-ink-200">
                  {shownFilter ? shownFilter.short : "Toutes les branches"}
                </span>
                {/* Fixed slot: mounting the spinner only while loading shifted
                    every button to its right, mid-click. */}
                <span className="flex w-3 shrink-0 justify-center">
                  {loadingCommits && (
                    <Loader2 size={11} className="animate-spin text-ink-500" />
                  )}
                </span>

                {/* Push, pull and fetch stay in place and go DISABLED rather
                    than disappearing: buttons that come and go move the ones
                    next to them, and that is how you misclick. */}
                <button
                  disabled={!!busyAction || !canPush}
                  onClick={() =>
                    repoPath &&
                    runAction(
                      needsUpstream ? "Push --set-upstream" : "Push",
                      () => api.push(repoPath, needsUpstream),
                      repoPath,
                    )
                  }
                  {...tip({
                    title: needsUpstream
                      ? "Publier cette branche"
                      : selected.worktree.ahead > 0
                        ? `Pousser ${selected.worktree.ahead} commit(s)`
                        : "Rien à pousser",
                    subtitle: selected.worktree.upstream ?? "aucun upstream",
                    badges: [
                      {
                        label: needsUpstream
                          ? "git push -u origin HEAD"
                          : "git push",
                        tone: "muted",
                      },
                    ],
                    hint: "Ne touche que ce worktree",
                  })}
                  className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] ${
                    canPush
                      ? "cursor-pointer bg-ahead/15 text-ahead hover:bg-ahead/25"
                      : "text-ink-600"
                  } disabled:cursor-default`}
                >
                  {busyIs("Push") ? (
                    <Loader2 size={11} className="animate-spin" />
                  ) : (
                    <ArrowUpFromLine size={11} />
                  )}
                  {busyIs("Push")
                    ? "Push…"
                    : needsUpstream
                      ? "Publier"
                      : `Push ↑${selected.worktree.ahead}`}
                </button>

                <button
                  disabled={!!busyAction || selected.worktree.behind === 0}
                  onClick={() =>
                    repoPath &&
                    runAction("Pull --ff-only", () => api.pull(repoPath), repoPath)
                  }
                  {...tip({
                    title:
                      selected.worktree.behind > 0
                        ? `Récupérer ${selected.worktree.behind} commit(s)`
                        : "Rien à récupérer",
                    subtitle: selected.worktree.upstream ?? "aucun upstream",
                    badges: [{ label: "git pull --ff-only", tone: "muted" }],
                    hint: "Ne touche que ce worktree",
                  })}
                  className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] ${
                    selected.worktree.behind > 0
                      ? "cursor-pointer bg-accent/15 text-accent hover:bg-accent/25"
                      : "text-ink-600"
                  } disabled:cursor-default`}
                >
                  {busyIs("Pull") ? (
                    <Loader2 size={11} className="animate-spin" />
                  ) : (
                    <GitPullRequestArrow size={11} />
                  )}
                  {busyIs("Pull") ? "Pull…" : `Pull ↓${selected.worktree.behind}`}
                </button>

                <button
                  disabled={!!busyAction}
                  onClick={() =>
                    repoPath &&
                    runAction(
                      "Fetch --all --prune",
                      () => api.fetch(repoPath),
                      repoPath,
                    )
                  }
                  {...tip({
                    title: "Fetch --all --prune",
                    subtitle: lastFetch
                      ? `Dernier fetch : ${absoluteTime(new Date(lastFetch * 1000).toISOString())}`
                      : "Aucun fetch enregistré pour ce dépôt",
                    hint: "L'avance et le retard affichés datent de ce fetch",
                  })}
                  className="flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-ink-500 hover:bg-ink-800 hover:text-ink-200 disabled:cursor-default disabled:opacity-40"
                >
                  {busyIs("Fetch") ? (
                    <Loader2 size={11} className="animate-spin" />
                  ) : (
                    <DownloadCloud size={11} />
                  )}
                  {busyIs("Fetch")
                    ? "Fetch…"
                    : lastFetch
                      ? relativeTime(new Date(lastFetch * 1000).toISOString())
                      : "jamais"}
                </button>

                <span className="ml-auto" />

                <button
                  onClick={() =>
                    state && updateState({ ...state, richColors: !state.richColors })
                  }
                  {...tip({
                    title: state?.richColors
                      ? "Badges colorés"
                      : "Badges neutres",
                    subtitle: state?.richColors
                      ? "Chaque badge prend la couleur de sa lane"
                      : "Seuls le tronc, la branche d'intégration et HEAD sont colorés",
                    hint: "Le graphe garde ses couleurs dans les deux cas",
                  })}
                  className={`flex cursor-pointer items-center gap-1.5 rounded px-2 py-1 ${
                    state?.richColors
                      ? "bg-ink-700 text-ink-100"
                      : "text-ink-500 hover:bg-ink-800 hover:text-ink-200"
                  }`}
                >
                  <Palette size={12} />
                  <span className="text-[10px]">
                    {state?.richColors ? "badges colorés" : "badges neutres"}
                  </span>
                </button>
              </div>

              <div className="min-h-0 flex-1">
                <CommitGraph
                  commits={commits}
                  priorityShas={priorityShas}
                  selectedSha={selectedSha}
                  headSha={headSha}
                  wip={wipSummary}
                  wipSelected={wipSelected}
                  gutterWidth={state?.gutterWidth ?? null}
                  onGutterWidthChange={setGutterWidth}
                  richColors={state?.richColors ?? false}
                  onSelect={selectCommit}
                  onSelectWip={selectWip}
                  onBranchFrom={onBranchFromCommit}
                  onBadgeAction={onBadgeAction}
                  currentBranch={selected.worktree.branch}
                  loading={loadingCommits}
                />
              </div>

              {(selectedSha || wipSelected) && (
                <>
                  <div
                    onMouseDown={() => {
                      dragging.current = true;
                      document.body.style.cursor = "row-resize";
                    }}
                    className="h-[3px] shrink-0 cursor-row-resize bg-ink-800 hover:bg-accent/60"
                  />
                  <div
                    style={{ height: detailHeight }}
                    className="shrink-0 border-t border-ink-800 bg-ink-900"
                  >
                    <CommitDetailPanel
                      repo={repoPath!}
                      detail={wipSelected ? null : detail}
                      wipTree={wipSelected ? wipTree : null}
                      loading={loadingDetail}
                      onClose={() => {
                        setSelectedSha(null);
                        setWipSelected(false);
                      }}
                    />
                  </div>
                </>
              )}
            </main>
          </>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 text-ink-500">
            <p className="text-[13px]">
              {roots.length > 0
                ? "Sélectionne un dépôt à gauche."
                : "Cet onglet n'a aucun dossier."}
            </p>
            <p className="text-[11px]">
              {roots.length > 0
                ? roots.join(" · ")
                : "Ajoute-en un avec l'icône dossier de la barre d'onglets."}
            </p>
          </div>
        )}
      </div>

      <WorkspaceSettings
        workspace={managedWorkspace}
        onAddFolder={() => managedWorkspace && addFolderTo(managedWorkspace)}
        onRemoveFolder={(root) => {
          if (!state || !managedWorkspace) return;
          updateState(
            upsertWorkspace(state, {
              ...managedWorkspace,
              roots: managedWorkspace.roots.filter((r) => r !== root),
            }),
          );
        }}
        onRename={() => managedWorkspace && renameTab(managedWorkspace)}
        onClose={() => setManaged(null)}
      />

      <ConfirmDialog spec={confirm} onCancel={() => setConfirm(null)} />

      <PruneModal
        open={pruneOpen}
        repoName={selected?.repo.name ?? ""}
        branches={staleBranches}
        remoteBranches={remoteBranches}
        base={remoteBase}
        tab={pruneTab}
        onTabChange={setPruneTab}
        loading={pruneLoading}
        running={pruneRunning}
        outcomes={pruneOutcomes}
        onConfirm={runPrune}
        onConfirmRemote={runRemotePrune}
        onClose={() => setPruneOpen(false)}
      />

      <PromptDialog
        open={!!prompt}
        title={prompt?.title ?? ""}
        hint={prompt?.hint}
        initial={prompt?.initial ?? ""}
        confirmLabel={prompt?.confirmLabel ?? "OK"}
        onConfirm={(v) => prompt?.onConfirm(v)}
        onCancel={() => setPrompt(null)}
      />
      <Toast toast={toast} onClose={() => setToast(null)} />
      <TooltipHost />
    </div>
  );
}
