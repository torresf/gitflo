import { api } from "../api";
import {
  freshState,
  loadState,
  parseState,
  type WorkspaceState,
} from "./workspaces";

/**
 * Settings persistence.
 *
 * The file is the source of truth. localStorage is only read once, to carry
 * over tabs created before the move (and before the rename), then never again.
 */
export async function loadSettings(fallbackRoots: string[]): Promise<WorkspaceState> {
  try {
    const fromFile = parseState(await api.readSettings());
    if (fromFile) return fromFile;
  } catch {
    // An unreadable settings file must not stop the app from opening.
  }

  // Nothing on disk: adopt whatever the webview still holds, else start fresh.
  const migrated = loadState(localStorage, fallbackRoots);
  await saveSettings(migrated);
  return migrated;
}

export async function saveSettings(state: WorkspaceState): Promise<void> {
  try {
    await api.writeSettings(JSON.stringify(state, null, 2));
  } catch {
    // Losing a write is survivable; crashing on it is not.
  }
}

/** At most one write per window, and the last state always wins. */
const MIN_WRITE_INTERVAL_MS = 250;

let pending: WorkspaceState | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
let lastWrite = 0;

async function flush(): Promise<void> {
  timer = undefined;
  const state = pending;
  pending = null;
  if (!state) return;
  lastWrite = Date.now();
  await saveSettings(state);
}

/**
 * Persist, coalescing bursts.
 *
 * Dragging the graph gutter updates the width on every mouse move; writing the
 * file each time meant dozens of writes a second. Coalescing keeps the state in
 * the UI immediate while the disk sees one write per window — and because the
 * pending state is replaced rather than queued, the value that lands is always
 * the newest one.
 */
export function persistSettings(state: WorkspaceState): void {
  pending = state;
  if (timer) return;
  const wait = Math.max(0, MIN_WRITE_INTERVAL_MS - (Date.now() - lastWrite));
  timer = setTimeout(() => void flush(), wait);
}

/** Write any pending state right away (used before the window goes away). */
export async function flushSettings(): Promise<void> {
  if (timer) {
    clearTimeout(timer);
    timer = undefined;
  }
  await flush();
}

export { freshState };
