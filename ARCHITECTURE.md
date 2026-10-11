# Architecture and traps

What the code does not say about itself. The README covers usage and
technologies; this file is for anyone about to modify gitflo — its own author in
six months included.

## Running

```bash
npm install
npm run tauri dev           # dev, hot reload on the front
npm test                    # ~190 front tests (vitest)
cd src-tauri && cargo test  # git parsers
npm run install-local       # build, replace /Applications/gitflo.app, relaunch
```

Bump the version in `package.json`, `src-tauri/tauri.conf.json` and
`src-tauri/Cargo.toml` together before installing a release, so the installed
app says which one it is.

Opt-in tests, replayed against real repositories (skipped by default):

```bash
cd src-tauri && cargo test -- --ignored --nocapture
GITFLO_REAL_REPO=~/code/some-repo npx vitest run graph.real
```

⚠ `tauri dev` holds port 1420; if it was killed roughly, an orphan Vite keeps it
and the restart fails with "Port 1420 already in use".
`lsof -ti :1420 | xargs kill -9` clears it.

## The traps already paid for

Each of these cost a debugging round-trip. They are all covered by a test, but
the test does not say *why* it exists.

**Tauri commands must stay `async`.** A command declared `fn` runs on the main
thread: one slow command (comparing 40 branches) froze the webview, no spinner
rendered, and macOS showed the wait cursor. The bodies are blocking; `async` is
what moves them.

**`{...tip(…)}` spreads BEFORE the element's own handlers.** It supplies its own
`onMouseDown`, so spreading it last silently replaces a drag or a press. That is
how the gutter handle ended up hovering but never dragging.

**The tooltip delay must not be re-armed on `onMouseMove`.** Otherwise the
tooltip never appears on a moving pointer.

**A NUL separator cannot travel in an `exec` argument.** `git log` records are
separated by `%x1e` (ASCII RS), not `%x00`.

**Paths are read with `-z` output** (status, diff, show). Without it numstat folds
a rename into one field (`src/{a => b}/f.rs`) and any non-ASCII, tab or quote
in a name comes back C-quoted. Paths sent back go through `:(literal)` so a
file named `a*.txt` is not a pattern.

**`--end-of-options` goes after the pseudo-options.** Everything past it is a
revision, `--not` and `--remotes` included. Refs from the UI sit behind it, and
a trailing `--` keeps a branch named like a file from being "ambiguous".

**`git diff --no-index` exits 1 both on "files differ" and on "could not
access"**: only a 1 WITH a diff is a success.

**`git for-each-ref` does NOT expand `%xNN`** (unlike `log` and `show`): the
separator byte is interpolated directly there.

**`git show` renders no diff on a merge** without `-m --first-parent`.

**Three merge tests, weakest to strongest**: `--merged` compares SHAs (blind to
a squash), `git cherry` compares patch ids (blind to a touched patch),
`merge-tree --write-tree` computes the tree the merge would produce — the only
one that decides. Without the third, the app announced "2 commits lost" about
fully shipped branches.

**A webview's `localStorage` is tied to the bundle identifier.** It changes
between `tauri dev` and an installed app: settings therefore live in a file at a
fixed path.

**An element mounted only during a load shifts its neighbours.** Spinners have
reserved slots, and so does anything that comes and goes next to a button (the
branch picker's clear cross, the old "tout" button that pushed the bin aside).

**Every async read checks, on landing, that it still applies.** Results are
applied only if the repo (`repoPathRef`), the tab (scan sequence) and the
request (per-list sequence) are still current. Without it, a slow `git log`
of repo A landed under repo B, and B's checkout picker listed A's branches.
Switching repo clears every per-repo list at once for the same reason.

**Every git write goes through `GitLock`** (`src/lib/gitLock.ts`): one at a
time, its path bound at click time, and the background fetch yields to it. Two
writes at once collided on `index.lock` and made the busy indicator lie.

**git runs with `LC_ALL=C`.** The front recognises refusals by their English
text; a translated git (Homebrew's) would defeat that silently.

**`git pull --ff-only` dead-ends on a diverged branch**, and the push is
refused too until the pull happens: both buttons failed at once. The default
pull is `--rebase --autostash`; the variants sit behind the chevron.

## What the graph does (`src/lib/graph.ts`)

The subtlest part, ~200 lines, some thirty tests. Two invariants:

1. **Every stroke leaves a dot or continues the stroke above it.** A lane
   "passes" a row only if it was live *before* it; a lane this commit has just
   claimed starts at its dot.
2. **A reserved lane is only drawn from its claim onwards** — by its own commit,
   or by a merge naming it as a parent.

Both were violated once each, with a visible symptom: floating strokes beside
merges, then a gap between a merge and the branch it merged.

## Assets

`design/icon.svg` is the app icon source; `design/social-preview.svg` the
GitHub share card. Both render through resvg:

```bash
node scripts/render-icon.mjs && npm run tauri icon design/icon.png
```

⚠ resvg does not support `oklch()` and silently drops the stroke — write hex in
these files even though the app itself uses OKLCH.

The social preview is uploaded by hand: GitHub → Settings → General → Social
preview. A repository cannot have an avatar of its own.

## Open leads (contributions welcome)

- **`git worktree prune`** is exposed on the Rust side but not wired to the UI.
- **Creating a worktree** from the app (only removal exists).
- **Virtualising the commit list** — 400 rows are fine, 5,000 are not.
- **Signing the `.app`** to avoid the right-click → Open on first launch.
- **Stash**: neither read nor write.
- **English UI**: the interface strings are still in French.

## Decisions not to redo

- No staging and no committing: this is a viewer.
- The `git` binary, not libgit2.
- No graph library.
- Two roled colours only (`master` green, `develop` blue); the current branch has
  **no** colour, it has a halo and a filled badge.
- Roled lanes do not consume a slot of the OKLCH ramp.
