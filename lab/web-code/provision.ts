/**
 * Repo provisioning for the web-code gateway.
 *
 * Maps a GitHub-style path `<owner>/<repo>/tree/<branch>` to a local
 * worktree under `~/ws/<owner>/<repo>/tree/<branch>` and ensures it
 * exists & is reasonably fresh:
 *
 *   - missing  -> `git clone --branch <branch> --single-branch
 *                  --recurse-submodules https://github.com/<owner>/<repo>`
 *                  into that dir (independent clone per branch)
 *   - present  -> `git fetch --prune`; then `git pull --ff-only` **only
 *                  if** the worktree is clean and fast-forwardable —
 *                  otherwise fetch-only (never clobber local work)
 *
 * After a clone, branch creation, or a pull that advanced the checkout, the
 * cross-platform `setup-repo.sh` runs via Bun Shell (`bun setup-repo.sh`):
 * it updates submodules and installs dependencies for whichever ecosystem(s)
 * the repo uses (JS via its pinned lockfile, Rust, Go, Python, Ruby). For any
 * non-`main` branch we also seed `.env.local` from the sibling `tree/main`
 * worktree (seed-once: never overwrites one already in the branch).
 *
 * All git invocations use `execFile` (argv array, no shell) and every
 * path segment is validated, so a hostile `owner`/`repo`/`branch` can't
 * inject options or escape `~/ws`.
 */

import watcher from "@parcel/watcher";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export const WS_ROOT = path.join(os.homedir(), "ws");
const GIT_TIMEOUT_MS = 120_000;
// Dependency installs / builds can be slow; give the setup script its own
// generous budget.
const SETUP_TIMEOUT_MS = 600_000;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SETUP_SCRIPT = path.join(HERE, "setup-repo.sh");

export type RepoSpec = { owner: string; repo: string; branch: string };

export type GitStatus = {
  branch: string;
  head: string;
  ahead: number;
  behind: number;
  dirty: boolean;
  hasUpstream: boolean;
};

/**
 * Why a provision failed, when we can tell:
 *   - "branch-not-found": repo exists on the remote but the branch does
 *     not — the shell offers a "Create branch" action for this.
 *   - "repo-not-found": the remote repo itself is missing/inaccessible.
 *   - "other": anything else (network, auth, disk, …).
 */
export type FailReason = "branch-not-found" | "repo-not-found" | "other";

export type ProvisionResult = {
  ok: boolean;
  spec: RepoSpec;
  /** Absolute local worktree path (the VS Code `?folder=` target). */
  folder: string;
  existed: boolean;
  action: "cloned" | "pulled" | "fetched" | "created" | "none" | "error";
  git?: GitStatus;
  error?: string;
  reason?: FailReason;
};

function classifyError(msg: string): FailReason {
  if (/remote branch .* not found/i.test(msg)) return "branch-not-found";
  if (/repository .* not found|could not read from remote/i.test(msg))
    return "repo-not-found";
  return "other";
}

/** Parse `<owner>/<repo>/tree/<branch>` (branch may contain slashes). */
export function parseSpec(p: string): RepoSpec | null {
  const clean = decodeURIComponent(p).replace(/^\/+/, "").replace(/\/+$/, "");
  const m = clean.match(/^([^/]+)\/([^/]+)\/tree\/(.+)$/);
  if (!m) return null;
  const [, owner, repo, branch] = m;
  if (![owner, repo, ...branch.split("/")].every(isSafeSegment)) return null;
  return { owner, repo, branch };
}

/** A path segment that can't traverse, hide options, or inject control. */
function isSafeSegment(s: string): boolean {
  return (
    s.length > 0 &&
    s !== "." &&
    s !== ".." &&
    !s.startsWith("-") && // no option injection (e.g. branch "--upload-pack=…")
    !/[/\\\0]/.test(s) &&
    !/[\x00-\x1f]/.test(s)
  );
}

export function folderFor(spec: RepoSpec): string {
  return path.join(WS_ROOT, spec.owner, spec.repo, "tree", spec.branch);
}

