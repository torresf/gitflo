import { FolderOpen, FolderPlus, Trash2, X } from "lucide-react";
import type { Workspace } from "../lib/workspaces";
import { tip } from "../lib/tooltip";

interface Props {
  workspace: Workspace | null;
  onAddFolder: () => void;
  onRemoveFolder: (root: string) => void;
  onRename: () => void;
  onClose: () => void;
}

export function WorkspaceSettings({
  workspace,
  onAddFolder,
  onRemoveFolder,
  onRename,
  onClose,
}: Props) {
  if (!workspace) return null;

  return (
    <div
      className="absolute inset-0 z-40 flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-[560px] rounded-xl border border-ink-700 bg-ink-850 shadow-2xl"
      >
        <header className="flex items-center gap-2 border-b border-ink-700 px-4 py-3">
          <h2 className="flex-1 text-[13px] font-semibold text-ink-100">
            Dossiers de « {workspace.name} »
          </h2>
          <button
            onClick={onRename}
            className="rounded px-2 py-1 text-[11px] text-ink-300 hover:bg-ink-700 hover:text-ink-100"
          >
            Renommer
          </button>
          <button
            onClick={onClose}
            className="rounded p-1 text-ink-400 hover:bg-ink-700 hover:text-ink-100"
          >
            <X size={13} />
          </button>
        </header>

        <div className="max-h-[320px] overflow-y-auto p-2">
          {workspace.roots.length === 0 && (
            <p className="px-2 py-3 text-[12px] text-ink-500">
              Aucun dossier. Ajoute-en un pour peupler cet onglet.
            </p>
          )}
          {workspace.roots.map((root) => (
            <div
              key={root}
              className="group flex items-center gap-2 rounded px-2 py-1.5 hover:bg-ink-800"
            >
              <FolderOpen size={13} className="shrink-0 text-ink-500" />
              <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-200 select-text">
                {root}
              </span>
              <button
                onClick={() => onRemoveFolder(root)}
                {...tip("Retirer ce dossier")}
                className="shrink-0 rounded p-1 text-ink-500 opacity-0 group-hover:opacity-100 hover:bg-ink-700 hover:text-danger"
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))}
        </div>

        <footer className="flex items-center justify-between border-t border-ink-700 px-4 py-3">
          <p className="text-[11px] text-ink-500">
            Les dépôts sont cherchés jusqu'à 4 niveaux sous chaque dossier.
          </p>
          <button
            onClick={onAddFolder}
            className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-[12px] font-medium text-ink-950"
          >
            <FolderPlus size={13} /> Ajouter un dossier
          </button>
        </footer>
      </div>
    </div>
  );
}
