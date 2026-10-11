import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  ArrowUpFromLine,
  ChevronDown,
  DownloadCloud,
  GitBranch,
  GitPullRequestArrow,
  ListFilter,
  Loader2,
  RefreshCw,
  Settings2,
} from "lucide-react";
import { api } from "./api";
import type {
  Branch,
  Commit,
  CommitDetail,
  DeleteOutcome,
  Editor,
  PullMode,
  RemoteBranchState,
  RepoGroup,
  StaleBranch,
  WebRemote,
  WorkingTree,
  Worktree,
} from "./types";
import { RepoSidebar } from "./components/RepoSidebar";
import {
  BranchList,
  type BranchAction,
  type BranchWebLink,
} from "./components/BranchList";
import { BranchPicker } from "./components/BranchPicker";
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
import { showContextMenu, type MenuSpec } from "./lib/menu";
import { GitLock } from "./lib/gitLock";
import { branchUrl, commitUrl, openOnLabel, publishedName } from "./lib/webUrl";
import { openUrl } from "@tauri-apps/plugin-opener";
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
  EDITORS,
  nameFromPath,
  PULL_MODES,
  removeWorkspace,
  toggleHidden,
  upsertWorkspace,
  type Workspace,
  type WorkspaceState,
} from "./lib/workspaces";
import { flushSettings, loadSettings, persistSettings } from "./lib/settings";

const COMMIT_LIMIT = 400;

/** Background fetch cadence while auto-fetch is on. */
const AUTO_FETCH_INTERVAL_MS = 5 * 60 * 1000;
/** Coming back to the window re-fetches only if the last one is older. */
const AUTO_FETCH_MIN_GAP_MS = 60 * 1000;
/** Coming back to the window re-reads the local state at most this often. */
const FOCUS_REFRESH_GAP_MS = 5 * 1000;

const PULL_LABEL: Record<PullMode, string> = {
  rebase: "Pull --rebase",
  merge: "Pull (merge)",
  "ff-only": "Pull --ff-only",
};

const PULL_COMMAND: Record<PullMode, string> = {
  rebase: "git pull --rebase --autostash",
  merge: "git pull --no-rebase --autostash",
  "ff-only": "git pull --ff-only",
};

const EDITOR_NAME: Record<Editor, string> = {
  vscode: "VS Code",
  cursor: "Cursor",
  zed: "Zed",
};

const PULL_HINT: Record<PullMode, string> = {
  rebase: "Rejoue tes commits locaux par-dessus ceux du serveur",
  merge: "Crée un commit de merge si les deux côtés ont avancé",
  "ff-only": "Refuse dès que la branche a divergé",
};

/** The worktree at `path` among a tab's visible repos, as a selection. */
function findSelection(repos: RepoGroup[], path: string | null, workspaceId: string) {
  if (!path) return null;
  for (const repo of repos) {
    const worktree = repo.worktrees.find((w) => w.path === path);
    if (worktree) return { repo, worktree, workspaceId };
  }
  return null;
}

/**
 * What was last read for a repo, shown at once when it is reopened while the
 * fresh read runs. Only ever shown for the repo it was read from.
 */
interface RepoCache {
  branches?: Branch[];
  /** Keyed by the revs it was read with: a filtered history is another list. */
  commits?: { key: string; list: Commit[] };
  lastFetch?: number | null;
  webRemote?: WebRemote | null;
}

const revsKey = (revs: string[]) => revs.join("\u0000");

