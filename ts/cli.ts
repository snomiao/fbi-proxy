#!/usr/bin/env bun
import getPort from "get-port";
import minimist from "minimist";
import hotMemo from "hot-memo";
import { exec } from "child_process";
import path from "path";
import { exists } from "fs/promises";
import { existsSync } from "fs";

// guide to install caddy
if (!(await Bun.$`caddy --version`.text().catch(() => ""))) {
  console.error("Caddy is not installed. Please install Caddy first");
  console.error(`For windows, try running:\n    choco install caddy\n`);
  console.error(`For linux, try running:\n    sudo apt install caddy\n`);
  process.exit(1);
}

const getProxyPath = () => {
  const root = Bun.fileURLToPath(import.meta.url) + "../";
  const filename =
    {
      "darwin-arm64": "fbi-proxy-darwin",
      "darwin-x64": "fbi-proxy-darwin",
      "linux-arm64": "fbi-proxy-linux-arm64",
      "linux-x64": "fbi-proxy-linux-x64",
      "linux-x86_64": "fbi-proxy-linux-x64",
      "win32-arm64": "fbi-proxy-windows-arm64.exe",
      "win32-x64": "fbi-proxy-windows-x64.exe",
    }[process.platform + "-" + process.arch] || "fbi-proxy-linux-x64";

  return [path.join(root, "rs/target/release", filename)].find((e) =>
    existsSync(e)
  );
};

// assume caddy is installed, launch proxy server now
const argv = minimist(process.argv.slice(2), {});
console.log(argv);
const PROXY_PORT = String(await getPort({ port: 24306 }));
const proxyProcess = await hotMemo(async () => {
  console.log("Starting Rust proxy server");

  // build and start the Rust proxy server
  const p = exec(`cargo watch -x "run --bin proxy"`, {
    env: {
      ...process.env,
      PROXY_PORT,
    },
    cwd: path.join(__dirname, "../rs"),
  });
  p.stdout?.pipe(process.stdout, { end: false });
  p.stderr?.pipe(process.stderr, { end: false });
  p.on("exit", (code) => {
    console.log(`Proxy server exited with code ${code}`);
    process.exit(code || 0);
  });

  console.log("Rust proxy server started on port 24306");
  return p;
});

const caddyProcess = await hotMemo(async () => {
  const Caddyfile = path.join(__dirname, "../Caddyfile");
  if (!(await exists(Caddyfile).catch(() => false))) {
    console.error("Caddyfile not found at " + Caddyfile);
    console.error(
      "Please create a Caddyfile in the root directory of the project."
    );
    process.exit(1);
  }
  console.log("Starting Caddy");
  const p = exec(`caddy run --watch --config ${Caddyfile}`, {
    env: {
      ...process.env,
      PROXY_PORT, // Rust proxy server port
      TLS: argv.tls || "internal", // Use internal TLS by default, or set via command line argument
    },
    cwd: path.dirname(Caddyfile),
  });
  p.stdout?.pipe(process.stdout, { end: false });
  p.stderr?.pipe(process.stderr, { end: false });
  p.on("exit", (code) => process.exit(code || 0));
  console.log("Caddy started with config at " + Caddyfile);
  return p;
});

console.log("all done");

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
