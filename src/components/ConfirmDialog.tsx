import { AlertTriangle } from "lucide-react";
import type { TipRow } from "../lib/tooltip";

export interface ConfirmSpec {
  title: string;
  message: string;
  rows?: TipRow[];
  /** Highlighted consequence, shown in danger tone. */
  warning?: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
}

export function ConfirmDialog({
  spec,
  onCancel,
}: {
  spec: ConfirmSpec | null;
  onCancel: () => void;
}) {
  if (!spec) return null;

  return (
    <div
      className="absolute inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onCancel}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-[480px] rounded-xl border border-ink-700 bg-ink-850 shadow-2xl"
      >
        <div className="px-4 pt-4">
          <h2 className="text-[13px] font-semibold text-ink-100">{spec.title}</h2>
          <p className="mt-1 text-[12px] leading-relaxed text-ink-300">
            {spec.message}
          </p>
        </div>

        {spec.rows && spec.rows.length > 0 && (
          <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 border-t border-ink-700 px-4 py-2.5">
            {spec.rows.map((row) => (
              <div key={row.label} className="contents">
                <dt className="text-[10px] tracking-wide text-ink-500 uppercase">
                  {row.label}
                </dt>
                <dd className="font-mono text-[11px] break-all text-ink-200 select-text">
                  {row.value}
                </dd>
              </div>
            ))}
          </dl>
        )}

        {spec.warning && (
          <p className="flex items-start gap-2 border-t border-danger/30 bg-danger/8 px-4 py-2.5 text-[11px] leading-snug text-danger">
            <AlertTriangle size={13} className="mt-px shrink-0" />
            {spec.warning}
          </p>
        )}

        <div className="flex justify-end gap-2 border-t border-ink-700 px-4 py-3">
          <button
            onClick={onCancel}
            className="rounded-md px-3 py-1.5 text-[12px] text-ink-300 hover:bg-ink-700 hover:text-ink-100"
          >
            Annuler
          </button>
          <button
            onClick={() => {
              spec.onConfirm();
              onCancel();
            }}
            className={`rounded-md px-3 py-1.5 text-[12px] font-medium text-ink-950 ${
              spec.danger ? "bg-danger" : "bg-accent"
            }`}
          >
            {spec.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
