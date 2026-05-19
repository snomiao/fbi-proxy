#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import getPort from "get-port";
import hotMemo from "hot-memo";
import path from "path";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { getFbiProxyBinary } from "./buildFbiProxy";
import { $ } from "./dSpawn";
import {
  configFromEnv,
  defaultConfigPath,
  helpfulSetupMessage,
  readConfigOrNull,
  writeConfig,
  type AuthConfigShape,
} from "./auth/authConfig";
import { spawnFbiAuth, type FbiAuthHandle } from "./auth/spawnFbiAuth";
import { isTty, readlinePrompter, runWizard } from "./auth/setupWizard";
import {
  defaultCaddyfilePath,
  writeCaddyfile,
  type CaddyfileOpts,
} from "./auth/caddyfileGen";
import {
  caddyNotFoundMessage,
  resolveCaddyBinary,
  spawnCaddy,
  type CaddyHandle,
} from "./auth/spawnCaddy";

const originalCwd = process.cwd();

// Subcommand routing & default behavior
//
// `fbi-proxy setup` (or `fbi-proxy` with no escape-hatch flags) runs the
// one-shot setup orchestrator: registers an oxmgr daemon, generates+trusts
// a TLS cert, installs a pf :443→:8443 forward, and verifies https://<domain>.
//
// Old foreground modes (Caddy, dev, raw TLS, auth wizard) are preserved by
// flags below — explicit opt-in keeps the existing surface intact for users
// who rely on it.
{
  const rawArgs = hideBin(process.argv);
  const firstPositional = rawArgs.find((a) => !a.startsWith("-"));
  const FOREGROUND_FLAGS = [
    "--dev",
    "--with-caddy",
    "--with-auth",
    "--tls",
    "--reconfigure",
  ];
  const wantsForeground = rawArgs.some((a) =>
    FOREGROUND_FLAGS.some((f) => a === f || a.startsWith(`${f}=`)),
  );
  const hasExplicitPortEnv = !!process.env.FBI_PROXY_PORT;
  const isSetupCmd = firstPositional === "setup";
  const isDefault = !firstPositional && !wantsForeground && !hasExplicitPortEnv;

  if (isSetupCmd || isDefault) {
    const { runSetup } = await import("./setup");
    const passArgs = rawArgs.filter((a) => a !== "setup");
    await runSetup(passArgs, { originalCwd });
    process.exit(0);
  }
}

process.chdir(path.resolve(import.meta.dir, ".."));

const argv = await yargs(hideBin(process.argv))
  .option("dev", {
    type: "boolean",
    default: false,
    description: "Run in development mode",
  })
  .option("with-auth", {
    type: "boolean",
    default: false,
    description:
      "Start the fbi-auth gateway alongside the proxy (Phase 1: Google OAuth)",
  })
  .option("with-caddy", {
    type: "boolean",
    default: false,
    description:
      "Auto-generate a Caddyfile and spawn Caddy alongside the proxy",
  })
  .option("domain", {
    type: "string",
    default: "fbi.com",
    description: "Domain to gate (default: fbi.com)",
  })
  .option("reconfigure", {
    type: "boolean",
    default: false,
    description:
      "Run the interactive fbi-auth setup wizard to (re)write auth.json (requires a TTY)",
  })
  .option("acme-email", {
    type: "string",
    description:
      "Optional ACME account email for the generated Caddyfile (Let's Encrypt notifications)",
  })
  .option("tls-mode", {
    type: "string",
    choices: ["auto", "internal"] as const,
    description:
      "TLS strategy for --with-caddy. 'auto' uses ACME (Let's Encrypt); 'internal' uses Caddy's local CA. Defaults to 'internal' for fbi.com, 'auto' otherwise.",
  })
  .option("tls", {
    type: "boolean",
    default: false,
    description:
      "Terminate TLS in the Rust proxy using a self-signed cert (no Caddy). Browser warning expected (Phase 1 — no system trust install). Use with --port 443 + sudo to serve standard HTTPS.",
  })
  .help().argv;

if (argv.tls && argv["with-caddy"]) {
  console.error(
    "[fbi-proxy] --tls and --with-caddy are mutually exclusive (Caddy already terminates TLS).",
  );
  process.exit(2);
}

const FBI_PROXY_PORT =
  process.env.FBI_PROXY_PORT ||
  (argv.tls ? "443" : String(await getPort({ port: 2432 })));

if (argv.tls) {
  await ensureRootIfTlsNeedsIt({
    domain: argv.domain,
    port: Number(FBI_PROXY_PORT),
  });
}

console.log("Preparing Binaries");

