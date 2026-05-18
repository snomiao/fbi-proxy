import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "child_process";
import fetch from "node-fetch";
import getPort from "get-port";
import { TestServerManager } from "./helpers/test-server";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Hot reload: when the `--routes` path is mutated on disk, the proxy
 * picks up the new rules without a restart. The bundled (compile-time)
 * routes are immutable; hot reload only applies to user-supplied files.
 */
describe("FBI Proxy routes hot reload", () => {
  let testServers: TestServerManager;
  let proxyProcess: ChildProcess | null = null;
  let proxyPort: number;
  let upstreamA: number;
  let upstreamB: number;
  let routesFilePath: string;

  beforeAll(async () => {
    testServers = new TestServerManager();
    proxyPort = await getPort();

    upstreamA = await testServers.startServer({
      port: await getPort(),
      responseHandler: () => ({ upstream: "A" }),
    });
    upstreamB = await testServers.startServer({
      port: await getPort(),
      responseHandler: () => ({ upstream: "B" }),
    });

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fbi-proxy-hot-"));
    routesFilePath = path.join(tmpDir, "routes.yaml");
    writeRoutes(routesFilePath, upstreamA);

    const projectRoot = path.resolve(__dirname, "..");
    const binaryPath = path.join(projectRoot, "target/release/fbi-proxy");

    proxyProcess = spawn(
      binaryPath,
      ["-p", proxyPort.toString(), "-h", "127.0.0.1", "-r", routesFilePath],
      {
        stdio: "pipe",
        env: {
          ...process.env,
          // info-level so we can verify the watcher saw the change.
          RUST_LOG: "info",
          FBI_PROXY_DOMAIN: "",
        },
      },
    );

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("hot-reload proxy failed to start"));
      }, 10000);
      proxyProcess!.stdout!.on("data", (data) => {
        if (data.toString().includes("FBI Proxy listening on")) {
          clearTimeout(timeout);
          resolve(void 0);
        }
      });
      proxyProcess!.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  });

  afterAll(async () => {
    if (proxyProcess) proxyProcess.kill("SIGTERM");
    await testServers.stopAllServers();
    try {
      fs.rmSync(path.dirname(routesFilePath), { recursive: true, force: true });
    } catch {}
  });

  async function hit(host: string): Promise<{ status: number; body: any }> {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/x`, {
      headers: { Host: host },
      redirect: "manual",
    });
    const text = await res.text();
    let body: any;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { status: res.status, body };
  }

  it("uses the initial routes file at startup", async () => {
    const res = await hit("hot.test.local");
    expect(res.status).toBe(200);
    expect(res.body.upstream).toBe("A");
  });

  it("picks up changes after the file is rewritten", async () => {
    // Rewrite to point at upstreamB. notify-rs typically fires within
    // a few hundred ms; we debounce 150ms and then reload, so wait a
    // beat before re-hitting the proxy.
    writeRoutes(routesFilePath, upstreamB);
    await new Promise((r) => setTimeout(r, 800));

    const res = await hit("hot.test.local");
    expect(res.status).toBe(200);
    expect(res.body.upstream).toBe("B");
  });

  it("keeps previous rules when the new file is invalid YAML", async () => {
    // First confirm we're back on B (sanity).
    fs.writeFileSync(routesFilePath, "not: : : valid: yaml:");
    await new Promise((r) => setTimeout(r, 800));

    // Existing compiled rules should still be live (B from previous test).
    const res = await hit("hot.test.local");
    expect(res.status).toBe(200);
    expect(res.body.upstream).toBe("B");
  });
});

function writeRoutes(filePath: string, upstreamPort: number): void {
  fs.writeFileSync(
    filePath,
    [
      "version: 1",
      "routes:",
      "  - name: hot",
      '    match: "{anything:multi}"',
      `    target: "127.0.0.1:${upstreamPort}"`,
      "    headers:",
      '      Host: "test"',
      "",
    ].join("\n"),
  );
}
