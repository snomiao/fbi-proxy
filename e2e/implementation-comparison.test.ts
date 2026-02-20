import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "child_process";
import fetch from "node-fetch";
import getPort from "get-port";
import { TestServerManager } from "./helpers/test-server";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe.skip("Implementation Comparison: Rust vs TypeScript", () => {
  let testServers: TestServerManager;
  let rustProxy: ChildProcess | null = null;
  let tsProxy: ChildProcess | null = null;
  let rustProxyPort: number;
  let tsProxyPort: number;
  let testPort3000: number;

  beforeAll(async () => {
    testServers = new TestServerManager();

    // Get ports for both implementations
    rustProxyPort = await getPort();
    tsProxyPort = await getPort();

    // Start test server
    testPort3000 = await testServers.startServer({
      port: await getPort({ port: 8000 }),
      responseHandler: (req) => ({
        message: "Hello from comparison test",
        implementation: "target-server",
        ...req,
        timestamp: Date.now()
      })
    });

    // Start Rust implementation
    console.log(`Starting Rust proxy on port ${rustProxyPort}...`);
    const projectRoot = path.resolve(__dirname, "..");
    const binaryPath = path.join(projectRoot, "target/release/fbi-proxy");

    rustProxy = spawn(binaryPath, [
      "-p", rustProxyPort.toString(),
      "-h", "127.0.0.1"
    ], {
      stdio: 'pipe',
      env: {
        ...process.env,
        RUST_LOG: "error", // Reduce log noise
        FBI_PROXY_DOMAIN: "" // Clear domain filter for tests
      }
    });

    // Start TypeScript implementation
    console.log(`Starting TypeScript proxy on port ${tsProxyPort}...`);
    tsProxy = spawn("bun", ["ts/cli.ts"], {
      cwd: projectRoot,
      stdio: 'pipe',
      env: {
        ...process.env,
        FBIPROXY_PORT: tsProxyPort.toString(),
        FBI_PROXY_DOMAIN: "" // Clear domain filter for tests
      }
    });

    // Wait for both proxies to start
    await Promise.all([
      new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error("Rust proxy failed to start"));
        }, 15000);

        rustProxy!.stdout!.on('data', (data) => {
          const output = data.toString();
          if (output.includes('FBI Proxy listening on')) {
            clearTimeout(timeout);
            resolve(void 0);
          }
        });

        rustProxy!.on('error', (err) => {
          clearTimeout(timeout);
          reject(err);
        });
      }),

      new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error("TypeScript proxy failed to start"));
        }, 15000);

        tsProxy!.stdout!.on('data', (data) => {
          const output = data.toString();
          if (output.includes('Proxy server running on port')) {
            clearTimeout(timeout);
            resolve(void 0);
          }
        });

        tsProxy!.on('error', (err) => {
          clearTimeout(timeout);
          reject(err);
        });
      })
    ]);

    console.log("Both proxy implementations started successfully");
  });

  afterAll(async () => {
    if (rustProxy) {
      rustProxy.kill('SIGTERM');
    }
    if (tsProxy) {
      tsProxy.kill('SIGTERM');
    }
    await testServers.stopAllServers();
  });

  async function makeRequest(proxyPort: number, host: string, path: string = "/", method: string = "GET") {
    const url = `http://127.0.0.1:${proxyPort}${path}`;

    const response = await fetch(url, {
      method,
      headers: { Host: host }
    });

    const rawBody = await response.text();
    let body;
    try {
      body = JSON.parse(rawBody);
    } catch {
      body = rawBody;
    }

    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body,
      rawBody
    };
  }

  describe("Core routing compatibility", () => {
    it("should handle numeric host routing consistently", async () => {
      const host = testPort3000.toString();
      const [rustResponse, tsResponse] = await Promise.all([
        makeRequest(rustProxyPort, host, "/comparison-test"),
        makeRequest(tsProxyPort, host, "/comparison-test")
      ]);

      // Both should succeed or both should fail
      expect(rustResponse.status).toBe(tsResponse.status);

      if (rustResponse.status === 200 && tsResponse.status === 200) {
        // Both should proxy to the same target
        expect(rustResponse.body.url).toBe(tsResponse.body.url);
        expect(rustResponse.body.headers.host).toBe(tsResponse.body.headers.host);
      }
    });

    it("should handle host--port routing consistently", async () => {
      const host = `localhost--${testPort3000}`;
      const [rustResponse, tsResponse] = await Promise.all([
        makeRequest(rustProxyPort, host, "/comparison-test"),
        makeRequest(tsProxyPort, host, "/comparison-test")
      ]);

      // Both should succeed or both should fail
      expect(rustResponse.status).toBe(tsResponse.status);

      if (rustResponse.status === 200 && tsResponse.status === 200) {
        // Both should proxy to the same target
        expect(rustResponse.body.url).toBe(tsResponse.body.url);
        expect(rustResponse.body.headers.host).toBe(tsResponse.body.headers.host);
      }
    });
  });

  describe("HTTP method support", () => {
    const methods = ["GET", "POST", "PUT", "DELETE", "PATCH"];

    methods.forEach(method => {
      it(`should handle ${method} requests consistently`, async () => {
        const [rustResponse, tsResponse] = await Promise.all([
          makeRequest(rustProxyPort, testPort3000.toString(), "/method-test", method),
          makeRequest(tsProxyPort, testPort3000.toString(), "/method-test", method)
        ]);

        expect(rustResponse.status).toBe(tsResponse.status);

        if (rustResponse.status === 200 && tsResponse.status === 200) {
          expect(rustResponse.body.method).toBe(method);
          expect(tsResponse.body.method).toBe(method);
          expect(rustResponse.body.method).toBe(tsResponse.body.method);
        }
      });
    });
  });

  describe("Error handling consistency", () => {
    it("should handle non-existent ports consistently", async () => {
      const [rustResponse, tsResponse] = await Promise.all([
        makeRequest(rustProxyPort, "9999", "/test"),
        makeRequest(tsProxyPort, "9999", "/test")
      ]);

      // Both should return 502 for unreachable targets
      expect(rustResponse.status).toBe(502);
      expect(tsResponse.status).toBe(502);
    });

    it("should handle malformed hosts consistently", async () => {
      const [rustResponse, tsResponse] = await Promise.all([
        makeRequest(rustProxyPort, "", "/test"),
        makeRequest(tsProxyPort, "", "/test")
      ]);

      // Both should handle empty hosts gracefully
      expect([400, 502]).toContain(rustResponse.status);
      expect([400, 502]).toContain(tsResponse.status);
    });
  });

  describe("Performance characteristics", () => {
    it("should both handle concurrent requests", async () => {
      const concurrentRequests = 10;
      const requests = Array.from({ length: concurrentRequests }, (_, i) => [
        makeRequest(rustProxyPort, testPort3000.toString(), `/concurrent-${i}`),
        makeRequest(tsProxyPort, testPort3000.toString(), `/concurrent-${i}`)
      ]).flat();

      const responses = await Promise.all(requests);

      // All requests should succeed
      responses.forEach(response => {
        expect(response.status).toBe(200);
      });

      // Check that all requests were processed
      const rustResponses = responses.filter((_, i) => i % 2 === 0);
      const tsResponses = responses.filter((_, i) => i % 2 === 1);

      expect(rustResponses).toHaveLength(concurrentRequests);
      expect(tsResponses).toHaveLength(concurrentRequests);
    });

    it("should handle rapid sequential requests", async () => {
      const sequentialCount = 20;
      const rustResponses = [];
      const tsResponses = [];

      for (let i = 0; i < sequentialCount; i++) {
        const [rustResponse, tsResponse] = await Promise.all([
          makeRequest(rustProxyPort, testPort3000.toString(), `/sequential-${i}`),
          makeRequest(tsProxyPort, testPort3000.toString(), `/sequential-${i}`)
        ]);

        rustResponses.push(rustResponse);
        tsResponses.push(tsResponse);
      }

      // All requests should succeed
      rustResponses.forEach(response => {
        expect(response.status).toBe(200);
      });

      tsResponses.forEach(response => {
        expect(response.status).toBe(200);
      });

      // Verify all sequential requests were processed correctly
      rustResponses.forEach((response, i) => {
        expect(response.body.url).toBe(`/sequential-${i}`);
      });

      tsResponses.forEach((response, i) => {
        expect(response.body.url).toBe(`/sequential-${i}`);
      });
    });
  });

  describe("Header handling consistency", () => {
    it("should preserve custom headers consistently", async () => {
      const customHeaders = {
        "X-Custom-Header": "test-value",
        "User-Agent": "test-comparison",
        "Authorization": "Bearer test-token"
      };

      const [rustResponse, tsResponse] = await Promise.all([
        fetch(`http://127.0.0.1:${rustProxyPort}/header-test`, {
          headers: { Host: testPort3000.toString(), ...customHeaders }
        }),
        fetch(`http://127.0.0.1:${tsProxyPort}/header-test`, {
          headers: { Host: testPort3000.toString(), ...customHeaders }
        })
      ]);

      const [rustBody, tsBody] = await Promise.all([
        rustResponse.json(),
        tsResponse.json()
      ]);

      // Both should preserve custom headers
      expect(rustBody.headers["x-custom-header"]).toBe("test-value");
      expect(tsBody.headers["x-custom-header"]).toBe("test-value");
      expect(rustBody.headers["user-agent"]).toBe("test-comparison");
      expect(tsBody.headers["user-agent"]).toBe("test-comparison");
    });

    it("should set Host header for target server consistently", async () => {
      const [rustResponse, tsResponse] = await Promise.all([
        makeRequest(rustProxyPort, testPort3000.toString(), "/host-check"),
        makeRequest(tsProxyPort, testPort3000.toString(), "/host-check")
      ]);

      expect(rustResponse.status).toBe(200);
      expect(tsResponse.status).toBe(200);

      // Both should set 'localhost' as the Host header for the target
      expect(rustResponse.body.headers.host).toBe("localhost");
      expect(tsResponse.body.headers.host).toBe("localhost");
    });
  });
});