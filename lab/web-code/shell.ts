/**
 * Client shell. Reads the pretty URL path and embeds VS Code web for the
 * corresponding folder.
 *
 *   https://fbi.com/<user>/<repo>/tree/<branch>
 *     -> iframe src = /_vscode/?folder=<home>/<wsRoot>/<user>/<repo>/tree/<branch>
 *
 * The `<home>` and `<wsRoot>` come from the shell server's /__config
 * endpoint, so the path is correct for whoever is running the daemon.
 */

type Config = { home: string; wsRoot: string };

async function main() {
  const msg = document.getElementById("msg") as HTMLDivElement;
  const frame = document.getElementById("frame") as HTMLIFrameElement;

  let cfg: Config;
  try {
    cfg = await (await fetch("/__config")).json();
  } catch (e) {
    msg.textContent = `Could not load /__config: ${e}`;
    return;
  }

  // Force VS Code Web to use its built-in English NLS. With a non-English
  // OS locale (e.g. ja_JP) VS Code resolves the locale from `navigator.
  // language` and fetches `…/<locale>/nls.messages.js` from
  // www.vscode-unpkg.net. That remote bundle is (a) version-mismatched —
  // producing `{0}` placeholder strings — and (b) CORS-blocked from a
  // custom origin like fbi.com, which aborts the whole workbench bootstrap
  // (blank editor, empty file tree).
  //
  // VS Code reads the locale from the `vscode.nls.locale` localStorage key
  // *and* an eponymous cookie (see `setLocale`/`doSetLocaleToCookie` in the
  // serve-web workbench bundle). The cookie is the reliable lever here
  // because it is attached to the iframe's own document request, so the
  // editor sees `en` before it computes the NLS URL. Shell and `/_vscode/`
  // are same-origin, so both stores are shared with the iframe.
  localStorage.setItem("vscode.nls.locale", "en");
  document.cookie = "vscode.nls.locale=en;path=/;max-age=3153600000";

  // Strip a leading slash; everything else is the repo path
  // (e.g. "<user>/<repo>/tree/<branch>"). Empty path -> open the ws root.
  const rel = decodeURIComponent(location.pathname.replace(/^\/+/, ""));
  const folder = rel
    ? `${cfg.home}/${cfg.wsRoot}/${rel}`
    : `${cfg.home}/${cfg.wsRoot}`;

  const src = `/_vscode/?folder=${encodeURIComponent(folder)}`;
  frame.src = src;
  frame.hidden = false;
  msg.hidden = true;
}

main();
