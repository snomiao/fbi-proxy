import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "child_process";
import fetch from "node-fetch";
import getPort from "get-port";
import { TestServerManager } from "./helpers/test-server";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe("Domain Filtering Functionality", () => {
  let testServers: TestServerManager;
  let proxyWithDomainFilter: ChildProcess | null = null;
  let proxyPort: number;
  let testPort3000: number;

  beforeAll(async () => {
    testServers = new TestServerManager();
    proxyPort = await getPort();

    // Start test server
    testPort3000 = await testServers.startServer({
      port: await getPort({ port: 6000 }),
      responseHandler: (req) => ({
        message: "Hello from filtered domain test",
        ...req,
        timestamp: Date.now()
      })
    });

    // Start proxy with domain filter
    console.log(`Starting proxy with domain filter on port ${proxyPort}...`);
    const projectRoot = path.resolve(__dirname, "..");
    const binaryPath = path.join(projectRoot, "target/release/fbi-proxy");

    proxyWithDomainFilter = spawn(binaryPath, [
      "-p", proxyPort.toString(),
      "-h", "127.0.0.1",
      "-d", "example.com"
    ], {
      stdio: 'pipe',
      env: {
        ...process.env,
        RUST_LOG: "error"
      }
    });

    // Wait for proxy to start
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Domain-filtered proxy failed to start"));
      }, 10000);

      proxyWithDomainFilter!.stdout!.on('data', (data) => {
        const output = data.toString();
        if (output.includes('FBI Proxy listening on')) {
          clearTimeout(timeout);
          resolve(void 0);
        }
      });

      proxyWithDomainFilter!.stderr!.on('data', (data) => {
        console.error('Domain proxy stderr:', data.toString());
      });

      proxyWithDomainFilter!.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  });

  afterAll(async () => {
    if (proxyWithDomainFilter) {
      proxyWithDomainFilter.kill('SIGTERM');
    }
    await testServers.stopAllServers();
  });

  async function makeFilteredRequest(host: string, path: string = "/") {
    const url = `http://127.0.0.1:${proxyPort}${path}`;

    const response = await fetch(url, {
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
      body,
      rawBody
    };
  }

  describe("Domain filter acceptance", () => {
    it("should accept requests for subdomain of filtered domain", async () => {
      const response = await makeFilteredRequest("3000.example.com", "/test");

      // This should be accepted but will fail because localhost:80 doesn't exist
      // The important part is that it's not rejected with domain filtering
      expect(response.status).toBe(502);
      expect(response.rawBody).not.toContain("Host not allowed");
    });

    it("should accept requests for the exact filtered domain", async () => {
      const response = await makeFilteredRequest("example.com", "/test");

      // Should be accepted (though will fail because localhost:80 doesn't exist)
      expect(response.status).toBe(502);
      expect(response.rawBody).not.toContain("Host not allowed");
    });

    it("should accept numeric subdomains of filtered domain", async () => {
      const response = await makeFilteredRequest("3000.example.com", "/api");

      // Should be accepted and parsed as subdomain routing
      expect(response.status).toBe(502);
      expect(response.rawBody).not.toContain("Host not allowed");
    });
  });

  describe("Domain filter rejection", () => {
    it("should reject requests for different domains", async () => {
      const response = await makeFilteredRequest("badsite.com", "/test");

      expect(response.status).toBe(502);
      expect(response.rawBody).toContain("Bad Gateway: Host not allowed");
    });

    it("should reject requests for subdomains of different domains", async () => {
      const response = await makeFilteredRequest("3000.badsite.com", "/test");

      expect(response.status).toBe(502);
      expect(response.rawBody).toContain("Bad Gateway: Host not allowed");
    });

    it("should reject requests for domains that partially match", async () => {
      const response = await makeFilteredRequest("notexample.com", "/test");

      expect(response.status).toBe(502);
      expect(response.rawBody).toContain("Bad Gateway: Host not allowed");
    });

    it("should reject requests for localhost when domain filter is active", async () => {
      const response = await makeFilteredRequest("localhost", "/test");

      expect(response.status).toBe(502);
      expect(response.rawBody).toContain("Bad Gateway: Host not allowed");
    });

    it("should reject numeric hosts when domain filter is active", async () => {
      const response = await makeFilteredRequest("3000", "/test");

      expect(response.status).toBe(502);
      expect(response.rawBody).toContain("Bad Gateway: Host not allowed");
    });
  });

  describe("Domain filter edge cases", () => {
    it("should handle hosts with ports correctly", async () => {
      const response = await makeFilteredRequest("3000.example.com:8080", "/test");

      // Should strip port and process the domain part
      expect(response.status).toBe(502);
      expect(response.rawBody).not.toContain("Host not allowed");
    });

    it("should handle multiple subdomain levels", async () => {
      const response = await makeFilteredRequest("api.v1.example.com", "/test");

      expect(response.status).toBe(502);
      expect(response.rawBody).not.toContain("Host not allowed");
    });

    it("should handle empty subdomains correctly", async () => {
      const response = await makeFilteredRequest(".example.com", "/test");

      // Malformed host should be rejected
      expect(response.status).toBe(502);
      expect(response.rawBody).toContain("Bad Gateway: Host not allowed");
    });
  });
});