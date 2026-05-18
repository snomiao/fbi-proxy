import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "child_process";
import fetch from "node-fetch";
import getPort from "get-port";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Verifies HTTPS upstream support (R5): a route with a `https://` prefix
 * causes the proxy to establish a TLS connection to the upstream and
 * forward the request transparently.
 *
 * Uses api.github.com — public, stable, no auth required. The /zen
 * endpoint returns one short zen sentence per request.
 */
describe("FBI Proxy HTTPS upstream (R5)", () => {
  let proxyProcess: ChildProcess | null = null;
  let proxyPort: number;
  let routesFilePath: string;

  beforeAll(async () => {
    proxyPort = await getPort();

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fbi-proxy-https-"));
    routesFilePath = path.join(tmpDir, "routes.yaml");
    fs.writeFileSync(
      routesFilePath,
      [
        "version: 1",
        "routes:",
        "  - name: github-passthrough",
        '    match: "{anything:multi}"',
        '    target: "https://api.github.com:443"',
        "    headers:",
        '      Host: "api.github.com"',
        "",
      ].join("\n"),
    );

    const projectRoot = path.resolve(__dirname, "..");
    const binaryPath = path.join(projectRoot, "target/release/fbi-proxy");

    proxyProcess = spawn(
      binaryPath,
      ["-p", proxyPort.toString(), "-h", "127.0.0.1", "-r", routesFilePath],
      {
        stdio: "pipe",
        env: {
          ...process.env,
          RUST_LOG: "error",
          FBI_PROXY_DOMAIN: "",
        },
      },
    );

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("HTTPS-upstream proxy failed to start"));
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

  afterAll(() => {
    if (proxyProcess) proxyProcess.kill("SIGTERM");
    try {
      fs.rmSync(path.dirname(routesFilePath), { recursive: true, force: true });
    } catch {}
  });

  it("forwards GET /zen to api.github.com over TLS and returns 200", async () => {
    const url = `http://127.0.0.1:${proxyPort}/zen`;
    const response = await fetch(url, {
      headers: { Host: "anything.example" },
      redirect: "manual",
    });
    expect(response.status).toBe(200);
    const body = await response.text();
    // GitHub /zen returns a short text line; assert non-empty.
    expect(body.length).toBeGreaterThan(0);
    expect(body.length).toBeLessThan(200);
  }, 20_000);

  it("preserves GitHub API response headers (proves real upstream)", async () => {
    const url = `http://127.0.0.1:${proxyPort}/zen`;
    const response = await fetch(url, {
      headers: { Host: "anything.example" },
      redirect: "manual",
    });
    expect(response.status).toBe(200);
    // x-github-* headers are GitHub-specific; their presence proves we
    // actually reached api.github.com via TLS (not a local fallback).
    const hasGithubHeader = Array.from(response.headers.keys()).some((k) =>
      k.toLowerCase().startsWith("x-github"),
    );
    expect(hasGithubHeader).toBe(true);
  }, 20_000);
});
