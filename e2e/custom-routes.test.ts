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
 * Verifies the `--routes` CLI flag (and `FBI_PROXY_ROUTES` env var):
 * the proxy loads a user-supplied routes.yaml and uses its rules
 * instead of the bundled defaults.
 */
describe("FBI Proxy --routes flag", () => {
  let testServers: TestServerManager;
  let proxyProcess: ChildProcess | null = null;
  let proxyPort: number;
  let upstreamPort: number;
  let routesFilePath: string;

  beforeAll(async () => {
    testServers = new TestServerManager();
    proxyPort = await getPort();

    // Start an upstream server that we'll route to via a custom rule.
    upstreamPort = await testServers.startServer({
      port: await getPort(),
      responseHandler: (req) => ({
        message: "Hello from custom-routes upstream",
        ...req,
        timestamp: Date.now(),
      }),
    });

    // Write a temporary routes.yaml with a custom rule:
    //   pr-{id:int}.test.local -> 127.0.0.1:{upstreamPort}
    // We anchor the target on a real localhost port we control so the
    // test can verify the request was forwarded according to the
    // custom rule (and not the bundled rules, which would have routed
    // pr-NN.test.local somewhere else entirely).
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fbi-proxy-routes-"));
    routesFilePath = path.join(tmpDir, "routes.yaml");
    fs.writeFileSync(
      routesFilePath,
      [
        "version: 1",
        "routes:",
        "  - name: pr-preview",
        '    match: "pr-{id:int}.{domain}"',
        `    target: "127.0.0.1:${upstreamPort}"`,
        "    headers:",
        '      Host: "preview-{id}.local"',
        "",
      ].join("\n"),
    );

    const projectRoot = path.resolve(__dirname, "..");
    const binaryPath = path.join(projectRoot, "target/release/fbi-proxy");

    proxyProcess = spawn(
      binaryPath,
      [
        "-p",
        proxyPort.toString(),
        "-h",
        "127.0.0.1",
        "-d",
        "test.local",
        "-r",
        routesFilePath,
      ],
      {
        stdio: "pipe",
        env: {
          ...process.env,
          RUST_LOG: "error",
          FBI_PROXY_DOMAIN: "test.local",
        },
      },
    );

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Custom-routes proxy failed to start"));
      }, 10000);

      proxyProcess!.stdout!.on("data", (data) => {
        if (data.toString().includes("FBI Proxy listening on")) {
          clearTimeout(timeout);
          resolve(void 0);
        }
      });

      proxyProcess!.stderr!.on("data", (data) => {
        console.error("custom-routes stderr:", data.toString());
      });

      proxyProcess!.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  });

  afterAll(async () => {
    if (proxyProcess) {
      proxyProcess.kill("SIGTERM");
    }
    await testServers.stopAllServers();
    try {
      fs.rmSync(path.dirname(routesFilePath), { recursive: true, force: true });
    } catch {}
  });

  async function makeRequest(host: string, path: string = "/") {
    const url = `http://127.0.0.1:${proxyPort}${path}`;
    const response = await fetch(url, {
      headers: { Host: host },
      redirect: "manual",
    });
    const rawBody = await response.text();
    let body: any;
    try {
      body = JSON.parse(rawBody);
    } catch {
      body = rawBody;
    }
    return { status: response.status, body, rawBody };
  }

  it("routes requests matching the custom rule to the upstream", async () => {
    const response = await makeRequest("pr-99.test.local", "/check");

    expect(response.status).toBe(200);
    expect(response.body.message).toBe("Hello from custom-routes upstream");
    expect(response.body.url).toBe("/check");
    // The custom rule rewrites Host to "preview-99.local".
    expect(response.body.headers.host).toBe("preview-99.local");
  });

  it("rejects hosts not matching the custom rule with 502", async () => {
    // The custom routes.yaml has only the pr-{id} rule. A host like
    // "3000.test.local" wouldn't match (no pr- prefix), so it should
    // be rejected with the standard 502 — proving the bundled rules
    // are NOT in play.
    const response = await makeRequest("3000.test.local", "/x");

    expect(response.status).toBe(502);
    expect(response.rawBody).toContain("Bad Gateway: Host not allowed");
  });
});
