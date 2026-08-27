import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Loader2, Trash2, X } from "lucide-react";
import type { DeleteOutcome, RemoteBranchState, StaleBranch } from "../types";
import {
  REASON_LABEL,
  REMOTE_STATE_LABEL,
  defaultRemoteSelection,
  isRemoteSafe,
  remoteState,
  defaultSelection,
  deletionBlocker,
  needsForce,
  retryableFailures,
} from "../lib/prune";
import { relativeTime } from "../lib/format";
import { tip } from "../lib/tooltip";

export type PruneTab = "local" | "remote";

interface Props {
  open: boolean;
  repoName: string;
  branches: StaleBranch[];
  remoteBranches: RemoteBranchState[];
  /** Base the merge state was computed against, e.g. "origin/develop". */
  base: string | null;
  tab: PruneTab;
  onTabChange: (tab: PruneTab) => void;
  loading: boolean;
  running: boolean;
  outcomes: DeleteOutcome[] | null;
  onConfirm: (names: string[], force: boolean) => void;
  onConfirmRemote: (names: string[]) => void;
  onClose: () => void;
}

const REMOTE_TONE: Record<string, string> = {
  merged: "border-ahead/45 bg-ahead/12 text-ahead",
  applied: "border-accent/45 bg-accent/12 text-accent",
  ahead: "border-behind/45 bg-behind/12 text-behind",
};

function RemoteRow({
  branch,
  checked,
  onToggle,
}: {
  branch: RemoteBranchState;
  checked: boolean;
  onToggle: () => void;
}) {
  const state = remoteState(branch);

  return (
    <label className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 hover:bg-ink-800">
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        className="shrink-0 accent-danger"
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-mono text-[11px] text-ink-100">
          {branch.branch}
        </span>
        <span className="block truncate text-[10px] text-ink-500">
          {branch.subject || "—"} · {branch.author}
        </span>
      </span>

      {branch.hasLocal && (
        <span
          className="shrink-0 rounded border border-ink-600 bg-ink-800 px-1.5 py-[1px] font-mono text-[10px] text-ink-400"
          {...tip({
            title: "Copie locale présente",
            hint: "La supprimer du serveur ne touche pas ta branche locale",
          })}
        >
          locale
        </span>
      )}

      <span
        className={`shrink-0 rounded border px-1.5 py-[1px] font-mono text-[10px] ${REMOTE_TONE[state]}`}
        {...tip(
          state === "applied"
            ? {
                title: "Déjà appliquée",
                subtitle: `${branch.unmergedCommits} commit(s) absents de la base`,
                hint: "Mais chacun a son équivalent déjà appliqué : merge squashé ou rebasé.",
              }
            : state === "ahead"
              ? {
                  title: `${branch.unappliedCommits} commit(s) jamais appliqués`,
                  warning:
                    "Ce travail n'existe nulle part ailleurs. Supprimer la branche du serveur le rend inaccessible.",
                }
              : { title: "Fusionnée dans la base" },
        )}
      >
        {REMOTE_STATE_LABEL[state]}
        {state === "ahead" ? ` · ${branch.unappliedCommits}` : ""}
      </span>

      <span className="w-10 shrink-0 text-right font-mono text-[10px] whitespace-nowrap text-ink-500">
        {relativeTime(branch.date)}
      </span>
    </label>
  );
}

function Row({
  branch,
  checked,
  onToggle,
}: {
  branch: StaleBranch;
  checked: boolean;
  onToggle: () => void;
}) {
  const blocker = deletionBlocker(branch);
  const risky = needsForce(branch);

  return (
    <label
      className={`flex items-center gap-2 rounded px-2 py-1.5 ${
        blocker ? "opacity-45" : "cursor-pointer hover:bg-ink-800"
      }`}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={!!blocker}
        onChange={onToggle}
        className="shrink-0 accent-danger"
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-mono text-[11px] text-ink-100">
          {branch.name}
        </span>
        <span className="block truncate text-[10px] text-ink-500">
          {branch.subject || "—"}
        </span>
      </span>

      <span
        className={`shrink-0 rounded border px-1.5 py-[1px] font-mono text-[10px] ${
          branch.reason === "gone"
            ? "border-danger/40 bg-danger/10 text-danger"
            : "border-ink-600 bg-ink-800 text-ink-400"
        }`}
      >
        {REASON_LABEL[branch.reason]}
      </span>

      {risky && (
        <span
          className="shrink-0 rounded border border-behind/50 bg-behind/12 px-1.5 py-[1px] font-mono text-[10px] text-behind"
          {...tip({
            title: "Apporte du contenu absent de la base",
            subtitle: `${branch.unmergedCommits} commit(s) propres`,
            warning:
              "La fusionner changerait la base : ce travail n'y est pas encore. Le supprimer le rend inaccessible.",
          })}
        >
          ⚠ {branch.unmergedCommits}
        </span>
      )}

      {blocker && (
        <span className="shrink-0 font-mono text-[10px] text-ink-500">{blocker}</span>
      )}

      <span className="w-10 shrink-0 text-right font-mono text-[10px] whitespace-nowrap text-ink-500">
        {relativeTime(branch.date)}
      </span>
    </label>
  );
}