async function git(
  cwd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return execFileP("git", args, {
    cwd,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** Read ahead/behind/dirty for a worktree (assumes it is a git dir). */
async function readStatus(dir: string): Promise<GitStatus> {
  // porcelain=v2 --branch gives `# branch.*` headers + entries.
  const { stdout } = await git(dir, ["status", "--porcelain=v2", "--branch"]);
  let branch = "";
  let head = "";
  let ahead = 0;
  let behind = 0;
  let hasUpstream = false;
  let dirty = false;
  for (const line of stdout.split("\n")) {
    if (line.startsWith("# branch.head ")) branch = line.slice(14).trim();
    else if (line.startsWith("# branch.oid ")) head = line.slice(13).trim();
    else if (line.startsWith("# branch.ab ")) {
      hasUpstream = true;
      const m = line.match(/\+(\d+)\s+-(\d+)/);
      if (m) {
        ahead = Number(m[1]);
        behind = Number(m[2]);
      }
    } else if (line && !line.startsWith("#")) {
      dirty = true; // any tracked/untracked entry
    }
  }
  return { branch, head: head.slice(0, 12), ahead, behind, dirty, hasUpstream };
}

/** Git status for an existing worktree, or null if it isn't provisioned. */
export async function statusOf(spec: RepoSpec): Promise<GitStatus | null> {
  const folder = folderFor(spec);
  if (!existsSync(path.join(folder, ".git"))) return null;
  try {
    return await readStatus(folder);
  } catch {
    return null;
  }
}

/**
 * Watch a worktree and call `onChange` with fresh git status whenever the
 * working tree or index may have changed — for live dirty/ahead/behind in the
 * UI without polling. Recursive native watch via @parcel/watcher (FSEvents /
 * inotify / ReadDirectoryChangesW). node_modules and `.git/objects` churn are
 * ignored (but `.git/index` & `.git/HEAD` are watched, so stage/commit/
 * checkout transitions are caught); bursts are debounced before the (fast)
 * `git status`. Returns an unsubscribe fn. Best-effort: errors are swallowed.
 */
export async function watchStatus(
  spec: RepoSpec,
  onChange: (status: GitStatus) => void,
): Promise<() => Promise<void>> {
  const folder = folderFor(spec);
  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      try {
        onChange(await readStatus(folder));
      } catch {
        // worktree vanished mid-watch, or a transient git lock — ignore
      }
    }, 300);
  };
  const sub = await watcher.subscribe(
    folder,
    (err) => {
      if (!err) schedule();
    },
    { ignore: ["**/node_modules/**", "**/.git/objects/**", "**/.git/lfs/**"] },
  );
  return async () => {
    if (timer) clearTimeout(timer);
    await sub.unsubscribe();
  };
}

/**
 * Run the cross-platform repo setup script (`setup-repo.sh`) in a worktree
 * via Bun Shell — `bun <script>` interprets the `.sh` with Bun's own shell,
 * so it works identically on Windows. The script updates submodules and
 * installs dependencies for whichever ecosystem(s) the repo uses (JS via the
 * pinned package manager, Rust, Go, Python, Ruby). Best-effort: a failed or
 * slow install must not fail provisioning — the editor still opens and the
 * user can re-run setup from the integrated terminal.
 */
