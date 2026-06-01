/**
 * Client-side helper shared by the VS Code shell and the wtx terminal UI:
 * call the gateway's /api/repo endpoint to ensure the local worktree
 * exists (clone/fetch/pull), and report the result.
 */

/** `wsRoot` is the absolute workspace-root path (server-joined). */
export type Config = { home: string; wsRoot: string };

export type GitStatus = {
  branch: string;
  head: string;
  ahead: number;
  behind: number;
  dirty: boolean;
  hasUpstream: boolean;
};

export type FailReason = "branch-not-found" | "repo-not-found" | "other";

export type ProvisionResult = {
  ok: boolean;
  folder: string;
  existed: boolean;
  action: "cloned" | "pulled" | "fetched" | "created" | "none" | "error";
  git?: GitStatus;
  error?: string;
  reason?: FailReason;
};

/**
 * Read a `/api/repo` response as JSON, but tolerate a non-JSON body (backend
 * down, an HTML error page, a truncated stream). Instead of throwing a raw
 * `SyntaxError`, surface the status + body so the caller can show a useful
 * message (and its fallback "open anyway" affordance).
 */
async function parseResult(res: Response): Promise<ProvisionResult> {
  const text = await res.text();
  try {
    return JSON.parse(text) as ProvisionResult;
  } catch {
    return {
      ok: false,
      folder: "",
      existed: false,
      action: "error",
      error: `HTTP ${res.status} ${res.statusText}: ${text.slice(0, 300) || "(empty body)"}`,
    };
  }
}

/** Provision the repo named by a `<owner>/<repo>/tree/<branch>` path. */
export async function provisionFromLocation(
  rel: string,
): Promise<ProvisionResult> {
  try {
    const res = await fetch(`/api/repo/${rel}`);
    return await parseResult(res);
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
    return await parseResult(res);
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

/**
 * Subscribe to live git status for a worktree over Server-Sent Events
 * (`GET /api/watch/<rel>`). Calls `onStatus` with each pushed `GitStatus`
 * (initial snapshot + every debounced filesystem change). Returns an
 * unsubscribe fn that closes the stream. Auto-reconnects (EventSource does
 * this for us); malformed frames are ignored.
 */
export function watchStatus(
  rel: string,
  onStatus: (git: GitStatus) => void,
): () => void {
  const es = new EventSource(`/api/watch/${rel}`);
  es.onmessage = (e) => {
    try {
      onStatus(JSON.parse(e.data) as GitStatus);
    } catch {
      // ignore heartbeats / malformed frames
    }
  };
  return () => es.close();
}
