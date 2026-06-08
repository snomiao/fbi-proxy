/**
 * Launcher for the web-code lab.
 *
 *  1. spawn `code serve-web` on :9999 with base path /_vscode/
 *  2. spawn the vite shell on :3001
 *  3. `fbi-proxy up`   — register the two routes with the running proxy
 *  4. on exit, `fbi-proxy down` — clean up our namespace
 *
 * Prereqs: a running fbi-proxy daemon (`fbi-proxy setup`) and the `code`
 * CLI on PATH (VS Code: "Shell Command: Install 'code' command in PATH").
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VSCODE_PORT = 9999;
const VSCODE_BASE = "/_vscode/";
// Lab-local server data dir so we can pre-seed settings (and not pollute
// the user's global ~/.vscode-server).
const VSCODE_DATA_DIR = path.join(HERE, ".vscode-serve-web");

// Each long-lived child is supervised: if it dies while we're still up
// (e.g. vite gets SIGTERM'd, or VS Code's server crashes), we respawn it
// with exponential backoff instead of leaving a half-dead daemon. Before
// this, a single vite-shell death left the launcher — and so oxmgr —
// reporting "running" while :3001 was gone, so the proxy served 502s for
// the fbi.com apex.
const children = new Map<string, ChildProcess>();
let shuttingDown = false;

// Supervisor backoff/guard tuning.
const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
// A child that stayed up at least this long is treated as healthy, so its
// next death restarts the backoff from zero rather than counting as part of
// a crash loop.
const STABLE_MS = 10_000;

/**
 * Pre-seed VS Code's User settings for the embedded serve-web instance.
 * Workspace Trust is disabled so opening a folder via `?folder=` shows the
 * file tree immediately instead of starting in restricted mode (which
 * otherwise leaves the Explorer empty until you click "Trust"). This is an
 * embedded, single-user dev tool, so the trust gate adds only friction.
 */
function seedVscodeSettings(): void {
  const userDir = path.join(VSCODE_DATA_DIR, "data", "User");
  mkdirSync(userDir, { recursive: true });
  writeFileSync(
    path.join(userDir, "settings.json"),
    JSON.stringify(
      {
        "security.workspace.trust.enabled": false,
        "workbench.startupEditor": "none",
      },
      null,
      2,
    ),
  );
}

// On Windows, `code`/`bun`/`bunx` resolve to .cmd/.bat shims that Node's
// spawn can't exec directly — it needs a shell. Harmless on Unix.
const NEEDS_SHELL = process.platform === "win32";

function supervise(cmd: string, args: string[], label: string): void {
  let restarts = 0;
  let startedAt = 0;

  const start = () => {
    if (shuttingDown) return;
    console.log(`[web-code] starting ${label}: ${cmd} ${args.join(" ")}`);
    // Pin cwd to this lab dir so vite resolves ./vite.config.ts (and its
    // /__config + /api/repo middleware, multi-page input, react plugin)
    // regardless of where the launcher was invoked from. Without this,
    // `bun lab/web-code/start.ts` from the repo root starts vite with the
    // repo root as its root → no config, no index.html, every route 404s.
    const child = spawn(cmd, args, {
      stdio: "inherit",
      shell: NEEDS_SHELL,
      cwd: HERE,
    });
    startedAt = Date.now();
    children.set(label, child);
    child.on("exit", (code, signal) => {
      children.delete(label);
      if (shuttingDown) return;
      // A healthy long run clears the crash counter so a one-off death
      // respawns immediately; only rapid repeat crashes get backed off.
      if (Date.now() - startedAt >= STABLE_MS) restarts = 0;
      restarts++;
      const delay = Math.min(
        MAX_BACKOFF_MS,
        BASE_BACKOFF_MS * 2 ** (restarts - 1),
      );
      console.log(
        `[web-code] ${label} exited (${signal ?? code}); respawning #${restarts} in ${delay}ms`,
      );
      setTimeout(start, delay);
    });
  };

  start();
}

function fbiProxy(args: string[], opts: { quiet?: boolean } = {}): number {
  // Resolve the repo CLI relative to this lab dir so it works in-tree.
  const cli = path.resolve(HERE, "../../ts/cli.ts");
  const res = spawnSync("bun", [cli, ...args], {
    stdio: opts.quiet ? "ignore" : "inherit",
    cwd: HERE,
    shell: NEEDS_SHELL,
  });
  return res.status ?? 1;
}

async function main() {
  // 1. VS Code web server
  seedVscodeSettings();
  supervise(
    "code",
    [
      "serve-web",
      "--port",
      String(VSCODE_PORT),
      "--server-base-path",
      VSCODE_BASE,
      "--server-data-dir",
      VSCODE_DATA_DIR,
      "--without-connection-token",
      "--accept-server-license-terms",
    ],
    "code serve-web",
  );

  // 2. vite shell (serves the iframe page, /api, and the wtx terminal page)
  supervise("bunx", ["vite", "--port", "3001", "--strictPort"], "vite shell");

  // 3. wtx PTY WebSocket server (web terminal backend, ?ui=wtx)
  supervise("bun", [path.join(HERE, "lib", "wtx", "wtx.mjs")], "wtx terminal");

  // Give them a moment, then register routes.
  await new Promise((r) => setTimeout(r, 1500));

  // 3. apply routes — retry until the proxy daemon accepts them. Under oxmgr
  // at boot, this lab and the fbi-proxy daemon are restored in undefined
  // order; if we win the race the proxy isn't listening yet, so a single
  // `up` would fail and the routes would silently never register (the three
  // child servers would still be "running"). Loop until it sticks.
  let up = 1;
  for (let i = 0; i < 60; i++) {
    up = fbiProxy(["up"], { quiet: true });
    if (up === 0) break;
    if (i === 0)
      console.log("[web-code] waiting for fbi-proxy daemon to accept routes…");
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (up !== 0) {
    // One last loud attempt so the actual CLI error reaches the logs.
    up = fbiProxy(["up"]);
  }
  if (up !== 0) {
    console.error(
      "[web-code] `fbi-proxy up` failed after retries — is the proxy running?",
    );
  } else {
    console.log(
      "[web-code] routes applied.\n" +
        "  VS Code : https://fbi.com/<owner>/<repo>/tree/<branch>\n" +
        "  Terminal: https://fbi.com/<owner>/<repo>/tree/<branch>?ui=wtx",
    );
  }

  // 4. cleanup on exit
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true; // stop supervisors from respawning during teardown
    console.log("\n[web-code] shutting down…");
    fbiProxy(["down"]);
    for (const c of children.values()) c.kill();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
