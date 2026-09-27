import { describe, expect, it } from "vitest";
import {
  buildCaddyConfig,
  hostPort,
  normalizeHost,
  parseTarget,
  type ServeState,
} from "./serve";

describe("normalizeHost", () => {
  it("appends the default domain to bare names", () => {
    expect(normalizeHost("myapp")).toBe("myapp.fbi.com");
    expect(normalizeHost("MyApp", "example.test")).toBe("myapp.example.test");
  });
  it("keeps full hosts and wildcards", () => {
    expect(normalizeHost("api.example.dev")).toBe("api.example.dev");
    expect(normalizeHost("*.foo.fbi.com")).toBe("*.foo.fbi.com");
    expect(normalizeHost("https://a.fbi.com/")).toBe("a.fbi.com");
  });
  it("rejects junk", () => {
    expect(() => normalizeHost("a b")).toThrow();
    expect(() => normalizeHost("a.fbi.com:443")).toThrow();
  });
});

describe("parseTarget", () => {
  it.each([
    ["3000", "localhost:3000", false],
    [":3000", "localhost:3000", false],
    ["localhost:5173", "localhost:5173", false],
    ["http://127.0.0.1:4000", "127.0.0.1:4000", false],
    ["http://127.0.0.1:4000/", "127.0.0.1:4000", false],
    ["http://example.com", "example.com:80", false],
    ["https://example.com", "example.com:443", "verify"],
    ["https+insecure://localhost:8443", "localhost:8443", "insecure"],
  ] as const)("%s", (input, dial, tls) => {
    expect(parseTarget(input)).toEqual({ dial, tls });
  });
  it("rejects paths for now", () => {
    expect(() => parseTarget("http://localhost:3000/foo")).toThrow(/paths/);
  });
});

describe("buildCaddyConfig", () => {
  const state: ServeState = {
    bind: "127.0.0.1",
    httpsPort: 8443,
    routes: {
      "b.fbi.com": {
        target: "3000",
        tls: "internal",
        rewriteHost: false,
        pid: 1,
      },
      "a.example.dev": {
        target: "https://up.example",
        tls: "acme",
        rewriteHost: true,
      },
    },
  };
  const cfg = buildCaddyConfig(state);
  const server = cfg.apps.http.servers.fbi_serve;

  it("listens only on the configured address, without a :80 redirector", () => {
    expect(server.listen).toEqual(["127.0.0.1:8443"]);
    expect(server.automatic_https).toEqual({ disable_redirects: true });
    expect(cfg.apps.http.https_port).toBe(8443);
    expect(cfg.admin.config.persist).toBe(false);
  });
  it("emits one sorted host route per entry", () => {
    expect(server.routes.map((r) => r.match[0]!.host[0])).toEqual([
      "a.example.dev",
      "b.fbi.com",
    ]);
    const [a, b] = server.routes;
    expect(b!.handle[0]).toEqual({
      handler: "reverse_proxy",
      upstreams: [{ dial: "localhost:3000" }],
    });
    expect(a!.handle[0]).toMatchObject({
      upstreams: [{ dial: "up.example:443" }],
      transport: { protocol: "http", tls: {} },
      headers: {
        request: { set: { Host: ["{http.reverse_proxy.upstream.hostport}"] } },
      },
    });
  });
  it("puts ACME hosts before the internal-CA catch-all", () => {
    expect(cfg.apps.tls.automation.policies).toEqual([
      { subjects: ["a.example.dev"] },
      { issuers: [{ module: "internal" }] },
    ]);
  });
});

describe("hostPort", () => {
  it("brackets IPv6 literals", () => {
    expect(hostPort("127.0.0.1", 443)).toBe("127.0.0.1:443");
    expect(hostPort("::1", 443)).toBe("[::1]:443");
    expect(hostPort("::", 8443)).toBe("[::]:8443");
  });
});
