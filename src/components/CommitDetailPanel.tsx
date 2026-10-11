import { useEffect, useMemo, useState } from "react";
import { Copy, FileDiff, X } from "lucide-react";
import type { ChangedFile, CommitDetail, WorkingTree } from "../types";
import { absoluteTime } from "../lib/format";
import { tip } from "../lib/tooltip";
import { api } from "../api";

interface Props {
  repo: string;
  detail: CommitDetail | null;
  /** When set, the panel describes uncommitted changes instead of a commit. */
  wipTree: WorkingTree | null;
  loading: boolean;
  onClose: () => void;
}

const STATUS_TONE: Record<string, string> = {
  A: "text-ahead",
  M: "text-accent",
  D: "text-danger",
  R: "text-behind",
  C: "text-behind",
  "?": "text-ink-400",
};

const STATUS_LABEL: Record<string, string> = {
  A: "ajouté",
  M: "modifié",
  D: "supprimé",
  R: "renommé",
  C: "copié",
  "?": "non suivi",
};

function FileRow({
  file,
  active,
  onClick,
}: {
  file: ChangedFile;
  active: boolean;
  onClick: () => void;
}) {
  const letter = file.status[0] ?? "M";
  const dir = file.path.includes("/")
    ? file.path.slice(0, file.path.lastIndexOf("/") + 1)
    : "";
  const base = file.path.slice(dir.length);

  return (
    <button
      onClick={onClick}
      {...tip(
        `${file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}\n${
          STATUS_LABEL[letter] ?? file.status
        }`,
      )}
      className={`flex w-full items-center gap-2 rounded px-2 py-[3px] text-left ${
        active ? "bg-ink-700" : "hover:bg-ink-800"
      }`}
    >
      <span
        className={`w-3 shrink-0 font-mono text-[10px] font-bold ${
          STATUS_TONE[letter] ?? "text-ink-400"
        }`}
      >
        {file.status}
      </span>
      <span className="min-w-0 flex-1 truncate text-[11px]">
        <span className="text-ink-500">{dir}</span>
        <span className="text-ink-200">{base}</span>
      </span>
      {file.binary ? (
        <span className="shrink-0 font-mono text-[10px] text-ink-500">bin</span>
      ) : (
        <span className="shrink-0 font-mono text-[10px]">
          {file.additions > 0 && <span className="text-ahead">+{file.additions}</span>}
          {file.deletions > 0 && (
            <span className="ml-1 text-danger">−{file.deletions}</span>
          )}
        </span>
      )}
    </button>
  );
}

/** Minimal unified-diff colouring: enough to read a hunk, no tokenizer. */
function DiffView({ diff }: { diff: string }) {
  const lines = useMemo(() => diff.split("\n"), [diff]);
  return (
    <pre className="overflow-x-auto p-2 font-mono text-[11px] leading-[1.45] select-text">
      {lines.map((line, i) => {
        let tone = "text-ink-300";
        if (line.startsWith("@@")) tone = "text-accent bg-accent/8";
        else if (line.startsWith("+") && !line.startsWith("+++"))
          tone = "text-ahead bg-ahead/8";
        else if (line.startsWith("-") && !line.startsWith("---"))
          tone = "text-danger bg-danger/8";
        else if (line.startsWith("diff ") || line.startsWith("index "))
          tone = "text-ink-500";
        return (
          <div key={i} className={`whitespace-pre px-1 ${tone}`}>
            {line || " "}
          </div>
        );
      })}
    </pre>
  );
}

