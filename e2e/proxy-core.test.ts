import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ProxyTestClient } from "./helpers/proxy-client";
import { TestServerManager } from "./helpers/test-server";

describe("FBI Proxy Core Functionality", () => {
  let client: ProxyTestClient;
  let testServers: TestServerManager;
  let testPort3000: number;
  let testPort8080: number;

  beforeAll(async () => {
    client = new ProxyTestClient();
    testServers = new TestServerManager();

    // Start additional test servers
    testPort3000 = await testServers.startServer({
      port: 3000,
      responseHandler: (req) => ({
        message: "Hello from port 3000",
        ...req,
        timestamp: Date.now()
      })
    });

    testPort8080 = await testServers.startServer({
      port: 8080,
      responseHandler: (req) => ({
        message: "Hello from port 8080",
        ...req,
        timestamp: Date.now()
      })
    });
  });

  afterAll(async () => {
    await testServers.stopAllServers();
  });

  describe("Rule 1: Number host goes to local port", () => {
    it("should proxy '3000' to localhost:3000", async () => {
      const response = await client.makeRequest({
        host: "3000",
        path: "/test"
      });

      expect(response.status).toBe(200);
      expect(response.body.message).toBe("Hello from port 3000");
      expect(response.body.url).toBe("/test");
      expect(response.body.headers.host).toBe("localhost");
    });

    it("should proxy '8080' to localhost:8080", async () => {
      const response = await client.makeRequest({
        host: "8080",
        path: "/api/data"
      });

      expect(response.status).toBe(200);
      expect(response.body.message).toBe("Hello from port 8080");
      expect(response.body.url).toBe("/api/data");
      expect(response.body.headers.host).toBe("localhost");
    });

    it("should handle POST requests to numeric hosts", async () => {
      const testData = JSON.stringify({ test: "data" });

      const response = await client.makeRequest({
        host: "3000",
        path: "/submit",
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: testData
      });

      expect(response.status).toBe(200);
      expect(response.body.method).toBe("POST");
      expect(response.body.url).toBe("/submit");
      expect(response.body.headers["content-type"]).toBe("application/json");
    });
  });

  describe("Rule 1.2: host--port goes to host:port", () => {
    it("should proxy 'localhost--3000' to localhost:3000", async () => {
      const response = await client.makeRequest({
        host: "localhost--3000",
        path: "/api"
      });

      expect(response.status).toBe(200);
      expect(response.body.message).toBe("Hello from port 3000");
      expect(response.body.headers.host).toBe("localhost");
    });

    it("should proxy 'api--8080' to api:8080 (should fail gracefully)", async () => {
      const response = await client.makeRequest({
        host: "api--8080",
        path: "/test"
      });

      // This should fail because 'api' is not a valid host
      expect(response.status).toBe(502);
    });
  });

  describe("Rule 2: Other host goes to host:80", () => {
    it("should proxy 'localhost' to localhost:80 (expected to fail)", async () => {
      const response = await client.makeRequest({
        host: "localhost",
        path: "/test"
      });

      // This should fail because nothing is running on port 80
      expect(response.status).toBe(502);
    });
  });

  describe("Rule 3: Subdomain hoisting", () => {
    it("should proxy '3000.localhost' to localhost:80 with host: 3000", async () => {
      const response = await client.makeRequest({
        host: "3000.localhost",
        path: "/subdomain-test"
      });

      // This should fail because localhost:80 is not running
      // but it tests the subdomain parsing logic
      expect(response.status).toBe(502);
    });
  });

  describe("HTTP Methods Support", () => {
    const testCases = [
      { method: "GET", path: "/get-test" },
      { method: "POST", path: "/post-test" },
      { method: "PUT", path: "/put-test" },
      { method: "DELETE", path: "/delete-test" },
      { method: "PATCH", path: "/patch-test" }
    ];

    testCases.forEach(({ method, path }) => {
      it(`should support ${method} requests`, async () => {
        const response = await client.makeRequest({
          host: "3000",
          path,
          method,
          headers: {
            "X-Test-Header": "test-value"
          }
        });

        expect(response.status).toBe(200);
        expect(response.body.method).toBe(method);
        expect(response.body.url).toBe(path);
        expect(response.body.headers["x-test-header"]).toBe("test-value");
      });
    });
  });

  describe("Header Preservation", () => {
    it("should preserve custom headers", async () => {
      const customHeaders = {
        "X-Custom-Header": "custom-value",
        "User-Agent": "test-agent",
        "Authorization": "Bearer test-token"
      };

      const response = await client.makeRequest({
        host: "3000",
        path: "/headers-test",
        headers: customHeaders
      });

      expect(response.status).toBe(200);
      expect(response.body.headers["x-custom-header"]).toBe("custom-value");
      expect(response.body.headers["user-agent"]).toBe("test-agent");
      expect(response.body.headers["authorization"]).toBe("Bearer test-token");
    });

    it("should correctly set Host header for target server", async () => {
      const response = await client.makeRequest({
        host: "3000",
        path: "/host-check"
      });

      expect(response.status).toBe(200);
      // The target server should receive 'localhost' as the host header
      expect(response.body.headers.host).toBe("localhost");
    });
  });

  describe("Error Handling", () => {
    it("should return 502 for unreachable hosts", async () => {
      const response = await client.makeRequest({
        host: "9999", // Assuming nothing runs on port 9999
        path: "/test"
      });

      expect(response.status).toBe(502);
    });

    it("should handle malformed requests gracefully", async () => {
      const response = await client.makeRequest({
        host: "3000",
        path: "/test",
        headers: {
          "Malformed-Header": "value\nwith\nnewlines"
        }
      });

      // Should either succeed or fail gracefully (not crash)
      expect([200, 400, 502]).toContain(response.status);
    });
  });

  describe("Content Handling", () => {
    it("should handle JSON responses correctly", async () => {
      const response = await client.makeRequest({
        host: "3000",
        path: "/json-test",
        headers: {
          "Accept": "application/json"
        }
      });

      expect(response.status).toBe(200);
      expect(response.headers["content-type"]).toContain("application/json");
      expect(typeof response.body).toBe("object");
    });

    it("should handle large request bodies", async () => {
      const largeData = JSON.stringify({
        data: "x".repeat(1000),
        timestamp: Date.now()
      });

      const response = await client.makeRequest({
        host: "3000",
        path: "/large-body",
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: largeData
      });

      expect(response.status).toBe(200);
      expect(response.body.method).toBe("POST");
    });
  });
});