/**
 * Client-side helper shared by the VS Code shell and the wtx terminal UI:
 * call the gateway's /api/repo endpoint to ensure the local worktree
 * exists (clone/fetch/pull), and report the result.
 */

/** `wsRoot` is the absolute workspace-root path (server-joined). */
export type Config = { home: string; wsRoot: string };

export type FailReason = "branch-not-found" | "repo-not-found" | "other";

export type ProvisionResult = {
  ok: boolean;
  folder: string;
  existed: boolean;
  action: "cloned" | "pulled" | "fetched" | "created" | "none" | "error";
  git?: {
    branch: string;
    head: string;
    ahead: number;
    behind: number;
    dirty: boolean;
  };
  error?: string;
  reason?: FailReason;
};

/** Provision the repo named by a `<owner>/<repo>/tree/<branch>` path. */
export async function provisionFromLocation(
  rel: string,
): Promise<ProvisionResult> {
  try {
    const res = await fetch(`/api/repo/${rel}`);
    return (await res.json()) as ProvisionResult;
  } catch (e) {
    return {
      ok: false,
      folder: "",
      existed: false,
      action: "error",
      error: String(e),
    };
  }
}

/**
 * Create the branch locally (off the repo's default branch, no push) for a
 * `<owner>/<repo>/tree/<branch>` path whose remote branch doesn't exist.
 */
export async function createBranchFromLocation(
  rel: string,
): Promise<ProvisionResult> {
  try {
    const res = await fetch(`/api/repo/${rel}?create=1`, { method: "POST" });
    return (await res.json()) as ProvisionResult;
  } catch (e) {
    return {
      ok: false,
      folder: "",
      existed: false,
      action: "error",
      error: String(e),
    };
  }
}

/** Short human-readable git-state note for status lines. */
export function statusNote(r: ProvisionResult, rel: string): string {
  const g = r.git;
  const parts = [
    r.action === "cloned" || r.action === "created"
      ? r.action
      : r.existed
        ? r.action
        : "ready",
    g ? `@ ${g.head}` : "",
    g && g.dirty ? "· local changes" : "",
    g && g.behind ? `· ${g.behind} behind` : "",
    g && g.ahead ? `· ${g.ahead} ahead` : "",
  ].filter(Boolean);
  return `${rel} — ${parts.join(" ")}`;
}
