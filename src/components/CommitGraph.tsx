import { memo, useEffect, useMemo, useRef } from "react";
import { Cloud, Laptop, PencilLine, Tag } from "lucide-react";
import type { Commit } from "../types";
import { groupRefs, type RefBadgeModel } from "../lib/refs";
import { buildGraph } from "../lib/graph";
import {
  laneBadgeColors,
  laneColor,
  laneRole,
  laneSolidColors,
  paletteIndex,
  rolesFromLayout,
} from "../lib/laneColors";
import { authorColor } from "../lib/authorColor";

import { absoluteTime, initials, relativeTime } from "../lib/format";
import { hideTip, tip } from "../lib/tooltip";
import { commitAuthorTip, commitTip, refBadgeTip, wipTip } from "../lib/tips";
import { MIN_GUTTER_WIDTH } from "../lib/workspaces";
import { showContextMenu } from "../lib/menu";

const ROW_H = 26;
const LANE_W = 12;
const GUTTER_PAD = 12;
/** Breathing room between the gutter's edge and the first badge. */
const GUTTER_GAP = 10;
const DOT_R = 3.6;
/** Badges that fit on one row before overflowing into "+N". */
const MAX_BADGES = 3;

export interface WipSummary {
  fileCount: number;
  staged: number;
  unstaged: number;
  untracked: number;
  conflicted: number;
}

interface Props {
  commits: Commit[];
  priorityShas: string[];
  selectedSha: string | null;
  headSha: string | null;
  /** Uncommitted changes, shown as a pseudo-row above the first commit. */
  wip: WipSummary | null;
  wipSelected: boolean;
  /** Gutter width in pixels, or null to fit the lanes. */
  gutterWidth: number | null;
  onGutterWidthChange: (width: number | null) => void;
  /** Colour ordinary branches by name instead of a neutral grey. */
  richColors: boolean;
  onSelect: (sha: string) => void;
  onSelectWip: () => void;
  onBranchFrom: (sha: string) => void;
  /** Checkout / merge driven from a branch badge; null when not actionable. */
  onBadgeAction: (action: "checkout" | "merge" | "merge-no-ff", badge: RefBadgeModel) => void;
  /** Bare name of the checked-out branch, to know which badge is current. */
  currentBranch: string | null;
  loading: boolean;
  /** The history was cut at the load limit: say so under the last row. */
  truncated: boolean;
  /** "Open on GitHub"-style entry for the commit menu, when the remote has one. */
  webLink: { label: string; open: (sha: string) => void } | null;
}

/** Filled tone for the checked-out branch: it should read as "you are here". */
const BADGE_SOLID: Record<string, string> = {
  trunk: "border-ahead bg-ahead text-ink-950",
  integration: "border-accent bg-accent text-ink-950",
  other: "border-ink-300 bg-ink-300 text-ink-950",
};

/** Tone per role, matching the graph lanes and the branch list exactly. */
const BADGE_TONE: Record<string, string> = {
  tag: "border-ahead/50 bg-ahead/12 text-ahead",
  trunk: "border-ahead/50 bg-ahead/12 text-ahead",
  integration: "border-accent/50 bg-accent/12 text-accent",
  local: "border-ink-500 bg-ink-800 text-ink-200",
  remote: "border-ink-600 bg-ink-800 text-ink-400",
};

/**
 * One decoration badge.
 *
 * Carries both icons when the branch exists locally AND on a remote, rather
 * than emitting two badges saying the same thing. The remote name never
 * appears: the cloud icon says "remote", and an `origin/` prefix on every row
 * pushed the refs that matter into the overflow.
 */
