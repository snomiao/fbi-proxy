/**
 * Client shell. Reads the pretty GitHub-style URL, asks the server to
 * provision the matching local worktree (clone if missing, fetch +
 * pull-if-clean if present), then embeds VS Code web for the folder the
 * server reports.
 *
 *   https://fbi.com/<owner>/<repo>/tree/<branch>
 *     -> GET /api/repo/<owner>/<repo>/tree/<branch>   (provision)
 *     -> iframe src = /_vscode/?folder=<local worktree>
 *
 * The bare ws root (empty path) skips provisioning and just opens
 * `~/<wsRoot>` so you can browse what's already checked out.
 */

import {
  createBranchFromLocation,
  provisionFromLocation,
  statusNote,
  watchStatusLive,
  type Config,
  type GitStatus,
} from "./provision-client";

function setStatus(msg: HTMLElement, html: string) {
  msg.innerHTML = html;
  msg.hidden = false;
}

/**
 * Escape text for safe interpolation into innerHTML. The repo path comes
 * from `location.pathname` (attacker-controllable in a crafted link), so
 * it must never reach innerHTML unescaped — otherwise e.g.
 * `/%3Cimg%20onerror=...%3E/tree/main` would run script on this origin.
 */
function esc(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c]!,
  );
}

async function main() {
  // UI selector: `?ui=wtx` opens the web terminal, anything else (or
  // `?ui=vscode`) opens VS Code. The terminal lives on its own page
  // (terminal.html, a React/xterm bundle) to keep the VS Code path a
  // dependency-free iframe shell; route there preserving the repo path
  // and remaining query so the same /api/repo provisioning applies.
  const ui = new URLSearchParams(location.search).get("ui");
  if (ui === "wtx") {
    // Hand off to the terminal page (a separate React/xterm bundle), passing
    // the repo path as `?repo=` so terminal.html is reached at a clean URL
    // (vite's SPA fallback otherwise wouldn't serve it under a repo path).
    const rel = location.pathname.replace(/^\/+/, "");
    location.replace(`/terminal.html?repo=${encodeURIComponent(rel)}`);
    return;
  }

  const msg = document.getElementById("msg") as HTMLDivElement;
  const frame = document.getElementById("frame") as HTMLIFrameElement;

  // Force VS Code Web to use its built-in English NLS. With a non-English
  // OS locale (e.g. ja_JP) VS Code resolves the locale from `navigator.
  // language` and fetches `…/<locale>/nls.messages.js` from
  // www.vscode-unpkg.net — version-mismatched (`{0}` placeholders) and
  // CORS-blocked from the fbi.com origin, which aborts the workbench
  // bootstrap (blank editor, empty tree). The cookie rides the iframe's
  // own request so the editor sees `en` before computing the NLS URL.
  localStorage.setItem("vscode.nls.locale", "en");
  document.cookie = "vscode.nls.locale=en;path=/;max-age=3153600000";

  let cfg: Config;
  try {
    cfg = await (await fetch("/__config")).json();
  } catch (e) {
    setStatus(msg, `Could not load /__config: ${e}`);
    return;
  }

  const rel = decodeURIComponent(location.pathname.replace(/^\/+/, ""));

  // Bare ws root: open it directly, no provisioning.
  if (!rel) {
    openVscode(frame, msg, cfg.wsRoot);
    return;
  }

  // Provision the repo via the API, surfacing progress + git status.
  setStatus(msg, `Provisioning <code>${esc(rel)}</code>…`);
  const result = await provisionFromLocation(rel);

  if (!result.ok) {
    // Remote repo exists but the branch doesn't yet → offer to create it
    // locally (branched off the default branch, no push).
    if (result.reason === "branch-not-found") {
      const branch = rel.split("/tree/")[1] ?? rel;
      offerCreateBranch(msg, frame, rel, branch);
      return;
    }
    // Any other failure (backend down, bad/non-JSON response, network): show
    // the error but still offer to open VS Code at the expected worktree path,
    // so a flaky/dead provisioner never fully blocks you.
    offerOpenAnyway(
      msg,
      frame,
      rel,
      result.folder || `${cfg.wsRoot}/${rel}`,
      result.error,
    );
    return;
  }

  setTitle(rel, result.git);
  liveTitle(rel);
  setStatus(msg, `${esc(statusNote(result, rel))}. Opening…`);
  openVscode(frame, msg, result.folder);
}

