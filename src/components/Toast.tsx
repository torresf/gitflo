import { useEffect, useRef } from "react";
import { AlertTriangle, CheckCircle2, X } from "lucide-react";

export interface ToastState {
  kind: "ok" | "error";
  title: string;
  detail?: string;
  /** Offered next step, e.g. retrying a refused delete with --force. */
  action?: { label: string; danger?: boolean; run: () => void };
}

export function Toast({
  toast,
  onClose,
}: {
  toast: ToastState | null;
  onClose: () => void;
}) {
  // Successes are transient; errors stay until dismissed so a merge conflict
  // message can actually be read. A toast offering an action also stays: it is
  // a prompt, not a notification.
  //
  // Keyed on the toast alone: the parent passes a new `onClose` on every
  // render, and re-arming on it kept pushing the dismissal back while the app
  // was refreshing.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!toast || toast.kind === "error" || toast.action) return;
    const timer = setTimeout(() => onCloseRef.current(), 3200);
    return () => clearTimeout(timer);
  }, [toast]);

  if (!toast) return null;

  return (
    <div
      className={`absolute right-4 bottom-4 z-50 flex max-w-[520px] items-start gap-2 rounded-lg border px-3 py-2 shadow-xl ${
        toast.kind === "ok"
          ? "border-ahead/40 bg-ink-800"
          : "border-danger/50 bg-ink-800"
      }`}
    >
      {toast.kind === "ok" ? (
        <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-ahead" />
      ) : (
        <AlertTriangle size={14} className="mt-0.5 shrink-0 text-danger" />
      )}
      <div className="min-w-0">
        <p className="text-[12px] font-semibold text-ink-100">{toast.title}</p>
        {toast.detail && (
          <pre className="mt-1 max-h-40 overflow-auto font-mono text-[10.5px] leading-relaxed whitespace-pre-wrap text-ink-300 select-text">
            {toast.detail}
          </pre>
        )}
        {toast.action && (
          <button
            onClick={() => {
              toast.action?.run();
              onClose();
            }}
            className={`mt-2 rounded-md px-2.5 py-1 text-[11px] font-medium ${
              toast.action.danger
                ? "bg-danger text-ink-950"
                : "bg-accent text-ink-950"
            }`}
          >
            {toast.action.label}
          </button>
        )}
      </div>
      <button
        onClick={onClose}
        className="shrink-0 rounded p-0.5 text-ink-400 hover:text-ink-100"
      >
        <X size={12} />
      </button>
    </div>
  );
}