export function CommitDetailPanel({
  repo,
  detail,
  wipTree,
  loading,
  onClose,
}: Props) {
  const [activeFile, setActiveFile] = useState<string | null>(null);
  /**
   * The diff and the file it belongs to. A refresh keeps showing the current
   * diff until the new one lands (no flash on every window focus), while a
   * different file shows the loader rather than the previous file's diff.
   */
  const [diff, setDiff] = useState<{ file: string; text: string } | null>(null);

  const files = wipTree ? wipTree.files : (detail?.files ?? []);
  // Identity of what the panel currently shows, used to reset the open file.
  const subject = wipTree ? "wip" : detail?.sha;

  useEffect(() => {
    setActiveFile(null);
    setDiff(null);
  }, [subject]);

  useEffect(() => {
    if (!activeFile) return;
    if (!wipTree && !detail) return;
    let cancelled = false;

    const untracked =
      files.find((f) => f.path === activeFile)?.status === "?";
    const request = wipTree
      ? api.workingTreeDiff(repo, activeFile, untracked)
      : api.fileDiff(repo, detail!.sha, activeFile);

    request
      .then((d) => !cancelled && setDiff({ file: activeFile, text: d }))
      .catch((e) => !cancelled && setDiff({ file: activeFile, text: String(e) }));
    return () => {
      cancelled = true;
    };
    // `wipTree` too: a refresh (window focus, ⌘R) brings a new tree, and the
    // open file's diff must follow the edits made meanwhile.
  }, [repo, subject, activeFile, wipTree]);

  // The open file was committed or reverted meanwhile: close it rather than
  // showing a diff of nothing.
  useEffect(() => {
    if (wipTree && activeFile && !wipTree.files.some((f) => f.path === activeFile)) {
      setActiveFile(null);
      setDiff(null);
    }
  }, [wipTree, activeFile]);

  if (!wipTree && !detail) {
    return (
      <div className="flex h-full items-center justify-center text-[12px] text-ink-500">
        {loading ? "Chargement…" : "Sélectionne un commit pour voir son détail."}
      </div>
    );
  }

  const totals = files.reduce(
    (acc, f) => ({ a: acc.a + f.additions, d: acc.d + f.deletions }),
    { a: 0, d: 0 },
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-start gap-2 border-b border-ink-800 px-3 py-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-semibold text-ink-100 select-text">
            {wipTree ? "Modifications non commitées" : detail!.subject}
          </p>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-ink-400">
            {wipTree ? (
              <>
                <span className="text-accent">{wipTree.stagedCount} indexé(s)</span>
                <span>·</span>
                <span className="text-behind">{wipTree.unstagedCount} modifié(s)</span>
                <span>·</span>
                <span>{wipTree.untrackedCount} non suivi(s)</span>
                {wipTree.conflictedCount > 0 && (
                  <>
                    <span>·</span>
                    <span className="text-danger">
                      {wipTree.conflictedCount} en conflit
                    </span>
                  </>
                )}
              </>
            ) : (
              <>
                <span className="font-mono text-ink-300">{detail!.shortSha}</span>
                <span>·</span>
                <span className="select-text">{detail!.author}</span>
                <span>·</span>
                <span>{absoluteTime(detail!.authorDate)}</span>
                {detail!.parents.length > 1 && (
                  <>
                    <span>·</span>
                    <span className="text-behind">
                      merge ({detail!.parents.length} parents)
                    </span>
                  </>
                )}
              </>
            )}
          </p>
        </div>
        {!wipTree && (
          <button
            onClick={() => navigator.clipboard.writeText(detail!.sha)}
            {...tip("Copier le SHA complet")}
            className="shrink-0 rounded p-1 text-ink-400 hover:bg-ink-700 hover:text-ink-100"
          >
            <Copy size={12} />
          </button>
        )}
        <button
          onClick={onClose}
          {...tip("Fermer le détail")}
          className="shrink-0 rounded p-1 text-ink-400 hover:bg-ink-700 hover:text-ink-100"
        >
          <X size={13} />
        </button>
      </header>

      {!wipTree && detail!.body && (
        <pre className="max-h-28 shrink-0 overflow-y-auto border-b border-ink-800 px-3 py-2 font-sans text-[12px] leading-relaxed whitespace-pre-wrap text-ink-300 select-text">
          {detail!.body}
        </pre>
      )}

      <div className="flex min-h-0 flex-1">
        <div className="flex w-[46%] min-w-[240px] shrink-0 flex-col border-r border-ink-800">
          <div className="flex shrink-0 items-center gap-2 px-3 py-1.5 text-[10px] font-semibold tracking-wider text-ink-500 uppercase">
            <FileDiff size={11} />
            {files.length} fichier{files.length > 1 ? "s" : ""}
            <span className="ml-auto font-mono normal-case">
              <span className="text-ahead">+{totals.a}</span>{" "}
              <span className="text-danger">−{totals.d}</span>
            </span>
          </div>
          <div className="flex-1 overflow-y-auto px-1 pb-2">
            {files.map((file) => (
              <FileRow
                key={file.path}
                file={file}
                active={file.path === activeFile}
                onClick={() => setActiveFile(file.path)}
              />
            ))}
          </div>
        </div>

        <div className="min-w-0 flex-1 overflow-auto bg-ink-950">
          {!activeFile && (
            <p className="p-3 text-[11px] text-ink-500">
              Clique un fichier pour voir son diff.
            </p>
          )}
          {activeFile && diff?.file !== activeFile && (
            <p className="p-3 text-[11px] text-ink-500">Chargement du diff…</p>
          )}
          {activeFile && diff?.file === activeFile && <DiffView diff={diff.text} />}
        </div>
      </div>
    </div>
  );
}
