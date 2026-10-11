import { useEffect, useState } from "react";
import { subscribeTip, type TipState, type TipTone } from "../lib/tooltip";

const OFFSET_X = 12;
const OFFSET_Y = 18;
const MARGIN = 8;

const TONE_TEXT: Record<TipTone, string> = {
  default: "text-ink-100",
  muted: "text-ink-400",
  ahead: "text-ahead",
  behind: "text-behind",
  accent: "text-accent",
  danger: "text-danger",
};

const TONE_BADGE: Record<TipTone, string> = {
  default: "border-ink-500 bg-ink-800 text-ink-200",
  muted: "border-ink-600 bg-ink-800 text-ink-400",
  ahead: "border-ahead/50 bg-ahead/12 text-ahead",
  behind: "border-behind/50 bg-behind/12 text-behind",
  accent: "border-accent/50 bg-accent/12 text-accent",
  danger: "border-danger/50 bg-danger/12 text-danger",
};

export function TooltipHost() {
  const [state, setState] = useState<TipState | null>(null);

  useEffect(() => subscribeTip(setState), []);

  if (!state) return null;
  const { content } = state;

  // Flip towards the inside of the window when close to an edge, so a tooltip
  // on the rightmost column is not clipped.
  const flipX = state.x > window.innerWidth - 340;
  const flipY = state.y > window.innerHeight - 200;

  return (
    <div
      className="pointer-events-none fixed z-[100] w-max max-w-[340px] rounded-lg border border-ink-600 bg-ink-850 shadow-2xl"
      style={{
        left: flipX ? undefined : state.x + OFFSET_X,
        right: flipX ? window.innerWidth - state.x + OFFSET_X : undefined,
        top: flipY ? undefined : state.y + OFFSET_Y,
        bottom: flipY ? window.innerHeight - state.y + OFFSET_Y : undefined,
        maxWidth: Math.max(200, Math.min(340, window.innerWidth - 2 * MARGIN)),
      }}
    >
      <div className="px-2.5 py-2">
        <p className="text-[12px] leading-snug font-semibold break-all text-ink-100">
          {content.title}
        </p>
        {content.subtitle && (
          <p className="mt-0.5 text-[11px] leading-snug text-ink-400">
            {content.subtitle}
          </p>
        )}

        {content.badges && content.badges.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {content.badges.map((badge, i) => (
              <span
                key={`${badge.label}-${i}`}
                // A monospace space is a full glyph wide: "branche courante"
                // read as two separate words. Pulled in to a normal gap.
                className={`rounded border px-1.5 py-[1px] font-mono text-[10px] leading-tight [word-spacing:-0.3em] ${
                  TONE_BADGE[badge.tone ?? "default"]
                }`}
              >
                {badge.label}
              </span>
            ))}
          </div>
        )}
      </div>

      {content.rows && content.rows.length > 0 && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 border-t border-ink-700 px-2.5 py-1.5">
          {content.rows.map((row, i) => (
            <div key={`${row.label}-${i}`} className="contents">
              <dt className="text-[10px] tracking-wide text-ink-500 uppercase">
                {row.label}
              </dt>
              <dd
                className={`text-[11px] leading-snug break-all ${
                  TONE_TEXT[row.tone ?? "default"]
                }`}
              >
                {row.value}
              </dd>
            </div>
          ))}
        </dl>
      )}

      {content.warning && (
        <p className="border-t border-danger/30 bg-danger/8 px-2.5 py-1.5 text-[11px] leading-snug text-danger">
          {content.warning}
        </p>
      )}

      {content.hint && (
        <p className="border-t border-ink-700 px-2.5 py-1.5 text-[10px] leading-snug text-ink-500">
          {content.hint}
        </p>
      )}
    </div>
  );
}
