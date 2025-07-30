#!/usr/bin/env bun
import getPort from "get-port";
import minimist from "minimist";
import { exec, spawn } from "child_process";
import path from "path";
import tsaComposer from "tsa-composer";
import { fromStdio } from "from-node-stream";
import sflow from "sflow";
import hotMemo from "hot-memo";
import { exists } from "fs";
import { getProxyFilename } from "./getProxyFilename";
import { DIE } from "phpdie";
import promiseAllProperties from "promise-all-properties";
import { buildFbiProxy } from "./buildFbiProxy";
import { $ } from "./dRun";
import { downloadCaddy } from "./downloadCaddy";

process.chdir(path.resolve(__dirname, "..")); // Change to project root directory

console.log("Preparing Binaries");

const { proxy, caddy } = await promiseAllProperties({
  proxy: buildFbiProxy(),
  caddy: downloadCaddy(),
});

console.log("Running fbi-proxy", JSON.stringify({ caddy, proxy }));

// assume caddy is installed, launch proxy server now
const argv = minimist(process.argv.slice(2), {
  default: {
    dev: false,
    d: false,
    fbihost: "fbi.com", // Default FBI host
  },
  alias: {
    dev: "d",
  },
  boolean: ["dev", "d", "help"],
});
// console.log(argv);
if (argv.help) {
  console.log(`Usage: fbi-proxy [options]
Options:
  --help          Show this help message
  --fbihost       Set the FBI host (default: fbi.com)
`);
  process.exit(0);
}

const FBIHOST = argv.fbihost || "fbi.com"; // Default FBI host
const FBIPROXY_PORT = String(await getPort({ port: 24306 }));
const proxyProcess = await hotMemo(async () => {
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

const caddyProcess = await hotMemo(async () => {
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

console.log("all done");
// show process pids
console.log(`Proxy server PID: ${proxyProcess.pid}`);
console.log(`Caddy server PID: ${caddyProcess.pid}`);

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
