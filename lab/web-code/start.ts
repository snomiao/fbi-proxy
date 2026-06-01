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

const children: ChildProcess[] = [];

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

function run(cmd: string, args: string[], label: string): ChildProcess {
  console.log(`[web-code] starting ${label}: ${cmd} ${args.join(" ")}`);
  const child = spawn(cmd, args, { stdio: "inherit" });
  child.on("exit", (code) =>
    console.log(`[web-code] ${label} exited (${code})`),
  );
  children.push(child);
  return child;
}

function fbiProxy(args: string[]): number {
  // Resolve the repo CLI relative to this lab dir so it works in-tree.
  const cli = path.resolve(HERE, "../../ts/cli.ts");
  const res = spawnSync("bun", [cli, ...args], { stdio: "inherit", cwd: HERE });
  return res.status ?? 1;
}

async function main() {
  // 1. VS Code web server
  seedVscodeSettings();
  run(
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
  run("bunx", ["vite", "--port", "3001", "--strictPort"], "vite shell");

  // 3. wtx PTY WebSocket server (web terminal backend, ?ui=wtx)
  run("bun", [path.join(HERE, "lib", "wtx", "wtx.mjs")], "wtx terminal");

  // Give them a moment, then register routes.
  await new Promise((r) => setTimeout(r, 1500));

  // 3. apply routes
  const up = fbiProxy(["up"]);
  if (up !== 0) {
    console.error("[web-code] `fbi-proxy up` failed — is the proxy running?");
  } else {
    console.log(
      "[web-code] routes applied.\n" +
        "  VS Code : https://fbi.com/<owner>/<repo>/tree/<branch>\n" +
        "  Terminal: https://fbi.com/<owner>/<repo>/tree/<branch>?ui=wtx",
    );
  }

  // 4. cleanup on exit
  const shutdown = () => {
    console.log("\n[web-code] shutting down…");
    fbiProxy(["down"]);
    for (const c of children) c.kill();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
