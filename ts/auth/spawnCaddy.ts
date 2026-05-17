import { existsSync } from "node:fs";
import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { $ } from "../dSpawn";
import { downloadCaddy } from "./downloadCaddy";

export type CaddyHandle = {
  pid: number | undefined;
  caddyfilePath: string;
  binary: string;
  kill: () => void;
};

/**
 * Resolve the Caddy binary, preferring (in order):
 *   1. `CADDY_BIN` env var
 *   2. `caddy` on $PATH (homebrew, apt, scoop, xcaddy, …)
 *   3. `~/.fbi-proxy/bin/caddy` (previously auto-downloaded)
 *   4. Auto-download the latest release from GitHub, verify SHA-512,
 *      install to `~/.fbi-proxy/bin/caddy`, and use it.
 *
 * Set `FBI_CADDY_AUTO_DOWNLOAD=false` to disable step 4 (e.g. for
 * air-gapped environments). When disabled and steps 1-3 all miss,
 * returns `null` so the CLI can print a helpful error.
 */
export async function resolveCaddyBinary(): Promise<string | null> {
  const fromEnv = process.env.CADDY_BIN;
  if (fromEnv && (await isExecutable(fromEnv))) return fromEnv;

  const fromPath = await whichCaddy();
  if (fromPath) return fromPath;

  const downloaded = join(homedir(), ".fbi-proxy", "bin", "caddy");
  if (existsSync(downloaded) && (await isExecutable(downloaded))) {
    return downloaded;
  }

  if (process.env.FBI_CADDY_AUTO_DOWNLOAD === "false") {
    return null;
  }

  try {
    console.log(
      "[caddy] no binary found — downloading the latest release from GitHub (~30 MB).",
    );
    console.log("[caddy] (set FBI_CADDY_AUTO_DOWNLOAD=false to opt out)");
    const path = await downloadCaddy({
      log: (m) => console.log(`[caddy-download] ${m}`),
    });
    return path;
  } catch (err) {
    console.error(`[caddy] auto-download failed: ${(err as Error).message}`);
    return null;
  }
}

export function caddyNotFoundMessage(): string {
  return [
    "",
    "[fbi-proxy] --with-caddy was passed but Caddy could not be found or downloaded.",
    "",
    "Auto-download from GitHub Releases is the default — if you saw a",
    "download error above, check your network or set FBI_CADDY_AUTO_DOWNLOAD=false",
    "and install Caddy manually:",
    "",
    "  - macOS:    brew install caddy",
    "  - Debian:   sudo apt install caddy   (or see https://caddyserver.com/docs/install)",
    "  - Windows:  scoop install caddy      (or: winget install CaddyServer.Caddy)",
    "  - Manual:   https://caddyserver.com/download",
    "",
    "Or point fbi-proxy at an existing binary:",
    "  CADDY_BIN=/path/to/caddy bunx fbi-proxy --with-caddy --domain <your-domain>",
    "",
  ].join("\n");
}

/**
 * Spawn `caddy run --config <caddyfilePath>` as a tracked child process.
 *
 * The caller is expected to have already verified the binary is reachable via
 * `resolveCaddyBinary()`. If you pass a custom binary path via `opts.binary`,
 * we use it directly.
 */
export async function spawnCaddy(opts: {
  caddyfilePath: string;
  binary?: string;
}): Promise<CaddyHandle | null> {
  const binary = opts.binary ?? (await resolveCaddyBinary());
  if (!binary) return null;

  console.log(`[caddy] using binary: ${binary}`);
  console.log(`[caddy] config: ${opts.caddyfilePath}`);

  const proc =
    $`${binary} run --config ${opts.caddyfilePath} --adapter caddyfile`.process;

  proc.on("exit", (code) => {
    console.log(`[caddy] exited with code ${code}`);
  });

  return {
    pid: proc.pid,
    caddyfilePath: opts.caddyfilePath,
    binary,
    kill: () => proc.kill?.(),
  };
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function whichCaddy(): Promise<string | null> {
  const result = await $`which caddy`.catch(() => null);
  if (!result || result.code !== 0) return null;
  const out = result.out.trim();
  return out.length > 0 ? out.split("\n")[0]!.trim() : null;
}