function RefBadge({
  badge,
  isCurrent,
  laneTint,
  laneSolid,
  onAction,
}: {
  badge: RefBadgeModel;
  isCurrent: boolean;
  /** Colours of the lane this badge's commit sits on, or null in plain mode. */
  laneTint: { border: string; background: string; text: string } | null;
  /** Filled variant of the same lane, used when this IS the current branch. */
  laneSolid: { border: string; background: string; text: string } | null;
  onAction: (action: "checkout" | "merge" | "merge-no-ff", badge: RefBadgeModel) => void;
}) {
  const tone = isCurrent
    ? (BADGE_SOLID[badge.role] ?? BADGE_SOLID.other)
    : badge.isTag
      ? BADGE_TONE.tag
      : badge.role !== "other"
        ? BADGE_TONE[badge.role]
        : badge.hasLocal
          ? BADGE_TONE.local
          : BADGE_TONE.remote;

  // Rich mode tints an unroled badge with ITS OWN LANE's colour, so a badge
  // and the line it belongs to always match. The three roles keep their fixed
  // colours either way: they are the language, not decoration.
  const custom =
    badge.isTag || badge.role !== "other"
      ? null
      : isCurrent
        ? laneSolid
        : laneTint;

  // A tag is not checkoutable, and the current branch is already checked out.
  const actionable = !badge.isTag && !isCurrent;

  const onContext = (e: React.MouseEvent) => {
    if (!actionable) return;
    // Do not fall through to the row's own menu.
    e.preventDefault();
    e.stopPropagation();
    showContextMenu([
      {
        text: `Checkout ${badge.label}`,
        action: () => onAction("checkout", badge),
      },
      { separator: true },
      {
        text: `Merger ${badge.label} dans la branche courante`,
        action: () => onAction("merge", badge),
      },
      {
        text: `Merger ${badge.label} sans fast-forward`,
        action: () => onAction("merge-no-ff", badge),
      },
    ]);
  };

  return (
    <span
      {...tip(refBadgeTip(badge, isCurrent))}
      onDoubleClick={(e) => {
        if (!actionable) return;
        e.stopPropagation();
        onAction("checkout", badge);
      }}
      onContextMenu={onContext}
      className={`inline-flex max-w-[210px] shrink-0 select-none items-center gap-1 rounded border px-1.5 py-[1px] font-mono text-[10px] leading-tight ${
        custom ? "" : tone
      } ${actionable ? "cursor-pointer hover:brightness-125" : ""}`}
      style={
        custom
          ? {
              borderColor: custom.border,
              background: custom.background,
              color: custom.text,
            }
          : undefined
      }
    >
      {badge.isTag ? (
        <Tag size={9} className="shrink-0" />
      ) : (
        <>
          {/* Laptop rather than a branch glyph: paired with the cloud it reads
              as "here" vs "on the remote" at a glance. */}
          {badge.hasLocal && <Laptop size={9} className="shrink-0" />}
          {badge.hasRemote && <Cloud size={9} className="shrink-0" />}
        </>
      )}
      <span className="truncate">{badge.label}</span>
    </span>
  );
}

function wipLabel(wip: WipSummary): string {
  const parts: string[] = [];
  if (wip.staged > 0) parts.push(`${wip.staged} indexé${wip.staged > 1 ? "s" : ""}`);
  if (wip.unstaged > 0) parts.push(`${wip.unstaged} modifié${wip.unstaged > 1 ? "s" : ""}`);
  if (wip.untracked > 0) parts.push(`${wip.untracked} non suivi${wip.untracked > 1 ? "s" : ""}`);
  if (wip.conflicted > 0) parts.push(`${wip.conflicted} en conflit`);
  return parts.join(" · ");
}

/**
 * Memoised: the app re-renders on things the graph does not show (dragging
 * the detail panel's edge, a toast, the busy label), and redrawing 400 rows on
 * each mouse move of a drag is what made it stutter.
 */
