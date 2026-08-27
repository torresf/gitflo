export interface Workspace {
  id: string;
  name: string;
  roots: string[];
  /**
   * Repos and worktrees hidden from this tab's list. Holds repo ids (the shared
   * git dir) and worktree paths in one array — the two can never collide, since
   * a repo id always points inside a `.git` directory.
   */
  hidden: string[];
}

export interface WorkspaceState {
  workspaces: Workspace[];
  activeId: string;
  /**
   * Width of the graph gutter in pixels, or null to size it to the lanes.
   *
   * A fixed width CLIPS the lanes that do not fit rather than squeezing them
   * all: lanes keep a constant spacing, and a repo with a wide fan-out simply
   * hides its rightmost branches behind the commit messages.
   */
  gutterWidth: number | null;
  /**
   * Repo ids whose worktree list is folded. Global rather than per-tab: a repo
   * you folded is folded wherever it shows up.
   */
  collapsedRepos: string[];
  /**
   * Colour every branch by its name, not just the three fixed roles.
   *
   * Off by default: the fixed roles are the point of the colour language, and
   * a wall of hues can drown them.
   */
  richColors: boolean;
  /** Path of the worktree to reopen on launch. */
  selectedPath: string | null;
}

export const MIN_GUTTER_WIDTH = 24;
export const MAX_GUTTER_WIDTH = 640;

export const clampGutterWidth = (value: unknown): number | null => {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.min(Math.max(Math.round(value), MIN_GUTTER_WIDTH), MAX_GUTTER_WIDTH);
};

export const STATE_KEY = "gitflo.workspaces";
/** Key used while the app was called gitscope; read once, then dropped. */
export const RENAMED_STATE_KEY = "gitscope.workspaces";
/** Pre-tabs key, migrated once into a single workspace. */
export const LEGACY_ROOTS_KEY = "gitflo.roots";
export const RENAMED_ROOTS_KEY = "gitscope.roots";

/** Minimal storage surface, so the loader is testable without a browser. */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

let counter = 0;
export function newId(): string {
  counter += 1;
  return `ws-${Date.now().toString(36)}-${counter}`;
}

/** "Acme" out of "~/code/acme" — a sane default tab name. */
export function nameFromPath(path: string): string {
  const base = path.split("/").filter(Boolean).pop() ?? "Projets";
  return base.charAt(0).toUpperCase() + base.slice(1);
}

export function createWorkspace(name: string, roots: string[] = []): Workspace {
  return { id: newId(), name, roots, hidden: [] };
}

function isWorkspace(value: unknown): value is Workspace {
  if (typeof value !== "object" || value === null) return false;
  const w = value as Record<string, unknown>;
  return (
    typeof w.id === "string" &&
    typeof w.name === "string" &&
    Array.isArray(w.roots) &&
    w.roots.every((r) => typeof r === "string")
  );
}

/** `hidden` postdates the first releases, so it may be missing on disk. */
function normalize(workspace: Workspace): Workspace {
  return {
    ...workspace,
    hidden: Array.isArray(workspace.hidden)
      ? workspace.hidden.filter((h) => typeof h === "string")
      : [],
  };
}

/**
 * Parse a persisted blob, tolerating anything: corrupt JSON, partially-shaped
 * objects, an activeId pointing at a deleted tab. Returns null when there is
 * nothing usable, so callers can fall back.
 *
 * A viewer that throws on its own config file is worse than one that starts
 * fresh.
 */
export function parseState(raw: string | null | undefined): WorkspaceState | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const candidate = parsed as Record<string, unknown>;
    const workspaces = Array.isArray(candidate.workspaces)
      ? candidate.workspaces.filter(isWorkspace)
      : [];
    if (workspaces.length === 0) return null;

    const normalized = workspaces.map(normalize);
    const activeId =
      typeof candidate.activeId === "string" &&
      normalized.some((w) => w.id === candidate.activeId)
        ? candidate.activeId
        : normalized[0].id;
    return {
      workspaces: normalized,
      activeId,
      gutterWidth: clampGutterWidth(candidate.gutterWidth),
      collapsedRepos: Array.isArray(candidate.collapsedRepos)
        ? candidate.collapsedRepos.filter((id): id is string => typeof id === "string")
        : [],
      richColors: candidate.richColors === true,
      selectedPath:
        typeof candidate.selectedPath === "string" ? candidate.selectedPath : null,
    };
  } catch {
    return null;
  }
}

export function freshState(fallbackRoots: string[] = []): WorkspaceState {
  const workspace = createWorkspace("Tous", fallbackRoots);
  return {
    workspaces: [workspace],
    activeId: workspace.id,
    gutterWidth: null,
    collapsedRepos: [],
    richColors: false,
    selectedPath: null,
  };
}

/**
 * Read from a key-value store — the pre-file location, kept only to migrate
 * settings written before they moved to `~/Library/Application Support`.
 */
export function loadState(store: KeyValueStore, fallbackRoots: string[] = []): WorkspaceState {
  const fromStore = parseState(
    store.getItem(STATE_KEY) ?? store.getItem(RENAMED_STATE_KEY),
  );
  if (fromStore) return fromStore;

  // One-shot migration from the flat roots list used before tabs existed.
  const legacy =
    store.getItem(LEGACY_ROOTS_KEY) ?? store.getItem(RENAMED_ROOTS_KEY);
  if (legacy) {
    try {
      const roots = JSON.parse(legacy) as unknown;
      if (Array.isArray(roots) && roots.every((r) => typeof r === "string") && roots.length) {
        return freshState(roots as string[]);
      }
    } catch {
      // Ignore an unreadable legacy value.
    }
  }

  return freshState(fallbackRoots);
}

/** Hide or unhide one entry (repo id or worktree path) in a tab. */
export function toggleHidden(workspace: Workspace, key: string): Workspace {
  const hidden = workspace.hidden.includes(key)
    ? workspace.hidden.filter((h) => h !== key)
    : [...workspace.hidden, key];
  return { ...workspace, hidden };
}

export function clearHidden(workspace: Workspace): Workspace {
  return { ...workspace, hidden: [] };
}

export const activeWorkspace = (state: WorkspaceState): Workspace =>
  state.workspaces.find((w) => w.id === state.activeId) ?? state.workspaces[0];

export function upsertWorkspace(
  state: WorkspaceState,
  workspace: Workspace,
): WorkspaceState {
  const exists = state.workspaces.some((w) => w.id === workspace.id);
  return {
    ...state,
    workspaces: exists
      ? state.workspaces.map((w) => (w.id === workspace.id ? workspace : w))
      : [...state.workspaces, workspace],
    activeId: exists ? state.activeId : workspace.id,
  };
}

/** Removing the last tab is refused: the app always needs one. */
export function removeWorkspace(state: WorkspaceState, id: string): WorkspaceState {
  if (state.workspaces.length <= 1) return state;
  const workspaces = state.workspaces.filter((w) => w.id !== id);
  return {
    ...state,
    workspaces,
    activeId: state.activeId === id ? workspaces[0].id : state.activeId,
  };
}