const proxyProcess = await hotMemo(async () => {
  const proxy = await getFbiProxyBinary({ originalCwd });
  console.log("Starting Rust proxy server");
  const p = $.opt({
    env: {
      ...process.env,
      FBI_PROXY_PORT,
      ...(argv.tls
        ? {
            FBI_PROXY_TLS: "true",
            FBI_PROXY_DOMAIN: argv.domain,
            // Forward CERT_DIR if the sudo wrapper set it (so the elevated
            // Rust binary writes to the original user's $HOME, not /var/root)
            ...(process.env.FBI_PROXY_CERT_DIR
              ? { FBI_PROXY_CERT_DIR: process.env.FBI_PROXY_CERT_DIR }
              : {}),
          }
        : {}),
    },
  })`${proxy}`.process;

  p.on("exit", (code) => {
    console.log(`Proxy server exited with code ${code}`);
    process.exit(code || 0);
  });
  return p;
});

console.log(`Proxy server PID: ${proxyProcess.pid}`);
console.log(`Proxy server running on port: ${FBI_PROXY_PORT}`);

let authHandle: FbiAuthHandle | undefined;
if (argv["with-auth"]) {
  authHandle = await startFbiAuth({
    domain: argv.domain,
    reconfigure: argv.reconfigure,
  });
}

let caddyHandle: CaddyHandle | undefined;
if (argv["with-caddy"]) {
  caddyHandle =
    (await startCaddy({
      domain: argv.domain,
      fbiProxyPort: Number(FBI_PROXY_PORT),
      fbiAuthPort: authHandle?.port,
      withAuth: Boolean(argv["with-auth"]),
      acmeEmail: argv["acme-email"],
      tlsMode:
        (argv["tls-mode"] as "auto" | "internal" | undefined) ?? undefined,
    })) ?? undefined;
}

console.log("All services started successfully!");

const exit = () => {
  console.log("Shutting down...");
  caddyHandle?.kill();
  authHandle?.kill();
  proxyProcess?.kill?.();
  process.exit(0);
};
process.on("SIGINT", exit);
process.on("SIGTERM", exit);
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
  exit();
});

