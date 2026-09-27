/**
 * `fbi-proxy serve <host> <target>` — tailscale-serve-style HTTPS
 * exposure of a local service at `https://<host>/`, fronted by a
 * fbi-proxy-managed Caddy instance.
 *
 *   fbi-proxy serve myapp 3000                # https://myapp.fbi.com → localhost:3000
 *   fbi-proxy serve api.example.test :8080    # any host; bare names get .fbi.com
 *   fbi-proxy serve --bg docs http://127.0.0.1:4000
 *   fbi-proxy serve myapp off                 # remove one
 *   fbi-proxy serve status | reset
 *
 * The managed Caddy is separate from any Caddy you run yourself: it has
 * its own admin address (FBI_SERVE_ADMIN, default 127.0.0.1:2430) and
 * never persists config. `~/.config/fbi-proxy/serve.json` is the source
 * of truth; every change rebuilds the whole Caddy config from it and
 * POSTs it to `/load`. Foreground serves record their PID and are pruned
 * once that process is gone.
 */

import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { lookup } from "node:dns/promises";
import net from "node:net";
import path from "node:path";
import yargs from "yargs";
import { defaultConfigDir } from "./adminClient";
import { caddyNotFoundMessage, resolveCaddyBinary } from "./auth/spawnCaddy";

const ADMIN = process.env.FBI_SERVE_ADMIN || "127.0.0.1:2430";
const DEFAULT_DOMAIN = process.env.FBI_SERVE_DOMAIN || "fbi.com";

export type TlsMode = "internal" | "acme";

export type ServeEntry = {
  target: string;
  tls: TlsMode;
  /** Rewrite the upstream Host header to the target's host:port. */
  rewriteHost: boolean;
  /** Owning foreground process; absent for `--bg` entries. */
  pid?: number;
};

export type ServeState = {
  bind: string;
  httpsPort: number;
  routes: Record<string, ServeEntry>;
};

export type ParsedTarget = {
  dial: string;
  tls: false | "verify" | "insecure";
};

const statePath = () => path.join(defaultConfigDir(), "serve.json");
const logPath = () => path.join(defaultConfigDir(), "serve-caddy.log");

/** `myapp` → `myapp.fbi.com`; anything with a dot is taken as a full host. */
export function normalizeHost(input: string, domain = DEFAULT_DOMAIN): string {
  let host = input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");
  if (!host.includes(".")) host = `${host}.${domain.replace(/^\./, "")}`;
  if (!/^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) {
    throw new Error(`[serve] invalid host '${input}'`);
  }
  return host;
}

/**
 * Accepts the same shapes as `tailscale serve`: `3000`, `:3000`,
 * `localhost:3000`, `http://host:port`, `https://host[:port]`,
 * `https+insecure://host:port`. Paths aren't supported yet.
 */
export function parseTarget(input: string): ParsedTarget {
  const t = input.trim();
  if (/^:?\d+$/.test(t))
    return { dial: `localhost:${t.replace(/^:/, "")}`, tls: false };
  const m = t.match(/^(https\+insecure|https|http):\/\/(.+)$/i);
  const scheme = m?.[1]?.toLowerCase() ?? "http";
  const rest = m?.[2] ?? t;
  const slash = rest.indexOf("/");
  const hostport = slash < 0 ? rest : rest.slice(0, slash);
  const pathPart = slash < 0 ? "" : rest.slice(slash);
  if (pathPart && pathPart !== "/") {
    throw new Error(`[serve] target paths aren't supported yet ('${input}')`);
  }
  if (!hostport) throw new Error(`[serve] invalid target '${input}'`);
  const hasPort = /:\d+$/.test(hostport) || /^\[.*\]:\d+$/.test(hostport);
  const defaultPort = scheme === "http" ? 80 : 443;
  const dial = hasPort ? hostport : `${hostport}:${defaultPort}`;
  const tls =
    scheme === "http" ? false : scheme === "https" ? "verify" : "insecure";
  return { dial, tls };
}

