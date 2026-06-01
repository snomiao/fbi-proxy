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

type Config = { home: string; wsRoot: string };

type ProvisionResult = {
  ok: boolean;
  folder: string;
  existed: boolean;
  action: "cloned" | "pulled" | "fetched" | "none" | "error";
  git?: {
    branch: string;
    head: string;
    ahead: number;
    behind: number;
    dirty: boolean;
  };
  error?: string;
};

function setStatus(msg: HTMLElement, html: string) {
  msg.innerHTML = html;
  msg.hidden = false;
}

async function main() {
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
  setStatus(msg, `Provisioning <code>${rel}</code>…`);
  let result: ProvisionResult;
  try {
    const res = await fetch(`/api/repo/${rel}`);
    result = await res.json();
  } catch (e) {
    setStatus(msg, `Provisioning request failed: ${e}`);
    return;
  }

  if (!result.ok) {
    setStatus(
      msg,
      `<strong>Could not provision <code>${rel}</code></strong><br><pre>${(result.error || "unknown error").replace(/</g, "&lt;")}</pre>`,
    );
    return;
  }

  const g = result.git;
  const note = [
    result.action === "cloned"
      ? "cloned"
      : result.existed
        ? result.action
        : "ready",
    g ? `@ ${g.head}` : "",
    g && g.dirty ? "· local changes" : "",
    g && g.behind ? `· ${g.behind} behind` : "",
    g && g.ahead ? `· ${g.ahead} ahead` : "",
  ]
    .filter(Boolean)
    .join(" ");
  setStatus(msg, `<code>${rel}</code> — ${note}. Opening…`);

  openVscode(frame, msg, result.folder);
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
