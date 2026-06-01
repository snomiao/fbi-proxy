/**
 * Web-terminal UI (`?ui=wtx`). Mounts the wtx React xterm terminal,
 * connected to the wtx PTY server proxied at `/_wtx/`, opened in the
 * same local worktree the gateway provisioned.
 *
 * The repo is provisioned by the same /api/repo endpoint the VS Code
 * path uses, so the terminal opens in a checkout that's guaranteed to
 * exist and be fresh.
 */

import "@xterm/xterm/css/xterm.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { WTx } from "./lib/wtx/lib/wtx-react/src";
import { provisionFromLocation, type Config } from "./provision-client";

async function main() {
  const root = createRoot(document.getElementById("root")!);
  const status = document.getElementById("status")!;

  let cfg: Config;
  try {
    cfg = await (await fetch("/__config")).json();
  } catch (e) {
    status.textContent = `Could not load /__config: ${e}`;
    return;
  }

  // Repo path arrives as `?repo=<owner>/<repo>/tree/<branch>` (the shell
  // hands off here so terminal.html is served at a clean URL).
  const rel = new URLSearchParams(location.search).get("repo") ?? "";
  let cwd: string;
  if (!rel) {
    cwd = cfg.wsRoot;
  } else {
    status.textContent = `Provisioning ${rel}…`;
    const res = await provisionFromLocation(rel);
    if (!res.ok) {
      status.textContent = `Could not provision ${rel}: ${res.error ?? "error"}`;
      return;
    }
    cwd = res.folder;
  }

  status.hidden = true;
  root.render(
    <StrictMode>
      <WTx wsUrl="/_wtx/" cwd={cwd} />
    </StrictMode>,
  );
}

main();
