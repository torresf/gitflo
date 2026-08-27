use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;

use rayon::prelude::*;
use serde::{Deserialize, Serialize};

/// Field separator used inside a single git output record (ASCII US).
const FS: char = '\x1f';
/// Record separator used between git log entries (ASCII RS).
///
/// Deliberately NOT NUL: `Command::arg` rejects a NUL byte outright (args are
/// C strings), so a `%x00` separator would fail the spawn, not the parse.
const RS: char = '\x1e';

fn run_git(cwd: &Path, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(cwd)
        // Never let git try to open an interactive prompt: a hung askpass
        // would freeze the whole app with no visible cause.
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .output()
        .map_err(|e| format!("failed to spawn git: {e}"))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        Err(if stderr.is_empty() { stdout } else { stderr })
    }
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

/// Parsed shape of `git status --porcelain=v2 --branch`.
struct StatusSummary {
    branch: Option<String>,
    head: Option<String>,
    upstream: Option<String>,
    ahead: u32,
    behind: u32,
    dirty: u32,
    staged: u32,
    untracked: u32,
    conflicted: u32,
}

fn parse_status_v2(raw: &str) -> StatusSummary {
    let mut s = StatusSummary {
        branch: None,
        head: None,
        upstream: None,
        ahead: 0,
        behind: 0,
        dirty: 0,
        staged: 0,
        untracked: 0,
        conflicted: 0,
    };

    for line in raw.lines() {
        if let Some(rest) = line.strip_prefix("# branch.head ") {
            // git writes the literal "(detached)" when HEAD points at no branch.
            s.branch = if rest == "(detached)" {
                None
            } else {
                Some(rest.to_string())
            };
        } else if let Some(rest) = line.strip_prefix("# branch.oid ") {
            s.head = if rest == "(initial)" {
                None
            } else {
                Some(rest.chars().take(9).collect())
            };
        } else if let Some(rest) = line.strip_prefix("# branch.upstream ") {
            s.upstream = Some(rest.to_string());
        } else if let Some(rest) = line.strip_prefix("# branch.ab ") {
            for token in rest.split_whitespace() {
                let value: u32 = token[1..].parse().unwrap_or(0);
                match token.chars().next() {
                    Some('+') => s.ahead = value,
                    Some('-') => s.behind = value,
                    _ => {}
                }
            }
        } else if let Some(rest) = line.strip_prefix("1 ").or_else(|| line.strip_prefix("2 ")) {
            // "<XY> <sub> ..." — X is the staged status, Y the worktree status.
            let xy: Vec<char> = rest.chars().take(2).collect();
            if xy.first().is_some_and(|c| *c != '.') {
                s.staged += 1;
            }
            if xy.get(1).is_some_and(|c| *c != '.') {
                s.dirty += 1;
            }
        } else if line.starts_with("u ") {
            s.conflicted += 1;
        } else if line.starts_with("? ") {
            s.untracked += 1;
        }
    }

    s
}

fn dir_name(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string_lossy().to_string())
}

