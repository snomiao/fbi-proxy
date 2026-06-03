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
 * (`GET /api/watch/<rel>`). Calls `onEvent` with each pushed `GitStatus`
 * (initial snapshot + every debounced filesystem change). Returns an
 * unsubscribe fn that closes the stream. Auto-reconnects (EventSource does
 * this for us); malformed frames are ignored.
 */
/**
 * A live watch event. `activity` marks any filesystem change (drives the UI
 * spinner); `status` is the git status, present only when it changed (or as the
 * initial snapshot).
 */
export type LiveEvent = {
  activity?: boolean;
  status?: GitStatus;
  /** How many tabs currently have this repo open (>=2 means duplicates). */
  presence?: number;
  /** window.name of the first/canonical tab — target for "switch to it". */
  primaryName?: string;
};

export function watchStatus(
  rel: string,
  onEvent: (ev: LiveEvent) => void,
): () => void {
  const es = new EventSource(`/api/watch/${rel}`);
  es.onmessage = (e) => {
    try {
      // SSE carries a status per message; treat each as activity + status.
      onEvent({ activity: true, status: JSON.parse(e.data) as GitStatus });
    } catch {
      // ignore heartbeats / malformed frames
    }
  };
  return () => es.close();
}

// --- Multiplexed live status via a single shared WebSocket -----------------
// All tabs of this origin share ONE SharedWorker holding ONE WebSocket
// (/api/watch-ws). It multiplexes every repo subscription, so opening 10+
// tabs costs one connection total (not one per tab) and keeps the tab title
// live while backgrounded. Falls back to per-tab SSE where SharedWorker is
// unavailable.

let sharedPort: MessagePort | null | undefined;
const liveHandlers = new Map<string, Set<(ev: LiveEvent) => void>>();

function ensureWorkerPort(): MessagePort | null {
  if (sharedPort !== undefined) return sharedPort;
  if (typeof SharedWorker === "undefined") return (sharedPort = null);
  try {
    const worker = new SharedWorker(
      new URL("./status-worker.ts", import.meta.url),
      // Named so every tab shares ONE instance — and so bumping the suffix
      // forces a fresh worker when the worker protocol changes (browsers key
      // SharedWorkers by URL + name and otherwise reuse a running instance).
      { type: "module", name: "fbi-web-code-status-v3" },
    );
    const port = worker.port;
    port.onmessage = (e: MessageEvent) => {
      const { rel, activity, status, presence, primaryName } = (e.data ??
        {}) as { rel?: string } & LiveEvent;
      if (rel)
        liveHandlers
          .get(rel)
          ?.forEach((cb) => cb({ activity, status, presence, primaryName }));
    };
    port.start();
    // Release this tab's subscriptions in the worker when the tab goes away.
    addEventListener("pagehide", () => port.postMessage({ type: "close" }));
    return (sharedPort = port);
  } catch {
    return (sharedPort = null);
  }
}

/**
 * Live git status for `rel`, multiplexed over the shared worker's single
 * WebSocket (or per-tab SSE as a fallback). Calls `onEvent` with each pushed
 * `GitStatus`. Returns an unsubscribe fn.
 */
export function watchStatusLive(
  rel: string,
  onEvent: (ev: LiveEvent) => void,
): () => void {
  const port = ensureWorkerPort();
  if (!port) return watchStatus(rel, onEvent); // SSE fallback

  let set = liveHandlers.get(rel);
  if (!set) {
    set = new Set();
    liveHandlers.set(rel, set);
  }
  set.add(onEvent);
  // Include this tab's window.name so the worker can name the canonical tab
  // back to duplicates (for "switch to existing tab").
  port.postMessage({ type: "sub", rel, name: globalThis.name });

  return () => {
    set!.delete(onEvent);
    if (set!.size === 0) {
      liveHandlers.delete(rel);
      port.postMessage({ type: "unsub", rel });
    }
  };
}