/** Build the complete Caddy JSON config for the managed instance. */
export function buildCaddyConfig(state: ServeState) {
  const hosts = Object.keys(state.routes).sort();
  const routes = hosts.map((host) => {
    const e = state.routes[host]!;
    const t = parseTarget(e.target);
    const handler: Record<string, unknown> = {
      handler: "reverse_proxy",
      upstreams: [{ dial: t.dial }],
    };
    if (t.tls) {
      handler.transport = {
        protocol: "http",
        tls: t.tls === "insecure" ? { insecure_skip_verify: true } : {},
      };
    }
    if (e.rewriteHost) {
      handler.headers = {
        request: { set: { Host: ["{http.reverse_proxy.upstream.hostport}"] } },
      };
    }
    return {
      "@id": `fbi-serve:${host}`,
      match: [{ host: [host] }],
      handle: [handler],
      terminal: true,
    };
  });
  const acmeHosts = hosts.filter((h) => state.routes[h]!.tls === "acme");
  return {
    admin: { listen: ADMIN, config: { persist: false } },
    apps: {
      http: {
        https_port: state.httpsPort,
        servers: {
          fbi_serve: {
            listen: [hostPort(state.bind, state.httpsPort)],
            routes,
            // No :80 redirect listener — keeps us off ports other servers own.
            automatic_https: { disable_redirects: true },
          },
        },
      },
      tls: {
        automation: {
          policies: [
            ...(acmeHosts.length ? [{ subjects: acmeHosts }] : []),
            { issuers: [{ module: "internal" }] },
          ],
        },
      },
    },
  };
}

/** `host:port`, bracketing IPv6 literals (`::1` → `[::1]:443`). */
export function hostPort(host: string, port: number): string {
  return host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`;
}

function readState(): ServeState {
  const p = statePath();
  const fallback: ServeState = {
    bind: "127.0.0.1",
    httpsPort: 443,
    routes: {},
  };
  if (!existsSync(p)) return fallback;
  try {
    return { ...fallback, ...JSON.parse(readFileSync(p, "utf8")) };
  } catch (e) {
    throw new Error(`[serve] could not parse ${p}: ${e}`);
  }
}

function writeState(state: ServeState): void {
  const p = statePath();
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(`${p}.tmp`, JSON.stringify(state, null, 2) + "\n");
  renameSync(`${p}.tmp`, p);
}

/**
 * Serialize read → apply → write across concurrent `serve` commands, so two
 * terminals (or a Ctrl+C racing a new serve) can't drop each other's routes.
 * A lock older than 30s is assumed to belong to a crashed process.
 */
async function withStateLock<T>(fn: () => Promise<T>): Promise<T> {
  const lock = `${statePath()}.lock`;
  mkdirSync(path.dirname(lock), { recursive: true });
  for (let waited = 0; ; waited += 100) {
    try {
      mkdirSync(lock);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      try {
        if (Date.now() - statSync(lock).mtimeMs > 30_000) {
          rmSync(lock, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue; // released between mkdir and stat
      }
      if (waited >= 15_000)
        throw new Error(`[serve] timed out waiting for ${lock}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Drop foreground entries whose serving process has exited. */
function prune(state: ServeState): ServeState {
  const routes = Object.fromEntries(
    Object.entries(state.routes).filter(
      ([, e]) => e.pid === undefined || isAlive(e.pid),
    ),
  );
  return { ...state, routes };
}

async function adminFetch(
  pathname: string,
  init?: RequestInit,
): Promise<Response> {
  return fetch(`http://${ADMIN}${pathname}`, {
    ...init,
    signal: AbortSignal.timeout(5000),
  });
}

async function caddyRunning(): Promise<boolean> {
  try {
    return (await adminFetch("/config/")).ok;
  } catch {
    return false;
  }
}

function portAnswers(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const done = (v: boolean) => {
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(500, () => done(false));
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
  });
}

/**
 * Refuse to start on a port something else already answers on. On Windows a
 * specific-address bind can succeed next to another process's wildcard
 * listener and silently steal its loopback traffic, so Caddy's own bind
 * error isn't enough.
 */
async function assertPortFree(state: ServeState): Promise<void> {
  const probeHost =
    state.bind === "0.0.0.0" || state.bind === ""
      ? "127.0.0.1"
      : state.bind === "::"
        ? "::1"
        : state.bind;
  if (await portAnswers(probeHost, state.httpsPort)) {
    throw new Error(
      `[serve] ${probeHost}:${state.httpsPort} is already in use by another server ` +
        `(your own Caddy/nginx?). The managed Caddy would shadow it.\n` +
        `  Pick another port:  fbi-proxy serve --https 8443 <host> <target>`,
    );
  }
}

