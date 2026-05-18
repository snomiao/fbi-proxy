import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import {
  hashPassword,
  makeLocalProvider,
  makeLocalProviderFromPassword,
} from "../src/providers/local";
import { localLoginRoute } from "../src/routes/localLogin";
import { verifyRoute, COOKIE_NAME } from "../src/routes/verify";
import { makeSession } from "../src/session";
import type { AuthConfig } from "../src/config";

const SECRET = "test-secret-" + "x".repeat(32);

function fakeConfig(overrides: Partial<AuthConfig> = {}): AuthConfig {
  return {
    version: 1,
    domain: "test.dev",
    cookieDomain: ".test.dev",
    ssoHost: "sso.test.dev",
    provider: "local",
    local: { email: "alice@test.dev", name: "Alice" },
    sessionSecret: SECRET,
    allowlist: { anySignedIn: true },
    ...overrides,
  };
}

describe("local provider (scrypt)", () => {
  it("hashPassword with same salt is deterministic", async () => {
    const a = await hashPassword("hunter2");
    const b = await hashPassword("hunter2", a.salt);
    expect(b.hash.equals(a.hash)).toBe(true);
  });

  it("hashPassword with different salt → different hash", async () => {
    const a = await hashPassword("hunter2");
    const b = await hashPassword("hunter2");
    expect(b.salt.equals(a.salt)).toBe(false);
    expect(b.hash.equals(a.hash)).toBe(false);
  });

  it("verify accepts correct password", async () => {
    const p = await makeLocalProviderFromPassword({
      email: "u@x",
      password: "correct horse battery staple",
    });
    expect(await p.verify("correct horse battery staple")).toBe(true);
  });

  it("verify rejects incorrect password", async () => {
    const p = await makeLocalProviderFromPassword({
      email: "u@x",
      password: "right",
    });
    expect(await p.verify("wrong")).toBe(false);
  });

  it("verify rejects empty password (does not throw)", async () => {
    const p = await makeLocalProviderFromPassword({
      email: "u@x",
      password: "right",
    });
    expect(await p.verify("")).toBe(false);
  });

  it("makeLocalProvider with mismatched-length hash returns false without throwing", async () => {
    const { hash, salt } = await hashPassword("right");
    const truncated = hash.subarray(0, hash.length - 1);
    const p = makeLocalProvider({
      user: { email: "u@x" },
      passwordHash: truncated,
      salt,
    });
    expect(await p.verify("right")).toBe(false);
  });
});

describe("local login route", () => {
  async function buildApp(cfgOverrides: Partial<AuthConfig> = {}) {
    const config = fakeConfig(cfgOverrides);
    const session = makeSession({
      secret: config.sessionSecret,
      audience: config.domain,
    });
    const provider = await makeLocalProviderFromPassword({
      email: config.local!.email,
      name: config.local!.name,
      password: "hunter2",
    });
    const app = new Hono();
    app.route(
      "/",
      localLoginRoute({
        config,
        provider,
        session,
        ssoOrigin: `https://${config.ssoHost}`,
      }),
    );
    app.route("/", verifyRoute({ config, session }));
    return { app, config, session };
  }

  it("GET /login serves the form HTML", async () => {
    const { app } = await buildApp();
    const res = await app.request("/login");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Sign in to test.dev");
    expect(html).toContain('id="u"');
    expect(html).toContain('id="p"');
    expect(html).toContain("/api/auth/local");
  });

  it("GET /login rejects unsafe rd", async () => {
    const { app } = await buildApp();
    const res = await app.request("/login?rd=https://evil.example.com/x");
    expect(res.status).toBe(400);
  });

  it("POST /api/auth/local: correct credentials → 200 + Set-Cookie", async () => {
    const { app } = await buildApp();
    const res = await app.request("/api/auth/local", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        username: "alice@test.dev",
        password: "hunter2",
      }).toString(),
    });
    expect(res.status).toBe(200);
    const cookie = res.headers.get("set-cookie");
    expect(cookie).toMatch(new RegExp(`^${COOKIE_NAME}=`));
    expect(cookie).toContain("Domain=.test.dev");
    expect(cookie).toContain("HttpOnly");
  });

  it("POST /api/auth/local: wrong password → 401", async () => {
    const { app } = await buildApp();
    const res = await app.request("/api/auth/local", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        username: "alice@test.dev",
        password: "WRONG",
      }).toString(),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("POST /api/auth/local: wrong username → 401 (no enumeration)", async () => {
    const { app } = await buildApp();
    const res = await app.request("/api/auth/local", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        username: "eve@test.dev",
        password: "hunter2",
      }).toString(),
    });
    expect(res.status).toBe(401);
  });

  it("POST /api/auth/local: missing fields → 400", async () => {
    const { app } = await buildApp();
    const res = await app.request("/api/auth/local", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: "alice@test.dev" }).toString(),
    });
    expect(res.status).toBe(400);
  });

  it("POST /api/auth/local: allowlist blocks the user → 403", async () => {
    const { app } = await buildApp({
      allowlist: { emails: ["bob@test.dev"], anySignedIn: false },
    });
    const res = await app.request("/api/auth/local", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        username: "alice@test.dev",
        password: "hunter2",
      }).toString(),
    });
    expect(res.status).toBe(403);
  });

  it("cookie from /api/auth/local is accepted by /api/auth/verify", async () => {
    const { app } = await buildApp();
    const loginRes = await app.request("/api/auth/local", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        username: "alice@test.dev",
        password: "hunter2",
      }).toString(),
    });
    const setCookie = loginRes.headers.get("set-cookie")!;
    const tokenMatch = setCookie.match(new RegExp(`${COOKIE_NAME}=([^;]+)`));
    expect(tokenMatch).not.toBeNull();
    const token = tokenMatch![1];

    const verifyRes = await app.request("/api/auth/verify", {
      headers: { cookie: `${COOKIE_NAME}=${token}` },
    });
    expect(verifyRes.status).toBe(200);
    expect(verifyRes.headers.get("Remote-Email")).toBe("alice@test.dev");
  });
});
