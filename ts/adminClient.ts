/**
 * Tiny client for the fbi-proxy loopback admin/control API.
 *
 * The running proxy publishes its (ephemeral) admin port to
 * `~/.config/fbi-proxy/runtime.json`. The `up` / `down` / `ps` CLI
 * subcommands read that file to find the port, then drive the `/rules`
 * endpoints over loopback HTTP.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

export type RuntimeInfo = {
  adminPort: number;
  proxyPort: number;
  pid: number;
  confDir: string;
};

/** A rule as reported by `GET /rules`. */
export type RuleInfo = {
  namespace: string;
  name: string;
  match: string;
  path: string | null;
  target: string;
  headers: Record<string, string>;
};

/** Default config dir, matching the Rust side + setup.ts. */
export function defaultConfigDir(): string {
  const fromEnv = process.env.FBI_PROXY_CONF_DIR;
  if (fromEnv && fromEnv.length > 0) {
    // FBI_PROXY_CONF_DIR points at conf.d; runtime.json sits beside it.
    return path.dirname(fromEnv);
  }
  return path.join(os.homedir(), ".config/fbi-proxy");
}

function runtimeJsonPath(): string {
  return path.join(defaultConfigDir(), "runtime.json");
}

/**
 * Locate the running proxy's admin endpoint. Throws a helpful error if
 * the proxy doesn't appear to be running.
 */
export function readRuntime(): RuntimeInfo {
  const p = runtimeJsonPath();
  if (!existsSync(p)) {
    throw new Error(
      `[fbi-proxy] no running proxy found (missing ${p}).\n` +
        `  Start it first: \`fbi-proxy setup\` (daemon) or \`fbi-proxy --tls --domain <d>\`.`,
    );
  }
  let info: RuntimeInfo;
  try {
    info = JSON.parse(readFileSync(p, "utf8"));
  } catch (e) {
    throw new Error(`[fbi-proxy] could not parse ${p}: ${e}`);
  }
  if (!info.adminPort) {
    throw new Error(
      `[fbi-proxy] ${p} has no adminPort — is the proxy up to date?`,
    );
  }
  return info;
}

function baseUrl(info: RuntimeInfo): string {
  return `http://127.0.0.1:${info.adminPort}`;
}

async function asError(res: Response): Promise<never> {
  let msg = `${res.status} ${res.statusText}`;
  try {
    const body = await res.json();
    if (body?.error) msg = body.error;
  } catch {
    // non-JSON body; keep the status line
  }
  throw new Error(`[fbi-proxy] admin API: ${msg}`);
}

/** GET /rules — the full merged rule table. */
export async function listRules(info = readRuntime()): Promise<RuleInfo[]> {
  const res = await fetch(`${baseUrl(info)}/rules`);
  if (!res.ok) await asError(res);
  return (await res.json()) as RuleInfo[];
}

/** PUT /rules/{namespace} — reconcile a namespace to `yamlBody`. */
export async function applyRules(
  namespace: string,
  yamlBody: string,
  info = readRuntime(),
): Promise<RuleInfo[]> {
  const res = await fetch(
    `${baseUrl(info)}/rules/${encodeURIComponent(namespace)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/yaml" },
      body: yamlBody,
    },
  );
  if (!res.ok) await asError(res);
  return (await res.json()) as RuleInfo[];
}

/** DELETE /rules/{namespace} — remove a namespace's fragment. */
export async function deleteRules(
  namespace: string,
  info = readRuntime(),
): Promise<{ ok: boolean; removed: boolean }> {
  const res = await fetch(
    `${baseUrl(info)}/rules/${encodeURIComponent(namespace)}`,
    {
      method: "DELETE",
    },
  );
  if (!res.ok) await asError(res);
  return (await res.json()) as { ok: boolean; removed: boolean };
}