export const CommitGraph = memo(function CommitGraph({
  commits,
  priorityShas,
  selectedSha,
  headSha,
  wip,
  wipSelected,
  gutterWidth,
  onGutterWidthChange,
  richColors,
  onSelect,
  onSelectWip,
  onBranchFrom,
  onBadgeAction,
  currentBranch,
  loading,
  truncated,
  webLink,
}: Props) {
  const { rows, laneCount, pinnedLanes } = useMemo(
    () => buildGraph(commits, priorityShas),
    [commits, priorityShas],
  );

  const headRow = useMemo(
    () => (headSha ? rows.findIndex((r) => r.commit.sha === headSha) : -1),
    [rows, headSha],
  );

  const roles = useMemo(() => rolesFromLayout(pinnedLanes), [pinnedLanes]);
  /** Lane of the checked-out commit: drives the halo, not the colour. */
  const headLane = headRow >= 0 ? rows[headRow].column : null;

  // Lanes always keep the same spacing; only how much of them is VISIBLE
  // changes, so narrowing the gutter hides the rightmost branches instead of
  // cramming every branch into less room.
  const naturalGutter = laneCount * LANE_W + GUTTER_PAD * 2;
  // Never wider than the lanes need: past that it is only empty space. A saved
  // width from a repo with more lanes is clamped down here too.
  const gutter = Math.min(gutterWidth ?? naturalGutter, naturalGutter);

  /**
   * Lane stroke. Roles keep their fixed colours; in rich mode the rest take a
   * hue chosen from their POSITION, which guarantees neighbouring lanes differ.
   */
  const strokeFor = (lane: number): string => laneColor(lane, roles);
  // The WIP pseudo-row occupies the first slot when present.
  const offset = wip ? ROW_H : 0;
  const x = (lane: number) => GUTTER_PAD + lane * LANE_W + LANE_W / 2;
  const y = (row: number) => offset + row * ROW_H + ROW_H / 2;

  // Dragging the gutter edge trades graph width for message width.
  const drag = useRef<{
    startX: number;
    startWidth: number;
    naturalWidth: number;
  } | null>(null);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!drag.current) return;
      const delta = e.clientX - drag.current.startX;
      const wanted = drag.current.startWidth + delta;
      // Dragging to the right edge means "fit the branches", stored as auto so
      // it keeps fitting when the lane count changes.
      onGutterWidthChange(
        wanted >= drag.current.naturalWidth
          ? null
          : Math.max(wanted, MIN_GUTTER_WIDTH),
      );
    };
    const onUp = () => {
      if (!drag.current) return;
      drag.current = null;
      document.body.style.cursor = "";
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [onGutterWidthChange]);

  // Selecting from outside (a branch in the list) can land on a row scrolled
  // out of sight; "nearest" leaves a row already on screen where it is.
  //
  // Once per selection: the row may only appear when the history lands, but a
  // later refresh (which rebuilds the rows) must not yank the view back to it
  // after the user has scrolled away.
  const scroller = useRef<HTMLDivElement>(null);
  const pendingScroll = useRef<string | null>(null);
  useEffect(() => {
    pendingScroll.current = selectedSha;
  }, [selectedSha]);
  useEffect(() => {
    const sha = pendingScroll.current;
    if (!sha) return;
    const row = scroller.current?.querySelector(`[data-sha="${sha}"]`);
    if (!row) return;
    row.scrollIntoView({ block: "nearest" });
    pendingScroll.current = null;
  }, [selectedSha, rows]);

  const onContext = (commit: Commit) => (e: React.MouseEvent) => {
    e.preventDefault();
    onSelect(commit.sha);
    showContextMenu([
      {
        text: "Créer une branche depuis ce commit…",
        action: () => onBranchFrom(commit.sha),
      },
      { separator: true },
      {
        text: `Copier le SHA (${commit.shortSha})`,
        action: () => navigator.clipboard.writeText(commit.sha),
      },
      {
        text: "Copier le message",
        action: () => navigator.clipboard.writeText(commit.subject),
      },
      ...(webLink
        ? [
            { separator: true as const },
            { text: webLink.label, action: () => webLink.open(commit.sha) },
          ]
        : []),
    ]);
  };

  if (commits.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-[12px] text-ink-500">
        {loading ? "Lecture de l'historique…" : "Aucun commit à afficher."}
      </div>
    );
  }

  const wipLane = headLane ?? 0;
  const wipColor = strokeFor(wipLane);

  return (
    <div ref={scroller} className="relative h-full overflow-auto">
      <div className="relative" style={{ minHeight: rows.length * ROW_H + offset }}>
        {/* Grab strip on the gutter's edge: narrows the graph, widens the
            messages. Sticky so it stays reachable while scrolled. */}
        <div
          {...tip({
            title: "Largeur du graphe",
            subtitle: "Masque les branches les plus à droite",
            hint: "Glisser pour redimensionner · Double-clic : ajuster aux branches",
          })}
          onMouseDown={(e) => {
            // Spread order matters: tip() also defines onMouseDown.
            hideTip();
            drag.current = {
              startX: e.clientX,
              startWidth: gutter,
              naturalWidth: naturalGutter,
            };
            document.body.style.cursor = "col-resize";
            e.preventDefault();
          }}
          onDoubleClick={() => onGutterWidthChange(null)}
          className="group absolute top-0 z-10 h-full w-[9px] cursor-col-resize"
          style={{ left: gutter - 5 }}
        >
          <div className="mx-auto h-full w-px bg-ink-800 group-hover:bg-accent/70" />
        </div>
        <div
          className="pointer-events-none absolute top-0 left-0 overflow-hidden"
          style={{ width: gutter, height: rows.length * ROW_H + offset }}
        >
        <svg
          className="pointer-events-none block"
          width={Math.max(naturalGutter, gutter)}
          height={rows.length * ROW_H + offset}
        >
          {/* Dashed stem from the uncommitted marker down to HEAD's dot. */}
          {wip && headRow >= 0 && (
            <line
              x1={x(wipLane)}
              y1={ROW_H / 2}
              x2={x(rows[headRow].column)}
              y2={y(headRow)}
              stroke={wipColor}
              strokeWidth={1.6}
              strokeDasharray="3 3"
              opacity={0.75}
            />
          )}

          {rows.map((row, i) =>
            row.edges.map((edge, k) => {
              const x1 = x(edge.from);
              const x2 = x(edge.to);
              const y1 = y(i);
              const y2 = y(i + 1);
              const color = strokeFor(edge.lane);
              const d =
                x1 === x2
                  ? `M${x1},${y1} L${x2},${y2}`
                  : // Curve the horizontal move so branch/merge reads as a bend,
                    // not a staircase.
                    `M${x1},${y1} C${x1},${y1 + ROW_H * 0.45} ${x2},${y2 - ROW_H * 0.45} ${x2},${y2}`;
              return (
                <path
                  key={`${i}-${k}`}
                  d={d}
                  fill="none"
                  stroke={color}
                  strokeWidth={1.6}
                  strokeLinecap="round"
                />
              );
            }),
          )}

          {wip && (
            <circle
              cx={x(wipLane)}
              cy={ROW_H / 2}
              r={DOT_R + 0.6}
              fill="none"
              stroke={wipColor}
              strokeWidth={1.6}
              strokeDasharray="2 2"
            />
          )}

          {rows.map((row, i) => {
            const cx = x(row.column);
            const cy = y(i);
            const color = strokeFor(row.column);
            const isHead = row.commit.sha === headSha;
            return (
              <g key={row.commit.sha}>
                {isHead && (
                  <circle cx={cx} cy={cy} r={DOT_R + 3.2} fill={color} opacity={0.22} />
                )}
                <circle
                  cx={cx}
                  cy={cy}
                  r={row.isMerge ? DOT_R + 0.8 : DOT_R}
                  fill={row.isMerge ? "#12171f" : color}
                  stroke={color}
                  strokeWidth={row.isMerge ? 2 : 1.4}
                />
              </g>
            );
          })}
        </svg>
        </div>

        {wip && (
          <div
            onClick={onSelectWip}
            style={{ height: ROW_H, paddingLeft: gutter + GUTTER_GAP }}
            className={`flex cursor-default items-center gap-2 pr-3 text-[12px] ${
              wipSelected ? "bg-ink-700/70" : "hover:bg-ink-800/70"
            }`}
            {...tip(wipTip(wip))}
          >
            <span
              className="inline-flex shrink-0 items-center gap-1 rounded border border-dashed px-1.5 py-[1px] font-mono text-[10px] leading-tight"
              style={{ borderColor: wipColor, color: wipColor }}
            >
              <PencilLine size={9} /> WIP
            </span>
            <span className="min-w-0 flex-1 truncate text-ink-200">
              Modifications non commitées
            </span>
            <span className="shrink-0 font-mono text-[10px] whitespace-nowrap text-ink-400">
              {wipLabel(wip)}
            </span>
            <span className="w-12 shrink-0 text-right font-mono text-[10px] whitespace-nowrap text-ink-500">
              {wip.fileCount} f.
            </span>
            <span className="w-16 shrink-0" />
          </div>
        )}

        {rows.map((row, i) => {
          const commit = row.commit;
          const selected = commit.sha === selectedSha;
          const avatar = authorColor(commit.email, commit.author);
          // Grouped and ranked so the branch you act on is never truncated away.
          const refs = groupRefs(commit.refs);
          return (
            <div
              key={commit.sha}
              data-sha={commit.sha}
              onClick={() => onSelect(commit.sha)}
              onContextMenu={onContext(commit)}
              style={{ height: ROW_H, paddingLeft: gutter + GUTTER_GAP }}
              className={`flex cursor-default items-center gap-2 pr-3 text-[12px] ${
                selected
                  ? "bg-ink-700/70"
                  : i % 2 === 1
                    ? "bg-ink-900/40 hover:bg-ink-800/70"
                    : "hover:bg-ink-800/70"
              }`}
            >
              {refs.length > 0 && (
                <span className="flex shrink-0 items-center gap-1">
                  {refs.slice(0, MAX_BADGES).map((badge) => (
                    <RefBadge
                      key={badge.key}
                      badge={badge}
                      isCurrent={
                        !badge.isTag &&
                        badge.hasLocal &&
                        badge.label === currentBranch
                      }
                      laneTint={
                        richColors && laneRole(row.column, roles) === "other"
                          ? laneBadgeColors(paletteIndex(row.column, roles))
                          : null
                      }
                      laneSolid={
                        laneRole(row.column, roles) === "other"
                          ? laneSolidColors(paletteIndex(row.column, roles))
                          : null
                      }
                      onAction={onBadgeAction}
                    />
                  ))}
                  {refs.length > MAX_BADGES && (
                    <span
                      className="font-mono text-[10px] text-ink-500"
                      {...tip({
                        title: `${refs.length - MAX_BADGES} référence(s) de plus`,
                        rows: refs.slice(MAX_BADGES).map((r) => ({
                          label: r.isTag ? "tag" : r.hasLocal ? "locale" : "distante",
                          value: r.label,
                        })),
                      })}
                    >
                      +{refs.length - MAX_BADGES}
                    </span>
                  )}
                </span>
              )}

              <span
                className={`min-w-0 flex-1 truncate ${
                  selected ? "text-ink-100" : "text-ink-200"
                }`}
                {...tip(commitTip(commit))}
              >
                {commit.subject}
              </span>

              <span
                className="flex h-[17px] w-[17px] shrink-0 items-center justify-center rounded-full text-[9px] font-semibold"
                style={{ background: avatar.bg, color: avatar.fg }}
                {...tip(commitAuthorTip(commit))}
              >
                {initials(commit.author)}
              </span>
              <span
                className="w-12 shrink-0 text-right font-mono text-[10px] whitespace-nowrap text-ink-500"
                {...tip({ title: absoluteTime(commit.date) })}
              >
                {relativeTime(commit.date)}
              </span>
              <span className="w-16 shrink-0 text-right font-mono text-[10px] whitespace-nowrap text-ink-500">
                {commit.shortSha}
              </span>
            </div>
          );
        })}

        {truncated && (
          <p
            style={{ paddingLeft: gutter + GUTTER_GAP }}
            className="py-2 pr-3 text-[11px] text-ink-500"
          >
            Seuls les {rows.length} commits les plus récents sont affichés.
          </p>
        )}
      </div>
    </div>
  );
});
