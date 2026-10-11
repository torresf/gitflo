use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Output, Stdio};
use std::sync::{mpsc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use rayon::prelude::*;
use serde::{Deserialize, Serialize};

/// Field separator used inside a single git output record (ASCII US).
const FS: char = '\x1f';
/// Record separator used between git log entries (ASCII RS).
///
/// Deliberately NOT NUL: `Command::arg` rejects a NUL byte outright (args are
/// C strings), so a `%x00` separator would fail the spawn, not the parse.
/// NUL is fine in git's OUTPUT, which is why path lists are read with `-z`.
const RS: char = '\x1e';

/// The one place a git command is built, so no invocation can miss part of
/// the environment.
fn git_command(cwd: &Path, args: &[&str]) -> Command {
    let mut cmd = Command::new("git");
    // Raw UTF-8 paths instead of C-quoted ones (`"caf\303\251.txt"`) in the
    // diff headers shown verbatim; the parsers read `-z` output regardless.
    cmd.args(["-c", "core.quotePath=false"])
        .args(args)
        .current_dir(cwd)
        // Never let git try to open an interactive prompt: a hung askpass
        // would freeze the whole app with no visible cause.
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        // English messages whatever the user's locale: the front recognises
        // refusals by their text ("not fully merged", "Directory not empty"),
        // and a translated git (Homebrew's is) would silently defeat that.
        .env("LC_ALL", "C")
        .env("LANGUAGE", "C")
        // Not a terminal either: merge then never opens an editor.
        .stdin(Stdio::null());
    cmd
}

fn git_output(cwd: &Path, args: &[&str]) -> Result<Output, String> {
    git_command(cwd, args)
        .output()
        .map_err(|e| format!("failed to spawn git: {e}"))
}

/// Everything git said about a failure: stderr (the error itself) THEN
/// stdout, where merge and rebase print their CONFLICT lines.
fn failure_message(output: &Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    let parts: Vec<&str> = [stderr.trim(), stdout.trim()]
        .into_iter()
        .filter(|s| !s.is_empty())
        .collect();
    if parts.is_empty() {
        format!("git a échoué ({})", output.status)
    } else {
        parts.join("\n")
    }
}

/// Pure stdout on success: what the parsers need.
fn run_git(cwd: &Path, args: &[&str]) -> Result<String, String> {
    let output = git_output(cwd, args)?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        Err(failure_message(&output))
    }
}

/// Resolve a user-given revision to a full sha, once, so the commands that
/// follow get an argument that can neither be read as an option nor be
/// ambiguous with a file of the same name.
fn resolve_commit(cwd: &Path, rev: &str) -> Result<String, String> {
    let sha = run_git(
        cwd,
        &["rev-parse", "--verify", "--quiet", "--end-of-options", &format!("{rev}^{{commit}}")],
    )
    .unwrap_or_default();
    let sha = sha.trim();
    if sha.is_empty() {
        Err(format!("Référence introuvable : {rev}"))
    } else {
        Ok(sha.to_string())
    }
}

fn tree_of(cwd: &Path, sha: &str) -> Result<String, String> {
    Ok(run_git(cwd, &["rev-parse", &format!("{sha}^{{tree}}")])?.trim().to_string())
}

fn list_remotes(cwd: &Path) -> Result<Vec<String>, String> {
    Ok(run_git(cwd, &["remote"])?
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(String::from)
        .collect())
}

/// The remote the current branch tracks, if it tracks one.
fn current_branch_remote(cwd: &Path) -> Option<String> {
    let branch = run_git(cwd, &["symbolic-ref", "--quiet", "--short", "HEAD"]).ok()?;
    let remote = run_git(cwd, &["config", "--get", &format!("branch.{}.remote", branch.trim())]).ok()?;
    let remote = remote.trim();
    // "." is a branch tracking another LOCAL branch: no remote involved.
    (!remote.is_empty() && remote != ".").then(|| remote.to_string())
}

/// Split `origin/feature/x` into remote and branch.
///
/// A remote name may itself contain `/` (`team/origin`), so splitting at the
/// first slash is wrong; the longest known remote that prefixes the ref wins.
/// Refs of a remote since removed fall back to the first slash.
fn split_remote_ref<'a>(short: &'a str, remotes: &[String]) -> Option<(&'a str, &'a str)> {
    remotes
        .iter()
        .filter(|r| {
            short.len() > r.len() + 1
                && short.starts_with(r.as_str())
                && short.as_bytes()[r.len()] == b'/'
        })
        .max_by_key(|r| r.len())
        .map(|r| (&short[..r.len()], &short[r.len() + 1..]))
        .or_else(|| short.split_once('/'))
}

// ---------------------------------------------------------------------------
// Network commands
// ---------------------------------------------------------------------------

/// A remote that accepts the connection and then never answers would leave
/// the spinner turning forever; past this, the command is killed.
const FETCH_TIMEOUT: Duration = Duration::from_secs(60);
/// Pull and push also carry local work (a rebase, a pre-push hook).
const PUSH_PULL_TIMEOUT: Duration = Duration::from_secs(120);

/// Whether to force ssh into batch mode. A Finder-launched app has no
/// terminal, so a passphrase or host-key question would wait forever.
///
/// Only when the user chose no ssh command of their own: GIT_SSH_COMMAND
/// takes precedence over core.sshCommand and GIT_SSH, and would silently
/// drop them.
fn wants_batch_ssh(cwd: &Path) -> bool {
    if std::env::var_os("GIT_SSH_COMMAND").is_some() || std::env::var_os("GIT_SSH").is_some() {
        return false;
    }
    !run_git(cwd, &["config", "--get", "core.sshCommand"]).is_ok_and(|v| !v.trim().is_empty())
}

/// Read a pipe to its end on a thread, so neither stream can fill up and
/// block git while we wait on the other.
fn drain(pipe: Option<impl Read + Send + 'static>) -> mpsc::Receiver<Vec<u8>> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(mut pipe) = pipe {
            let _ = pipe.read_to_end(&mut buf);
        }
        let _ = tx.send(buf);
    });
    rx
}

/// Kill git AND the ssh it spawned: the child leads its own process group.
fn kill_group(child: &mut Child) {
    let _ = Command::new("kill")
        .args(["-KILL", &format!("-{}", child.id())])
        .status();
    let _ = child.kill();
    let _ = child.wait();
}

fn run_git_network(cwd: &Path, args: &[&str], timeout: Duration) -> Result<Output, String> {
    let mut cmd = git_command(cwd, args);
    if wants_batch_ssh(cwd) {
        cmd.env("GIT_SSH_COMMAND", "ssh -o BatchMode=yes");
    }
    let mut child = cmd
        .process_group(0)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to spawn git: {e}"))?;
    let stdout = drain(child.stdout.take());
    let stderr = drain(child.stderr.take());

    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() >= timeout => {
                kill_group(&mut child);
                return Err(format!(
                    "Délai dépassé ({} s) : le distant ne répond pas",
                    timeout.as_secs()
                ));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(e) => return Err(format!("failed to wait for git: {e}")),
        }
    };
    // An ssh ControlPersist master inherits the pipes and outlives git: do not
    // wait on it for the end of the streams.
    let grace = Duration::from_secs(2);
    Ok(Output {
        status,
        stdout: stdout.recv_timeout(grace).unwrap_or_default(),
        stderr: stderr.recv_timeout(grace).unwrap_or_default(),
    })
}

// ---------------------------------------------------------------------------
// Workspace scan
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Worktree {
    pub path: String,
    pub name: String,
    /// Branch name, or None when HEAD is detached.
    pub branch: Option<String>,
    pub head: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub dirty_files: u32,
    pub staged_files: u32,
    pub untracked_files: u32,
    pub conflicted_files: u32,
    /// True for the checkout that owns the shared .git directory.
    pub is_primary: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RepoGroup {
    /// Stable identity: the canonical shared git directory.
    pub id: String,
    pub name: String,
    /// Path of the primary checkout, used for repo-wide reads.
    pub primary_path: String,
    pub worktrees: Vec<Worktree>,
}

/// Parsed shape of `git status --porcelain=v2 --branch -z`.
struct StatusSummary {
    branch: Option<String>,
    head: Option<String>,
    upstream: Option<String>,
    ahead: u32,
    behind: u32,
    dirty: u32,
    staged: u32,
    untracked: Vec<String>,
    conflicted: u32,
}

/// `-z` output: one record per NUL, and a rename record ("2 …") is followed
/// by one more NUL-terminated field, its source path.
fn parse_status_v2(raw: &str) -> StatusSummary {
    let mut s = StatusSummary {
        branch: None,
        head: None,
        upstream: None,
        ahead: 0,
        behind: 0,
        dirty: 0,
        staged: 0,
        untracked: Vec::new(),
        conflicted: 0,
    };

    let mut records = raw.split('\0');
    while let Some(record) = records.next() {
        if let Some(rest) = record.strip_prefix("# branch.head ") {
            // git writes the literal "(detached)" when HEAD points at no branch.
            s.branch = if rest == "(detached)" {
                None
            } else {
                Some(rest.to_string())
            };
        } else if let Some(rest) = record.strip_prefix("# branch.oid ") {
            s.head = if rest == "(initial)" {
                None
            } else {
                Some(rest.chars().take(9).collect())
            };
        } else if let Some(rest) = record.strip_prefix("# branch.upstream ") {
            s.upstream = Some(rest.to_string());
        } else if let Some(rest) = record.strip_prefix("# branch.ab ") {
            for token in rest.split_whitespace() {
                let value: u32 = token[1..].parse().unwrap_or(0);
                match token.chars().next() {
                    Some('+') => s.ahead = value,
                    Some('-') => s.behind = value,
                    _ => {}
                }
            }
        } else if let Some(rest) = record.strip_prefix("1 ").or_else(|| record.strip_prefix("2 ")) {
            if record.starts_with('2') {
                records.next();
            }
            // "<XY> <sub> ..." — X is the staged status, Y the worktree status.
            let xy: Vec<char> = rest.chars().take(2).collect();
            if xy.first().is_some_and(|c| *c != '.') {
                s.staged += 1;
            }
            if xy.get(1).is_some_and(|c| *c != '.') {
                s.dirty += 1;
            }
        } else if record.starts_with("u ") {
            s.conflicted += 1;
        } else if let Some(path) = record.strip_prefix("? ") {
            s.untracked.push(path.to_string());
        }
    }

    s
}

fn dir_name(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string_lossy().to_string())
}

