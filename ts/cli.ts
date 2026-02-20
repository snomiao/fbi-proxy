#!/usr/bin/env bun
import getPort from "get-port";
import hotMemo from "hot-memo";
import path from "path";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { getFbiProxyBinary } from "./buildFbiProxy";
import { $ } from "./dSpawn";

process.chdir(path.resolve(import.meta.dir, "..")); // Change to project root directory

// Parse command line arguments with yargs
await yargs(hideBin(process.argv))
  .option("dev", {
    alias: "d",
    type: "boolean",
    default: false,
    description: "Run in development mode",
  })
  .help().argv;

console.log("Preparing Binaries");

const FBI_PROXY_PORT =
  process.env.FBI_PROXY_PORT || String(await getPort({ port: 2432 }));

const proxyProcess = await hotMemo(async () => {
  const proxy = await getFbiProxyBinary();
  console.log("Starting Rust proxy server");
  const p = $.opt({
    env: {
      ...process.env,
      FBI_PROXY_PORT, // Rust proxy server port
    },
  })`${proxy}`.process;

  p.on("exit", (code) => {
    console.log(`Proxy server exited with code ${code}`);
    process.exit(code || 0);
  });
  return p;
});

console.log("All services started successfully!");
console.log(`Proxy server PID: ${proxyProcess.pid}`);
console.log(`Proxy server running on port: ${FBI_PROXY_PORT}`);

const exit = () => {
  console.log("Shutting down...");
  proxyProcess?.kill?.();
  process.exit(0);
};
process.on("SIGINT", exit);
process.on("SIGTERM", exit);
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
  exit();
});