export default function App() {
  const [state, setState] = useState<WorkspaceState | null>(null);
  const [repos, setRepos] = useState<RepoGroup[]>([]);
  const [repoCounts, setRepoCounts] = useState<Record<string, number>>({});
  const [scanning, setScanning] = useState(false);

  /** The open worktree, and the tab it was opened from (its memory slot). */
  const [selected, setSelected] = useState<{
    repo: RepoGroup;
    worktree: Worktree;
    workspaceId: string;
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
  /** Where the open repo's remote lives on the web, for "open on GitHub". */
  const [webRemote, setWebRemote] = useState<WebRemote | null>(null);
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
  /** Worktree path to re-select once the tab's scan returns. */
  const restoreTargetRef = useRef<string | null>(null);

  const repoPath = selected?.worktree.path ?? null;
  const workspace = state ? activeWorkspace(state) : null;
  const roots = workspace?.roots ?? [];

  /**
   * Latest values, for async code to check against when it lands.
   *
   * Every read is asynchronous and every one of them can finish after the
   * user has moved on (another repo, another tab, another filter). A result is
   * only applied if what it was asked for is still what is on screen —
   * otherwise repo A's history ends up under repo B's name, and the next
   * checkout from B's branch list runs with A's branches.
   */
  const repoPathRef = useRef(repoPath);
  repoPathRef.current = repoPath;
  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;

  /** The single lock every git write goes through (see lib/gitLock.ts). */
  const lockRef = useRef(new GitLock());

  // -- Workspace state ----------------------------------------------------

  useEffect(() => {
    // The fallback roots are only consulted on a truly first launch.
    api
      .defaultRoots()
      .then((defaults) => loadSettings(defaults))
      .then(setState);
  }, []);

  const updateState = useCallback((next: WorkspaceState) => {
    setState(next);
    persistSettings(next);
  }, []);

  // Remember what each tab had open, so coming back to it (or relaunching)
  // lands on the same repo. Written to the tab the selection was made in —
  // never to "the active tab", which during a switch is already the next one.
  // An empty selection is not written: it is a transient state of a switch.
  useEffect(() => {
    if (!state || !selected) return;
    const owner = state.workspaces.find((w) => w.id === selected.workspaceId);
    if (!owner || owner.selectedPath === selected.worktree.path) return;
    updateState(upsertWorkspace(state, { ...owner, selectedPath: selected.worktree.path }));
  }, [selected, state, updateState]);

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

  /** Tab the repo list was scanned for: stale until the new scan lands. */
  const [reposWorkspaceId, setReposWorkspaceId] = useState<string | null>(null);
  const scanSeq = useRef(0);
  /**
   * Last scan of each tab, so switching tabs is instant: the cached list shows
   * right away and the rescan refreshes it in the background.
   */
  const reposCacheRef = useRef<Record<string, RepoGroup[]>>({});
  const repoCacheRef = useRef<Record<string, RepoCache>>({});
  const cacheFor = (path: string) => (repoCacheRef.current[path] ??= {});

  const rescan = useCallback(
    async (rootList: string[], workspaceId: string, hiddenKeys: string[]) => {
      const seq = ++scanSeq.current;
      if (rootList.length === 0) {
        restoreTargetRef.current = null;
        setRepos([]);
        setReposWorkspaceId(workspaceId);
        setRepoCounts((counts) => ({ ...counts, [workspaceId]: 0 }));
        setScanning(false);
        return;
      }
      setScanning(true);
      try {
        const found = await api.scanWorkspace(rootList);
        // A newer scan (another tab, a folder added) supersedes this one.
        if (seq !== scanSeq.current) return;
        reposCacheRef.current[workspaceId] = found;
        setRepos(found);
        setReposWorkspaceId(workspaceId);
        // Count what the tab shows, not what the disk holds.
        setRepoCounts((counts) => ({
          ...counts,
          [workspaceId]: visibleRepos(found, hiddenKeys).length,
        }));

        const restore = restoreTargetRef.current;
        restoreTargetRef.current = null;
        setSelected((current) => {
          // First scan of a tab (launch, or switching to it): reopen what was
          // open there last time — unless something was clicked meanwhile.
          if (!current && restore) {
            return findSelection(visibleRepos(found, hiddenKeys), restore, workspaceId);
          }
          // Keep the current selection pointing at a live object.
          if (!current) return current;
          const repo = found.find((r) => r.id === current.repo.id);
          const worktree = repo?.worktrees.find((w) => w.path === current.worktree.path);
          return repo && worktree ? { ...current, repo, worktree } : null;
        });
      } catch (e) {
        if (seq !== scanSeq.current) return;
        setToast({ kind: "error", title: "Scan impossible", detail: String(e) });
      } finally {
        if (seq === scanSeq.current) setScanning(false);
      }
    },
    [],
  );

  const rescanCurrent = useCallback(async () => {
    const w = workspaceRef.current;
    if (w) await rescan(w.roots, w.id, w.hidden);
  }, [rescan]);

  const shownWorkspaceRef = useRef<string | null>(null);
  useEffect(() => {
    if (!workspace) return;
    // Another tab: drop the previous tab's list now rather than showing it
    // under the new tab's name until the scan lands.
    if (shownWorkspaceRef.current !== workspace.id) {
      shownWorkspaceRef.current = workspace.id;
      const cached = reposCacheRef.current[workspace.id];
      if (cached) {
        // Seen before: show its last scan and reopen its repo right away.
        setRepos(cached);
        setReposWorkspaceId(workspace.id);
        setSelected(
          findSelection(
            visibleRepos(cached, workspace.hidden),
            workspace.selectedPath,
            workspace.id,
          ),
        );
        restoreTargetRef.current = null;
      } else {
        setRepos([]);
        setReposWorkspaceId(null);
        // Each tab reopens its own last repo once its list lands.
        setSelected(null);
        restoreTargetRef.current = workspace.selectedPath;
      }
    }
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

  // The filter carries the repo it was chosen in, so switching repos can never
  // send another repo's ref to git (see lib/revs.ts).
  const revs = useMemo(() => resolveRevs(filter, repoPath), [filter, repoPath]);
  const shownFilter = useMemo(() => activeFilter(filter, repoPath), [filter, repoPath]);
  const revsRef = useRef(revs);
  revsRef.current = revs;

  const [loadingBranches, setLoadingBranches] = useState(false);
  const branchesSeq = useRef(0);
  const commitsSeq = useRef(0);

  const reloadBranches = useCallback(async (path: string) => {
    const seq = ++branchesSeq.current;
    setLoadingBranches(true);
    try {
      const list = await api.listBranches(path);
      cacheFor(path).branches = list;
      if (seq === branchesSeq.current && path === repoPathRef.current) setBranches(list);
    } catch (e) {
      if (seq === branchesSeq.current && path === repoPathRef.current) {
        setToast({ kind: "error", title: "Lecture des branches", detail: String(e) });
      }
    } finally {
      if (seq === branchesSeq.current) setLoadingBranches(false);
    }
  }, []);

  const reloadCommits = useCallback(async (path: string, revList: string[]) => {
    const seq = ++commitsSeq.current;
    setLoadingCommits(true);
    try {
      const list = await api.listCommits(path, revList, COMMIT_LIMIT);
      cacheFor(path).commits = { key: revsKey(revList), list };
      if (seq === commitsSeq.current && path === repoPathRef.current) setCommits(list);
    } catch (e) {
      if (seq === commitsSeq.current && path === repoPathRef.current) {
        setCommits([]);
        setToast({ kind: "error", title: "Lecture de l'historique", detail: String(e) });
      }
    } finally {
      if (seq === commitsSeq.current) setLoadingCommits(false);
    }
  }, []);

  const reloadLastFetch = useCallback(async (path: string) => {
    const value = await api.lastFetch(path).catch(() => null);
    cacheFor(path).lastFetch = value;
    if (path === repoPathRef.current) setLastFetch(value);
  }, []);

  // Another repo: replace everything bound to the previous one at once —
  // with what was last read for THIS repo if it was open before (instant
  // switch, refreshed just after), else empty lists with their spinners.
  // Never the previous repo's data, which a checkout could be run from.
  useEffect(() => {
    const cached = repoPath ? repoCacheRef.current[repoPath] : undefined;
    const commitsCache = cached?.commits;
    setBranches(cached?.branches ?? []);
    setCommits(
      commitsCache && commitsCache.key === revsKey(revsRef.current) ? commitsCache.list : [],
    );
    setLastFetch(cached?.lastFetch ?? null);
    setWebRemote(cached?.webRemote ?? null);
    setSelectedSha(null);
    setDetail(null);
    setWipSelected(false);
    setWipTree(null);
    if (!repoPath) return;
    reloadBranches(repoPath);
    reloadLastFetch(repoPath);
    const path = repoPath;
    api
      .remoteWebUrl(path)
      .then((remote) => {
        cacheFor(path).webRemote = remote;
        if (path === repoPathRef.current) setWebRemote(remote);
      })
      .catch(() => undefined);
  }, [repoPath, reloadBranches, reloadLastFetch]);

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

  const wipSelectedRef = useRef(wipSelected);
  wipSelectedRef.current = wipSelected;

  const reloadWip = useCallback(async (path: string) => {
    const tree = await api.workingTree(path).catch(() => null);
    if (path === repoPathRef.current && wipSelectedRef.current) setWipTree(tree);
  }, []);

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

  // -- Refresh ------------------------------------------------------------

  /**
   * Re-read everything on screen: the tab's repo list (working-tree counts,
   * ahead/behind) and, if `path` is still the open repo, its branches, history
   * and working tree. Safe to call from anywhere, at any time: each read checks
   * on landing that it still applies.
   */
  const refresh = useCallback(
    async (path: string | null) => {
      const reads: Promise<unknown>[] = [rescanCurrent()];
      if (path && path === repoPathRef.current) {
        reads.push(
          reloadBranches(path),
          reloadCommits(path, revsRef.current),
          reloadLastFetch(path),
        );
        if (wipSelectedRef.current) reads.push(reloadWip(path));
      }
      await Promise.all(reads);
    },
    [rescanCurrent, reloadBranches, reloadCommits, reloadLastFetch, reloadWip],
  );

  // -- Actions ------------------------------------------------------------

  /** Label and repo of the git write running, for the indicators. */
  const [busy, setBusy] = useState<{ label: string; path: string } | null>(null);

  /**
   * Run a git write under the app-wide lock, with the indicator on.
   *
   * `path` is bound when the user clicks, never read later, so the command
   * runs on the repo that was on screen at that moment even if another one is
   * opened while it runs. Returns undefined when refused (another write is
   * running) — the toast says so.
   */
  const withLock = useCallback(
    async <T,>(label: string, path: string, fn: () => Promise<T>): Promise<T | undefined> => {
      const lock = lockRef.current;
      if (lock.busy) {
        setToast({
          kind: "error",
          title: "Une action est déjà en cours",
          detail: `${lock.busy} — attends qu'elle se termine.`,
        });
        return undefined;
      }
      setBusy({ label, path });
      try {
        const result = await lock.run(label, fn);
        return result?.value;
      } finally {
        setBusy(null);
      }
    },
    [],
  );

  /** Names the repo in a message when it is no longer the one on screen. */
  const where = (path: string) =>
    path === repoPathRef.current ? "" : ` (${nameFromPath(path)})`;

  const runAction = useCallback(
    async (label: string, fn: () => Promise<{ output: string }>, path: string) => {
      await withLock(label, path, async () => {
        try {
          const result = await fn();
          setToast({ kind: "ok", title: label + where(path), detail: result.output || undefined });
        } catch (e) {
          // git's own stderr is the useful part here (conflicts, dirty tree…).
          setToast({ kind: "error", title: `${label}${where(path)} — échec`, detail: String(e) });
        }
        await refresh(path);
      });
    },
    [withLock, refresh],
  );

  // -- Auto-fetch ---------------------------------------------------------

  const [autoFetching, setAutoFetching] = useState(false);
  /** Last background fetch per tab, so switching tabs does not skip one. */
  const lastAutoFetchRef = useRef<Record<string, number>>({});
  const shownReposRef = useRef(shownRepos);
  shownReposRef.current = shownRepos;
  const reposWorkspaceRef = useRef(reposWorkspaceId);
  reposWorkspaceRef.current = reposWorkspaceId;

  /**
   * Fetch every repo the tab shows, then refresh what is on screen.
   *
   * Silent unless asked for (`manual`): a background fetch that toasts on each
   * flaky remote would be noise. Fetch is per repository, not per worktree,
   * so linked worktrees are fetched once through their primary checkout.
   */
  const fetchAll = useCallback(
    async (manual: boolean) => {
      const w = workspaceRef.current;
      // Only once the list really is this tab's: right after a tab switch it
      // still holds the previous one.
      if (!w || reposWorkspaceRef.current !== w.id) return;
      const targets = [...new Set(shownReposRef.current.map((r) => r.primaryPath))];
      if (targets.length === 0) return;

      const ran = await lockRef.current.runBackground(async () => {
        setAutoFetching(true);
        try {
          const outcomes = await api.fetchMany(targets);
          lastAutoFetchRef.current[w.id] = Date.now();
          if (manual) {
            const failed = outcomes.filter((o) => !o.ok);
            setToast({
              kind: failed.length > 0 ? "error" : "ok",
              title: `Fetch de ${outcomes.length - failed.length}/${outcomes.length} dépôt(s)`,
              detail:
                failed.length > 0
                  ? failed
                      .map((o) => `${nameFromPath(o.repo)} : ${o.output.split("\n")[0]}`)
                      .join("\n")
                  : undefined,
            });
          }
        } catch (e) {
          if (manual) setToast({ kind: "error", title: "Fetch des dépôts", detail: String(e) });
        } finally {
          setAutoFetching(false);
        }
      });
      if (ran) await refresh(repoPathRef.current);
      else if (manual) {
        setToast({ kind: "error", title: "Fetch des dépôts", detail: "Une action est déjà en cours." });
      }
    },
    [refresh],
  );

  const fetchDue = () => {
    const w = workspaceRef.current;
    return !!w && Date.now() - (lastAutoFetchRef.current[w.id] ?? 0) > AUTO_FETCH_MIN_GAP_MS;
  };

  // Timers and listeners call the latest closures without re-subscribing.
  const fetchAllRef = useRef(fetchAll);
  fetchAllRef.current = fetchAll;
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  const autoFetchOn = state?.autoFetch ?? false;
  /** Set once this tab's scan has landed: what the auto-fetch waits for. */
  const scannedTab = reposWorkspaceId === workspace?.id ? reposWorkspaceId : null;

  useEffect(() => {
    if (!autoFetchOn || !scannedTab) return;
    // Right away when turned on or when a tab's list lands, then on a cadence —
    // even in the background, so the window is current when you come back.
    if (fetchDue()) void fetchAllRef.current(false);
    const timer = setInterval(() => void fetchAllRef.current(false), AUTO_FETCH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [autoFetchOn, scannedTab]);

  // Coming back to the window: whatever changed meanwhile (a commit from the
  // terminal, files edited in the editor) shows up without ⌘R. Throttled: a
  // quick alt-tab back and forth does not re-read every repo each time.
  const lastFocusRefreshRef = useRef(0);
  useEffect(() => {
    const onFocus = () => {
      if (lockRef.current.busy) return;
      if (autoFetchOn && fetchDue()) {
        void fetchAllRef.current(false);
        return;
      }
      if (Date.now() - lastFocusRefreshRef.current < FOCUS_REFRESH_GAP_MS) return;
      lastFocusRefreshRef.current = Date.now();
      void refreshRef.current(repoPathRef.current);
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [autoFetchOn]);

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

  /**
   * Delete a branch, and when git refuses because it is not fully merged,
   * offer the forced delete with what it would actually destroy.
   *
   * `git branch -d` is the right default, but its refusal is a dead end in a
   * GUI: the hint tells you to run -D in a terminal.
   */
  const deleteBranch = useCallback(
    async (branch: Branch, force: boolean) => {
      if (!repoPath) return;
      const path = repoPath;
      // Bound now, with the branch list it was computed from.
      const base = pruneBase;
      const label = `Suppression ${branch.short}`;
      await withLock(label, path, async () => {
        try {
          const result = await api.deleteBranch(path, branch.short, force);
          setToast({ kind: "ok", title: label + where(path), detail: result.output || undefined });
          await refresh(path);
          return;
        } catch (e) {
          const message = String(e);
          if (force || !message.includes("not fully merged")) {
            setToast({ kind: "error", title: `${label}${where(path)} — échec`, detail: message });
            return;
          }
          // What would actually be lost. The commit count alone lies: a branch
          // merged through a squashed request keeps commits nothing else has,
          // while every line of it already shipped.
          let contribution: [boolean, number] | null = null;
          let checkError: string | null = null;
          if (base) {
            try {
              contribution = await api.branchContribution(path, branch.short, base);
            } catch (err) {
              checkError = String(err);
            }
          }
          const [contributesNothing, lost] = contribution ?? [false, 0];

          setToast({
            kind: "error",
            title: `${branch.short} n'est pas entièrement fusionnée`,
            detail: !contribution
              ? `Impossible de vérifier ce qu'elle apporte${
                  checkError ? ` (${checkError})` : base ? "" : " : aucune branche d'intégration"
                } — prudence.`
              : contributesNothing
                ? `La fusionner dans ${base} ne changerait rien : tout son contenu y est déjà${
                    lost > 0
                      ? ` (ses ${lost} commit(s) propres viennent d'une requête squashée ou rebasée)`
                      : ""
                  }. La suppression ne perd rien.`
                : `Elle apporte du contenu absent de ${base}. La supprimer le rend inaccessible.`,
            action: {
              label: "Supprimer quand même (-D)",
              danger: !contributesNothing,
              run: () => void deleteBranchRef.current(branch, true),
            },
          });
        }
      });
    },
    [repoPath, pruneBase, withLock, refresh],
  );
  // The toast's retry runs later, from whatever render is current then.
  const deleteBranchRef = useRef(deleteBranch);
  deleteBranchRef.current = deleteBranch;

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
    [repoPath, selected, branches, runAction, deleteBranch],
  );

  const pruneSeq = useRef(0);
  const openPrune = useCallback(async () => {
    if (!repoPath) return;
    const path = repoPath;
    const seq = ++pruneSeq.current;
    setPruneOpen(true);
    setPruneOutcomes(null);
    setStaleBranches([]);
    setRemoteBranches([]);
    setPruneLoading(true);
    try {
      // Both sides at once: switching tabs must not re-scan.
      const [local, remote] = await Promise.all([
        api.staleBranches(path, pruneBase),
        remoteBase
          ? api.remoteBranchesState(path, remoteBase)
          : Promise.resolve([] as RemoteBranchState[]),
      ]);
      if (seq !== pruneSeq.current) return;
      setStaleBranches(local);
      setRemoteBranches(remote);
    } catch (e) {
      if (seq !== pruneSeq.current) return;
      setToast({ kind: "error", title: "Analyse des branches", detail: String(e) });
    } finally {
      if (seq === pruneSeq.current) setPruneLoading(false);
    }
  }, [repoPath, pruneBase, remoteBase]);

  // The prune modal is about one repo: switching away closes it, so its
  // delete button can never act on the repo opened next.
  useEffect(() => {
    pruneSeq.current++;
    setPruneOpen(false);
    setPruneLoading(false);
  }, [repoPath]);

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
          { label: "Dépôt", value: nameFromPath(path) },
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
          void withLock(`Suppression sur ${remote}`, path, async () => {
            setPruneRunning(true);
            try {
              const outcomes = await api.deleteRemoteBranches(path, remote, branchNames);
              setPruneOutcomes(outcomes);
              const failed = outcomes.filter((o) => !o.deleted).length;
              setToast({
                kind: failed > 0 ? "error" : "ok",
                title: `${outcomes.length - failed} branche(s) supprimée(s) sur ${remote}${
                  failed > 0 ? `, ${failed} en échec` : ""
                }`,
              });
            } catch (e) {
              setToast({ kind: "error", title: "Suppression distante", detail: String(e) });
            } finally {
              setPruneRunning(false);
            }
            await refresh(path);
          });
        },
      });
    },
    [repoPath, remoteBranches, withLock, refresh],
  );

  const runPrune = useCallback(
    async (names: string[], force: boolean) => {
      if (!repoPath) return;
      const path = repoPath;
      await withLock(`Suppression de ${names.length} branche(s)`, path, async () => {
        setPruneRunning(true);
        try {
          const outcomes = await api.deleteBranches(path, names, force);
          setPruneOutcomes(outcomes);
          const failed = outcomes.filter((o) => !o.deleted).length;
          setToast({
            kind: failed > 0 ? "error" : "ok",
            title: `${outcomes.length - failed} branche(s) supprimée(s)${
              failed > 0 ? `, ${failed} en échec` : ""
            }`,
          });
        } catch (e) {
          setToast({ kind: "error", title: "Suppression", detail: String(e) });
        } finally {
          setPruneRunning(false);
        }
        await refresh(path);
      });
    },
    [repoPath, withLock, refresh],
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

  /** Bin a worktree directory git could not remove, then prune registrations. */
  const discardLeftovers = useCallback(
    async (repo: RepoGroup, worktree: Worktree) => {
      await withLock(`Corbeille ${worktree.name}`, repo.primaryPath, async () => {
        try {
          const result = await api.discardWorktreeDirectory(repo.primaryPath, worktree.path);
          setToast({
            kind: "ok",
            title: `Dossier « ${worktree.name} » mis à la corbeille`,
            detail: result.output || undefined,
          });
          setSelected((current) =>
            current?.worktree.path === worktree.path ? null : current,
          );
        } catch (e) {
          setToast({ kind: "error", title: "Mise à la corbeille", detail: String(e) });
        }
        await rescanCurrent();
      });
    },
    [withLock, rescanCurrent],
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

      const run = () =>
        withLock(`Suppression du worktree ${worktree.name}`, repo.primaryPath, async () => {
          try {
            const result = await api.removeWorktree(repo.primaryPath, worktree.path, force);
            setToast({
              kind: "ok",
              title: `Worktree « ${worktree.name} » supprimé`,
              detail: result.output || undefined,
            });
            // The pane would otherwise point at a directory that no longer exists.
            setSelected((current) =>
              current?.worktree.path === worktree.path ? null : current,
            );
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
                      run: () => void removeWorktreeRef.current(repo, worktree, true),
                    }
                  : undefined,
            });
          }
          await rescanCurrent();
        });

      if (force) {
        await run();
        return;
      }

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
    [withLock, rescanCurrent, discardLeftovers],
  );
  const removeWorktreeRef = useRef(removeWorktree);
  removeWorktreeRef.current = removeWorktree;

  // "Open on GitHub": only offered when the remote has a known web home.
  const commitWebLink = useMemo(
    () =>
      webRemote
        ? {
            label: openOnLabel(webRemote),
            open: (sha: string) => void openUrl(commitUrl(webRemote, sha)),
          }
        : null,
    [webRemote],
  );
  const branchWebLink = useMemo<BranchWebLink | null>(
    () =>
      webRemote
        ? {
            label: openOnLabel(webRemote),
            open: (branch: Branch) => {
              const name = publishedName(branch);
              if (name) void openUrl(branchUrl(webRemote, name));
            },
          }
        : null,
    [webRemote],
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
        // One layer per press, topmost first: dismissing a dialog must not
        // also close the detail panel underneath it.
        if (prompt) setPrompt(null);
        else if (confirm) setConfirm(null);
        else if (pruneOpen) setPruneOpen(false);
        else if (managed) setManaged(null);
        else {
          setSelectedSha(null);
          setWipSelected(false);
        }
      }
      if (e.key === "r" && e.metaKey) {
        e.preventDefault();
        void refreshRef.current(repoPathRef.current);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [prompt, confirm, pruneOpen, managed]);

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
  const busyIs = (prefix: string) =>
    !!busy && busy.path === repoPath && busy.label.startsWith(prefix);

  /** A branch with no upstream can always be published; otherwise, ahead > 0. */
  const needsUpstream = !!selected && !selected.worktree.upstream;
  const canPush = !!selected && (needsUpstream || selected.worktree.ahead > 0);
  /** Both sides moved: the server refuses the push until the pull is done. */
  const diverged =
    !!selected && selected.worktree.ahead > 0 && selected.worktree.behind > 0;
  /**
   * A git write is running: no second one on top. The background fetch does
   * not count — a write started during it simply waits for it to land.
   */
  const syncBusy = !!busy;
  const pullMode = state?.pullMode ?? "rebase";
  const editor = state?.editor ?? "vscode";

  const runPull = (mode: PullMode) => {
    if (!repoPath) return;
    const path = repoPath;
    runAction(PULL_LABEL[mode], () => api.pull(path, mode), path);
  };

  const setPullMode = (mode: PullMode) => {
    if (state) updateState({ ...state, pullMode: mode });
  };

  const pullDefaultMenu = (): MenuSpec =>
    PULL_MODES.map((mode) => ({
      text: PULL_COMMAND[mode],
      checked: mode === pullMode,
      action: () => setPullMode(mode),
    }));

  const openPullMenu = (anchor: Element) => {
    const canPull = !!selected && selected.worktree.behind > 0 && !syncBusy;
    void showContextMenu(
      [
        ...PULL_MODES.map((mode) => ({
          text: `${PULL_COMMAND[mode]}${mode === pullMode ? "  (défaut)" : ""}`,
          enabled: canPull,
          action: () => runPull(mode),
        })),
        { separator: true as const },
        { text: "Commande par défaut", items: pullDefaultMenu() },
      ],
      anchor,
    );
  };

  const openSettingsMenu = (anchor: Element) => {
    if (!state) return;
    void showContextMenu(
      [
        {
          text: "Autofetch des dépôts de l'onglet",
          checked: state.autoFetch,
          action: () => updateState({ ...state, autoFetch: !state.autoFetch }),
        },
        {
          text: "Badges colorés",
          checked: state.richColors,
          action: () => updateState({ ...state, richColors: !state.richColors }),
        },
        { text: "Pull par défaut", items: pullDefaultMenu() },
        {
          text: "Éditeur",
          items: EDITORS.map((editor) => ({
            text: EDITOR_NAME[editor],
            checked: editor === state.editor,
            action: () => updateState({ ...state, editor }),
          })),
        },
        { separator: true },
        {
          text: `Fetch des ${shownRepos.length} dépôts maintenant`,
          enabled: !syncBusy && shownRepos.length > 0,
          action: () => void fetchAll(true),
        },
      ],
      anchor,
    );
  };

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
          {busy ? (
            <span className="flex items-center gap-1.5 whitespace-nowrap text-accent">
              <Loader2 size={12} className="animate-spin" />
              {busy.label}
              {/* The repo it runs on, once it is no longer the one on screen. */}
              {busy.path !== repoPath && ` · ${nameFromPath(busy.path)}`}…
            </span>
          ) : autoFetching ? (
            <span className="flex items-center gap-1.5 whitespace-nowrap text-ink-500">
              <Loader2 size={12} className="animate-spin" />
              Fetch des dépôts…
            </span>
          ) : (
            <span className="whitespace-nowrap text-ink-500">
              {shownRepos.length} dépôts · {dirtyRepos} avec des modifs
            </span>
          )}
        </span>

        <button
          onClick={() => void refresh(repoPath)}
          {...tip("Rafraîchir (⌘R)")}
          className="cursor-pointer rounded-md p-1.5 text-ink-300 hover:bg-ink-700 hover:text-ink-100"
        >
          <RefreshCw size={13} className={scanning ? "animate-spin" : ""} />
        </button>
        <button
          onClick={(e) => openSettingsMenu(e.currentTarget)}
          {...tip({
            title: "Réglages",
            subtitle: "Autofetch, badges colorés, pull par défaut, éditeur",
          })}
          className="cursor-pointer rounded-md p-1.5 text-ink-300 hover:bg-ink-700 hover:text-ink-100"
        >
          <Settings2 size={13} />
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
          onSelect={(repo, worktree) =>
            workspace && setSelected({ repo, worktree, workspaceId: workspace.id })
          }
          onRefresh={() => void refresh(repoPath)}
          onAddRoot={() => workspace && addFolderTo(workspace)}
          onHide={hideEntry}
          onUnhide={hideEntry}
          onRemoveWorktree={(repo, worktree) => removeWorktree(repo, worktree)}
          editorLabel={`Ouvrir dans ${EDITOR_NAME[editor]}`}
          onOpenInEditor={(path) =>
            api
              .openInEditor(path, editor)
              .catch((e) =>
                setToast({ kind: "error", title: "Ouverture dans l'éditeur", detail: String(e) }),
              )
          }
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
              selectedSha={selectedSha}
              currentBranch={selected.worktree.branch}
              worktreePath={selected.worktree.path}
              onSelect={(branch) => selectCommit(branch.sha)}
              onAction={onBranchAction}
              onPrune={openPrune}
              pruneBusy={pruneLoading || pruneRunning}
              loading={loadingBranches && branches.length === 0}
              webLink={branchWebLink}
            />

            <main className="flex min-w-0 flex-1 flex-col">
              <div className="flex h-8 shrink-0 items-center gap-2 border-b border-ink-800 px-3 text-[11px] whitespace-nowrap text-ink-400">
                {/* Push, pull and fetch come first, at the left edge, so no
                    label of variable width ever moves them. They go DISABLED
                    rather than disappearing for the same reason. */}
                <button
                  disabled={syncBusy || !canPush}
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
                          ? "git push --set-upstream"
                          : "git push",
                        tone: "muted",
                      },
                    ],
                    warning: diverged
                      ? `Le serveur a ${selected.worktree.behind} commit(s) que tu n'as pas : il refusera le push. Pull d'abord.`
                      : undefined,
                    hint: "Ne touche que ce worktree",
                  })}
                  className={`flex min-w-[66px] items-center gap-1 rounded px-1.5 py-0.5 text-[10px] ${
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

                {/* Split button: the default pull on the left, every variant
                    (and the choice of default) behind the chevron. */}
                <span className="flex items-stretch">
                  <button
                    disabled={syncBusy || selected.worktree.behind === 0}
                    onClick={() => runPull(pullMode)}
                    {...tip({
                      title:
                        selected.worktree.behind > 0
                          ? `Récupérer ${selected.worktree.behind} commit(s)`
                          : "Rien à récupérer",
                      subtitle: selected.worktree.upstream ?? "aucun upstream",
                      badges: [{ label: PULL_COMMAND[pullMode], tone: "muted" }],
                      hint: `${PULL_HINT[pullMode]} · Flèche : autres commandes`,
                    })}
                    className={`flex min-w-[58px] items-center gap-1 rounded-l px-1.5 py-0.5 text-[10px] ${
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
                    disabled={syncBusy}
                    onClick={(e) => openPullMenu(e.currentTarget)}
                    {...tip({
                      title: "Autres commandes de pull",
                      subtitle: `Par défaut : ${PULL_COMMAND[pullMode]}`,
                    })}
                    className={`flex items-center rounded-r border-l px-0.5 ${
                      selected.worktree.behind > 0
                        ? "cursor-pointer border-accent/25 bg-accent/15 text-accent hover:bg-accent/25"
                        : "border-ink-800 text-ink-600 hover:bg-ink-800 hover:text-ink-300"
                    } disabled:cursor-default`}
                  >
                    <ChevronDown size={10} />
                  </button>
                </span>

                <button
                  disabled={syncBusy}
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
                  className="flex min-w-[52px] cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-ink-500 hover:bg-ink-800 hover:text-ink-200 disabled:cursor-default disabled:opacity-40"
                >
                  {busyIs("Fetch") || autoFetching ? (
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

                <span className="mx-0.5 h-3.5 w-px shrink-0 bg-ink-800" />

                <BranchPicker
                  branches={branches}
                  selectedRef={
                    selected.worktree.branch
                      ? `refs/heads/${selected.worktree.branch}`
                      : null
                  }
                  label={selected.worktree.branch ?? `détaché · ${selected.worktree.head ?? "?"}`}
                  icon={<GitBranch size={11} className="shrink-0 text-ink-500" />}
                  tooltip={{
                    title: "Branche courante",
                    subtitle: "Choisir une branche la checkoute",
                    hint: "Une branche distante crée la locale qui la suit",
                  }}
                  placeholder="Checkout une branche"
                  disabled={syncBusy}
                  disabledReason={(b) => {
                    // A remote branch checks out its local counterpart, so it
                    // is blocked by the same worktree.
                    const local =
                      b.kind === "local"
                        ? b
                        : branches.find(
                            (l) => l.kind === "local" && l.short === stripRemote(b.short),
                          );
                    const holder = local?.worktreePath;
                    return holder && holder !== selected.worktree.path
                      ? `Occupée par le worktree « ${nameFromPath(holder)} »`
                      : null;
                  }}
                  onSelect={(branch) => branch && onBranchAction("checkout", branch)}
                />

                <span className="ml-auto" />

                {/* Fixed slot: mounting the spinner only while loading shifted
                    its neighbours, mid-click. */}
                <span className="flex w-3 shrink-0 justify-center">
                  {loadingCommits && (
                    <Loader2 size={11} className="animate-spin text-ink-500" />
                  )}
                </span>

                <BranchPicker
                  branches={branches}
                  selectedRef={shownFilter?.refname ?? null}
                  label={shownFilter ? shownFilter.short : "Toutes les branches"}
                  icon={<ListFilter size={11} className="shrink-0 text-ink-500" />}
                  tooltip={{
                    title: "Filtrer le graphe",
                    subtitle: "N'afficher que l'historique d'une branche",
                  }}
                  placeholder="Filtrer sur une branche"
                  noneLabel="Toutes les branches"
                  align="right"
                  onSelect={(branch) =>
                    setFilter(branch ? { repoPath: selected.worktree.path, branch } : null)
                  }
                />

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
                  truncated={commits.length >= COMMIT_LIMIT}
                  webLink={commitWebLink}
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
