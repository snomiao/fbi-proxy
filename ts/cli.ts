#!/usr/bin/env bun
import getPort from "get-port";
import hotMemo from "hot-memo";
import path from "path";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { buildFbiProxy } from "./buildFbiProxy";
import { $ } from "./dSpawn";
import { downloadCaddy } from "./downloadCaddy";
import { execa } from "execa";

process.chdir(path.resolve(__dirname, "..")); // Change to project root directory

// Parse command line arguments with yargs
const argv = await yargs(hideBin(process.argv))
  .option("fbihost", {
    type: "string",
    default: "fbi.com",
    description: "Set the FBI host",
  })
  .option("caddy", {
    type: "boolean",
    default: false,
    description: "Start Caddy server",
  })
  .option("dev", {
    alias: "d",
    type: "boolean",
    default: false,
    description: "Run in development mode",
  })
  .help().argv;

console.log("Preparing Binaries");

const FBIHOST = argv.fbihost;
const FBIPROXY_PORT = String(await getPort({ port: 2432 }));

const proxyProcess = await hotMemo(async () => {
  const proxy = await buildFbiProxy();
  console.log("Starting Rust proxy server");
  const p = $.opt({
    env: {
      ...process.env,
      FBIPROXY_PORT, // Rust proxy server port
    },
  })`${proxy}`.process;

  p.on("exit", (code) => {
    console.log(`Proxy server exited with code ${code}`);
    process.exit(code || 0);
  });
  return p;
});

let caddyProcess: any = null;

// Only start Caddy if --caddy flag is passed
if (argv.caddy) {
  const caddy = await downloadCaddy();
  caddyProcess = await hotMemo(async () => {
    const p = $.opt({
      env: {
        ...process.env,
        FBIPROXY_PORT, // Rust proxy server port
        FBIHOST,
      },
    })`${caddy} run`.process;
    p.on("exit", (code) => {
      console.log(`Caddy exited with code ${code}`);
      process.exit(code || 0);
    });
    return p;
  });
}

console.log("all done");
// show process pids
console.log(`Proxy server PID: ${proxyProcess.pid}`);
if (caddyProcess) {
  console.log(`Caddy server PID: ${caddyProcess.pid}`);
} else {
  console.log("Caddy server not started (use --caddy to start it)");
}

const exit = () => {
  console.log("Shutting down...");
  proxyProcess?.kill?.();
  caddyProcess?.kill?.();
  process.exit(0);
};
process.on("SIGINT", exit);
process.on("SIGTERM", exit);
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
  exit();
});
