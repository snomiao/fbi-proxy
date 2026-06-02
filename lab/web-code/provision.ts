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
 * One shared native watcher per worktree, fanned out to many subscribers.
 * Recursive watch over a large tree (and the `git status` it triggers) is
 * expensive, so N browser tabs on the same repo must NOT each spin one up —
 * that starves the single-threaded dev server. We keep a per-folder registry:
 * the first subscriber creates the watcher, the last to leave tears it down,
 * and every change recomputes status once and broadcasts it.
 */
/**
 * A watch notification. `activity` is true for every (debounced) filesystem
 * burst — the signal the UI uses to show a "working" spinner. `status` is
 * present only when the git status actually changed since the last burst (or
 * for the snapshot handed to a brand-new subscriber), so the wire stays quiet
 * when nothing meaningful moved.
 */
export type StatusEvent = { activity: boolean; status?: GitStatus };

type WatchEntry = {
  subscribers: Set<(e: StatusEvent) => void>;
  last?: GitStatus;
  teardown: () => Promise<void>;
};
const watches = new Map<string, WatchEntry>();

/**
 * Subscribe to live git status for `spec`'s worktree. `onChange` fires with a
 * fresh `GitStatus` whenever the working tree or index may have changed (and
 * immediately with the last-known status, if any). Native recursive watch via
 * @parcel/watcher (FSEvents / inotify / ReadDirectoryChangesW); node_modules
 * and `.git/objects` churn are ignored, but `.git/index` & `.git/HEAD` are
 * watched so stage/commit/checkout transitions are caught; bursts are
 * debounced before the (fast) `git status`. Returns an unsubscribe fn; the
 * underlying watcher is shared and only torn down when the last subscriber
 * leaves. Best-effort: errors are swallowed.
 */
export async function watchStatus(
  spec: RepoSpec,
  onChange: (e: StatusEvent) => void,
): Promise<() => Promise<void>> {
  const folder = folderFor(spec);
  let entry = watches.get(folder);

  if (!entry) {
    // Register synchronously (before the async subscribe) so a second
    // concurrent caller joins this entry instead of creating a rival watcher.
    const subscribers = new Set<(e: StatusEvent) => void>();
    entry = { subscribers, teardown: async () => {} };
    watches.set(folder, entry);

    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastKey = "";
    let pendingWorkingTree = false; // did a non-.git file change this burst?
    const schedule = (workingTree: boolean) => {
      if (workingTree) pendingWorkingTree = true;
      if (timer) clearTimeout(timer);
      timer = setTimeout(async () => {
        const activity = pendingWorkingTree;
        pendingWorkingTree = false;
        try {
          const status = await readStatus(folder);
          const key = JSON.stringify(status);
          const changed = key !== lastKey;
          if (changed) {
            lastKey = key;
            entry!.last = status;
          }
          // `activity` (the spinner) fires only on real working-tree edits, not
          // on .git churn — VS Code has this folder open and pokes .git
          // constantly (git polling), which would otherwise spin the title
          // forever. Flags still update on .git changes too (commit, pull).
          // Stay silent when neither the working tree nor the status moved.
          if (!activity && !changed) return;
          for (const cb of subscribers)
            cb({ activity, status: changed ? status : undefined });
        } catch {
          // worktree vanished mid-watch, or a transient git lock — ignore
        }
      }, 300);
    };
    try {
      const sub = await watcher.subscribe(
        folder,
        (err, events) => {
          if (err) return;
          // A change outside .git is a real edit (spins the title); .git-only
          // bursts still recompute status but don't spin.
          const workingTree = events.some(
            (e) => !/[\\/]\.git[\\/]/.test(e.path),
          );
          schedule(workingTree);
        },
        {
          ignore: [
            "**/node_modules/**",
            "**/.git/objects/**",
            "**/.git/lfs/**",
          ],
        },
      );
      entry.teardown = async () => {
        if (timer) clearTimeout(timer);
        await sub.unsubscribe();
      };
    } catch {
      // watcher unavailable — drop the entry so a later call can retry
      watches.delete(folder);
      throw new Error("watch unavailable");
    }
  }

  entry.subscribers.add(onChange);
  // Hand the newcomer current state at once (no `activity` → no spurious spin).
  if (entry.last) onChange({ activity: false, status: entry.last });

  return async () => {
    const e = watches.get(folder);
    if (!e) return;
    e.subscribers.delete(onChange);
    if (e.subscribers.size === 0) {
      watches.delete(folder);
      await e.teardown();
    }
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
 * Fire-and-forget remote refresh for an existing worktree: `git fetch`, then
 * `git pull --ff-only` if it's safe (clean, behind, not ahead), then re-run
 * setup if the checkout actually advanced. Runs detached from the request so a
 * slow fetch never blocks the editor opening; the file watcher broadcasts any
 * resulting status change to the live UI. Best-effort — errors are swallowed.
 */
async function refreshInBackground(folder: string): Promise<void> {
  try {
    await git(folder, ["fetch", "--prune", "origin"]);
    const st = await readStatus(folder);
    if (st.hasUpstream && !st.dirty && st.behind > 0 && st.ahead === 0) {
      const before = st.head;
      await git(folder, ["pull", "--ff-only"]);
      const after = await readStatus(folder);
      if (after.head !== before) await runRepoSetup(folder);
    }
  } catch {
    // network/auth/lock hiccup — leave the worktree as-is
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

    // Present: return the current local status immediately, then refresh from
    // the remote in the BACKGROUND. A `git fetch` on a large, actively-pushed
    // repo can be slow, and blocking the response on it stalls the editor
    // opening (and trips the proxy's upstream timeout → 502). The watcher
    // pushes any pull-induced changes live, so the UI still converges.
    await seedEnvLocal(spec, folder);
    const current = await readStatus(folder);
    void refreshInBackground(folder);
    return { ...base, ok: true, action: "fetched", git: current };
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
