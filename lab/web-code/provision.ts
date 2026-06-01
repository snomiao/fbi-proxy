/**
 * Repo provisioning for the web-code gateway.
 *
 * Maps a GitHub-style path `<owner>/<repo>/tree/<branch>` to a local
 * worktree under `~/ws/<owner>/<repo>/tree/<branch>` and ensures it
 * exists & is reasonably fresh:
 *
 *   - missing  -> `git clone --branch <branch> --single-branch
 *                  https://github.com/<owner>/<repo>` into that dir
 *                  (independent clone per branch)
 *   - present  -> `git fetch --prune`; then `git pull --ff-only` **only
 *                  if** the worktree is clean and fast-forwardable —
 *                  otherwise fetch-only (never clobber local work)
 *
 * All git invocations use `execFile` (argv array, no shell) and every
 * path segment is validated, so a hostile `owner`/`repo`/`branch` can't
 * inject options or escape `~/ws`.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export const WS_ROOT = path.join(os.homedir(), "ws");
const GIT_TIMEOUT_MS = 120_000;

export type RepoSpec = { owner: string; repo: string; branch: string };

export type GitStatus = {
  branch: string;
  head: string;
  ahead: number;
  behind: number;
  dirty: boolean;
  hasUpstream: boolean;
};

export type ProvisionResult = {
  ok: boolean;
  spec: RepoSpec;
  /** Absolute local worktree path (the VS Code `?folder=` target). */
  folder: string;
  existed: boolean;
  action: "cloned" | "pulled" | "fetched" | "none" | "error";
  git?: GitStatus;
  error?: string;
};

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
        "--",
        url,
        folder,
      ]);
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
    const after = await readStatus(folder);
    return { ...base, ok: true, action, git: after };
  } catch (e: unknown) {
    const err = e as { stderr?: string; message?: string };
    return {
      ...base,
      ok: false,
      action: "error",
      error: (err.stderr || err.message || String(e)).trim().slice(0, 600),
    };
  }
}
