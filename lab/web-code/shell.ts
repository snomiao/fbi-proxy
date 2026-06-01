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
  type Config,
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
    openVscode(frame, msg, `${cfg.home}/${cfg.wsRoot}`);
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
    setStatus(
      msg,
      `<strong>Could not provision <code>${esc(rel)}</code></strong><br><pre>${esc(result.error || "unknown error")}</pre>`,
    );
    return;
  }

  setStatus(msg, `${esc(statusNote(result, rel))}. Opening…`);
  openVscode(frame, msg, result.folder);
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
