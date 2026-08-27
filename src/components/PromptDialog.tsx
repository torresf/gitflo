import { useEffect, useState } from "react";

interface Props {
  open: boolean;
  title: string;
  hint?: string;
  initial?: string;
  confirmLabel: string;
  onConfirm: (value: string) => void;
  onCancel: () => void;
}

export function PromptDialog({
  open,
  title,
  hint,
  initial = "",
  confirmLabel,
  onConfirm,
  onCancel,
}: Props) {
  const [value, setValue] = useState(initial);

  useEffect(() => {
    if (open) setValue(initial);
  }, [open, initial]);

  if (!open) return null;

  return (
    <div
      className="absolute inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onCancel}
    >
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          const trimmed = value.trim();
          if (trimmed) onConfirm(trimmed);
        }}
        className="w-[420px] rounded-xl border border-ink-700 bg-ink-850 p-4 shadow-2xl"
      >
        <h2 className="text-[13px] font-semibold text-ink-100">{title}</h2>
        {hint && <p className="mt-1 text-[11px] text-ink-400">{hint}</p>}
        <input
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && onCancel()}
          className="mt-3 w-full rounded-md border border-ink-600 bg-ink-900 px-2.5 py-1.5 font-mono text-[12px] text-ink-100 select-text focus:border-accent focus:outline-none"
        />
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md px-3 py-1.5 text-[12px] text-ink-300 hover:bg-ink-700 hover:text-ink-100"
          >
            Annuler
          </button>
          <button
            type="submit"
            disabled={!value.trim()}
            className="rounded-md bg-accent px-3 py-1.5 text-[12px] font-medium text-ink-950 disabled:opacity-40"
          >
            {confirmLabel}
          </button>
        </div>
      </form>
    </div>
  );
}
