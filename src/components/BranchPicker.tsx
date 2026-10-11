import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown, Cloud, Laptop, Search, X } from "lucide-react";
import type { Branch } from "../types";
import { tip, type TipContent } from "../lib/tooltip";

interface Props {
  branches: Branch[];
  /** Refname shown as chosen, or null. */
  selectedRef: string | null;
  label: string;
  /** Glyph before the label. */
  icon?: ReactNode;
  tooltip: TipContent;
  placeholder: string;
  /**
   * Label of a "no branch" entry (e.g. every branch). When set, the list
   * starts with it and a clear cross sits next to the button.
   */
  noneLabel?: string;
  /** Which edge the list drops from; "right" for a picker at the far right. */
  align?: "left" | "right";
  /** Why a branch cannot be picked, or null when it can. */
  disabledReason?: (branch: Branch) => string | null;
  /** The whole picker is unavailable (e.g. a git action is running). */
  disabled?: boolean;
  onSelect: (branch: Branch | null) => void;
}

/**
 * A searchable branch list dropping from a toolbar button. Used twice in the
 * graph toolbar: to check out a branch, and to filter the graph on one.
 */
export function BranchPicker({
  branches,
  selectedRef,
  label,
  icon,
  tooltip,
  placeholder,
  noneLabel,
  align = "left",
  disabledReason,
  disabled = false,
  onSelect,
}: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  /** Keyboard highlight, as an index into `pickable`. */
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? branches.filter((b) => b.short.toLowerCase().includes(q)) : branches;
  }, [branches, query]);

  // Closing it when it becomes unavailable, rather than leaving a list whose
  // clicks would be ignored.
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  const pick = (branch: Branch | null) => {
    setOpen(false);
    setQuery("");
    if (branch?.refname === selectedRef) return;
    onSelect(branch);
  };

  const row = (branch: Branch) => {
    const reason = disabledReason?.(branch) ?? null;
    const chosen = selectedRef === branch.refname;
    return (
      <button
        key={branch.refname}
        data-ref={branch.refname}
        disabled={!!reason}
        onClick={() => pick(branch)}
        {...(reason ? tip(reason) : {})}
        className={`flex w-full items-center gap-1.5 rounded px-2 py-[3px] text-left ${
          chosen
            ? "bg-ink-700 text-ink-100"
            : branch.refname === activeRef
              ? "bg-ink-800 text-ink-100"
              : reason
              ? "cursor-default text-ink-600"
              : "text-ink-300 hover:bg-ink-800 hover:text-ink-100"
        }`}
      >
        {branch.kind === "remote" ? (
          <Cloud size={11} className="shrink-0 text-ink-500" />
        ) : (
          <Laptop size={11} className="shrink-0 text-ink-500" />
        )}
        <span className="min-w-0 flex-1 truncate">{branch.short}</span>
        {chosen && <Check size={11} className="shrink-0 text-ahead" />}
      </button>
    );
  };

  const locals = matches.filter((b) => b.kind === "local");
  const remotes = matches.filter((b) => b.kind === "remote");
  /** In display order, which is what the arrow keys walk. */
  const pickable = [...locals, ...remotes].filter((b) => !disabledReason?.(b));
  const activeRef = pickable[Math.min(active, pickable.length - 1)]?.refname ?? null;

  useEffect(() => setActive(0), [query, open]);
  useEffect(() => {
    if (!activeRef) return;
    list.current
      ?.querySelector(`[data-ref="${CSS.escape(activeRef)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeRef]);
  const heading = (text: string) => (
    <p className="px-2 pt-1.5 pb-0.5 text-[10px] font-semibold tracking-wider text-ink-500 uppercase">
      {text}
    </p>
  );

  return (
    <div ref={root} className="relative flex min-w-0 shrink items-center">
      <button
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        {...tip(tooltip)}
        className="flex max-w-[240px] min-w-0 cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 font-medium text-ink-200 hover:bg-ink-800 hover:text-ink-100 disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent"
      >
        {icon}
        <span className="truncate">{label}</span>
        <ChevronDown size={11} className="shrink-0 text-ink-500" />
      </button>
      {/* Slot always present, so the clear cross appearing moves nothing. */}
      {noneLabel !== undefined && (
        <span className="flex w-4 shrink-0 justify-center">
          {selectedRef && (
            <button
              onClick={() => pick(null)}
              {...tip(noneLabel)}
              className="cursor-pointer rounded text-ink-500 hover:text-ink-100"
            >
              <X size={11} />
            </button>
          )}
        </span>
      )}

      {open && (
        <div
          className={`absolute top-full z-50 mt-1 flex max-h-[420px] w-[300px] flex-col rounded-lg border border-ink-600 bg-ink-850 shadow-2xl ${
            align === "right" ? "right-0" : "left-0"
          }`}
        >
          <div className="flex shrink-0 items-center gap-2 border-b border-ink-700 px-2 py-1.5">
            <Search size={11} className="shrink-0 text-ink-500" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  // Keep the app-wide Escape (which also closes the detail
                  // panel) for when the picker is not open.
                  e.stopPropagation();
                  setOpen(false);
                }
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  const step = e.key === "ArrowDown" ? 1 : -1;
                  const n = pickable.length;
                  if (n > 0) setActive((i) => (Math.min(i, n - 1) + step + n) % n);
                }
                if (e.key === "Enter" && activeRef) {
                  pick(pickable.find((b) => b.refname === activeRef) ?? null);
                }
              }}
              placeholder={placeholder}
              className="w-full bg-transparent text-[12px] text-ink-100 placeholder:text-ink-500 focus:outline-none"
            />
          </div>
          <div ref={list} className="min-h-0 flex-1 overflow-y-auto p-1">
            {noneLabel !== undefined && !query && (
              <button
                onClick={() => pick(null)}
                className={`flex w-full items-center gap-1.5 rounded px-2 py-[3px] text-left ${
                  selectedRef === null
                    ? "bg-ink-700 text-ink-100"
                    : "text-ink-300 hover:bg-ink-800 hover:text-ink-100"
                }`}
              >
                <span className="flex-1">{noneLabel}</span>
                {selectedRef === null && <Check size={11} className="shrink-0 text-ahead" />}
              </button>
            )}
            {locals.length > 0 && heading("Locales")}
            {locals.map(row)}
            {remotes.length > 0 && heading("Distantes")}
            {remotes.map(row)}
            {matches.length === 0 && <p className="px-2 py-2 text-ink-500">Aucune branche.</p>}
          </div>
        </div>
      )}
    </div>
  );
}
