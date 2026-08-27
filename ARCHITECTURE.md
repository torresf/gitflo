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
```

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
reserved slots.

## What the graph does (`src/lib/graph.ts`)

The subtlest part, ~200 lines, some thirty tests. Two invariants:

1. **Every stroke leaves a dot or continues the stroke above it.** A lane
   "passes" a row only if it was live *before* it; a lane this commit has just
   claimed starts at its dot.
2. **A reserved lane is only drawn from its claim onwards** — by its own commit,
   or by a merge naming it as a parent.

Both were violated once each, with a visible symptom: floating strokes beside
merges, then a gap between a merge and the branch it merged.

## Open leads (contributions welcome)

- **Fetch every repository** in one action (the per-repository command exists).
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
