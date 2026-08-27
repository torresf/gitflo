/**
 * Tooltip plumbing.
 *
 * Native `title` attributes take roughly a second to appear, which is too slow
 * for a dense list you sweep the pointer across. This is a single-instance
 * store instead of per-component state: the hover handlers touch no React
 * state, so moving the pointer over the commit list never re-renders its rows.
 */
export type TipTone =
  | "default"
  | "muted"
  | "ahead"
  | "behind"
  | "accent"
  | "danger";

export interface TipBadge {
  label: string;
  tone?: TipTone;
}

export interface TipRow {
  label: string;
  value: string;
  tone?: TipTone;
}

/** Structured tooltip: a heading, optional badges, key/value rows and a hint. */
export interface TipContent {
  title: string;
  subtitle?: string;
  badges?: TipBadge[];
  rows?: TipRow[];
  /** Dimmed footer, typically the available interactions. */
  hint?: string;
  /** Highlighted warning line, e.g. an explanation of a red state. */
  warning?: string;
}

export interface TipState {
  content: TipContent;
  x: number;
  y: number;
}

const SHOW_DELAY_MS = 90;

let current: TipState | null = null;
/** Content waiting out the show delay; its position keeps updating. */
let pending: TipState | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<(state: TipState | null) => void>();

function emit() {
  for (const listener of listeners) listener(current);
}

export function subscribeTip(listener: (state: TipState | null) => void) {
  listeners.add(listener);
  listener(current);
  return () => {
    listeners.delete(listener);
  };
}

export function hideTip() {
  if (timer) clearTimeout(timer);
  timer = undefined;
  pending = null;
  if (current !== null) {
    current = null;
    emit();
  }
}

export function showTip(content: TipContent, x: number, y: number) {
  if (!content?.title) return hideTip();

  // Already visible: follow the pointer with no delay, so sweeping across a
  // list feels continuous instead of blinking.
  if (current) {
    current = { content, x, y };
    emit();
    return;
  }

  // Waiting out the delay: update what will be shown, but do NOT restart the
  // timer. onMouseMove fires continuously, and re-arming on each event meant
  // the tooltip never appeared unless the pointer stopped dead.
  pending = { content, x, y };
  if (timer) return;

  timer = setTimeout(() => {
    timer = undefined;
    current = pending;
    pending = null;
    emit();
  }, SHOW_DELAY_MS);
}

/**
 * Handlers to spread on any element that should carry a tooltip.
 *
 * Accepts a plain string for simple cases, or a TipContent for a structured
 * one.
 *
 * ⚠ Spread `{...tip(…)}` BEFORE the element's own handlers. It supplies an
 * `onMouseDown` (to dismiss on click), so spreading it last silently replaces
 * a drag or press handler — that is exactly how the graph resize handle ended
 * up hovering but never dragging.
 */
export function tip(content: TipContent | string | null | undefined) {
  if (!content) return {};
  const resolved: TipContent =
    typeof content === "string" ? { title: content } : content;
  if (!resolved.title) return {};

  return {
    onMouseEnter: (e: React.MouseEvent) => showTip(resolved, e.clientX, e.clientY),
    onMouseMove: (e: React.MouseEvent) => showTip(resolved, e.clientX, e.clientY),
    onMouseLeave: hideTip,
    // A click means the user acted; a lingering tooltip would just be in the way.
    onMouseDown: hideTip,
  };
}
