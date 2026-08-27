import { FolderPlus, Plus, Settings2 } from "lucide-react";
import type { Workspace } from "../lib/workspaces";
import { showContextMenu } from "../lib/menu";
import { tip } from "../lib/tooltip";

interface Props {
  workspaces: Workspace[];
  activeId: string;
  repoCounts: Record<string, number>;
  onActivate: (id: string) => void;
  onCreate: () => void;
  onRename: (workspace: Workspace) => void;
  onRemove: (workspace: Workspace) => void;
  onManage: (workspace: Workspace) => void;
  onAddFolder: (workspace: Workspace) => void;
}

export function WorkspaceTabs({
  workspaces,
  activeId,
  repoCounts,
  onActivate,
  onCreate,
  onRename,
  onRemove,
  onManage,
  onAddFolder,
}: Props) {
  const onContext = (workspace: Workspace) => (e: React.MouseEvent) => {
    e.preventDefault();
    showContextMenu([
      { text: "Renommer l'onglet…", action: () => onRename(workspace) },
      { text: "Ajouter un dossier…", action: () => onAddFolder(workspace) },
      { text: "Gérer les dossiers…", action: () => onManage(workspace) },
      { separator: true },
      {
        text: "Supprimer l'onglet",
        // The app always needs one workspace to scan.
        enabled: workspaces.length > 1,
        action: () => onRemove(workspace),
      },
    ]);
  };

  const active = workspaces.find((w) => w.id === activeId);

  return (
    <nav className="flex h-8 shrink-0 items-center gap-0.5 border-b border-ink-800 bg-ink-900 px-2">
      {workspaces.map((workspace) => {
        const isActive = workspace.id === activeId;
        return (
          <button
            key={workspace.id}
            onClick={() => onActivate(workspace.id)}
            onContextMenu={onContext(workspace)}
            onDoubleClick={() => onRename(workspace)}
            {...tip(
              workspace.roots.length > 0
                ? workspace.roots.join("\n")
                : "Aucun dossier — clic droit pour en ajouter",
            )}
            className={`flex h-full items-center gap-1.5 border-b-2 px-3 whitespace-nowrap transition-colors ${
              isActive
                ? "border-accent text-ink-100"
                : "border-transparent text-ink-400 hover:text-ink-200"
            }`}
          >
            <span className="text-[12px] font-medium">{workspace.name}</span>
            <span className="font-mono text-[10px] text-ink-500">
              {repoCounts[workspace.id] ?? (workspace.roots.length === 0 ? "∅" : "…")}
            </span>
          </button>
        );
      })}

      <button
        onClick={onCreate}
        {...tip("Nouvel onglet")}
        className="ml-1 rounded p-1 text-ink-400 hover:bg-ink-700 hover:text-ink-100"
      >
        <Plus size={13} />
      </button>

      {active && (
        <>
          <button
            onClick={() => onAddFolder(active)}
            {...tip(`Ajouter un dossier à « ${active.name} »`)}
            className="rounded p-1 text-ink-400 hover:bg-ink-700 hover:text-ink-100"
          >
            <FolderPlus size={13} />
          </button>
          <button
            onClick={() => onManage(active)}
            {...tip(`Dossiers de « ${active.name} »`)}
            className="rounded p-1 text-ink-400 hover:bg-ink-700 hover:text-ink-100"
          >
            <Settings2 size={13} />
          </button>
        </>
      )}
    </nav>
  );
}