/**
 * Tab title: `[!] [↓behind] [↑ahead] <branch>@<repo>\<owner> - web-code`.
 * A status glance across many tabs: `!` = uncommitted changes, then VS
 * Code-style sync counts — `↓N` commits behind upstream, `↑N` ahead. Each
 * part shows only when non-zero (ahead/behind need a tracked upstream).
 * `rel` is `<owner>/<repo>/tree/<branch>` (branch may contain slashes).
 */
function setTitle(rel: string, git?: GitStatus) {
  const [ownerRepo, branch = rel] = rel.split("/tree/");
  const [owner = "", repo = ""] = (ownerRepo ?? "").split("/");
  const flags = [
    git?.dirty ? "!" : "",
    git && git.behind > 0 ? `↓${git.behind}` : "",
    git && git.ahead > 0 ? `↑${git.ahead}` : "",
  ]
    .filter(Boolean)
    .join(" ");
  const prefix = flags ? `${flags} ` : "";
  document.title = `${prefix}${branch}@${repo}\\${owner} - web-code`;
}

/**
 * Keep the title's flags live: subscribe to the worktree's git status (over
 * the shared-worker WebSocket, multiplexed across all tabs) and re-render the
 * title on every change — file edit, stage, commit, fetch. Works while the tab
 * is backgrounded, so the title acts as a Slack-style at-a-glance indicator.
 */
function liveTitle(rel: string) {
  watchStatusLive(rel, (git) => setTitle(rel, git));
}

/**
 * Provisioning failed for a reason we can't auto-handle (backend down, bad
 * response, network). Surface the error and offer to open VS Code at the
 * expected worktree path anyway — the editor still works against whatever is
 * (or isn't) on disk, so a dead/flaky provisioner never fully blocks you.
 */
function offerOpenAnyway(
  msg: HTMLElement,
  frame: HTMLIFrameElement,
  rel: string,
  folder: string,
  error?: string,
) {
  setStatus(
    msg,
    `<strong>Could not provision <code>${esc(rel)}</code></strong>` +
      `<br><pre>${esc(error || "unknown error")}</pre>` +
      `<button id="open-anyway">Open VS Code anyway</button>` +
      `<p style="opacity:.6;font-size:.9em">Opens <code>${esc(folder)}</code> directly — may be empty or stale if provisioning didn't finish.</p>`,
  );
  msg
    .querySelector<HTMLButtonElement>("#open-anyway")
    ?.addEventListener("click", () => {
      setTitle(rel);
      liveTitle(rel);
      openVscode(frame, msg, folder);
    });
}

/** Render a "Create branch" affordance and wire it to the create API. */
function offerCreateBranch(
  msg: HTMLElement,
  frame: HTMLIFrameElement,
  rel: string,
  branch: string,
) {
  const b = esc(branch);
  setStatus(
    msg,
    `<p>Branch <code>${b}</code> doesn't exist on the remote yet.</p>` +
      `<button id="create-branch">Create branch <code>${b}</code> locally</button>` +
      `<p style="opacity:.6;font-size:.9em">Branches off the repo's default branch. Not pushed — push it later from the editor or terminal.</p>`,
  );
  const btn = msg.querySelector<HTMLButtonElement>("#create-branch");
  btn?.addEventListener("click", async () => {
    btn.disabled = true;
    setStatus(msg, `Creating <code>${b}</code>…`);
    const r = await createBranchFromLocation(rel);
    if (!r.ok) {
      setStatus(
        msg,
        `<strong>Could not create <code>${b}</code></strong><br><pre>${esc(r.error || "unknown error")}</pre>`,
      );
      return;
    }
    setTitle(rel, r.git);
    liveTitle(rel);
    setStatus(msg, `${esc(statusNote(r, rel))}. Opening…`);
    openVscode(frame, msg, r.folder);
  });
}

function openVscode(
  frame: HTMLIFrameElement,
  msg: HTMLElement,
  folder: string,
) {
  frame.src = `/_vscode/?folder=${encodeURIComponent(folder)}`;
  frame.hidden = false;
  frame.addEventListener("load", () => (msg.hidden = true), { once: true });
}

main();
