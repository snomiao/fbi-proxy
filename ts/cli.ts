#!/usr/bin/env bun
import getPort from "get-port";
import minimist from "minimist";
import { exec, spawn } from "child_process";
import path from "path";
import tsaComposer from "tsa-composer";
import { fromStdio } from "from-node-stream";
import sflow from "sflow";
import hotMemo from "hot-memo";
import fsp from "fs/promises";
import { existsSync } from "fs";
import { getProxyFilename } from "./getProxyFilename";
import { DIE } from "phpdie";
import promiseAllProperties from "promise-all-properties";
import { buildFbiProxy } from "./buildFbiProxy";
import { $ } from "./dRun";


process.chdir(path.resolve(__dirname, "..")); // Change to project root directory
console.log('Preparing Binaries')

const getProxy = (async () => {
  const built = './release/' + getProxyFilename();
  return (await fsp.exists(built) && built) || await buildFbiProxy() || DIE('Failed to build proxy binary. Please check your Rust setup.');
})
const getCaddy = (async () => {
  // use pwdCaddy if already downloaded
  const pwdCaddy = './caddy';
  if (existsSync(pwdCaddy)) {
    console.log("Using existing Caddy binary at " + pwdCaddy);
    return pwdCaddy;
  }

  // or use system caddy if installed, run `caddy --version` to check
  if (await $`caddy --version`) {
    return 'caddy';
  }

  // or if system caddy is not installed, download caddy using caddy-baron
  if (!existsSync(pwdCaddy)) {
    // download latest caddy to ./caddy
    console.log("Downloading Caddy...");
    // @ts-ignore
    await import('../node_modules/caddy-baron/index.mjs')

    if (!existsSync(pwdCaddy))
      throw new Error("Failed to download Caddy. Please install Caddy manually or check your network connection.");
  }

  return pwdCaddy;
})

const { proxy, caddy } = await promiseAllProperties({
  proxy: getProxy(),
  caddy: getCaddy()
})

console.log('running fbi-proxy', { caddy, proxy });

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
console.log(argv);
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
  // TODO: in production, build and start the Rust proxy server
  //       using `cargo build --release` and then run the binary
  const p = await (async () => {
    if (!(await fsp.exists(proxy).catch(() => false))) {
      console.error("Proxy binary not found at " + proxy);
      await buildFbiProxy();
      await fsp.exists(proxy).catch(() => false) || DIE('Failed to build proxy binary. Please check your Rust setup.');
    }

    console.log("Using proxy binary at " + proxy);
    const p = spawn(proxy, {
      env: {
        ...process.env,
        FBIPROXY_PORT, // Rust proxy server port
      },
    });
    if (!p) {
      console.error("Failed to start proxy server");
      process.exit(1);
    }
    return p;
  })();

  p.stdout?.pipe(process.stdout, { end: false });
  p.stderr?.pipe(process.stderr, { end: false });
  p.on("exit", (code) => {
    console.log(`Proxy server exited with code ${code}`);
    process.exit(code || 0);
  });

  console.log(`Rust proxy server started on port ${FBIPROXY_PORT}`);
  return p;
});

const caddyProcess = await hotMemo(async () => {
  const Caddyfile = path.join(__dirname, "../Caddyfile");
  const p = spawn(caddy, ['run'], {
    env: {
      ...process.env,
      FBIPROXY_PORT, // Rust proxy server port
      FBIHOST,
      // TLS: argv.tls || "internal", // Use internal TLS by default, or set via command line argument
    },
    cwd: path.dirname(Caddyfile),
  });
  p.stdout?.pipe(process.stdout, { end: false });
  p.stderr?.pipe(process.stderr, { end: false });
  p.on("exit", (code) => {
    console.log(`Caddy exited with code ${code}`);
    process.exit(code || 0)
  });
  console.log("Caddy started with config at " + Caddyfile);
  return p;
});


console.log("all done");
// show process pids
console.log(`Proxy server PID: ${proxyProcess.pid}`);
console.log(`Caddy server PID: ${caddyProcess.pid}`);

const exit = () => {
  console.log("Shutting down...");
  proxyProcess?.kill?.();
  // caddyProcess?.kill?.();
  process.exit(0);
};
process.on("SIGINT", exit);
process.on("SIGTERM", exit);
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
  exit();
});