async function ensureRootIfTlsNeedsIt(opts: {
  domain: string;
  port: number;
}): Promise<void> {
  if (process.platform !== "darwin") {
    // Linux/Windows trust install is a follow-up. The Rust side prints a
    // friendly fallback message if untrusted.
    return;
  }
  if (process.getuid?.() === 0) return;

  const home = process.env.HOME ?? "";
  const certDir =
    process.env.FBI_PROXY_CERT_DIR ??
    path.join(home, ".config/fbi-proxy/certs");
  const slug = opts.domain || "localhost";
  const certPath = path.join(certDir, `${slug}.pem`);

  const needsPortBind = opts.port < 1024;
  const certMissing = !existsSync(certPath);
  const certUntrusted = !certMissing && !isMacosCertTrusted(certPath);
  const needsTrustInstall = certMissing || certUntrusted;

  if (!needsPortBind && !needsTrustInstall) return;

  const reasons = [
    needsPortBind && `bind :${opts.port}`,
    needsTrustInstall && "install cert to system trust",
  ]
    .filter(Boolean)
    .join(" + ");
  console.log(`[fbi-proxy] --tls needs root to: ${reasons}`);

  // Preserve HOME and CERT_DIR so the elevated process writes cert/auth
  // files into the original user's directory, not /var/root.
  const sudoArgs = [
    `HOME=${home}`,
    `FBI_PROXY_CERT_DIR=${certDir}`,
    process.execPath,
    ...process.argv.slice(1),
  ];

  // Prefer terminal sudo when a TTY is attached; otherwise fall back to the
  // macOS GUI authentication dialog via osascript so non-TTY contexts (agent
  // shells, oxmgr-spawned children) can still escalate with a single password
  // prompt instead of erroring out with "a terminal is required".
  const hasTty = !!process.stdin.isTTY;
  if (hasTty) {
    console.log(
      `[fbi-proxy] re-launching via sudo (terminal password prompt)…`,
    );
    const result = spawnSync("sudo", sudoArgs, { stdio: "inherit" });
    process.exit(result.status ?? 1);
  }

  console.log(`[fbi-proxy] no TTY — opening macOS authentication dialog…`);
  const shellCmd = sudoArgs.map(shellQuote).join(" ");
  const script = `do shell script ${appleScriptQuote(shellCmd)} with administrator privileges`;
  const result = spawnSync("osascript", ["-e", script], { stdio: "inherit" });
  process.exit(result.status ?? 1);
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function appleScriptQuote(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function isMacosCertTrusted(certPath: string): boolean {
  const result = spawnSync("security", ["verify-cert", "-c", certPath], {
    stdio: "ignore",
  });
  return result.status === 0;
}

async function startFbiAuth(opts: {
  domain: string;
  reconfigure: boolean;
}): Promise<FbiAuthHandle | undefined> {
  const configPath = defaultConfigPath();
  let cfg = await readConfigOrNull(configPath);

  if (opts.reconfigure) {
    if (!isTty()) {
      console.error(
        "[fbi-auth] --reconfigure requires a TTY (interactive terminal).",
      );
      return undefined;
    }
    if (cfg) {
      console.log(
        `[fbi-auth] --reconfigure: existing config at ${configPath} will be replaced.`,
      );
      console.log(
        `[fbi-auth] previous values used as defaults; press Enter to keep each.`,
      );
    }
    const prompter = readlinePrompter();
    const next = await runWizard(prompter, {
      domain: opts.domain,
      existing: cfg,
    });
    if (cfg) {
      const changed = changedFields(cfg, next);
      if (changed.length === 0) {
        console.log("[fbi-auth] no changes — skipping write.");
        return undefined;
      }
      console.log(`[fbi-auth] changed fields: ${changed.join(", ")}`);
    }
    console.log(`[fbi-auth] writing config from wizard → ${configPath}`);
    await writeConfig(next, configPath);
    cfg = next;
  } else if (!cfg) {
    if (isTty()) {
      const prompter = readlinePrompter();
      cfg = await runWizard(prompter, { domain: opts.domain, existing: null });
      console.log(`[fbi-auth] writing config from wizard → ${configPath}`);
      await writeConfig(cfg, configPath);
    } else {
      const fromEnv = configFromEnv(opts.domain);
      if (fromEnv) {
        console.log(`[fbi-auth] writing config from env vars → ${configPath}`);
        await writeConfig(fromEnv, configPath);
        cfg = fromEnv;
      } else {
        console.error(helpfulSetupMessage(opts.domain, configPath));
        console.error(
          "[fbi-auth] not started — --with-auth requires a config, env vars, or a TTY for the wizard.",
        );
        return undefined;
      }
    }
  }

  console.log(
    `[fbi-auth] starting (domain=${cfg.domain}, provider=${cfg.provider})`,
  );
  const handle = await spawnFbiAuth({ configPath });
  console.log(
    `[fbi-auth] PID ${handle.pid} listening on 127.0.0.1:${handle.port}`,
  );
  return handle;
}

async function startCaddy(opts: {
  domain: string;
  fbiProxyPort: number;
  fbiAuthPort: number | undefined;
  withAuth: boolean;
  acmeEmail?: string;
  tlsMode?: "auto" | "internal";
}): Promise<CaddyHandle | null> {
  // Verify Caddy is present before generating anything, so the error message
  // is the first thing the user sees instead of a stray Caddyfile on disk.
  const binary = await resolveCaddyBinary();
  if (!binary) {
    console.error(caddyNotFoundMessage());
    return null;
  }

  if (opts.withAuth && opts.fbiAuthPort === undefined) {
    console.error(
      "[caddy] --with-auth was requested but fbi-auth failed to start; refusing to spawn Caddy with a broken forward_auth target.",
    );
    return null;
  }

  const domain = opts.domain.startsWith(".")
    ? opts.domain.slice(1)
    : opts.domain;
  const tlsMode: "auto" | "internal" =
    opts.tlsMode ?? (domain === "fbi.com" ? "internal" : "auto");

  const caddyOpts: CaddyfileOpts = {
    domain,
    fbiProxyPort: opts.fbiProxyPort,
    tlsMode,
    acmeEmail: opts.acmeEmail,
    withAuth: opts.withAuth,
    ...(opts.withAuth && opts.fbiAuthPort !== undefined
      ? {
          ssoHost: `sso.${domain}`,
          fbiAuthPort: opts.fbiAuthPort,
        }
      : {}),
  };

  const caddyfilePath = defaultCaddyfilePath();
  const { path: writtenPath } = await writeCaddyfile(caddyOpts, caddyfilePath);
  console.log(`[caddy] wrote Caddyfile → ${writtenPath}`);
  console.log(
    `[caddy] domain=${domain} tlsMode=${tlsMode} withAuth=${opts.withAuth}`,
  );

  const handle = await spawnCaddy({ caddyfilePath: writtenPath, binary });
  if (handle) {
    console.log(`[caddy] PID ${handle.pid}`);
  }
  return handle;
}

function changedFields(prev: AuthConfigShape, next: AuthConfigShape): string[] {
  const fields: (keyof AuthConfigShape)[] = [
    "domain",
    "cookieDomain",
    "ssoHost",
    "provider",
    "clientId",
    "clientSecret",
    "firebase",
    "allowlist",
  ];
  const changed: string[] = [];
  for (const k of fields) {
    if (JSON.stringify(prev[k]) !== JSON.stringify(next[k])) changed.push(k);
  }
  return changed;
}