fn canonical(path: &str) -> String {
    std::fs::canonicalize(path)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| path.to_string())
}

/// Read one checkout: its shared git dir (for grouping) and its status.
fn read_checkout(path: &Path) -> Option<(String, Worktree)> {
    // Both dirs in one spawn, printed in the order asked.
    let dirs = run_git(path, &["rev-parse", "--path-format=absolute", "--git-common-dir", "--git-dir"]).ok()?;
    let mut dirs = dirs.lines().map(str::trim);
    let common_dir = dirs.next().filter(|d| !d.is_empty())?;
    let own_git_dir = dirs.next().filter(|d| !d.is_empty())?;
    let common_dir = canonical(common_dir);
    let own_git_dir = canonical(own_git_dir);

    // `-uall` on purpose: `-unormal` would count an untracked directory as one
    // file, and the sidebar number would disagree with the changes panel.
    let status = run_git(path, &["status", "--porcelain=v2", "--branch", "-z", "-uall"])
        .map(|raw| parse_status_v2(&raw))
        .unwrap_or_else(|_| parse_status_v2(""));

    let worktree = Worktree {
        path: path.to_string_lossy().to_string(),
        name: dir_name(path),
        branch: status.branch,
        head: status.head,
        upstream: status.upstream,
        ahead: status.ahead,
        behind: status.behind,
        dirty_files: status.dirty,
        staged_files: status.staged,
        untracked_files: status.untracked.len() as u32,
        conflicted_files: status.conflicted,
        // A linked worktree has its own git dir nested under the shared one.
        is_primary: own_git_dir == common_dir,
    };

    Some((common_dir, worktree))
}

/// Directory names that never contain a checkout we care about but can hold
/// thousands of entries. Skipping them keeps a deep scan instant.
const SKIPPED_DIRS: &[&str] = &[
    "node_modules",
    "target",
    "dist",
    "build",
    "vendor",
    "venv",
    ".venv",
    "__pycache__",
    "Library",
    "Applications",
];

/// Classify the `.git` entry of a directory.
///
/// A directory holds a repo we want (own `.git` dir, or a linked worktree
/// whose `.git` FILE points into `…/.git/worktrees/<name>`), a submodule we
/// skip (points into `…/.git/modules/<name>`), or nothing.
enum GitEntry {
    Repo,
    Submodule,
    None,
}

fn classify_git_entry(dir: &Path) -> GitEntry {
    let dot_git = dir.join(".git");
    if dot_git.is_dir() {
        return GitEntry::Repo;
    }
    if !dot_git.is_file() {
        return GitEntry::None;
    }
    // Linked worktrees and submodules both use a `gitdir:` pointer file. The
    // match includes `.git/`: a bare "/modules/" also caught the worktrees of
    // any repo that merely lives under a directory named `modules`.
    match std::fs::read_to_string(&dot_git) {
        Ok(content) if content.contains("/.git/modules/") => GitEntry::Submodule,
        Ok(_) => GitEntry::Repo,
        Err(_) => GitEntry::None,
    }
}

/// Walk `dir` up to `max_depth` levels collecting every checkout found.
///
/// Descending CONTINUES below a checkout on purpose: a repo that groups
/// sibling service repos in its own subdirectories is a common layout, and
/// stopping at the outer `.git` hid every one of them. Submodules are the
/// case we do skip — they belong to their parent, not to the workspace.
fn collect_checkouts(dir: &Path, depth: u32, max_depth: u32, found: &mut Vec<PathBuf>) {
    match classify_git_entry(dir) {
        GitEntry::Repo => found.push(dir.to_path_buf()),
        GitEntry::Submodule => return,
        GitEntry::None => {}
    }

    if depth >= max_depth {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() || path.is_symlink() {
            continue;
        }
        let name = dir_name(&path);
        if name.starts_with('.') || SKIPPED_DIRS.contains(&name.as_str()) {
            continue;
        }
        collect_checkouts(&path, depth + 1, max_depth, found);
    }
}

/// Scan each root for git checkouts, grouping the worktrees of a same
/// repository together under one entry.
pub fn scan_workspace(roots: &[String], max_depth: u32) -> Vec<RepoGroup> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    for root in roots {
        collect_checkouts(&PathBuf::from(root), 0, max_depth.max(1), &mut candidates);
    }

    candidates.sort();
    candidates.dedup();

    let scanned: Vec<(String, Worktree)> = candidates
        .par_iter()
        .filter_map(|p| read_checkout(p))
        .collect();

    let mut groups: HashMap<String, Vec<Worktree>> = HashMap::new();
    for (common_dir, worktree) in scanned {
        groups.entry(common_dir).or_default().push(worktree);
    }

    let mut result: Vec<RepoGroup> = groups
        .into_iter()
        .map(|(id, mut worktrees)| {
            worktrees.sort_by(|a, b| b.is_primary.cmp(&a.is_primary).then(a.name.cmp(&b.name)));
            let primary = worktrees
                .iter()
                .find(|w| w.is_primary)
                .or_else(|| worktrees.first());
            let name = primary.map(|w| w.name.clone()).unwrap_or_default();
            let primary_path = primary.map(|w| w.path.clone()).unwrap_or_default();
            RepoGroup {
                id,
                name,
                primary_path,
                worktrees,
            }
        })
        .collect();

    result.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    result
}

/// Existing, plausible code directories under the user home, offered as
/// defaults on first launch so the app is useful with zero configuration.
pub fn default_roots() -> Vec<String> {
    let Some(home) = std::env::var_os("HOME").map(PathBuf::from) else {
        return Vec::new();
    };
    ["Projects", "Code", "code", "dev", "Developer", "src", "repos", "work"]
        .iter()
        .map(|c| home.join(c))
        .filter(|p| p.is_dir())
        .map(|p| p.to_string_lossy().to_string())
        .collect()
}

// ---------------------------------------------------------------------------
// Branches
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Branch {
    pub refname: String,
    pub short: String,
    pub kind: String,
    pub sha: String,
    pub short_sha: String,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub gone: bool,
    pub date: String,
    pub author: String,
    pub subject: String,
    pub is_head: bool,
    /// Set when the branch is checked out in some worktree: git refuses a
    /// second checkout of the same branch, so the UI has to say who holds it.
    pub worktree_path: Option<String>,
    pub remote: Option<String>,
}

/// Parse `[ahead 2, behind 1]`, `[gone]`, `[behind 3]` or an empty string.
fn parse_track(track: &str) -> (u32, u32, bool) {
    let inner = track.trim().trim_start_matches('[').trim_end_matches(']');
    if inner.is_empty() {
        return (0, 0, false);
    }
    if inner == "gone" {
        return (0, 0, true);
    }
    let mut ahead = 0;
    let mut behind = 0;
    for part in inner.split(',') {
        let part = part.trim();
        if let Some(n) = part.strip_prefix("ahead ") {
            ahead = n.trim().parse().unwrap_or(0);
        } else if let Some(n) = part.strip_prefix("behind ") {
            behind = n.trim().parse().unwrap_or(0);
        }
    }
    (ahead, behind, false)
}

/// Parse `%(ahead-behind:<base>)`, "<ahead> <behind>".
fn parse_ahead_behind(field: &str) -> Option<(u32, u32)> {
    let mut parts = field.split_whitespace();
    let ahead = parts.next()?.parse().ok()?;
    let behind = parts.next()?.parse().ok()?;
    Some((ahead, behind))
}

pub fn list_branches(repo: &str) -> Result<Vec<Branch>, String> {
    let repo_path = Path::new(repo);
    // Unlike `log`/`show`, for-each-ref does NOT expand %xNN escapes (it would
    // emit the literal "%x1f"), so the separator byte is interpolated directly.
    let format = format!(
        "%(refname){FS}%(refname:short){FS}%(objectname){FS}%(objectname:short){FS}\
         %(upstream:short){FS}%(upstream:track){FS}%(committerdate:iso8601-strict){FS}\
         %(authorname){FS}%(contents:subject){FS}%(HEAD){FS}%(worktreepath)"
    );

    let raw = run_git(
        repo_path,
        &[
            "for-each-ref",
            "--sort=-committerdate",
            &format!("--format={format}"),
            "refs/heads",
            "refs/remotes",
        ],
    )?;
    let remotes = list_remotes(repo_path)?;

    let mut branches = Vec::new();
    for line in raw.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let f: Vec<&str> = line.split(FS).collect();
        if f.len() < 11 {
            continue;
        }

        let refname = f[0].to_string();
        // origin/HEAD is a symbolic pointer, not a branch anyone checks out.
        if refname.ends_with("/HEAD") {
            continue;
        }

        let (ahead, behind, gone) = parse_track(f[5]);
        // From the full refname: `refname:short` turns into "remotes/origin/x"
        // when a local branch is literally named "origin/x".
        let remote = refname
            .strip_prefix("refs/remotes/")
            .and_then(|short| split_remote_ref(short, &remotes))
            .map(|(remote, _)| remote.to_string());
        let kind = if refname.starts_with("refs/remotes/") {
            "remote"
        } else {
            "local"
        };

        branches.push(Branch {
            short: f[1].to_string(),
            kind: kind.to_string(),
            sha: f[2].to_string(),
            short_sha: f[3].to_string(),
            upstream: if f[4].is_empty() {
                None
            } else {
                Some(f[4].to_string())
            },
            ahead,
            behind,
            gone,
            date: f[6].to_string(),
            author: f[7].to_string(),
            subject: f[8].to_string(),
            is_head: f[9] == "*",
            worktree_path: if f[10].is_empty() {
                None
            } else {
                Some(f[10].to_string())
            },
            remote,
            refname,
        });
    }

    Ok(branches)
}

// ---------------------------------------------------------------------------
// Commits
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Commit {
    pub sha: String,
    pub short_sha: String,
    pub parents: Vec<String>,
    pub author: String,
    pub email: String,
    pub date: String,
    pub subject: String,
    /// Decoration as given by %D (branch/tag names pointing here).
    pub refs: Vec<String>,
}