/// Read one checkout: its shared git dir (for grouping) and its status.
fn read_checkout(path: &Path) -> Option<(String, Worktree)> {
    let common_dir = run_git(path, &["rev-parse", "--path-format=absolute", "--git-common-dir"])
        .ok()?
        .trim()
        .to_string();
    if common_dir.is_empty() {
        return None;
    }
    let common_dir = std::fs::canonicalize(&common_dir)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or(common_dir);

    let own_git_dir = run_git(path, &["rev-parse", "--path-format=absolute", "--git-dir"])
        .ok()?
        .trim()
        .to_string();
    let own_git_dir = std::fs::canonicalize(&own_git_dir)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or(own_git_dir);

    let status = run_git(path, &["status", "--porcelain=v2", "--branch", "-uall"])
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
        untracked_files: status.untracked,
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
    // Linked worktrees and submodules both use a `gitdir:` pointer file.
    match std::fs::read_to_string(&dot_git) {
        Ok(content) if content.contains("/modules/") => GitEntry::Submodule,
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

pub fn list_branches(repo: &str) -> Result<Vec<Branch>, String> {
    // Unlike `log`/`show`, for-each-ref does NOT expand %xNN escapes (it would
    // emit the literal "%x1f"), so the separator byte is interpolated directly.
    let format = format!(
        "%(refname){FS}%(refname:short){FS}%(objectname){FS}%(objectname:short){FS}\
         %(upstream:short){FS}%(upstream:track){FS}%(committerdate:iso8601-strict){FS}\
         %(authorname){FS}%(contents:subject){FS}%(HEAD){FS}%(worktreepath)"
    );

    let raw = run_git(
        Path::new(repo),
        &[
            "for-each-ref",
            "--sort=-committerdate",
            &format!("--format={format}"),
            "refs/heads",
            "refs/remotes",
        ],
    )?;

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

        let kind = if refname.starts_with("refs/remotes/") {
            "remote"
        } else {
            "local"
        };
        let (ahead, behind, gone) = parse_track(f[5]);
        let remote = if kind == "remote" {
            f[1].split('/').next().map(|s| s.to_string())
        } else {
            None
        };

        branches.push(Branch {
            refname,
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
        args.push("--all".into());
    } else {
        args.extend(revs.iter().cloned());
    }

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

pub fn commit_detail(repo: &str, sha: &str) -> Result<CommitDetail, String> {
    let repo_path = Path::new(repo);
    let format =
        "--format=%H%x1f%h%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%cn%x1f%cI%x1f%D%x1f%s%x1f%b";
    let raw = run_git(repo_path, &["show", "-s", &format, sha])?;
    let f: Vec<&str> = raw.split(FS).collect();
    if f.len() < 11 {
        return Err(format!("unexpected git show output for {sha}"));
    }

    // numstat gives the counts, name-status the letter (and rename source).
    let numstat = run_git(
        repo_path,
        &[
            "show",
            "--numstat",
            "--format=",
            "-M",
            "-m",
            "--first-parent",
            "--no-color",
            sha,
        ],
    )
    .unwrap_or_default();
    let name_status = run_git(
        repo_path,
        &[
            "show",
            "--name-status",
            "--format=",
            "-M",
            "-m",
            "--first-parent",
            "--no-color",
            sha,
        ],
    )
    .unwrap_or_default();

    let mut status_by_path: HashMap<String, (String, Option<String>)> = HashMap::new();
    for line in name_status.lines() {
        let mut parts = line.split('\t');
        let Some(code) = parts.next() else { continue };
        let code = code.trim();
        if code.is_empty() {
            continue;
        }
        let first = parts.next().unwrap_or_default().to_string();
        let second = parts.next().map(|s| s.to_string());
        match second {
            // Rename/copy: "<code>\t<old>\t<new>".
            Some(new_path) => {
                status_by_path.insert(new_path, (code.to_string(), Some(first)));
            }
            None => {
                status_by_path.insert(first, (code.to_string(), None));
            }
        }
    }

    let mut files = Vec::new();
    for line in numstat.lines() {
        let parts: Vec<&str> = line.split('\t').collect();
        if parts.len() < 3 {
            continue;
        }
        let binary = parts[0] == "-" || parts[1] == "-";
        // A rename shows as "old => new" in numstat's path column; the
        // name-status map already holds the resolved new path.
        let path = parts[2..].join("\t");
        let path = if path.contains(" => ") {
            parts
                .last()
                .map(|s| s.to_string())
                .unwrap_or_else(|| path.clone())
        } else {
            path
        };
        let (status, old_path) = status_by_path
            .get(&path)
            .cloned()
            .unwrap_or_else(|| ("M".to_string(), None));
        files.push(ChangedFile {
            path,
            old_path,
            status,
            additions: parts[0].parse().unwrap_or(0),
            deletions: parts[1].parse().unwrap_or(0),
            binary,
        });
    }

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
        files,
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
            sha,
            "--",
            file,
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

/// Merge numstat counts with name-status letters for a `git diff` invocation.
fn collect_diff_files(repo: &Path, extra: &[&str]) -> Vec<ChangedFile> {
    let mut numstat_args = vec!["diff", "--numstat", "-M", "--no-color"];
    numstat_args.extend_from_slice(extra);
    let mut status_args = vec!["diff", "--name-status", "-M", "--no-color"];
    status_args.extend_from_slice(extra);

    let numstat = run_git(repo, &numstat_args).unwrap_or_default();
    let name_status = run_git(repo, &status_args).unwrap_or_default();

    let mut status_by_path: HashMap<String, (String, Option<String>)> = HashMap::new();
    for line in name_status.lines() {
        let mut parts = line.split('\t');
        let Some(code) = parts.next() else { continue };
        let code = code.trim();
        if code.is_empty() {
            continue;
        }
        let first = parts.next().unwrap_or_default().to_string();
        match parts.next() {
            Some(new_path) => {
                status_by_path.insert(new_path.to_string(), (code.to_string(), Some(first)));
            }
            None => {
                status_by_path.insert(first, (code.to_string(), None));
            }
        }
    }

    let mut files = Vec::new();
    for line in numstat.lines() {
        let parts: Vec<&str> = line.split('\t').collect();
        if parts.len() < 3 {
            continue;
        }
        let binary = parts[0] == "-" || parts[1] == "-";
        let path = parts[2..].join("\t");
        let path = if path.contains(" => ") {
            parts.last().map(|s| s.to_string()).unwrap_or(path)
        } else {
            path
        };
        let (status, old_path) = status_by_path
            .get(&path)
            .cloned()
            .unwrap_or_else(|| ("M".to_string(), None));
        files.push(ChangedFile {
            path,
            old_path,
            status,
            additions: parts[0].parse().unwrap_or(0),
            deletions: parts[1].parse().unwrap_or(0),
            binary,
        });
    }
    files
}

/// Everything not yet committed: staged, unstaged and untracked, as one list.
///
/// The diff is taken against HEAD so a staged-then-modified file appears once
/// with its total change, which is what "what have I not committed yet" means
/// to a reader. Untracked files carry no counts (there is no blob to diff)
/// and are marked `?`.
pub fn working_tree(repo: &str) -> Result<WorkingTree, String> {
    let repo_path = Path::new(repo);

    // A repo with no commit yet has no HEAD to diff against; fall back to the
    // index so a first import still shows its files.
    let has_head = run_git(repo_path, &["rev-parse", "--verify", "--quiet", "HEAD"])
        .map(|out| !out.trim().is_empty())
        .unwrap_or(false);

    let mut files = if has_head {
        collect_diff_files(repo_path, &["HEAD"])
    } else {
        collect_diff_files(repo_path, &["--cached"])
    };

    let untracked = run_git(
        repo_path,
        &["ls-files", "--others", "--exclude-standard"],
    )
    .unwrap_or_default();
    let mut untracked_count = 0;
    for path in untracked.lines().filter(|l| !l.trim().is_empty()) {
        untracked_count += 1;
        files.push(ChangedFile {
            path: path.to_string(),
            old_path: None,
            status: "?".to_string(),
            additions: 0,
            deletions: 0,
            binary: false,
        });
    }

    let status = run_git(repo_path, &["status", "--porcelain=v2", "--branch", "-uall"])
        .map(|raw| parse_status_v2(&raw))
        .unwrap_or_else(|_| parse_status_v2(""));

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
        // --no-index exits 1 on difference, which run_git reports as an error;
        // the payload is on stdout, so read it directly.
        let output = Command::new("git")
            .args(["diff", "--no-index", "--no-color", "--unified=3", "--", "/dev/null", file])
            .current_dir(repo_path)
            .env("GIT_TERMINAL_PROMPT", "0")
            .output()
            .map_err(|e| format!("failed to spawn git: {e}"))?;
        return Ok(String::from_utf8_lossy(&output.stdout).to_string());
    }

    let has_head = run_git(repo_path, &["rev-parse", "--verify", "--quiet", "HEAD"])
        .map(|out| !out.trim().is_empty())
        .unwrap_or(false);
    let mut args = vec!["diff", "--no-color", "-M", "--unified=3"];
    if has_head {
        args.push("HEAD");
    } else {
        args.push("--cached");
    }
    args.push("--");
    args.push(file);
    run_git(repo_path, &args)
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

/// Local branches whose remote counterpart is gone, or that are fully merged.
///
/// Two distinct populations, reported with the reason so the UI never deletes
/// on a guess:
///  - `gone`: the upstream ref no longer exists (branch deleted after merge).
///  - `merged`: every commit is already contained in the given base branch.
///
/// `unmerged_commits` is the safety number: `git branch -d` refuses a branch
/// holding unmerged work, and anything above zero here means real commits
/// would need `-D` to disappear.
pub fn stale_branches(repo: &str, base: Option<&str>) -> Result<Vec<StaleBranch>, String> {
    let repo_path = Path::new(repo);

    // Which branch is HEAD here: never propose deleting it.
    let head = run_git(repo_path, &["rev-parse", "--abbrev-ref", "HEAD"])
        .map(|s| s.trim().to_string())
        .unwrap_or_default();

    let format = format!(
        "%(refname:short){FS}%(objectname){FS}%(objectname:short){FS}%(upstream:short){FS}\
         %(upstream:track){FS}%(committerdate:iso8601-strict){FS}%(contents:subject){FS}%(worktreepath)"
    );
    let raw = run_git(
        repo_path,
        &[
            "for-each-ref",
            "--sort=committerdate",
            &format!("--format={format}"),
            "refs/heads",
        ],
    )?;

    // Branches fully contained in the base branch, when one was given.
    let merged: Vec<String> = match base {
        Some(base) => run_git(repo_path, &["branch", "--format=%(refname:short)", "--merged", base])
            .map(|out| out.lines().map(|l| l.trim().to_string()).collect())
            .unwrap_or_default(),
        None => Vec::new(),
    };

    let mut result = Vec::new();
    for line in raw.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let f: Vec<&str> = line.split(FS).collect();
        if f.len() < 8 {
            continue;
        }
        let name = f[0].to_string();
        let (_, _, gone) = parse_track(f[4]);
        let is_merged = merged.iter().any(|m| m == &name);

        let reason = if gone {
            "gone"
        } else if is_merged {
            "merged"
        } else {
            continue;
        };

        // A pinned branch is never a candidate, whatever git says about it.
        if matches!(name.as_str(), "main" | "master" | "develop" | "dev") {
            continue;
        }

        // How much unique work would be lost. `--not --remotes` also spares a
        // branch whose commits live on some remote even if this base lacks them.
        let unmerged = run_git(
            repo_path,
            &[
                "rev-list",
                "--count",
                &name,
                "--not",
                "--remotes",
                base.unwrap_or("HEAD"),
            ],
        )
        .ok()
        .and_then(|out| out.trim().parse::<u32>().ok())
        .unwrap_or(0);

        // Exact emptiness test, above the commit and patch heuristics.
        let contributes_nothing = base
            .and_then(|base| contributes_nothing(repo, base, &name))
            .unwrap_or(unmerged == 0);

        result.push(StaleBranch {
            name: name.clone(),
            contributes_nothing,
            sha: f[1].to_string(),
            short_sha: f[2].to_string(),
            upstream: if f[3].is_empty() { None } else { Some(f[3].to_string()) },
            date: f[5].to_string(),
            subject: f[6].to_string(),
            reason: reason.to_string(),
            unmerged_commits: unmerged,
            worktree_path: if f[7].is_empty() { None } else { Some(f[7].to_string()) },
            is_head: name == head,
        });
    }

    Ok(result)
}

/// Whether merging `branch` into `base` would change anything at all.
///
/// The exact test, and the only one that survives a squashed or rebased merge
/// request: `git merge-tree --write-tree` computes the tree the merge WOULD
/// produce, and if that equals the base's own tree, the branch contributes
/// nothing — whatever its commits look like.
///
/// Both `--merged` (compares commits) and `git cherry` (compares patch ids)
/// answer "not merged" for a branch whose patch was touched on the way in —
/// rebased, squashed, or conflict-resolved — even though every line shipped.
/// Requires git 2.38+; on older git this reports `None` rather than guessing.
pub fn contributes_nothing(repo: &str, base: &str, branch: &str) -> Option<bool> {
    let repo_path = Path::new(repo);
    let merged_tree = run_git(repo_path, &["merge-tree", "--write-tree", base, branch]).ok()?;
    let merged_tree = merged_tree.lines().next()?.trim().to_string();
    if merged_tree.len() < 40 {
        return None;
    }
    let base_tree = run_git(repo_path, &["rev-parse", &format!("{base}^{{tree}}")]).ok()?;
    Some(merged_tree == base_tree.trim())
}

/// Commits held by `branch` and by nothing else — no other local branch, no
/// remote. This is exactly what a forced delete would destroy.
pub fn unmerged_commit_count(repo: &str, branch: &str) -> Result<u32, String> {
    let repo_path = Path::new(repo);

    // Every local branch except this one, so work merged elsewhere is spared.
    let others = run_git(repo_path, &["branch", "--format=%(refname:short)"])?;
    let mut args: Vec<String> = vec![
        "rev-list".into(),
        "--count".into(),
        branch.to_string(),
        "--not".into(),
        "--remotes".into(),
    ];
    for other in others.lines().map(|l| l.trim()) {
        if !other.is_empty() && other != branch {
            args.push(other.to_string());
        }
    }

    let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    run_git(repo_path, &arg_refs)?
        .trim()
        .parse::<u32>()
        .map_err(|e| format!("unexpected rev-list output: {e}"))
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

    let merged: Vec<String> = run_git(
        repo_path,
        &["branch", "-r", "--format=%(refname:short)", "--merged", base],
    )
    .map(|out| out.lines().map(|l| l.trim().to_string()).collect())
    .unwrap_or_default();

    let locals: Vec<String> = run_git(repo_path, &["branch", "--format=%(refname:short)"])
        .map(|out| out.lines().map(|l| l.trim().to_string()).collect())
        .unwrap_or_default();

    let format = format!(
        "%(refname:short){FS}%(objectname:short){FS}%(committerdate:iso8601-strict){FS}\
         %(contents:subject){FS}%(authorname)"
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
    let mut result = Vec::new();

    for line in raw.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let f: Vec<&str> = line.split(FS).collect();
        if f.len() < 5 {
            continue;
        }
        let name = f[0].to_string();
        let Some((remote, branch)) = name.split_once('/') else {
            continue;
        };
        if branch.is_empty() || protected.contains(&branch) || name == base {
            continue;
        }

        let unmerged = run_git(repo_path, &["rev-list", "--count", &name, "--not", base])
            .ok()
            .and_then(|out| out.trim().parse::<u32>().ok())
            .unwrap_or(0);

        // `git cherry` marks "+" a commit whose change has no equivalent in the
        // base, and "-" one already applied there under a different sha.
        let unapplied = if unmerged == 0 {
            0
        } else {
            run_git(repo_path, &["cherry", base, &name])
                .map(|out| {
                    out.lines().filter(|l| l.trim_start().starts_with('+')).count() as u32
                })
                .unwrap_or(unmerged)
        };

        let contributes = contributes_nothing(repo, base, &name).unwrap_or(unapplied == 0);

        result.push(StaleRemoteBranch {
            contributes_nothing: contributes,
            remote: remote.to_string(),
            branch: branch.to_string(),
            merged: merged.iter().any(|m| m == &name),
            unmerged_commits: unmerged,
            equivalent_merged: unapplied == 0,
            unapplied_commits: unapplied,
            has_local: locals.iter().any(|l| l == branch),
            short_sha: f[1].to_string(),
            date: f[2].to_string(),
            subject: f[3].to_string(),
            author: f[4].to_string(),
            name,
        });
    }

    Ok(result)
}

/// Delete branches on a remote, one push per branch so one refusal (a
/// protected branch, most often) does not hide the rest.
pub fn delete_remote_branches(
    repo: &str,
    remote: &str,
    branches: &[String],
) -> Result<Vec<DeleteOutcome>, String> {
    let repo_path = Path::new(repo);

    Ok(branches
        .iter()
        .map(
            |branch| match run_git(repo_path, &["push", remote, "--delete", branch]) {
                Ok(out) => DeleteOutcome {
                    name: branch.clone(),
                    deleted: true,
                    message: out.trim().to_string(),
                },
                Err(err) => DeleteOutcome {
                    name: branch.clone(),
                    deleted: false,
                    message: err,
                },
            },
        )
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
        .map(|name| match run_git(repo_path, &["branch", flag, name]) {
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

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ActionResult {
    pub ok: bool,
    pub output: String,
}

fn action(repo: &str, args: &[&str]) -> Result<ActionResult, String> {
    match run_git(Path::new(repo), args) {
        Ok(out) => Ok(ActionResult {
            ok: true,
            output: out.trim().to_string(),
        }),
        Err(err) => Err(err),
    }
}

pub fn checkout(repo: &str, branch: &str) -> Result<ActionResult, String> {
    action(repo, &["checkout", branch])
}

pub fn checkout_remote(repo: &str, local: &str, remote_ref: &str) -> Result<ActionResult, String> {
    action(repo, &["checkout", "-b", local, "--track", remote_ref])
}

pub fn create_branch(repo: &str, name: &str, start: &str) -> Result<ActionResult, String> {
    action(repo, &["checkout", "-b", name, start])
}

pub fn merge(repo: &str, branch: &str, no_ff: bool) -> Result<ActionResult, String> {
    let mut args = vec!["merge", "--no-edit"];
    if no_ff {
        args.push("--no-ff");
    }
    args.push(branch);
    action(repo, &args)
}

pub fn rebase(repo: &str, onto: &str) -> Result<ActionResult, String> {
    action(repo, &["rebase", onto])
}

pub fn delete_branch(repo: &str, branch: &str, force: bool) -> Result<ActionResult, String> {
    action(repo, &["branch", if force { "-D" } else { "-d" }, branch])
}

/// Remove a linked worktree: drops its registration AND deletes its directory.
///
/// Run from the primary checkout, since the worktree being removed may be the
/// current directory. git refuses to remove the main worktree, and refuses one
/// holding uncommitted work unless forced — both are left to git rather than
/// re-implemented here, so the refusal messages stay authoritative.
pub fn remove_worktree(repo: &str, path: &str, force: bool) -> Result<ActionResult, String> {
    let mut args = vec!["worktree", "remove"];
    if force {
        args.push("--force");
    }
    args.push(path);
    action(repo, &args)
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
        return Err(format!("{path} is not a directory"));
    }
    // Refuse anything that is not a checkout directory, in case a caller ever
    // passes something unexpected: this deletes a whole tree.
    if target.parent().is_none() || target == Path::new("/") {
        return Err(format!("refusing to discard {path}"));
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
    action(repo, &args)
}

/// Push the current branch.
///
/// `set_upstream` publishes a branch that has none yet (`push -u origin HEAD`),
/// which is the case where a plain `git push` fails with a hint instead of
/// doing the obvious thing.
pub fn push(repo: &str, set_upstream: bool) -> Result<ActionResult, String> {
    if set_upstream {
        action(repo, &["push", "--set-upstream", "origin", "HEAD"])
    } else {
        action(repo, &["push"])
    }
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

pub fn pull(repo: &str) -> Result<ActionResult, String> {
    action(repo, &["pull", "--ff-only"])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_status_v2_branch_headers() {
        let raw = "\
# branch.oid 6454e405aaaa1111bbbb
# branch.head feature/login
# branch.upstream origin/feature/login
# branch.ab +3 -2
1 .M N... 100644 100644 100644 aaa bbb lib/foo.py
1 M. N... 100644 100644 100644 aaa bbb lib/bar.py
1 MM N... 100644 100644 100644 aaa bbb lib/baz.py
u UU N... 100644 100644 100644 100644 aaa bbb ccc conflicted.py
? untracked.txt
";
        let s = parse_status_v2(raw);
        assert_eq!(s.branch.as_deref(), Some("feature/login"));
        assert_eq!(s.head.as_deref(), Some("6454e405a"));
        assert_eq!(s.upstream.as_deref(), Some("origin/feature/login"));
        assert_eq!((s.ahead, s.behind), (3, 2));
        // baz.py counts in both columns, foo.py only unstaged, bar.py only staged.
        assert_eq!(s.dirty, 2);
        assert_eq!(s.staged, 2);
        assert_eq!(s.conflicted, 1);
        assert_eq!(s.untracked, 1);
    }

    #[test]
    fn detached_head_yields_no_branch() {
        let s = parse_status_v2("# branch.oid abc123def\n# branch.head (detached)\n");
        assert!(s.branch.is_none());
        assert_eq!(s.head.as_deref(), Some("abc123def"));
    }

    #[test]
    fn empty_repo_has_no_head() {
        let s = parse_status_v2("# branch.oid (initial)\n# branch.head main\n");
        assert!(s.head.is_none());
    }

    #[test]
    fn parses_upstream_track_shapes() {
        assert_eq!(parse_track(""), (0, 0, false));
        assert_eq!(parse_track("[ahead 2]"), (2, 0, false));
        assert_eq!(parse_track("[behind 5]"), (0, 5, false));
        assert_eq!(parse_track("[ahead 2, behind 1]"), (2, 1, false));
        assert_eq!(parse_track("[gone]"), (0, 0, true));
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
