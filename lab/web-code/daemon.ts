/**
 * Register the web-code lab under oxmgr so it runs as a managed, auto-restarting
 * daemon (and is restored at boot) instead of a foreground `bun run dev`.
 *
 * It wraps the same launcher (`start.ts`) as a single oxmgr process — start.ts
 * already orchestrates its three child servers (code serve-web, vite shell, wtx
 * PTY) plus `fbi-proxy up`/`down`, so one managed process keeps that lifecycle
 * intact. The launcher retries `fbi-proxy up` until the proxy answers, so boot
 * ordering between this and the `fbi-proxy` daemon doesn't matter.
 *
 *   bun daemon.ts              register + start (idempotent) + persist at boot
 *   bun daemon.ts --uninstall  stop and remove the managed process
 *
 * Prereqs: `oxmgr` on PATH (`brew install oxmgr` / `npm i -g oxmgr`) and a
 * running fbi-proxy daemon (`fbi-proxy setup`).
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OXMGR_NAME = "web-code-lab";

function uninstall(): void {
  console.log(`[daemon] removing oxmgr process "${OXMGR_NAME}"…`);
  spawnSync("oxmgr", ["delete", OXMGR_NAME], { stdio: "inherit" });
}

function install(): void {
  // The bun running this script is the bun we want oxmgr to use. An absolute
  // path makes token 0 of the command resolvable even before oxmgr applies the
  // injected PATH (the child `code`/`bunx` spawns still need PATH below).
  const bun = process.execPath;
  const home = process.env.HOME!;
  const startTs = path.join(HERE, "start.ts");

  console.log(`[daemon] registering "${OXMGR_NAME}" → ${bun} ${startTs}`);

  // Idempotent: drop any prior registration first (best-effort).
  spawnSync("oxmgr", ["delete", OXMGR_NAME], { stdio: "ignore" });

  const res = spawnSync(
    "oxmgr",
    [
      "start",
      "--name",
      OXMGR_NAME,
      "--restart",
      "always",
      "--cwd",
      HERE,
      "--env",
      `HOME=${home}`,
      // start.ts spawns `code`, `bunx vite`, and `bun` — they must resolve on
      // the daemon's PATH, which is not the interactive shell's by default.
      "--env",
      `PATH=${process.env.PATH || "/usr/local/bin:/usr/bin:/bin"}`,
      `${bun} ${startTs}`,
    ],
    { stdio: "inherit" },
  );
  if (res.status !== 0) {
    console.error(
      "[daemon] oxmgr start failed — is `oxmgr` installed? (`brew install oxmgr` / `npm i -g oxmgr`)",
    );
    process.exit(res.status ?? 1);
  }

  // Persist the daemon across reboots (writes the LaunchAgent if not already).
  spawnSync("oxmgr", ["service", "install"], { stdio: "ignore" });

  console.log(
    `[daemon] "${OXMGR_NAME}" is managed.\n` +
      `  status: oxmgr status ${OXMGR_NAME}\n` +
      `  logs:   oxmgr logs ${OXMGR_NAME}\n` +
      `  stop:   bun daemon.ts --uninstall  (or: oxmgr stop ${OXMGR_NAME})`,
  );
}

const uninstallFlag = process.argv.slice(2).includes("--uninstall");
if (uninstallFlag) uninstall();
else install();
