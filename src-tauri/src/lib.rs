// Commands are `async` so Tauri runs them off the main thread. A synchronous
// command executes ON the UI thread, so a slow one (scanning 40 branches with
// `git merge-tree`) freezes the webview: no spinner renders, and macOS shows
// the wait cursor. The bodies stay blocking; being async is what moves them.
mod git;

use git::{
    ActionResult, Branch, Commit, CommitDetail, DeleteOutcome, FetchOutcome, RemoteWeb,
    RepoGroup, StaleBranch, StaleRemoteBranch, WorkingTree,
};

#[tauri::command]
async fn scan_workspace(roots: Vec<String>, max_depth: Option<u32>) -> Vec<RepoGroup> {
    git::scan_workspace(&roots, max_depth.unwrap_or(4))
}

#[tauri::command]
async fn default_roots() -> Vec<String> {
    git::default_roots()
}

#[tauri::command]
async fn list_branches(repo: String) -> Result<Vec<Branch>, String> {
    git::list_branches(&repo)
}

#[tauri::command]
async fn list_commits(
    repo: String,
    revs: Vec<String>,
    limit: Option<u32>,
    skip: Option<u32>,
) -> Result<Vec<Commit>, String> {
    git::list_commits(&repo, &revs, limit.unwrap_or(200), skip.unwrap_or(0))
}

#[tauri::command]
async fn commit_detail(repo: String, sha: String) -> Result<CommitDetail, String> {
    git::commit_detail(&repo, &sha)
}

#[tauri::command]
async fn file_diff(repo: String, sha: String, file: String) -> Result<String, String> {
    git::file_diff(&repo, &sha, &file)
}

#[tauri::command]
async fn working_tree(repo: String) -> Result<WorkingTree, String> {
    git::working_tree(&repo)
}

#[tauri::command]
async fn working_tree_diff(
    repo: String,
    file: String,
    untracked: Option<bool>,
) -> Result<String, String> {
    git::working_tree_diff(&repo, &file, untracked.unwrap_or(false))
}

#[tauri::command]
async fn stale_branches(repo: String, base: Option<String>) -> Result<Vec<StaleBranch>, String> {
    git::stale_branches(&repo, base.as_deref())
}

#[tauri::command]
async fn delete_branches(
    repo: String,
    names: Vec<String>,
    force: Option<bool>,
) -> Result<Vec<DeleteOutcome>, String> {
    git::delete_branches(&repo, &names, force.unwrap_or(false))
}

#[tauri::command]
async fn remote_branches_state(
    repo: String,
    base: String,
) -> Result<Vec<StaleRemoteBranch>, String> {
    git::remote_branches_state(&repo, &base)
}

#[tauri::command]
async fn delete_remote_branches(
    repo: String,
    remote: String,
    branches: Vec<String>,
) -> Result<Vec<DeleteOutcome>, String> {
    git::delete_remote_branches(&repo, &remote, &branches)
}

#[tauri::command]
async fn unmerged_commit_count(repo: String, branch: String) -> Result<u32, String> {
    git::unmerged_commit_count(&repo, &branch)
}

/// (contributes_nothing, unmerged_commits) for one branch against a base.
/// A failure is an error, not `(false, 0)`: that pair reads as "nothing
/// would be lost" and could green-light a forced delete.
#[tauri::command]
async fn branch_contribution(
    repo: String,
    branch: String,
    base: String,
) -> Result<(bool, u32), String> {
    git::branch_contribution(&repo, &branch, &base)
}

#[tauri::command]
async fn checkout(repo: String, branch: String) -> Result<ActionResult, String> {
    git::checkout(&repo, &branch)
}

#[tauri::command]
async fn checkout_remote(
    repo: String,
    local: String,
    remote_ref: String,
) -> Result<ActionResult, String> {
    git::checkout_remote(&repo, &local, &remote_ref)
}

#[tauri::command]
async fn create_branch(repo: String, name: String, start: String) -> Result<ActionResult, String> {
    git::create_branch(&repo, &name, &start)
}

#[tauri::command]
async fn merge(repo: String, branch: String, no_ff: Option<bool>) -> Result<ActionResult, String> {
    git::merge(&repo, &branch, no_ff.unwrap_or(false))
}

#[tauri::command]
async fn rebase(repo: String, onto: String) -> Result<ActionResult, String> {
    git::rebase(&repo, &onto)
}

#[tauri::command]
async fn delete_branch(repo: String, branch: String, force: Option<bool>) -> Result<ActionResult, String> {
    git::delete_branch(&repo, &branch, force.unwrap_or(false))
}

#[tauri::command]
async fn remove_worktree(
    repo: String,
    path: String,
    force: Option<bool>,
) -> Result<ActionResult, String> {
    git::remove_worktree(&repo, &path, force.unwrap_or(false))
}