async function runRepoSetup(dir: string): Promise<void> {
  try {
    await execFileP("bun", [SETUP_SCRIPT], {
      cwd: dir,
      timeout: SETUP_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    // best-effort
  }
}

/**
 * Seed a non-`main` branch worktree's `.env.local` from the sibling
 * `tree/main` worktree, so feature checkouts inherit the local (gitignored)
 * env without re-entry. Seed-once: skips if the branch already has one, so
 * per-branch edits are never clobbered. Always reads `tree/main` directly
 * (not `../main`) so branches containing `/` resolve correctly.
 */
async function seedEnvLocal(spec: RepoSpec, folder: string): Promise<void> {
  if (spec.branch === "main") return;
  const src = path.join(
    WS_ROOT,
    spec.owner,
    spec.repo,
    "tree",
    "main",
    ".env.local",
  );
  const dest = path.join(folder, ".env.local");
  if (!existsSync(src) || existsSync(dest)) return;
  try {
    await copyFile(src, dest);
  } catch {
    // best-effort — a locked/disappearing source must not fail provisioning
  }
}

/**
 * Ensure the worktree for `spec` exists and is fresh. Never throws —
 * failures are returned as `{ ok:false, action:"error", error }`.
 */
export async function provision(spec: RepoSpec): Promise<ProvisionResult> {
  const folder = folderFor(spec);
  const base: Omit<ProvisionResult, "action"> & {
    action: ProvisionResult["action"];
  } = {
    ok: false,
    spec,
    folder,
    existed: existsSync(path.join(folder, ".git")),
    action: "none",
  };

  try {
    if (!base.existed) {
      // Clone this branch independently into the worktree path.
      await mkdir(path.dirname(folder), { recursive: true });
      const url = `https://github.com/${spec.owner}/${spec.repo}`;
      await git(WS_ROOT, [
        "clone",
        "--branch",
        spec.branch,
        "--single-branch",
        "--recurse-submodules",
        "--",
        url,
        folder,
      ]);
      await seedEnvLocal(spec, folder);
      await runRepoSetup(folder);
      const git2 = await readStatus(folder);
      return { ...base, ok: true, action: "cloned", git: git2 };
    }

    // Present: fetch, then pull --ff-only only if safe.
    await git(folder, ["fetch", "--prune", "origin"]);
    const st = await readStatus(folder);
    let action: ProvisionResult["action"] = "fetched";
    if (st.hasUpstream && !st.dirty && st.behind > 0 && st.ahead === 0) {
      await git(folder, ["pull", "--ff-only"]);
      action = "pulled";
    }
    await seedEnvLocal(spec, folder);
    if (action === "pulled") {
      // The checkout advanced — re-run full setup (submodule pointers and
      // dependency lockfiles may have changed). When nothing was pulled we
      // do NO submodule/install work: those only change with the checkout,
      // and running them on every page open makes opens crawl for repos
      // with many submodules.
      await runRepoSetup(folder);
    }
    const after = await readStatus(folder);
    return { ...base, ok: true, action, git: after };
  } catch (e: unknown) {
    const err = e as { stderr?: string; message?: string };
    const error = (err.stderr || err.message || String(e)).trim().slice(0, 600);
    return {
      ...base,
      ok: false,
      action: "error",
      error,
      reason: classifyError(error),
    };
  }
}

/**
 * Create `spec.branch` locally (no push) for a repo whose remote branch
 * doesn't exist yet. Clones the repo's default branch into the worktree
 * path, then `git switch -c <branch>`. Refuses if the worktree already
 * exists (use the normal provision path for that). Never throws.
 */
export async function createBranch(spec: RepoSpec): Promise<ProvisionResult> {
  const folder = folderFor(spec);
  const base = {
    ok: false as boolean,
    spec,
    folder,
    existed: existsSync(path.join(folder, ".git")),
    action: "none" as ProvisionResult["action"],
  };
  if (base.existed) {
    return {
      ...base,
      ok: false,
      action: "error",
      error: "worktree already exists",
    };
  }
  try {
    await mkdir(path.dirname(folder), { recursive: true });
    const url = `https://github.com/${spec.owner}/${spec.repo}`;
    // Clone the default branch (no --branch), then branch off it locally.
    await git(WS_ROOT, ["clone", "--recurse-submodules", "--", url, folder]);
    await git(folder, ["switch", "-c", spec.branch]);
    await seedEnvLocal(spec, folder);
    await runRepoSetup(folder);
    const status = await readStatus(folder);
    return { ...base, ok: true, action: "created", git: status };
  } catch (e: unknown) {
    const err = e as { stderr?: string; message?: string };
    const error = (err.stderr || err.message || String(e)).trim().slice(0, 600);
    return {
      ...base,
      ok: false,
      action: "error",
      error,
      reason: classifyError(error),
    };
  }
}