async function startCaddy(): Promise<void> {
  const binary = await resolveCaddyBinary();
  if (!binary) throw new Error(caddyNotFoundMessage());
  const dir = defaultConfigDir();
  mkdirSync(dir, { recursive: true });
  const bootstrap = path.join(dir, "serve-caddy.bootstrap.json");
  writeFileSync(
    bootstrap,
    JSON.stringify({ admin: { listen: ADMIN, config: { persist: false } } }),
  );
  const log = openSync(logPath(), "a");
  const child = spawn(binary, ["run", "--config", bootstrap], {
    detached: true,
    stdio: ["ignore", log, log],
    windowsHide: true,
  });
  child.unref();
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (await caddyRunning()) {
      console.log(
        `[serve] started managed Caddy (pid ${child.pid}, admin ${ADMIN})`,
      );
      return;
    }
  }
  throw new Error(`[serve] managed Caddy didn't come up — see ${logPath()}`);
}

async function stopCaddy(): Promise<void> {
  if (!(await caddyRunning())) return;
  await adminFetch("/stop", { method: "POST" }).catch(() => {});
  console.log("[serve] no routes left — stopped managed Caddy");
}

/** Push `state` to the managed Caddy, starting or stopping it as needed. */
async function apply(state: ServeState, prev: ServeState): Promise<void> {
  if (Object.keys(state.routes).length === 0) return stopCaddy();
  const running = await caddyRunning();
  const listenerChanged =
    prev.bind !== state.bind || prev.httpsPort !== state.httpsPort;
  if (!running || listenerChanged) await assertPortFree(state);
  if (!running) await startCaddy();
  const res = await adminFetch("/load", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(buildCaddyConfig(state)),
  });
  if (!res.ok) {
    const reason = (await res.text()).trim();
    // Don't leave a Caddy we just started running with no routes; the next
    // call would take it for a healthy instance and nothing would stop it.
    if (!running) await adminFetch("/stop", { method: "POST" }).catch(() => {});
    throw new Error(`[serve] Caddy rejected the config: ${reason}`);
  }
  // Marker-guarded, so cheap to call every time — and it still runs when a
  // retry finds Caddy already up after an earlier failed start.
  await trustLocalCa();
}

/** Install Caddy's local CA into the system trust store (idempotent). */
async function trustLocalCa(): Promise<void> {
  if (process.env.FBI_SERVE_NO_TRUST === "1") return;
  const marker = path.join(defaultConfigDir(), "serve-caddy.trusted");
  if (existsSync(marker)) return;
  const binary = await resolveCaddyBinary();
  if (!binary) return;
  console.log(
    "[serve] installing Caddy's local CA into the system trust store (may prompt)…",
  );
  const r = spawnSync(binary, ["trust", "--address", ADMIN], {
    stdio: "inherit",
  });
  if (r.status === 0) writeFileSync(marker, new Date().toISOString() + "\n");
  else
    console.log(
      "[serve] trust install failed — browsers will warn until you run `caddy trust`",
    );
}

async function warnIfNotLoopback(host: string): Promise<void> {
  const probe = host.replace(/^\*\./, "x.");
  try {
    const { address } = await lookup(probe);
    if (!address.startsWith("127.") && address !== "::1") {
      console.log(
        `[serve] note: ${probe} resolves to ${address}, not this machine's loopback`,
      );
    }
  } catch {
    console.log(
      `[serve] note: ${probe} doesn't resolve — add it to your hosts file or DNS`,
    );
  }
}

function urlFor(host: string, state: ServeState): string {
  return `https://${host}${state.httpsPort === 443 ? "" : `:${state.httpsPort}`}/`;
}

function printStatus(state: ServeState, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(state, null, 2));
    return;
  }
  const hosts = Object.keys(state.routes).sort();
  if (hosts.length === 0) {
    console.log("No serve config");
    return;
  }
  for (const host of hosts) {
    const e = state.routes[host]!;
    const mode = e.pid === undefined ? "bg" : `fg pid ${e.pid}`;
    console.log(
      `${urlFor(host, state)}  →  ${e.target}   (${mode}, tls ${e.tls})`,
    );
  }
}