export function PruneModal({
  open,
  repoName,
  branches,
  remoteBranches,
  base,
  tab,
  onTabChange,
  loading,
  running,
  outcomes,
  onConfirm,
  onConfirmRemote,
  onClose,
}: Props) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [remoteSelected, setRemoteSelected] = useState<Set<string>>(new Set());

  // Reset the selection whenever a fresh list arrives.
  useEffect(() => {
    setSelected(defaultSelection(branches));
  }, [branches]);

  useEffect(() => {
    setRemoteSelected(defaultRemoteSelection(remoteBranches));
  }, [remoteBranches]);

  const remoteRisky = useMemo(
    () =>
      remoteBranches.filter((b) => remoteSelected.has(b.name) && !isRemoteSafe(b)),
    [remoteBranches, remoteSelected],
  );

  const risky = useMemo(
    () => branches.filter((b) => selected.has(b.name) && needsForce(b)),
    [branches, selected],
  );
  const selectable = useMemo(
    () => branches.filter((b) => !deletionBlocker(b)),
    [branches],
  );

  // `git branch -d` refuses anything not merged into HEAD, which is stricter
  // than our own "would this lose commits" test.
  const retry = useMemo(
    () => (outcomes ? retryableFailures(outcomes, branches) : null),
    [outcomes, branches],
  );

  if (!open) return null;

  const toggle = (name: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  return (
    <div
      className="absolute inset-0 z-40 flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="relative flex max-h-[80vh] w-[720px] flex-col rounded-xl border border-ink-700 bg-ink-850 shadow-2xl"
      >
        {running && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 rounded-xl bg-ink-950/70">
            <Loader2 size={22} className="animate-spin text-danger" />
            <p className="text-[12px] text-ink-200">Suppression en cours…</p>
            <p className="text-[11px] text-ink-500">
              {tab === "remote"
                ? "Un push par branche vers le serveur."
                : "Une suppression par branche."}
            </p>
          </div>
        )}
        <header className="flex items-center gap-2 border-b border-ink-700 px-4 py-3">
          <h2 className="text-[13px] font-semibold text-ink-100">
            Nettoyer les branches · {repoName}
          </h2>
          <div className="ml-3 flex items-center gap-0.5 rounded-md bg-ink-900 p-0.5">
            {(["local", "remote"] as const).map((key) => (
              <button
                key={key}
                onClick={() => onTabChange(key)}
                className={`rounded px-2.5 py-1 text-[11px] ${
                  tab === key
                    ? "bg-ink-700 text-ink-100"
                    : "text-ink-400 hover:text-ink-200"
                }`}
              >
                {key === "local" ? "Locales" : "Distantes"}
                <span className="ml-1.5 font-mono text-[10px] text-ink-500">
                  {key === "local" ? branches.length : remoteBranches.length}
                </span>
              </button>
            ))}
          </div>
          {base && tab === "remote" && (
            <span className="font-mono text-[10px] text-ink-500">vs {base}</span>
          )}
          <span className="flex-1" />
          <button
            onClick={onClose}
            className="rounded p-1 text-ink-400 hover:bg-ink-700 hover:text-ink-100"
          >
            <X size={13} />
          </button>
        </header>

        {loading ? (
          <p className="px-4 py-8 text-center text-[12px] text-ink-500">
            Analyse des branches…
          </p>
        ) : outcomes ? (
          <div className="max-h-[420px] overflow-y-auto px-2 py-2">
            {outcomes.map((outcome) => (
              <div
                key={outcome.name}
                className="flex items-start gap-2 rounded px-2 py-1.5"
              >
                <span
                  className={`shrink-0 font-mono text-[11px] ${
                    outcome.deleted ? "text-ahead" : "text-danger"
                  }`}
                >
                  {outcome.deleted ? "✓" : "✕"}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-mono text-[11px] text-ink-200">
                    {outcome.name}
                  </span>
                  {outcome.message && (
                    <span className="block font-mono text-[10px] break-all text-ink-500">
                      {outcome.message}
                    </span>
                  )}
                </span>
              </div>
            ))}
          </div>
        ) : tab === "remote" ? (
          remoteBranches.length === 0 ? (
            <p className="px-4 py-8 text-center text-[12px] text-ink-500">
              Aucune branche distante en dehors des branches principales.
            </p>
          ) : (
            <>
              <div className="flex items-center gap-2 border-b border-ink-700 px-3 py-2 text-[11px] text-ink-400">
                <button
                  onClick={() =>
                    setRemoteSelected(new Set(remoteBranches.map((b) => b.name)))
                  }
                  className="rounded px-2 py-1 hover:bg-ink-700 hover:text-ink-100"
                >
                  Tout
                </button>
                <button
                  onClick={() => setRemoteSelected(defaultRemoteSelection(remoteBranches))}
                  className="rounded px-2 py-1 hover:bg-ink-700 hover:text-ink-100"
                >
                  Fusionnées seulement
                </button>
                <button
                  onClick={() => setRemoteSelected(new Set())}
                  className="rounded px-2 py-1 hover:bg-ink-700 hover:text-ink-100"
                >
                  Aucune
                </button>
                <span className="ml-auto font-mono">
                  {remoteSelected.size} / {remoteBranches.length}
                </span>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
                {remoteBranches.map((branch) => (
                  <RemoteRow
                    key={branch.name}
                    branch={branch}
                    checked={remoteSelected.has(branch.name)}
                    onToggle={() =>
                      setRemoteSelected((current) => {
                        const next = new Set(current);
                        if (next.has(branch.name)) next.delete(branch.name);
                        else next.add(branch.name);
                        return next;
                      })
                    }
                  />
                ))}
              </div>
            </>
          )
        ) : branches.length === 0 ? (
          <p className="px-4 py-8 text-center text-[12px] text-ink-500">
            Rien à nettoyer : aucune branche locale dont la distante a disparu ni
            déjà fusionnée.
          </p>
        ) : (
          <>
            <div className="flex items-center gap-2 border-b border-ink-700 px-3 py-2 text-[11px] text-ink-400">
              <button
                onClick={() => setSelected(new Set(selectable.map((b) => b.name)))}
                className="rounded px-2 py-1 hover:bg-ink-700 hover:text-ink-100"
              >
                Tout
              </button>
              <button
                onClick={() => setSelected(defaultSelection(branches))}
                className="rounded px-2 py-1 hover:bg-ink-700 hover:text-ink-100"
              >
                Sûres seulement
              </button>
              <button
                onClick={() => setSelected(new Set())}
                className="rounded px-2 py-1 hover:bg-ink-700 hover:text-ink-100"
              >
                Aucune
              </button>
              <span className="ml-auto font-mono">
                {selected.size} / {branches.length}
              </span>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
              {branches.map((branch) => (
                <Row
                  key={branch.name}
                  branch={branch}
                  checked={selected.has(branch.name)}
                  onToggle={() => toggle(branch.name)}
                />
              ))}
            </div>
          </>
        )}

        <footer className="flex items-center gap-3 border-t border-ink-700 px-4 py-3">
          {retry && retry.names.length > 0 && (
            <p className="flex items-start gap-1.5 text-[11px] leading-snug text-ink-400">
              <AlertTriangle size={13} className="mt-px shrink-0 text-behind" />
              <span>
                {retry.names.length} refusée(s) : git exige qu'une branche soit
                fusionnée dans la branche courante.
                {retry.losingWork.length > 0
                  ? ` ${retry.losingWork.length} contien(nen)t des commits uniques.`
                  : " Aucune ne contient de commit unique."}
              </span>
            </p>
          )}
          {tab === "remote" && remoteRisky.length > 0 && !outcomes && (
            <p className="flex items-start gap-1.5 text-[11px] leading-snug text-danger">
              <AlertTriangle size={13} className="mt-px shrink-0" />
              {remoteRisky.length} branche(s) portent du travail jamais appliqué
              ailleurs · suppression sur le serveur
            </p>
          )}
          {tab === "local" && risky.length > 0 && !outcomes && (
            <p className="flex items-center gap-1.5 text-[11px] text-behind">
              <AlertTriangle size={13} className="shrink-0" />
              {risky.length} branche(s) apportent du contenu absent de la base
              · suppression forcée
            </p>
          )}
          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={onClose}
              className="rounded-md px-3 py-1.5 text-[12px] text-ink-300 hover:bg-ink-700 hover:text-ink-100"
            >
              {outcomes ? "Fermer" : "Annuler"}
            </button>
            {retry && retry.names.length > 0 && (
              <button
                onClick={() => onConfirm(retry.names, true)}
                disabled={running}
                className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12px] font-medium text-ink-950 disabled:opacity-40 ${
                  retry.losingWork.length > 0 ? "bg-danger" : "bg-behind"
                }`}
              >
                {running ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : (
                  <Trash2 size={13} />
                )}
                Forcer ({retry.names.length})
              </button>
            )}
            {!outcomes && tab === "remote" && (
              <button
                onClick={() =>
                  onConfirmRemote(
                    remoteBranches
                      .filter((b) => remoteSelected.has(b.name))
                      .map((b) => b.branch),
                  )
                }
                disabled={remoteSelected.size === 0 || running}
                className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12px] font-medium text-ink-950 disabled:opacity-40 ${
                  remoteRisky.length > 0 ? "bg-danger" : "bg-behind"
                }`}
              >
                {running ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : (
                  <Trash2 size={13} />
                )}
                Supprimer sur le serveur ({remoteSelected.size})
              </button>
            )}
            {!outcomes && tab === "local" && (
              <button
                onClick={() => onConfirm([...selected], risky.length > 0)}
                disabled={selected.size === 0 || running}
                className="flex items-center gap-1.5 rounded-md bg-danger px-3 py-1.5 text-[12px] font-medium text-ink-950 disabled:opacity-40"
              >
                {running ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : (
                  <Trash2 size={13} />
                )}
                Supprimer {selected.size}
              </button>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
}