#[tauri::command]
async fn discard_worktree_directory(repo: String, path: String) -> Result<ActionResult, String> {
    git::discard_worktree_directory(&repo, &path)
}

#[tauri::command]
async fn prune_worktrees(repo: String) -> Result<ActionResult, String> {
    git::prune_worktrees(&repo)
}

#[tauri::command]
async fn fetch(repo: String, prune: Option<bool>) -> Result<ActionResult, String> {
    git::fetch(&repo, prune.unwrap_or(true))
}

#[tauri::command]
async fn push(repo: String, set_upstream: Option<bool>) -> Result<ActionResult, String> {
    git::push(&repo, set_upstream.unwrap_or(false))
}

#[tauri::command]
async fn last_fetch(repo: String) -> Result<Option<u64>, String> {
    git::last_fetch(&repo)
}

#[tauri::command]
async fn pull(repo: String, mode: Option<String>) -> Result<ActionResult, String> {
    git::pull(&repo, mode.as_deref().unwrap_or("ff-only"))
}

#[tauri::command]
async fn fetch_many(repos: Vec<String>) -> Vec<FetchOutcome> {
    git::fetch_many(&repos)
}

#[tauri::command]
async fn remote_web_url(repo: String, remote: Option<String>) -> Result<Option<RemoteWeb>, String> {
    git::remote_web_url(&repo, remote.as_deref())
}

/// Settings live at a FIXED path, deliberately not derived from the bundle
/// identifier and not in the webview's localStorage.
///
/// localStorage is scoped to the webview's data container, which changes with
/// the bundle identifier and differs between `tauri dev` and a built .app — so
/// renaming the app, or simply installing it, silently loses every tab. A plain
/// file survives both.
fn settings_path() -> Result<std::path::PathBuf, String> {
    let home = std::env::var_os("HOME").ok_or_else(|| "no HOME".to_string())?;
    Ok(std::path::PathBuf::from(home)
        .join("Library/Application Support/gitflo/settings.json"))
}

#[tauri::command]
async fn read_settings() -> Result<Option<String>, String> {
    let path = settings_path()?;
    match std::fs::read_to_string(&path) {
        Ok(content) => Ok(Some(content)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("failed to read {}: {e}", path.display())),
    }
}

#[tauri::command]
async fn write_settings(content: String) -> Result<(), String> {
    let path = settings_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("failed to create {}: {e}", parent.display()))?;
    }
    // Write-then-rename: a crash mid-write must not leave a truncated file that
    // would read back as "no tabs".
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, content).map_err(|e| format!("failed to write: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("failed to replace: {e}"))
}

/// `open` hands off to Launch Services and returns at once, so waiting on it
/// costs nothing and leaves no zombie child behind, unlike a bare `spawn`.
fn reveal(path: &str) -> Result<(), String> {
    let status = std::process::Command::new("open")
        .arg("-R")
        .arg(path)
        .status()
        .map_err(|e| e.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("Impossible d'afficher {path} dans le Finder"))
    }
}

#[tauri::command]
async fn reveal_in_finder(path: String) -> Result<(), String> {
    reveal(&path)
}

#[tauri::command]
async fn open_in_editor(path: String, editor: Option<String>) -> Result<(), String> {
    // By application name, not the `cursor`/`code` shell commands: an app
    // launched from the Finder gets a minimal PATH that never holds them.
    let app = match editor.as_deref().unwrap_or("vscode") {
        "vscode" => "Visual Studio Code",
        "cursor" => "Cursor",
        "zed" => "Zed",
        other => return Err(format!("éditeur inconnu : {other}")),
    };
    // `open -a` exits non-zero when the app is not installed. Said plainly
    // rather than falling back to something else: the choice is the user's.
    let opened = std::process::Command::new("open")
        .args(["-a", app])
        .arg(&path)
        .status()
        .is_ok_and(|s| s.success());
    if opened {
        Ok(())
    } else {
        Err(format!("{app} est introuvable. Choisis un autre éditeur dans les réglages."))
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            scan_workspace,
            default_roots,
            list_branches,
            list_commits,
            commit_detail,
            file_diff,
            working_tree,
            working_tree_diff,
            stale_branches,
            delete_branches,
            unmerged_commit_count,
            branch_contribution,
            remote_branches_state,
            delete_remote_branches,
            remove_worktree,
            prune_worktrees,
            discard_worktree_directory,
            read_settings,
            write_settings,
            checkout,
            checkout_remote,
            create_branch,
            merge,
            rebase,
            delete_branch,
            fetch,
            fetch_many,
            remote_web_url,
            pull,
            last_fetch,
            push,
            reveal_in_finder,
            open_in_editor,
        ])
        .run(tauri::generate_context!())
        .expect("error while running gitflo");
}
