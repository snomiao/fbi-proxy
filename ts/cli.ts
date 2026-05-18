#!/usr/bin/env bun
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
  .help().argv;

console.log("Preparing Binaries");

const FBI_PROXY_PORT =
  process.env.FBI_PROXY_PORT || String(await getPort({ port: 2432 }));

const proxyProcess = await hotMemo(async () => {
  const proxy = await getFbiProxyBinary({ originalCwd });
  console.log("Starting Rust proxy server");
  const p = $.opt({
    env: {
      ...process.env,
      FBI_PROXY_PORT,
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