pub fn list_commits(
    repo: &str,
    revs: &[String],
    limit: u32,
    skip: u32,
) -> Result<Vec<Commit>, String> {
    // Revisions come from the UI; one starting with '-' would be an option.
    if let Some(bad) = revs.iter().find(|r| r.starts_with('-')) {
        return Err(format!("Révision invalide : {bad}"));
    }

    // `git log` expands %xNN itself; keep the escapes textual.
    let format =
        "--pretty=format:%H%x1f%h%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%D%x1e".to_string();
    let limit_arg = format!("--max-count={limit}");
    let skip_arg = format!("--skip={skip}");

    let mut args: Vec<String> = vec![
        "log".into(),
        format,
        limit_arg,
        skip_arg,
        "--date-order".into(),
        // Fully-qualified decorations: the short form cannot tell a local
        // `feature/x` from a remote `origin/x`, so badges could not be ranked.
        "--decorate=full".into(),
    ];
    if revs.is_empty() {
        // Not `--all`: it also walks refs/stash, refs/notes and the like,
        // whose commits are nobody's history. HEAD keeps a detached checkout
        // visible; `--ignore-missing` keeps an unborn HEAD from failing.
        args.extend(
            ["--ignore-missing", "--branches", "--remotes", "--tags", "HEAD"]
                .map(String::from),
        );
    } else {
        args.push("--end-of-options".into());
        args.extend(revs.iter().cloned());
    }
    // Revisions only: a branch named like a file is not "ambiguous".
    args.push("--".into());

    let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    let raw = run_git(Path::new(repo), &arg_refs)?;

    let mut commits = Vec::new();
    for record in raw.split(RS) {
        let record = record.trim_start_matches('\n');
        if record.trim().is_empty() {
            continue;
        }
        let f: Vec<&str> = record.split(FS).collect();
        if f.len() < 8 {
            continue;
        }
        commits.push(Commit {
            sha: f[0].to_string(),
            short_sha: f[1].to_string(),
            parents: f[2].split_whitespace().map(|s| s.to_string()).collect(),
            author: f[3].to_string(),
            email: f[4].to_string(),
            date: f[5].to_string(),
            subject: f[6].to_string(),
            refs: f[7]
                .split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect(),
        });
    }

    Ok(commits)
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    pub path: String,
    pub old_path: Option<String>,
    pub status: String,
    pub additions: u32,
    pub deletions: u32,
    pub binary: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CommitDetail {
    pub sha: String,
    pub short_sha: String,
    pub parents: Vec<String>,
    pub author: String,
    pub email: String,
    pub author_date: String,
    pub committer: String,
    pub committer_date: String,
    pub subject: String,
    pub body: String,
    pub refs: Vec<String>,
    pub files: Vec<ChangedFile>,
}

/// Parse `--raw --numstat -z` output: the raw section (status letter, rename
/// source) then the numstat section (counts), both NUL-separated.
///
/// `-z` is what makes this reliable. Without it numstat folds a rename into
/// ONE field (`src/{a => b}/f.rs`, the new path appearing nowhere whole), and
/// any path with a non-ASCII byte, a tab or a quote comes back C-quoted.
fn parse_changed_files_z(raw: &str) -> Vec<ChangedFile> {
    let mut entries: Vec<(String, Option<String>, String)> = Vec::new();
    let mut counts: HashMap<String, (u32, u32, bool)> = HashMap::new();

    let mut tokens = raw.split('\0');
    while let Some(token) = tokens.next() {
        let token = token.trim_start_matches('\n');
        if token.is_empty() {
            continue;
        }
        if token.starts_with(':') {
            // ":<mode> <mode> <sha> <sha> <status>", then one path, or two
            // (source, destination) for a rename or a copy.
            let status = token.rsplit(' ').next().unwrap_or_default().to_string();
            let first = tokens.next().unwrap_or_default().to_string();
            if status.starts_with('R') || status.starts_with('C') {
                let second = tokens.next().unwrap_or_default().to_string();
                entries.push((second, Some(first), status));
            } else {
                entries.push((first, None, status));
            }
        } else {
            // "<added>\t<deleted>\t<path>", or an empty path followed by the
            // source and destination of a rename. "-" counts mean binary.
            let mut parts = token.splitn(3, '\t');
            let added = parts.next().unwrap_or_default();
            let deleted = parts.next().unwrap_or_default();
            let mut path = parts.next().unwrap_or_default().to_string();
            if path.is_empty() {
                tokens.next();
                path = tokens.next().unwrap_or_default().to_string();
            }
            let binary = added == "-" || deleted == "-";
            counts.insert(
                path,
                (added.parse().unwrap_or(0), deleted.parse().unwrap_or(0), binary),
            );
        }
    }

    entries
        .into_iter()
        .map(|(path, old_path, status)| {
            let (additions, deletions, binary) = counts.get(&path).copied().unwrap_or((0, 0, false));
            ChangedFile {
                path,
                old_path,
                status,
                additions,
                deletions,
                binary,
            }
        })
        .collect()
}

/// Turn a repo-relative path into a pathspec that matches only itself: a
/// file named `*.rs` or `:(top)x` would otherwise be read as a pattern.
fn literal_pathspec(path: &str) -> String {
    format!(":(literal){path}")
}

pub fn commit_detail(repo: &str, sha: &str) -> Result<CommitDetail, String> {
    let repo_path = Path::new(repo);
    let format =
        "--format=%H%x1f%h%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%cn%x1f%cI%x1f%D%x1f%s%x1f%b";
    let raw = run_git(repo_path, &["show", "-s", format, "--end-of-options", sha, "--"])?;
    let f: Vec<&str> = raw.split(FS).collect();
    if f.len() < 11 {
        return Err(format!("unexpected git show output for {sha}"));
    }

    // Counts, letters and rename sources in one pass. Kept apart from the
    // metadata above: the free-text body could hold any separator we chose.
    let changes = run_git(
        repo_path,
        &[
            "show",
            "-z",
            "--raw",
            "--numstat",
            "--format=",
            "-M",
            "-m",
            "--first-parent",
            "--no-color",
            "--end-of-options",
            f[0],
            "--",
        ],
    )?;

    Ok(CommitDetail {
        sha: f[0].to_string(),
        short_sha: f[1].to_string(),
        parents: f[2].split_whitespace().map(|s| s.to_string()).collect(),
        author: f[3].to_string(),
        email: f[4].to_string(),
        author_date: f[5].to_string(),
        committer: f[6].to_string(),
        committer_date: f[7].to_string(),
        refs: f[8]
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect(),
        subject: f[9].to_string(),
        body: f[10].trim_end().to_string(),
        files: parse_changed_files_z(&changes),
    })
}

pub fn file_diff(repo: &str, sha: &str, file: &str) -> Result<String, String> {
    // `-m --first-parent`: without it a merge commit yields an empty diff.
    run_git(
        Path::new(repo),
        &[
            "show",
            "--format=",
            "--no-color",
            "-M",
            "-m",
            "--first-parent",
            "--unified=3",
            "--end-of-options",
            sha,
            "--",
            &literal_pathspec(file),
        ],
    )
}

// ---------------------------------------------------------------------------
// Working tree (uncommitted changes)
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WorkingTree {
    pub files: Vec<ChangedFile>,
    pub staged_count: u32,
    pub unstaged_count: u32,
    pub untracked_count: u32,
    pub conflicted_count: u32,
}

/// Everything not yet committed: staged, unstaged and untracked, as one list.
///
/// The diff is taken against HEAD so a staged-then-modified file appears once
/// with its total change, which is what "what have I not committed yet" means
/// to a reader. Untracked files carry no counts (there is no blob to diff)
/// and are marked `?`.
pub fn working_tree(repo: &str) -> Result<WorkingTree, String> {
    let repo_path = Path::new(repo);

    // One status pass: the counts, the untracked list, and whether HEAD exists.
    let status = parse_status_v2(&run_git(
        repo_path,
        &["status", "--porcelain=v2", "--branch", "-z", "-uall"],
    )?);

    // A repo with no commit yet has no HEAD to diff against; fall back to the
    // index so a first import still shows its files.
    let against = if status.head.is_some() { "HEAD" } else { "--cached" };
    let diff = run_git(
        repo_path,
        &["diff", "-z", "--raw", "--numstat", "-M", "--no-color", against, "--"],
    )?;
    let mut files = parse_changed_files_z(&diff);

    let untracked_count = status.untracked.len() as u32;
    for path in status.untracked {
        files.push(ChangedFile {
            path,
            old_path: None,
            status: "?".to_string(),
            additions: 0,
            deletions: 0,
            binary: false,
        });
    }

    files.sort_by(|a, b| a.path.cmp(&b.path));

    Ok(WorkingTree {
        files,
        staged_count: status.staged,
        unstaged_count: status.dirty,
        untracked_count,
        conflicted_count: status.conflicted,
    })
}

/// Diff of one uncommitted file. An untracked file has no blob to compare
/// against, so it is diffed against /dev/null to show up as all-additions.
pub fn working_tree_diff(repo: &str, file: &str, untracked: bool) -> Result<String, String> {
    let repo_path = Path::new(repo);
    if untracked {
        // --no-index exits 1 when the files differ, the expected case here,
        // but ALSO on "Could not access": a 1 without a diff is a failure.
        // Plain paths, not pathspecs.
        let output = git_output(
            repo_path,
            &["diff", "--no-index", "--no-color", "--unified=3", "--", "/dev/null", file],
        )?;
        return match output.status.code() {
            Some(0) => Ok(String::from_utf8_lossy(&output.stdout).to_string()),
            Some(1) if !output.stdout.is_empty() => {
                Ok(String::from_utf8_lossy(&output.stdout).to_string())
            }
            _ => Err(failure_message(&output)),
        };
    }

    let has_head = run_git(repo_path, &["rev-parse", "--verify", "--quiet", "HEAD"])
        .map(|out| !out.trim().is_empty())
        .unwrap_or(false);
    let pathspec = literal_pathspec(file);
    run_git(
        repo_path,
        &[
            "diff",
            "--no-color",
            "-M",
            "--unified=3",
            if has_head { "HEAD" } else { "--cached" },
            "--",
            &pathspec,
        ],
    )
}

// ---------------------------------------------------------------------------
// Pruning
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StaleBranch {
    pub name: String,
    pub sha: String,
    pub short_sha: String,
    pub upstream: Option<String>,
    pub date: String,
    pub subject: String,
    /// Why this branch is a deletion candidate.
    pub reason: String,
    /// Commits it holds that are on no other branch: deleting loses them.
    pub unmerged_commits: u32,
    /// Merging it into the base would produce no change at all.
    pub contributes_nothing: bool,
    /// Worktree holding it, if any — those cannot be deleted.
    pub worktree_path: Option<String>,
    pub is_head: bool,
}

fn rev_list_count(cwd: &Path, args: &[&str]) -> Result<u32, String> {
    let mut full = vec!["rev-list", "--count"];
    full.extend_from_slice(args);
    full.push("--");
    run_git(cwd, &full)?
        .trim()
        .parse::<u32>()
        .map_err(|e| format!("unexpected rev-list output: {e}"))
}

/// Local branches whose remote counterpart is gone, or that are fully merged.
///
/// Two distinct populations, reported with the reason so the UI never deletes
/// on a guess:
///  - `gone`: the upstream ref no longer exists (branch deleted after merge).
///  - `merged`: every commit is already contained in the given base branch.
///
/// `unmerged_commits` is the safety number: `git branch -d` refuses a branch
/// holding unmerged work, and anything above zero here means real commits
/// would need `-D` to disappear. A count git could not produce is an error,
/// never a zero: a zero is what makes a branch look safe to delete.
pub fn stale_branches(repo: &str, base: Option<&str>) -> Result<Vec<StaleBranch>, String> {
    let repo_path = Path::new(repo);
    let base_sha = base.map(|b| resolve_commit(repo_path, b)).transpose()?;
    let base_tree = base_sha.as_deref().map(|sha| tree_of(repo_path, sha)).transpose()?;

    // %(HEAD) flags the branch checked out here: never propose deleting it.
    // %(ahead-behind) (git 2.41) answers `--merged` for every branch in the
    // same pass: merged means nothing ahead of the base.
    let mut format = format!(
        "%(refname){FS}%(refname:short){FS}%(objectname){FS}%(objectname:short){FS}\
         %(upstream:short){FS}%(upstream:track){FS}%(committerdate:iso8601-strict){FS}\
         %(contents:subject){FS}%(worktreepath){FS}%(HEAD)"
    );
    if let Some(sha) = &base_sha {
        format.push_str(&format!("{FS}%(ahead-behind:{sha})"));
    }
    let raw = run_git(
        repo_path,
        &[
            "for-each-ref",
            "--sort=committerdate",
            &format!("--format={format}"),
            "refs/heads",
        ],
    )?;

    let mut candidates = Vec::new();
    for line in raw.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let f: Vec<&str> = line.split(FS).collect();
        if f.len() < 10 {
            continue;
        }
        let (_, _, gone) = parse_track(f[5]);
        let is_merged = f.get(10).and_then(|ab| parse_ahead_behind(ab)).is_some_and(|(ahead, _)| ahead == 0);

        let reason = if gone {
            "gone"
        } else if is_merged {
            "merged"
        } else {
            continue;
        };

        // A pinned branch is never a candidate, whatever git says about it.
        if matches!(f[1], "main" | "master" | "develop" | "dev") {
            continue;
        }
        candidates.push((f, reason, is_merged));
    }

    candidates
        .into_par_iter()
        .map(|(f, reason, is_merged)| {
            // How much unique work would be lost. `--not --remotes` also spares
            // a branch whose commits live on some remote even if this base
            // lacks them. Full refnames: nothing to mistake for a file.
            let unmerged = rev_list_count(
                repo_path,
                &[f[0], "--not", "--remotes", base_sha.as_deref().unwrap_or("HEAD")],
            )?;

            // Exact emptiness test, above the commit and patch heuristics. A
            // branch already contained in the base trivially changes nothing.
            let contributes_nothing = match (&base_sha, &base_tree) {
                (Some(_), Some(_)) if is_merged => true,
                (Some(sha), Some(tree)) => merge_is_noop(repo_path, sha, tree, f[0])?,
                _ => unmerged == 0,
            };

            Ok(StaleBranch {
                name: f[1].to_string(),
                contributes_nothing,
                sha: f[2].to_string(),
                short_sha: f[3].to_string(),
                upstream: if f[4].is_empty() { None } else { Some(f[4].to_string()) },
                date: f[6].to_string(),
                subject: f[7].to_string(),
                reason: reason.to_string(),
                unmerged_commits: unmerged,
                worktree_path: if f[8].is_empty() { None } else { Some(f[8].to_string()) },
                is_head: f[9] == "*",
            })
        })
        .collect()
}

