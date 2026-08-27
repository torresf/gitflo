# gitflo

A native macOS viewer for git branches and commits across many repositories.

![macOS](https://img.shields.io/badge/macOS-Apple%20Silicon-black)
![licence](https://img.shields.io/badge/licence-MIT-blue)

- **Many repositories at once**, grouped by their real git object: the worktrees
  of one repository are a single expandable entry.
- **A readable commit graph**, adjustable width, semantic colours.
- **Checkout, merge, rebase, push, pull, fetch** from a right-click or a
  double-click.
- **Branch cleanup**, local and remote, detecting branches whose work already
  shipped — including through a squashed merge request.
- **Uncommitted changes** shown above the graph, with their diffs.

It reads local repositories only and sends nothing anywhere. The sole network
writes are the `fetch` / `pull` / `push` you ask for.

## What it does that others don't

The sidebar lists **repositories grouped by their real git object**, not by
folder: the `api`, `api-wip`, `api-hotfix` checkouts are one expandable entry,
because `git rev-parse --git-common-dir` ties them to the same `.git`. Each
worktree shows its branch, its ahead/behind counts and how many files it has
pending.

## Install

There is no signed release, so macOS blocks the app on first launch.

```bash
# from the .dmg or the .app
xattr -dr com.apple.quarantine /Applications/gitflo.app
```

Or build from source (below). Requirements: Node 20+, stable Rust, Xcode
Command Line Tools, git 2.38+ (for the shipped-branch detection).

## Contributing

`ARCHITECTURE.md` documents the graph invariants, the traps already paid for and
the open leads. Read it before touching `src/lib/graph.ts`.

## Technologies

| Layer | Choice | Version |
|---|---|---|
| App shell | Tauri | 2.11 |
| Backend | Rust (2021 edition) | 1.96 |
| Parallelism | rayon | 1 |
| Serialisation | serde / serde_json | 1 |
| View | React | 19.2 |
| Front language | TypeScript | 5.8 |
| Build | Vite | 7.3 |
| Styling | Tailwind CSS (Vite plugin) | 4.3 |
| Icons | lucide-react | 1.34 |
| Front tests | Vitest | 4.1 |
| Icon rendering | @resvg/resvg-js (dev) | 2.6 |

Tauri plugins: `dialog` (folder picker), `opener`.

### Why these choices

**Tauri over Electron** — a ten-megabyte binary instead of about 150, the system
webview, and a native Rust backend for the part that matters here: reading
dozens of repositories fast.

**The `git` binary over libgit2.** The same worktrees, the same hooks, the same
credential helpers as the command line, no cmake dependency to build — and
above all git's own `stderr` surfaces verbatim in the UI, which is what makes a
merge conflict readable instead of an "operation failed".

**Every Tauri command is `async`.** A command declared `fn` runs on the main
thread: one slow command (comparing 40 branches with `git merge-tree`) froze the
webview, no spinner rendered, and macOS showed the wait cursor. The bodies stay
blocking; being async is what moves them off the UI thread.

**`status --porcelain=v2 --branch -uall` in one call** yields the branch, the
upstream, ahead/behind *and* the file states. That is what scans 37
repositories in 0.4 s, with `rayon` for parallelism.

**Business logic in pure functions**, components reduced to rendering: hence
~190 tests running in a second and a half with no DOM and no git repository,
plus a few opt-in tests replayed against real repositories.

**OKLCH for lane colours** — a perceptually uniform space, so an equal step in
hue looks equally different. In HSL the same ramp crowds the greens and thins
the blues.

**No graph library.** Lane placement is about two hundred lines
(`src/lib/graph.ts`) and it is the subtlest part of the project: some thirty
tests cover it, plus a replay on a real repository.

### Accepted limits

- No staging and no committing: this is a viewer, not a full client.
- No list virtualisation — 400 rows are fine, 5,000 would crawl.
- The `.app` is unsigned.
- `git merge-tree --write-tree` needs git 2.38+; below that, the "this branch
  contributes nothing" detection falls back to heuristics.

## Development

```bash
npm install
npm run tauri dev        # dev app, hot reload on the front
npm test                 # graph algorithm and pure-logic tests (vitest)
cd src-tauri && cargo test   # git parser tests
```

Check the scan against the real disk:

```bash
cd src-tauri && cargo test scans_local_workspace -- --ignored --nocapture
```

## Building the app

```bash
npm run tauri build
```

Produces `src-tauri/target/release/bundle/macos/gitflo.app` (plus a `.dmg`).
Copy the `.app` into `/Applications`.

> The app is unsigned. On first launch macOS blocks it: right-click the app →
> **Open**, or `xattr -dr com.apple.quarantine /Applications/gitflo.app`.

## Architecture

```
src-tauri/src/git.rs    all the git work: scan, branches, commits, actions
src-tauri/src/lib.rs    the commands exposed to the front
src/lib/graph.ts        lane placement and edge routing
src/components/         repo sidebar, branch list, graph, commit detail
```

### The two parts not to break

`parse_status_v2` reads `git status --porcelain=v2 --branch`, which yields the
branch, the upstream, ahead/behind and the file states **in a single call** —
hence a 37-repository scan in 0.4 s. The X and Y columns of the status code
count separately (`MM` is one staged file AND one modified file).

`buildGraph` keeps one lane per line of development awaiting a commit. The first
parent inherits the commit's lane: that is what keeps a branch a continuous
vertical instead of hopping columns. Covered by
`src/lib/__tests__/graph.test.ts` — any change goes through it.

## Hiding repositories

Right-click a sidebar row → "Masquer …". A whole repository or a single
worktree. The list is **per tab**: the same repository can be visible in one tab
and hidden in another. When something is hidden, an eye-off button appears in the
sidebar header with the count; it opens a menu to bring them back one at a time
or all at once.

Storage is one list per tab mixing repository ids and worktree paths — the two
cannot be confused, since a repository id always points inside a `.git`
directory.

## Lane colours

Two fixed roles, everything else on a ramp:

| Lane | Colour |
|---|---|
| `master` / `main` | green `#57d38c` |
| `develop` / `dev` | blue `#4c9aff` |
| the rest | OKLCH ramp, violet → pink → red → orange → yellow |

The role comes from the lanes `buildGraph` **actually** reserved, never from the
mere existence of the branch: on a filtered page where neither `master` nor
`develop` appears, lane 0 is an ordinary branch and must not be painted as the
trunk.

Roled lanes **do not consume a ramp slot**, so the first ordinary branch is
always violet whatever the repository's shape (`paletteIndex`). The offset counts
the roled lanes to its left, without assuming they sit at positions 0 and 1.

There is **no colour for HEAD**: the current branch keeps its lane's colour and
is recognisable by the halo on its dot, its filled badge and the check mark in
the list. A dedicated colour made a branch change hue the moment you checked it
out.

The "coloured / neutral badges" toggle in the graph bar affects **badges only** —
the graph keeps its colours either way, otherwise flipping it felt like the
history had changed.

## Branch cleanup

The bin icon in the branch list opens two tabs, Local and Remote, analysed in
one pass.

The question it answers is not "does git call this merged?" but "would deleting
this lose work?". Three tests, weakest to strongest:

1. `git branch --merged` compares **SHAs** — blind to a squashed request.
2. `git cherry` compares **patch ids** — blind to a patch touched on the way in.
3. `git merge-tree --write-tree` computes the tree the merge **would** produce:
   if it equals the base's own tree, the branch contributes nothing, whatever
   its commits look like. This one decides.

Without the third, the app warned "2 commits lost forever" about fully shipped
branches — 5 candidates out of 6 in a real case.

Guardrails: preselection limited to what contributes nothing, main branches never
offered, current branch and branches held by a worktree disabled with the reason
shown, one deletion per branch so a refusal cannot mask others, and a dedicated
confirmation on the remote side (it changes the server for everyone).

## Shortcuts

| Key | Effect |
|---|---|
| `⌘R` | rescan repositories |
| `Esc` | close the commit detail |
| right-click a branch | checkout, merge, rebase, create, delete |
| right-click a repository | hide, open in editor, reveal in Finder |
| right-click a commit | create a branch, copy the SHA |
| right-click a worktree | remove the worktree |
| double-click a branch | checkout |
| double-click a branch badge | checkout |
| right-click a branch badge | checkout, merge |
| drag the gutter edge | graph width (double-click: auto) |

### Where settings live

`~/Library/Application Support/gitflo/settings.json` — tabs, folders, hidden
repositories, folded repositories, gutter width, badge mode, last selection.

A file rather than the webview's `localStorage`: that one is tied to the
webview's data container, which changes with the bundle identifier and differs
between `tauri dev` and an installed app — renaming the app, or merely
installing it, lost every tab. Atomic writes (temp file then rename) and
coalesced writes, since dragging the gutter would otherwise produce dozens of
writes a second.

## The WIP row

When the selected worktree is not clean, a row appears above the first commit: a
dashed circle on HEAD's lane, a dashed stem down to HEAD's commit. The counts
come from the scan the sidebar already did, so the row costs nothing; the file
list is only read on click.

The diff is taken **against HEAD**, so a file staged then modified again appears
once with its total change. Untracked files are diffed against `/dev/null` and
marked `?`.

⚠ Untracked files are counted with `status -uall` (not git's default
directory-collapsed mode), otherwise the sidebar and this panel report different
numbers for the same checkout.