export async function runServe(rawArgs: string[]): Promise<number> {
  const argv = await yargs(rawArgs)
    .scriptName("fbi-proxy serve")
    .usage(
      "$0 <host> <target>\n$0 <host> off\n$0 status [--json]\n$0 reset\n\n" +
        "Expose a local service at https://<host>/ via a managed Caddy.\n" +
        "A bare <host> like 'myapp' becomes myapp.fbi.com (every *.fbi.com resolves to 127.0.0.1).\n" +
        "<target>: 3000 | localhost:3000 | http://host:port | https://host | https+insecure://host:port",
    )
    .option("bg", {
      type: "boolean",
      default: false,
      description: "Keep serving after this command exits",
    })
    .option("https", {
      type: "number",
      description: "HTTPS port for the managed Caddy (sticky; default 443)",
    })
    .option("bind", {
      type: "string",
      description:
        "Listen address for the managed Caddy (sticky; default 127.0.0.1)",
    })
    .option("domain", {
      type: "string",
      default: DEFAULT_DOMAIN,
      description: "Suffix for bare host names",
    })
    .option("tls", {
      type: "string",
      choices: ["internal", "acme"] as const,
      default: "internal",
      description:
        "internal = Caddy local CA; acme = public cert (host must be publicly reachable)",
    })
    .option("rewrite-host", {
      type: "boolean",
      description:
        "Send the target's host:port as Host upstream (default: on for https targets). Helps dev servers that reject unknown hosts (e.g. Vite allowedHosts)",
    })
    .option("json", { type: "boolean", default: false })
    .strictOptions()
    .help().argv;

  const [first, second] = argv._.map(String);
  try {
    const result = await withStateLock(() => mutate(argv, first, second));
    if (result.code !== undefined) return result.code;
    const { host } = result;
    console.log("Press Ctrl+C to stop.");
    return await new Promise<number>((resolve) => {
      const keepAlive = setInterval(() => {}, 1 << 30);
      const stop = async () => {
        clearInterval(keepAlive);
        try {
          await withStateLock(async () => {
            const before = readState();
            const after = prune(before);
            if (after.routes[host]?.pid === process.pid)
              delete after.routes[host];
            await apply(after, before);
            writeState(after);
          });
          console.log(`
[serve] stopped serving ${host}`);
        } catch (e) {
          console.error(e instanceof Error ? e.message : String(e));
        }
        resolve(0);
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      process.once("SIGHUP", stop);
    });
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 1;
  }
}

/**
 * The locked part of a `serve` command. Returns an exit code, or the host a
 * foreground serve should keep alive until Ctrl+C.
 */
async function mutate(
  argv: {
    https?: number;
    bind?: string;
    json: boolean;
    domain: string;
    tls: string;
    bg: boolean;
    "rewrite-host"?: boolean;
  },
  first: string | undefined,
  second: string | undefined,
): Promise<{ code: number } | { code?: undefined; host: string }> {
  const prev = readState();
  let state = prune(prev);
  if (argv.https !== undefined) state.httpsPort = argv.https;
  if (argv.bind !== undefined) state.bind = argv.bind;

  if (!first || first === "status") {
    const changed = JSON.stringify(state) !== JSON.stringify(prev);
    // After a reboot the --bg routes are still on file but Caddy is gone.
    const down =
      Object.keys(state.routes).length > 0 && !(await caddyRunning());
    if (changed || down) {
      await apply(state, prev);
      writeState(state);
    }
    printStatus(state, argv.json);
    return { code: 0 };
  }
  if (first === "reset") {
    await apply({ ...state, routes: {} }, prev);
    writeState({ ...state, routes: {} });
    console.log("[serve] cleared all routes");
    return { code: 0 };
  }
  if (!second) {
    console.error("[serve] usage: fbi-proxy serve <host> <target|off>");
    return { code: 2 };
  }

  const host = normalizeHost(first, argv.domain);
  if (second === "off") {
    if (!state.routes[host]) {
      console.error(`[serve] ${host} isn't being served`);
      return { code: 1 };
    }
    delete state.routes[host];
    await apply(state, prev);
    writeState(state);
    console.log(`[serve] stopped serving ${host}`);
    return { code: 0 };
  }

  const target = parseTarget(second);
  const existing = state.routes[host];
  if (existing?.pid !== undefined && existing.pid !== process.pid) {
    console.error(
      `[serve] ${host} is already served by pid ${existing.pid} — stop it or run \`fbi-proxy serve ${first} off\``,
    );
    return { code: 1 };
  }
  state.routes[host] = {
    target: second,
    tls: argv.tls as TlsMode,
    rewriteHost: argv["rewrite-host"] ?? target.tls !== false,
    ...(argv.bg ? {} : { pid: process.pid }),
  };
  await apply(state, prev);
  writeState(state);
  if (argv.tls === "internal") await warnIfNotLoopback(host);
  console.log(`Available at ${urlFor(host, state)}  →  ${second}`);
  if (argv.bg) {
    console.log(
      `Serving in the background. Stop with: fbi-proxy serve ${first} off`,
    );
    return { code: 0 };
  }
  return { host };
}
