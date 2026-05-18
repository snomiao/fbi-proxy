import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "child_process";
import fetch from "node-fetch";
import getPort from "get-port";
import { TestServerManager } from "./helpers/test-server";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe("FBI Proxy metrics endpoint", () => {
  let testServers: TestServerManager;
  let proxyProcess: ChildProcess | null = null;
  let proxyPort: number;
  let metricsPort: number;
  let upstreamPort: number;

  beforeAll(async () => {
    testServers = new TestServerManager();
    proxyPort = await getPort();
    metricsPort = await getPort();

    upstreamPort = await testServers.startServer({
      port: await getPort(),
      responseHandler: () => ({ ok: true }),
    });

    const projectRoot = path.resolve(__dirname, "..");
    const binaryPath = path.join(projectRoot, "target/release/fbi-proxy");

    proxyProcess = spawn(
      binaryPath,
      ["-p", proxyPort.toString(), "-h", "127.0.0.1"],
      {
        stdio: "pipe",
        env: {
          ...process.env,
          RUST_LOG: "error",
          FBI_PROXY_DOMAIN: "",
          FBI_PROXY_METRICS_PORT: metricsPort.toString(),
        },
      },
    );

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("metrics proxy failed to start")),
        10000,
      );
      proxyProcess!.stdout!.on("data", (data) => {
        const s = data.toString();
        if (s.includes("FBI Proxy listening on")) {
          clearTimeout(timeout);
          resolve(void 0);
        }
      });
      proxyProcess!.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
    // Give the metrics task a brief moment to bind too.
    await new Promise((r) => setTimeout(r, 200));
  });

  afterAll(async () => {
    if (proxyProcess) proxyProcess.kill("SIGTERM");
    await testServers.stopAllServers();
  });

  async function scrape(): Promise<Record<string, number>> {
    const res = await fetch(`http://127.0.0.1:${metricsPort}/metrics`);
    const text = await res.text();
    const out: Record<string, number> = {};
    for (const line of text.split("\n")) {
      if (line.startsWith("#") || !line.trim()) continue;
      const [name, value] = line.split(/\s+/);
      out[name] = Number(value);
    }
    return out;
  }

  it("serves Prometheus-format counters on the admin port", async () => {
    const m = await scrape();
    expect(m["fbi_proxy_requests_total"]).toBeGreaterThanOrEqual(0);
    expect(m["fbi_proxy_status_2xx_total"]).toBeGreaterThanOrEqual(0);
    expect(
      m["fbi_proxy_upstream_connect_failures_total"],
    ).toBeGreaterThanOrEqual(0);
  });

  it("increments status_2xx on a successful upstream request", async () => {
    const before = await scrape();
    await fetch(`http://127.0.0.1:${proxyPort}/x`, {
      headers: { Host: upstreamPort.toString() }, // port-as-host → localhost:<port>
    });
    const after = await scrape();
    expect(after["fbi_proxy_requests_total"]).toBe(
      before["fbi_proxy_requests_total"] + 1,
    );
    expect(after["fbi_proxy_status_2xx_total"]).toBe(
      before["fbi_proxy_status_2xx_total"] + 1,
    );
  });

  it("increments upstream_connect_failures + 5xx on an unreachable host", async () => {
    const unreachable = await getPort(); // allocated then released
    const before = await scrape();
    await fetch(`http://127.0.0.1:${proxyPort}/x`, {
      headers: { Host: unreachable.toString() },
    });
    const after = await scrape();
    expect(after["fbi_proxy_upstream_connect_failures_total"]).toBe(
      before["fbi_proxy_upstream_connect_failures_total"] + 1,
    );
    expect(after["fbi_proxy_status_5xx_total"]).toBe(
      before["fbi_proxy_status_5xx_total"] + 1,
    );
  });

  it("404s for unknown paths on the metrics endpoint", async () => {
    const res = await fetch(`http://127.0.0.1:${metricsPort}/varz`);
    expect(res.status).toBe(404);
  });
});