/// Whether merging `rev` into the base would change anything at all.
///
/// The exact test, and the only one that survives a squashed or rebased merge
/// request: `git merge-tree --write-tree` computes the tree the merge WOULD
/// produce, and if that equals the base's own tree, the branch contributes
/// nothing — whatever its commits look like.
///
/// Both `--merged` (compares commits) and `git cherry` (compares patch ids)
/// answer "not merged" for a branch whose patch was touched on the way in —
/// rebased, squashed, or conflict-resolved — even though every line shipped.
/// Requires git 2.38+. `base_sha` and `rev` must be a sha or a full refname.
fn merge_is_noop(cwd: &Path, base_sha: &str, base_tree: &str, rev: &str) -> Result<bool, String> {
    let output = git_output(cwd, &["merge-tree", "--write-tree", base_sha, rev])?;
    match output.status.code() {
        Some(0) => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            Ok(stdout.lines().next().map(str::trim) == Some(base_tree))
        }
        // Conflicts: the branch changes lines the base changed differently,
        // so it does carry something the base lacks.
        Some(1) => Ok(false),
        _ => Err(failure_message(&output)),
    }
}

/// (contributes_nothing, unmerged_commits) for one local branch against a
/// base. Errors propagate: "could not tell" must never read as "safe".
pub fn branch_contribution(repo: &str, branch: &str, base: &str) -> Result<(bool, u32), String> {
    let repo_path = Path::new(repo);
    let base_sha = resolve_commit(repo_path, base)?;
    let base_tree = tree_of(repo_path, &base_sha)?;
    let nothing = merge_is_noop(repo_path, &base_sha, &base_tree, &format!("refs/heads/{branch}"))?;
    Ok((nothing, unmerged_commit_count(repo, branch)?))
}

/// Commits held by `branch` and by nothing else — no other local branch, no
/// remote. This is exactly what a forced delete would destroy.
pub fn unmerged_commit_count(repo: &str, branch: &str) -> Result<u32, String> {
    // Every local branch except this one, so work merged elsewhere is spared.
    // `--exclude` is a glob, but a branch name cannot hold `*`, `?` or `[`.
    rev_list_count(
        Path::new(repo),
        &[
            &format!("refs/heads/{branch}"),
            "--not",
            "--remotes",
            &format!("--exclude={branch}"),
            "--branches",
        ],
    )
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StaleRemoteBranch {
    /// Short ref as git shows it, e.g. `origin/fix/x`.
    pub name: String,
    pub remote: String,
    /// Branch name on the remote, i.e. what `push --delete` takes.
    pub branch: String,
    pub short_sha: String,
    pub date: String,
    pub subject: String,
    pub author: String,
    /// Contained in the base branch: deleting it loses nothing.
    pub merged: bool,
    /// Commits it holds that the base does not.
    pub unmerged_commits: u32,
    /// Every change it carries already exists in the base, patch-wise.
    ///
    /// This is what catches a squashed or rebased merge request: the commits
    /// differ, so `--merged` says no, yet the work IS in the base.
    pub equivalent_merged: bool,
    /// Commits whose change is in the base under no equivalent (git cherry +).
    pub unapplied_commits: u32,
    /// Merging it into the base would produce no change at all.
    pub contributes_nothing: bool,
    /// A local branch of the same name exists.
    pub has_local: bool,
}

/// Remote branches, with their merge state against a remote base.
///
/// Answers "can I delete this from the server?" — the state you cannot see
/// from a branch list. Never proposes the base itself, the remote's HEAD
/// pointer, or the usual long-lived branches.
pub fn remote_branches_state(
    repo: &str,
    base: &str,
) -> Result<Vec<StaleRemoteBranch>, String> {
    let repo_path = Path::new(repo);
    let base_sha = resolve_commit(repo_path, base)?;
    let base_tree = tree_of(repo_path, &base_sha)?;
    let remotes = list_remotes(repo_path)?;

    let locals: HashSet<String> = run_git(
        repo_path,
        &["for-each-ref", "--format=%(refname:lstrip=2)", "refs/heads"],
    )?
    .lines()
    .map(String::from)
    .collect();

    // %(ahead-behind) (git 2.41) gives every branch's unique commit count in
    // this one pass, where a rev-list per branch used to; zero ahead is
    // exactly what `branch --merged` reports.
    let format = format!(
        "%(refname){FS}%(objectname:short){FS}%(committerdate:iso8601-strict){FS}\
         %(contents:subject){FS}%(authorname){FS}%(symref){FS}%(ahead-behind:{base_sha})"
    );
    let raw = run_git(
        repo_path,
        &[
            "for-each-ref",
            "--sort=committerdate",
            &format!("--format={format}"),
            "refs/remotes",
        ],
    )?;

    let protected = ["main", "master", "develop", "dev", "staging", "HEAD"];
    let mut candidates = Vec::new();
    for line in raw.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let f: Vec<&str> = line.split(FS).collect();
        if f.len() < 7 || !f[5].is_empty() {
            continue;
        }
        let Some(name) = f[0].strip_prefix("refs/remotes/") else {
            continue;
        };
        let Some((remote, branch)) = split_remote_ref(name, &remotes) else {
            continue;
        };
        if branch.is_empty() || protected.contains(&branch) || name == base {
            continue;
        }
        let Some((unmerged, _)) = parse_ahead_behind(f[6]) else {
            return Err(format!("unexpected ahead-behind output for {name}"));
        };
        candidates.push((f, name, remote, branch, unmerged));
    }

    candidates
        .into_par_iter()
        .map(|(f, name, remote, branch, unmerged)| {
            // `git cherry` marks "+" a commit whose change has no equivalent in
            // the base, and "-" one already applied there under a different sha.
            let unapplied = if unmerged == 0 {
                0
            } else {
                run_git(repo_path, &["cherry", &base_sha, f[0]])?
                    .lines()
                    .filter(|l| l.trim_start().starts_with('+'))
                    .count() as u32
            };

            // A branch already contained in the base trivially changes nothing.
            let contributes = unmerged == 0 || merge_is_noop(repo_path, &base_sha, &base_tree, f[0])?;

            Ok(StaleRemoteBranch {
                contributes_nothing: contributes,
                remote: remote.to_string(),
                branch: branch.to_string(),
                merged: unmerged == 0,
                unmerged_commits: unmerged,
                equivalent_merged: unapplied == 0,
                unapplied_commits: unapplied,
                has_local: locals.contains(branch),
                short_sha: f[1].to_string(),
                date: f[2].to_string(),
                subject: f[3].to_string(),
                author: f[4].to_string(),
                name: name.to_string(),
            })
        })
        .collect()
}

