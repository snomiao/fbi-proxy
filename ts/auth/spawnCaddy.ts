import { existsSync } from "node:fs";
import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { $ } from "../dSpawn";

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
 *   3. `~/.fbi-proxy/bin/caddy` (Phase 3.1: auto-downloaded)
 *
 * Returns `null` if none are present, so the CLI can print a helpful error.
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

  return null;
}

export function caddyNotFoundMessage(): string {
  return [
    "",
    "[fbi-proxy] --with-caddy was passed but no Caddy binary was found.",
    "",
    "Install Caddy via one of:",
    "  - macOS:    brew install caddy",
    "  - Debian:   sudo apt install caddy   (or see https://caddyserver.com/docs/install)",
    "  - Windows:  scoop install caddy      (or: winget install CaddyServer.Caddy)",
    "  - Manual:   https://caddyserver.com/download",
    "",
    "Or point fbi-proxy at an existing binary:",
    "  CADDY_BIN=/path/to/caddy bunx fbi-proxy --with-caddy --domain <your-domain>",
    "",
    "(Phase 3.1 will auto-download Caddy from the GitHub release if it's missing.)",
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
