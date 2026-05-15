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
} from "./auth/authConfig";
import { spawnFbiAuth, type FbiAuthHandle } from "./auth/spawnFbiAuth";
import { isTty, readlinePrompter, runWizard } from "./auth/setupWizard";

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

console.log("All services started successfully!");

const exit = () => {
  console.log("Shutting down...");
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
    const prompter = readlinePrompter();
    cfg = await runWizard(prompter, { domain: opts.domain, existing: cfg });
    console.log(`[fbi-auth] writing config from wizard → ${configPath}`);
    await writeConfig(cfg, configPath);
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
