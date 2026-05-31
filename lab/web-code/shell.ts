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

  // Strip a leading slash; everything else is the repo path
  // (e.g. "snomiao/rechrome/tree/main"). Empty path -> open the ws root.
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