/// Delete branches on a remote, one push per branch so one refusal (a
/// protected branch, most often) does not hide the rest.
pub fn delete_remote_branches(
    repo: &str,
    remote: &str,
    branches: &[String],
) -> Result<Vec<DeleteOutcome>, String> {
    Ok(branches
        .iter()
        .map(|branch| {
            // The full refname: a tag of the same name must not be the one deleted.
            let target = format!("refs/heads/{branch}");
            let result = network_action(
                repo,
                &["push", "--delete", "--end-of-options", remote, &target],
                PUSH_PULL_TIMEOUT,
            );
            match result {
                Ok(out) => DeleteOutcome {
                    name: branch.clone(),
                    deleted: true,
                    message: out.output,
                },
                Err(err) => DeleteOutcome {
                    name: branch.clone(),
                    deleted: false,
                    message: err,
                },
            }
        })
        .collect())
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DeleteOutcome {
    pub name: String,
    pub deleted: bool,
    pub message: String,
}

/// Delete several branches, reporting each one independently.
///
/// One failure must not hide the rest: a batch that stops at the first refusal
/// leaves the user guessing which ones went through.
pub fn delete_branches(
    repo: &str,
    names: &[String],
    force: bool,
) -> Result<Vec<DeleteOutcome>, String> {
    let repo_path = Path::new(repo);
    let flag = if force { "-D" } else { "-d" };

    Ok(names
        .iter()
        .map(|name| match run_git(repo_path, &["branch", flag, "--end-of-options", name]) {
            Ok(out) => DeleteOutcome {
                name: name.clone(),
                deleted: true,
                message: out.trim().to_string(),
            },
            Err(err) => DeleteOutcome {
                name: name.clone(),
                deleted: false,
                message: err,
            },
        })
        .collect())
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------
//
// Every ref, sha or path coming from the UI sits behind `--end-of-options`:
// a branch named `--upload-pack=…` must stay a (refused) name, not become an
// option. Trailing `--` marks it as a revision, never a file.

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ActionResult {
    pub ok: bool,
    pub output: String,
}

/// What an action reports. fetch, push and pull write their whole report
/// ("Everything up-to-date", the updated refs) to stderr, so stdout alone
/// would read as silence.
fn action_result(output: Output) -> Result<ActionResult, String> {
    if !output.status.success() {
        return Err(failure_message(&output));
    }
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let output = if stdout.is_empty() {
        String::from_utf8_lossy(&output.stderr).trim().to_string()
    } else {
        stdout
    };
    Ok(ActionResult { ok: true, output })
}

fn action(repo: &str, args: &[&str]) -> Result<ActionResult, String> {
    action_result(git_output(Path::new(repo), args)?)
}

fn network_action(repo: &str, args: &[&str], timeout: Duration) -> Result<ActionResult, String> {
    action_result(run_git_network(Path::new(repo), args, timeout)?)
}

pub fn checkout(repo: &str, branch: &str) -> Result<ActionResult, String> {
    action(repo, &["checkout", "--end-of-options", branch, "--"])
}

pub fn checkout_remote(repo: &str, local: &str, remote_ref: &str) -> Result<ActionResult, String> {
    // `-b` consumes its value, and git refuses a branch name starting with '-'.
    action(repo, &["checkout", "--track", "-b", local, "--end-of-options", remote_ref, "--"])
}

pub fn create_branch(repo: &str, name: &str, start: &str) -> Result<ActionResult, String> {
    action(repo, &["checkout", "-b", name, "--end-of-options", start, "--"])
}

pub fn merge(repo: &str, branch: &str, no_ff: bool) -> Result<ActionResult, String> {
    let mut args = vec!["merge", "--no-edit"];
    if no_ff {
        args.push("--no-ff");
    }
    args.extend(["--end-of-options", branch]);
    action(repo, &args)
}

pub fn rebase(repo: &str, onto: &str) -> Result<ActionResult, String> {
    action(repo, &["rebase", "--end-of-options", onto])
}

pub fn delete_branch(repo: &str, branch: &str, force: bool) -> Result<ActionResult, String> {
    action(repo, &["branch", if force { "-D" } else { "-d" }, "--end-of-options", branch])
}

/// Remove a linked worktree: drops its registration AND deletes its directory.
///
/// Run from the primary checkout, since the worktree being removed may be the
/// current directory. git refuses to remove the main worktree, and refuses one
/// holding uncommitted work unless forced — both are left to git rather than
/// re-implemented here, so the refusal messages stay authoritative.
/// Directories a `git worktree remove` of this session left behind, once git
/// had already dropped their registration (and possibly their `.git` file).
///
/// Nothing on disk tells them apart from any other folder by then, so the only
/// proof they were a worktree is having watched git remove it. Without this,
/// "no `.git` inside" would be enough to bin an arbitrary directory.
fn leftover_dirs() -> &'static Mutex<HashSet<PathBuf>> {
    static DIRS: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();
    DIRS.get_or_init(|| Mutex::new(HashSet::new()))
}

pub fn remove_worktree(repo: &str, path: &str, force: bool) -> Result<ActionResult, String> {
    let mut args = vec!["worktree", "remove"];
    if force {
        args.push("--force");
    }
    args.extend(["--end-of-options", path]);
    let result = action(repo, &args);
    if let Err(err) = &result {
        if err.contains("Directory not empty") {
            if let Ok(dir) = std::fs::canonicalize(path) {
                leftover_dirs().lock().unwrap().insert(dir);
            }
        }
    }
    result
}

/// Whether `target` is a directory this repo's worktrees own, and thus safe
/// to bin. Anything else is refused: this deletes a whole tree.
///
/// Accepted: a registered linked worktree (never the main one); a directory
/// whose `.git` FILE points into this repo's `worktrees/`; or a directory with
/// no `.git` at all that a failed `git worktree remove` just left behind (see
/// `leftover_dirs`) — git drops the registration and may already have deleted
/// the `.git` file before stopping.
fn owns_worktree_dir(repo: &Path, target: &Path) -> Result<bool, String> {
    let target = std::fs::canonicalize(target).map_err(|e| format!("{}: {e}", target.display()))?;

    let listing = run_git(repo, &["worktree", "list", "--porcelain", "-z"])?;
    let mut paths = listing
        .split('\0')
        .filter_map(|record| record.strip_prefix("worktree "))
        .map(|p| PathBuf::from(canonical(p)));
    // git lists the main worktree first.
    let main = paths.next().ok_or("git worktree list est vide")?;
    if target == main || main.starts_with(&target) {
        return Ok(false);
    }
    if paths.any(|p| p == target) {
        return Ok(true);
    }

    let dot_git = target.join(".git");
    if dot_git.is_file() {
        let common_dir = run_git(repo, &["rev-parse", "--path-format=absolute", "--git-common-dir"])?;
        let worktrees_dir = PathBuf::from(canonical(common_dir.trim())).join("worktrees");
        let content = std::fs::read_to_string(&dot_git).unwrap_or_default();
        let Some(gitdir) = content.trim().strip_prefix("gitdir:") else {
            return Ok(false);
        };
        // The registration itself may be gone already: compare its parent.
        let gitdir = target.join(gitdir.trim());
        return Ok(gitdir
            .parent()
            .is_some_and(|parent| PathBuf::from(canonical(&parent.to_string_lossy())) == worktrees_dir));
    }

    Ok(!dot_git.exists() && leftover_dirs().lock().unwrap().contains(&target))
}

/// Move a leftover worktree directory to the Trash, then prune registrations.
///
/// `git worktree remove` deletes the files git tracks, but leaves anything it
/// ignores — `node_modules`, a virtualenv, or just the `.DS_Store` the Finder
/// dropped in there — so its final rmdir fails with "Directory not empty".
/// The Trash rather than an outright delete: this removes a directory the user
/// may still have things in, and that must be undoable.
pub fn discard_worktree_directory(repo: &str, path: &str) -> Result<ActionResult, String> {
    let target = Path::new(path);
    if !target.exists() {
        return prune_worktrees(repo);
    }
    if !target.is_dir() {
        return Err(format!("{path} n'est pas un dossier"));
    }
    if target.parent().is_none() || !owns_worktree_dir(Path::new(repo), target)? {
        return Err(format!("Refusé : {path} n'est pas un worktree de ce dépôt"));
    }

    // Finder's own delete puts it in the Trash, recoverable, with no extra
    // dependency to install.
    let script = format!(
        "tell application \"Finder\" to delete POSIX file \"{}\"",
        path.replace('\\', "\\\\").replace('"', "\\\"")
    );
    let output = Command::new("osascript")
        .args(["-e", &script])
        .output()
        .map_err(|e| format!("failed to run osascript: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "could not move {path} to the Trash: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }

    let pruned = prune_worktrees(repo)?;
    Ok(ActionResult {
        ok: true,
        output: format!("Dossier placé dans la corbeille. {}", pruned.output).trim().to_string(),
    })
}

/// Drop registrations of worktrees whose directory no longer exists.
pub fn prune_worktrees(repo: &str) -> Result<ActionResult, String> {
    action(repo, &["worktree", "prune"])
}

pub fn fetch(repo: &str, prune: bool) -> Result<ActionResult, String> {
    let mut args = vec!["fetch", "--all"];
    if prune {
        args.push("--prune");
    }
    network_action(repo, &args, FETCH_TIMEOUT)
}

/// Push the current branch.
///
/// `set_upstream` publishes a branch that has none yet (`push -u <remote>
/// HEAD`), which is the case where a plain `git push` fails with a hint
/// instead of doing the obvious thing. The remote is the branch's configured
/// one, else the only remote there is, else `origin`.
pub fn push(repo: &str, set_upstream: bool) -> Result<ActionResult, String> {
    if !set_upstream {
        return network_action(repo, &["push"], PUSH_PULL_TIMEOUT);
    }
    let repo_path = Path::new(repo);
    let remotes = list_remotes(repo_path)?;
    let remote = current_branch_remote(repo_path)
        .filter(|r| remotes.contains(r))
        .or_else(|| (remotes.len() == 1).then(|| remotes[0].clone()))
        .unwrap_or_else(|| "origin".to_string());
    network_action(
        repo,
        &["push", "--set-upstream", "--end-of-options", &remote, "HEAD"],
        PUSH_PULL_TIMEOUT,
    )
}

/// When this repo last fetched, as a Unix timestamp in seconds.
///
/// Read from the mtime of `FETCH_HEAD` in the SHARED git dir, which git
/// rewrites on every fetch — including a fetch that brought nothing new, which
/// is exactly the case you want dated. Absent before the first fetch.
pub fn last_fetch(repo: &str) -> Result<Option<u64>, String> {
    let common_dir = run_git(
        Path::new(repo),
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
    )?;
    let path = Path::new(common_dir.trim()).join("FETCH_HEAD");

    match std::fs::metadata(&path) {
        Ok(meta) => {
            let modified = meta
                .modified()
                .map_err(|e| format!("no mtime on {}: {e}", path.display()))?;
            let secs = modified
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(|e| format!("bad mtime: {e}"))?
                .as_secs();
            Ok(Some(secs))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("cannot read {}: {e}", path.display())),
    }
}

/// How `pull` reconciles a branch that has diverged from its upstream.
///
/// `--ff-only` alone dead-ends as soon as there is something to push AND
/// something to pull: git refuses, and the push is refused too until the pull
/// happens. Rebase and merge are the two ways out; `--autostash` keeps a dirty
/// tree from blocking either.
pub fn pull(repo: &str, mode: &str) -> Result<ActionResult, String> {
    let args: &[&str] = match mode {
        "ff-only" => &["pull", "--ff-only"],
        "merge" => &["pull", "--no-rebase", "--autostash"],
        "rebase" => &["pull", "--rebase", "--autostash"],
        other => return Err(format!("unknown pull mode: {other}")),
    };
    network_action(repo, args, PUSH_PULL_TIMEOUT)
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FetchOutcome {
    pub repo: String,
    pub ok: bool,
    pub output: String,
}

/// fetch_many's own small pool. On rayon's global pool, a dozen fetches
/// waiting on the network would hold every worker, and the next workspace
/// scan would queue behind them.
fn fetch_pool() -> &'static rayon::ThreadPool {
    static POOL: OnceLock<rayon::ThreadPool> = OnceLock::new();
    POOL.get_or_init(|| {
        rayon::ThreadPoolBuilder::new()
            .num_threads(4)
            .thread_name(|i| format!("gitflo-fetch-{i}"))
            .build()
            .expect("failed to build the fetch thread pool")
    })
}

/// Fetch several repositories at once, for the background auto-fetch.
///
/// Never fails as a whole: one unreachable remote must not hide the others.
pub fn fetch_many(repos: &[String]) -> Vec<FetchOutcome> {
    fetch_pool().install(|| {
        repos
            .par_iter()
            .map(|repo| match fetch(repo, true) {
                Ok(result) => FetchOutcome {
                    repo: repo.clone(),
                    ok: true,
                    output: result.output,
                },
                Err(err) => FetchOutcome {
                    repo: repo.clone(),
                    ok: false,
                    output: err,
                },
            })
            .collect()
    })
}

// ---------------------------------------------------------------------------
// Remote web page
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteWeb {
    /// e.g. `https://github.com/owner/repo`, no trailing slash.
    pub base: String,
    /// "github", "gitlab", "bitbucket" or "other".
    pub kind: String,
}

/// Web page of a remote. Default remote: the one the current branch tracks,
/// else `origin`, else the first. None when the URL has no web equivalent.
pub fn remote_web_url(repo: &str, remote: Option<&str>) -> Result<Option<RemoteWeb>, String> {
    let repo_path = Path::new(repo);
    let remote = match remote {
        Some(remote) => remote.to_string(),
        None => {
            let remotes = list_remotes(repo_path)?;
            let chosen = current_branch_remote(repo_path)
                .filter(|r| remotes.contains(r))
                .or_else(|| remotes.iter().find(|r| *r == "origin").cloned())
                .or_else(|| remotes.first().cloned());
            match chosen {
                Some(remote) => remote,
                None => return Ok(None),
            }
        }
    };
    let url = run_git(repo_path, &["remote", "get-url", "--end-of-options", &remote])?;
    Ok(web_base_from_remote_url(url.trim()))
}

/// Convert a clone URL into the https address of its web page.
///
/// Handles scp-like (`git@host:owner/repo.git`), `ssh://`, `git://` and
/// `http(s)://` URLs, any depth of path (GitLab subgroups). Credentials are
/// dropped — a token in a clone URL must never end up in a link — and so is
/// an ssh port, which says nothing about where the web server listens.
fn web_base_from_remote_url(url: &str) -> Option<RemoteWeb> {
    let (web_scheme, host, path) = match url.split_once("://") {
        Some((scheme, rest)) => {
            let scheme = scheme.to_ascii_lowercase();
            let web_scheme = match scheme.as_str() {
                "https" => "https",
                "http" => "http",
                "ssh" | "git" | "git+ssh" | "ssh+git" => "https",
                _ => return None,
            };
            let (authority, path) = rest.split_once('/')?;
            let host = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
            let host = if scheme.starts_with("http") {
                host
            } else {
                match host.rsplit_once(':') {
                    Some((h, port)) if port.chars().all(|c| c.is_ascii_digit()) => h,
                    _ => host,
                }
            };
            (web_scheme, host, path)
        }
        None => {
            // scp-like: a colon before any slash; anything else is a local path.
            let (authority, path) = url.split_once(':')?;
            if authority.contains('/') {
                return None;
            }
            let host = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
            ("https", host, path)
        }
    };
    if host.is_empty() {
        return None;
    }

    let path = path.trim_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path).trim_end_matches('/');
    // owner/repo at the least; a lone segment is no hosted project page.
    if path.split('/').filter(|s| !s.is_empty()).count() < 2 || path.contains("//") {
        return None;
    }

    let lower = host.to_ascii_lowercase();
    let kind = ["github", "gitlab", "bitbucket"]
        .into_iter()
        .find(|k| lower.contains(k))
        .unwrap_or("other");
    Some(RemoteWeb {
        base: format!("{web_scheme}://{host}/{path}"),
        kind: kind.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_status_v2_branch_headers() {
        let raw = [
            "# branch.oid 6454e405aaaa1111bbbb",
            "# branch.head feature/login",
            "# branch.upstream origin/feature/login",
            "# branch.ab +3 -2",
            "1 .M N... 100644 100644 100644 aaa bbb lib/foo.py",
            "1 M. N... 100644 100644 100644 aaa bbb lib/bar.py",
            "1 MM N... 100644 100644 100644 aaa bbb lib/baz.py",
            // A rename carries its source as one more NUL field: not a record.
            "2 R. N... 100644 100644 100644 aaa bbb R100 lib/new.py",
            "? looks like a record.py",
            "u UU N... 100644 100644 100644 100644 aaa bbb ccc conflicted.py",
            "? untracked.txt",
            "? caf\u{e9} \"quoted\"\tname.txt",
            "",
        ]
        .join("\0");
        let s = parse_status_v2(&raw);
        assert_eq!(s.branch.as_deref(), Some("feature/login"));
        assert_eq!(s.head.as_deref(), Some("6454e405a"));
        assert_eq!(s.upstream.as_deref(), Some("origin/feature/login"));
        assert_eq!((s.ahead, s.behind), (3, 2));
        // baz.py counts in both columns, foo.py only unstaged, bar.py and the
        // rename only staged.
        assert_eq!(s.dirty, 2);
        assert_eq!(s.staged, 3);
        assert_eq!(s.conflicted, 1);
        assert_eq!(s.untracked, vec!["untracked.txt", "caf\u{e9} \"quoted\"\tname.txt"]);
    }

    #[test]
    fn detached_head_yields_no_branch() {
        let s = parse_status_v2("# branch.oid abc123def\0# branch.head (detached)\0");
        assert!(s.branch.is_none());
        assert_eq!(s.head.as_deref(), Some("abc123def"));
    }

    #[test]
    fn empty_repo_has_no_head() {
        let s = parse_status_v2("# branch.oid (initial)\0# branch.head main\0");
        assert!(s.head.is_none());
    }

    #[test]
    fn parses_renames_and_odd_paths_from_z_output() {
        // What `git show -z --raw --numstat` prints for a directory rename, a
        // non-ASCII name, a tab in a name and a binary file.
        let raw = [
            ":100644 100644 aaa bbb R079",
            "src/a/f.rs",
            "src/b/f.rs",
            ":100644 100644 ccc ddd M",
            "caf\u{e9}.txt",
            ":000000 100644 000 eee A",
            "tab\tname.txt",
            ":100644 100644 fff 111 M",
            "logo.png",
            "1\t0\t",
            "src/a/f.rs",
            "src/b/f.rs",
            "1\t0\tcaf\u{e9}.txt",
            "2\t0\ttab\tname.txt",
            "-\t-\tlogo.png",
            "",
        ]
        .join("\0");
        let files = parse_changed_files_z(&raw);
        assert_eq!(files.len(), 4);

        assert_eq!(files[0].path, "src/b/f.rs");
        assert_eq!(files[0].old_path.as_deref(), Some("src/a/f.rs"));
        assert_eq!(files[0].status, "R079");
        assert_eq!((files[0].additions, files[0].deletions), (1, 0));

        assert_eq!(files[1].path, "caf\u{e9}.txt");
        assert_eq!((files[1].status.as_str(), files[1].additions), ("M", 1));

        assert_eq!(files[2].path, "tab\tname.txt");
        assert_eq!((files[2].status.as_str(), files[2].additions), ("A", 2));

        assert!(files[3].binary);
        assert_eq!(files[3].old_path, None);
    }

    #[test]
    fn splits_remote_refs_on_the_longest_known_remote() {
        let remotes = vec!["origin".to_string(), "team/origin".to_string(), "team".to_string()];
        assert_eq!(split_remote_ref("origin/fix/x", &remotes), Some(("origin", "fix/x")));
        assert_eq!(split_remote_ref("team/origin/main", &remotes), Some(("team/origin", "main")));
        assert_eq!(split_remote_ref("team/feature", &remotes), Some(("team", "feature")));
        // A ref left by a removed remote still splits somewhere sensible.
        assert_eq!(split_remote_ref("gone/feature", &remotes), Some(("gone", "feature")));
        // A remote name that is only a prefix of a longer word does not match.
        assert_eq!(split_remote_ref("origins/x", &remotes), Some(("origins", "x")));
    }

    #[test]
    fn parses_ahead_behind() {
        assert_eq!(parse_ahead_behind("3 0"), Some((3, 0)));
        assert_eq!(parse_ahead_behind(""), None);
    }

    #[test]
    fn converts_remote_urls_to_web_pages() {
        let web = |url: &str| web_base_from_remote_url(url).map(|w| (w.base, w.kind));
        let some = |base: &str, kind: &str| Some((base.to_string(), kind.to_string()));

        assert_eq!(web("git@github.com:owner/repo.git"), some("https://github.com/owner/repo", "github"));
        assert_eq!(web("https://github.com/owner/repo"), some("https://github.com/owner/repo", "github"));
        assert_eq!(web("https://github.com/owner/repo.git/"), some("https://github.com/owner/repo", "github"));
        assert_eq!(
            web("ssh://git@gitlab.example.com:2222/group/sub/repo.git"),
            some("https://gitlab.example.com/group/sub/repo", "gitlab")
        );
        assert_eq!(
            web("git@gitlab.com:group/sub/repo.git"),
            some("https://gitlab.com/group/sub/repo", "gitlab")
        );
        // Credentials never survive into the link.
        assert_eq!(
            web("https://user:s3cret@bitbucket.org/team/repo.git"),
            some("https://bitbucket.org/team/repo", "bitbucket")
        );
        assert_eq!(web("https://jdoe@git.corp.io:8443/a/b"), some("https://git.corp.io:8443/a/b", "other"));
        assert_eq!(web("http://git.lan/a/b.git"), some("http://git.lan/a/b", "other"));
        assert_eq!(web("ssh://git@github.com/owner/repo"), some("https://github.com/owner/repo", "github"));

        assert_eq!(web("/Users/me/repos/thing.git"), None);
        assert_eq!(web("../sibling"), None);
        assert_eq!(web("file:///srv/repo.git"), None);
        assert_eq!(web("https://example.com/lonely"), None);
        assert_eq!(web(""), None);
    }

    #[test]
    fn parses_upstream_track_shapes() {
        assert_eq!(parse_track(""), (0, 0, false));
        assert_eq!(parse_track("[ahead 2]"), (2, 0, false));
        assert_eq!(parse_track("[behind 5]"), (0, 5, false));
        assert_eq!(parse_track("[ahead 2, behind 1]"), (2, 1, false));
        assert_eq!(parse_track("[gone]"), (0, 0, true));
    }

    /// Builds a throwaway repo full of awkward names (a renamed directory, an
    /// accented file, a glob character, a branch named like a file, a remote
    /// with a slash) and runs the real commands on it.
    /// `GITFLO_SCRATCH=/some/dir cargo test scratch_repo -- --ignored`
    #[test]
    #[ignore = "writes a scratch repository"]
    fn scratch_repo_end_to_end() {
        let root = PathBuf::from(std::env::var("GITFLO_SCRATCH").unwrap_or_else(|_| {
            std::env::temp_dir().to_string_lossy().to_string()
        }))
        .join("gitflo-e2e");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let root = std::fs::canonicalize(&root).unwrap();
        let repo_path = root.join("modules").join("repo");
        std::fs::create_dir_all(&repo_path).unwrap();
        let repo = repo_path.to_str().unwrap();
        let git = |args: &[&str]| {
            let mut full = vec!["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"];
            full.extend_from_slice(args);
            run_git(&repo_path, &full).unwrap_or_else(|e| panic!("git {args:?}: {e}"))
        };
        let write = |name: &str, content: &str| {
            let path = repo_path.join(name);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, content).unwrap();
        };

        git(&["init", "-q", "-b", "main"]);
        write("src/a/f.rs", "one\ntwo\nthree\nfour\n");
        write("caf\u{e9}.txt", "x\n");
        write("a*.txt", "star\n");
        write("ab.txt", "plain\n");
        git(&["add", "."]);
        git(&["commit", "-qm", "init"]);
        git(&["mv", "src/a", "src/b"]);
        write("src/b/f.rs", "one\ntwo\nthree\nfour\nfive\n");
        write("caf\u{e9}.txt", "x\ny\n");
        git(&["commit", "-qam", "rename"]);

        // Renames and non-ASCII names come back whole, and diff by their path.
        let detail = commit_detail(repo, "HEAD").unwrap();
        let renamed = detail.files.iter().find(|f| f.status.starts_with('R')).expect("no rename");
        assert_eq!(renamed.path, "src/b/f.rs");
        assert_eq!(renamed.old_path.as_deref(), Some("src/a/f.rs"));
        assert_eq!(renamed.additions, 1);
        assert!(detail.files.iter().any(|f| f.path == "caf\u{e9}.txt"));
        for f in &detail.files {
            assert!(!file_diff(repo, &detail.sha, &f.path).unwrap().is_empty(), "{}", f.path);
        }

        // A branch named exactly like a file is still just a branch.
        git(&["branch", "caf\u{e9}.txt", "HEAD~1"]);
        assert_eq!(list_commits(repo, &["caf\u{e9}.txt".into()], 10, 0).unwrap().len(), 1);
        assert!(list_commits(repo, &["--all".into()], 10, 0).is_err());
        assert_eq!(list_commits(repo, &[], 10, 0).unwrap().len(), 2);
        let (nothing, unique) = branch_contribution(repo, "caf\u{e9}.txt", "main").unwrap();
        assert!(nothing);
        assert_eq!(unique, 0);
        assert!(branch_contribution(repo, "no-such-branch", "main").is_err());
        let stale = stale_branches(repo, Some("main")).unwrap();
        assert_eq!(stale.len(), 1);
        assert!(stale[0].contributes_nothing && stale[0].reason == "merged");
        checkout(repo, "caf\u{e9}.txt").unwrap();
        checkout(repo, "main").unwrap();
        assert!(checkout(repo, "--orphan=x").is_err());

        // A branch with unique work is never reported as contributing nothing.
        git(&["checkout", "-q", "-b", "feature"]);
        write("feature.txt", "new\n");
        git(&["add", "."]);
        git(&["commit", "-qm", "feature"]);
        git(&["checkout", "-q", "main"]);
        assert_eq!(branch_contribution(repo, "feature", "main").unwrap(), (false, 1));

        // Uncommitted: a staged rename, odd names, a glob character.
        git(&["mv", "ab.txt", "ab-renamed.txt"]);
        write("a*.txt", "star\nchanged\n");
        write("caf\u{e9}.txt", "x\ny\nz\n");
        write("new \"q\"\tfile.txt", "hello\n");
        let wt = working_tree(repo).unwrap();
        let paths: Vec<&str> = wt.files.iter().map(|f| f.path.as_str()).collect();
        println!("{paths:?}");
        assert!(paths.contains(&"caf\u{e9}.txt"));
        assert!(paths.contains(&"new \"q\"\tfile.txt"));
        let moved = wt.files.iter().find(|f| f.path == "ab-renamed.txt").expect("rename");
        assert_eq!(moved.old_path.as_deref(), Some("ab.txt"));
        assert_eq!(wt.untracked_count, 1);
        for f in &wt.files {
            let diff = working_tree_diff(repo, &f.path, f.status == "?").unwrap();
            assert!(!diff.is_empty(), "empty diff for {}", f.path);
        }
        // `a*.txt` is a literal name, not a pattern also matching others.
        let star = working_tree_diff(repo, "a*.txt", false).unwrap();
        assert_eq!(star.matches("diff --git").count(), 1, "{star}");
        assert!(working_tree_diff(repo, "missing.txt", true).is_err());
        git(&["reset", "-q", "--hard"]);
        std::fs::remove_file(repo_path.join("new \"q\"\tfile.txt")).unwrap();

        // A remote whose name holds a slash.
        let bare = root.join("remote.git");
        run_git(&root, &["init", "-q", "--bare", bare.to_str().unwrap()]).unwrap();
        git(&["remote", "add", "team/origin", bare.to_str().unwrap()]);
        git(&["push", "-q", "team/origin", "main", "feature", "caf\u{e9}.txt"]);
        fetch(repo, true).unwrap();
        let branches = list_branches(repo).unwrap();
        let remote_feature = branches.iter().find(|b| b.refname == "refs/remotes/team/origin/feature").unwrap();
        assert_eq!(remote_feature.remote.as_deref(), Some("team/origin"));
        let state = remote_branches_state(repo, "team/origin/main").unwrap();
        let feature = state.iter().find(|b| b.branch == "feature").unwrap();
        assert_eq!((feature.remote.as_str(), feature.unmerged_commits, feature.merged), ("team/origin", 1, false));
        assert!(!feature.contributes_nothing && feature.has_local);
        let cafe = state.iter().find(|b| b.branch == "caf\u{e9}.txt").unwrap();
        assert!(cafe.merged && cafe.contributes_nothing);
        let deleted = delete_remote_branches(repo, "team/origin", &["caf\u{e9}.txt".into()]).unwrap();
        assert!(deleted[0].deleted, "{}", deleted[0].message);

        // `push -u` picks the only remote there is, not a hardcoded origin.
        git(&["checkout", "-q", "-b", "publish-me"]);
        let pushed = push(repo, true).unwrap();
        assert!(!pushed.output.is_empty(), "push reported nothing");
        assert_eq!(git(&["config", "branch.publish-me.remote"]).trim(), "team/origin");
        git(&["checkout", "-q", "main"]);

        git(&["remote", "set-url", "team/origin", "git@github.com:me/thing.git"]);
        let web = remote_web_url(repo, None).unwrap().unwrap();
        assert_eq!(web.base, "https://github.com/me/thing");

        // Worktrees: one under a `modules` directory is not a submodule; only
        // directories this repo's worktrees own may be binned.
        let linked = root.join("modules").join("linked");
        git(&["worktree", "add", "-q", linked.to_str().unwrap(), "feature"]);
        assert!(matches!(classify_git_entry(&linked), GitEntry::Repo));
        assert!(owns_worktree_dir(&repo_path, &linked).unwrap());
        assert!(!owns_worktree_dir(&repo_path, &repo_path).unwrap());
        assert!(!owns_worktree_dir(&repo_path, &root).unwrap());
        let other = root.join("other");
        run_git(&root, &["init", "-q", other.to_str().unwrap()]).unwrap();
        assert!(!owns_worktree_dir(&repo_path, &other).unwrap());
        // Leftover after the registration is gone, `.git` file still there.
        std::fs::remove_dir_all(repo_path.join(".git/worktrees/linked")).unwrap();
        assert!(owns_worktree_dir(&repo_path, &linked).unwrap());

        // A remote that never answers is killed at the deadline, and a
        // configured core.sshCommand is honoured rather than overridden.
        git(&["config", "core.sshCommand", "sleep 30 #"]);
        let started = Instant::now();
        let err = run_git_network(&repo_path, &["fetch", "ssh://nowhere.invalid/x"], Duration::from_secs(1))
            .unwrap_err();
        assert!(err.contains("Délai dépassé"), "{err}");
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    /// End-to-end read of a real repo: branches, commits, one detail.
    /// `cargo test -- --ignored --nocapture`
    #[test]
    #[ignore = "depends on the local filesystem"]
    fn reads_branches_and_commits() {
        let roots = default_roots();
        let groups = scan_workspace(&roots, 4);
        // Prefer a repo with several worktrees: the interesting case.
        let group = groups
            .iter()
            .max_by_key(|g| g.worktrees.len())
            .expect("no repo found");
        let repo = &group.primary_path;
        println!("repo: {repo}");

        let branches = list_branches(repo).expect("list_branches failed");
        let locals = branches.iter().filter(|b| b.kind == "local").count();
        let remotes = branches.iter().filter(|b| b.kind == "remote").count();
        println!("branches: {locals} local / {remotes} remote");
        for b in branches.iter().take(6) {
            println!(
                "   [{}] {:<48} head:{} wt:{:?} +{} -{}",
                b.kind, b.short, b.is_head, b.worktree_path, b.ahead, b.behind
            );
        }
        assert!(locals > 0, "expected at least one local branch");
        assert!(
            branches.iter().any(|b| b.is_head),
            "no branch flagged as HEAD"
        );
        assert!(
            branches.iter().any(|b| b.worktree_path.is_some()),
            "expected at least one branch held by a worktree"
        );

        let commits = list_commits(repo, &[], 40, 0).expect("list_commits failed");
        println!("commits: {}", commits.len());
        assert_eq!(commits.len(), 40, "expected a full page of commits");
        let merges = commits.iter().filter(|c| c.parents.len() > 1).count();
        let decorated = commits.iter().filter(|c| !c.refs.is_empty()).count();
        println!("   {merges} merges, {decorated} decorated");
        for c in commits.iter().take(4) {
            println!("   {} {:<58} refs:{:?}", c.short_sha, c.subject, c.refs);
        }
        // Every parent listed must be a real sha, never an empty field.
        for c in &commits {
            for p in &c.parents {
                assert_eq!(p.len(), 40, "bad parent sha {p:?} on {}", c.short_sha);
            }
        }

        let detail = commit_detail(repo, &commits[0].sha).expect("commit_detail failed");
        println!(
            "detail {}: {} file(s), committer {}",
            detail.short_sha,
            detail.files.len(),
            detail.committer
        );
        for f in detail.files.iter().take(5) {
            println!("   {} {} +{} -{}", f.status, f.path, f.additions, f.deletions);
        }
        assert_eq!(detail.sha, commits[0].sha);

        if let Some(file) = detail.files.first() {
            let diff = file_diff(repo, &detail.sha, &file.path).expect("file_diff failed");
            println!("diff of {} -> {} bytes", file.path, diff.len());
            assert!(!diff.is_empty() || file.binary);
        }
    }

    /// Reads the uncommitted changes of whichever local checkout is dirtiest.
    /// `cargo test -- --ignored --nocapture`
    #[test]
    #[ignore = "depends on the local filesystem"]
    fn reads_working_tree() {
        let groups = scan_workspace(&default_roots(), 4);
        let dirtiest = groups
            .iter()
            .flat_map(|g| g.worktrees.iter())
            .max_by_key(|w| w.dirty_files + w.staged_files + w.untracked_files)
            .expect("no worktree found");
        println!(
            "{} — dirty:{} staged:{} untracked:{}",
            dirtiest.name, dirtiest.dirty_files, dirtiest.staged_files, dirtiest.untracked_files
        );
        if dirtiest.dirty_files + dirtiest.staged_files + dirtiest.untracked_files == 0 {
            println!("nothing uncommitted anywhere; skipping assertions");
            return;
        }

        let wt = working_tree(&dirtiest.path).expect("working_tree failed");
        println!(
            "{} file(s) — staged:{} unstaged:{} untracked:{} conflicted:{}",
            wt.files.len(),
            wt.staged_count,
            wt.unstaged_count,
            wt.untracked_count,
            wt.conflicted_count
        );
        for f in wt.files.iter().take(8) {
            println!("   {} {} +{} -{}", f.status, f.path, f.additions, f.deletions);
        }
        assert!(!wt.files.is_empty(), "dirty worktree reported no file");

        // Every listed file must produce a readable diff (or be untracked-empty).
        for f in wt.files.iter().take(5) {
            let untracked = f.status == "?";
            let diff = working_tree_diff(&dirtiest.path, &f.path, untracked)
                .unwrap_or_else(|e| panic!("diff failed for {}: {e}", f.path));
            println!("   diff {} -> {} bytes (untracked={untracked})", f.path, diff.len());
            if !f.binary && !untracked {
                assert!(!diff.is_empty(), "empty diff for tracked change {}", f.path);
            }
        }
    }

    /// Lists deletion candidates on the local repos. Read-only.
    /// `cargo test -- --ignored --nocapture`
    #[test]
    #[ignore = "depends on the local filesystem"]
    fn finds_stale_branches() {
        let groups = scan_workspace(&default_roots(), 4);
        let mut total = 0;
        for group in groups.iter().take(12) {
            let base = ["develop", "main", "master"]
                .iter()
                .find(|b| {
                    run_git(
                        Path::new(&group.primary_path),
                        &["rev-parse", "--verify", "--quiet", b],
                    )
                    .map(|o| !o.trim().is_empty())
                    .unwrap_or(false)
                })
                .copied();

            let stale = stale_branches(&group.primary_path, base).unwrap_or_default();
            if stale.is_empty() {
                continue;
            }
            println!("{} (base {:?}) — {} candidate(s)", group.name, base, stale.len());
            for b in stale.iter().take(10) {
                println!(
                    "   {:<58} {:<7} unmerged:{} apporte-rien:{}",
                    b.name, b.reason, b.unmerged_commits, b.contributes_nothing
                );
                // The trunk must never be proposed for deletion.
                assert!(!matches!(b.name.as_str(), "main" | "master" | "develop"));
            }
            total += stale.len();
        }
        println!("total candidates: {total}");
    }

    /// Counts what a forced delete of a real branch would destroy. Read-only.
    /// `cargo test -- --ignored --nocapture`
    #[test]
    #[ignore = "depends on the local filesystem"]
    fn counts_unmerged_commits() {
        let groups = scan_workspace(&default_roots(), 4);
        // Whichever local repo has the most branches: the interesting one.
        let repo = groups
            .iter()
            .max_by_key(|g| list_branches(&g.primary_path).map(|b| b.len()).unwrap_or(0))
            .map(|g| g.primary_path.clone())
            .expect("no repo found");

        let branches = list_branches(&repo).expect("list_branches");
        let mut checked = 0;
        for branch in branches.iter().filter(|b| b.kind == "local").take(12) {
            let count = unmerged_commit_count(&repo, &branch.short)
                .unwrap_or_else(|e| panic!("count failed for {}: {e}", branch.short));
            println!("{:<58} unique:{count}", branch.short);
            checked += 1;
        }
        assert!(checked > 0);

        // A branch that is an ancestor of another can hold nothing unique.
        let merged_somewhere = branches
            .iter()
            .find(|b| b.kind == "local" && b.short == "master");
        if let Some(b) = merged_somewhere {
            let count = unmerged_commit_count(&repo, &b.short).unwrap();
            println!("master unique: {count}");
        }
    }

    /// Merge state of the remote branches of the largest local repo. Read-only.
    /// `cargo test -- --ignored --nocapture`
    #[test]
    #[ignore = "depends on the local filesystem"]
    fn reports_remote_branch_state() {
        let groups = scan_workspace(&default_roots(), 4);
        let repo = groups
            .iter()
            .max_by_key(|g| list_branches(&g.primary_path).map(|b| b.len()).unwrap_or(0))
            .map(|g| g.primary_path.clone())
            .expect("no repo found");

        // Whichever integration branch this repo uses.
        let base = ["origin/develop", "origin/main", "origin/master"]
            .iter()
            .find(|b| {
                run_git(Path::new(&repo), &["rev-parse", "--verify", "--quiet", b])
                    .map(|o| !o.trim().is_empty())
                    .unwrap_or(false)
            })
            .copied()
            .expect("no remote base branch");

        let state = remote_branches_state(&repo, base).expect("state");
        let merged = state.iter().filter(|b| b.merged).count();
        println!(
            "{} remote branches — {merged} merged into {base}, {} not",
            state.len(),
            state.len() - merged
        );
        for b in state.iter().filter(|b| b.merged).take(8) {
            println!("   MERGED   {:<58} unique:{}", b.branch, b.unmerged_commits);
        }
        let empty = state.iter().filter(|b| b.contributes_nothing).count();
        println!("   {empty} n'apportent RIEN à la base (merge-tree)");
        let equivalent = state
            .iter()
            .filter(|b| !b.merged && b.equivalent_merged)
            .count();
        println!("   dont {equivalent} déjà appliquées (squash/rebase)");
        for b in state.iter().filter(|b| !b.merged && b.equivalent_merged).take(8) {
            println!("   APPLIED  {:<58} unique:{}", b.branch, b.unmerged_commits);
        }
        for b in state.iter().filter(|b| !b.equivalent_merged).take(8) {
            println!(
                "   REAL     {:<58} unapplied:{}",
                b.branch, b.unapplied_commits
            );
        }
        // A merged branch cannot hold commits the base lacks.
        for b in state.iter().filter(|b| b.merged) {
            assert_eq!(b.unmerged_commits, 0, "{} merged but unique>0", b.branch);
        }
        assert!(!state.is_empty());
    }

    /// Sanity check against the real machine. Run explicitly:
    /// `cargo test -- --ignored --nocapture`
    #[test]
    #[ignore = "depends on the local filesystem"]
    fn scans_local_workspace() {
        let roots = default_roots();
        assert!(!roots.is_empty(), "no candidate root under $HOME");
        let groups = scan_workspace(&roots, 3);
        println!("{} repos found across {:?}", groups.len(), roots);
        for group in groups.iter().take(40) {
            println!(
                "  {} ({} worktree(s)) -> {}",
                group.name,
                group.worktrees.len(),
                group.primary_path
            );
            for wt in &group.worktrees {
                println!(
                    "      {:<42} {:<38} +{} -{} dirty:{}{}",
                    wt.name,
                    wt.branch.clone().unwrap_or_else(|| "(detached)".into()),
                    wt.ahead,
                    wt.behind,
                    wt.dirty_files + wt.staged_files + wt.untracked_files,
                    if wt.is_primary { " [primary]" } else { "" }
                );
            }
        }
        assert!(!groups.is_empty());
    }
}
