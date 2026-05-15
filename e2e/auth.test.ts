import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import {
  makeSession,
  buildCookie,
  clearCookie,
  readCookie,
  COOKIE_NAME,
} from "../lib/fbi-auth/src/session";
import { decide } from "../lib/fbi-auth/src/allowlist";
import { verifyRoute } from "../lib/fbi-auth/src/routes/verify";
import { meRoute } from "../lib/fbi-auth/src/routes/me";
import { logoutRoute } from "../lib/fbi-auth/src/routes/logout";
import { healthRoute } from "../lib/fbi-auth/src/routes/health";
import type { AuthConfig } from "../lib/fbi-auth/src/config";

const SECRET = "test-secret-" + "x".repeat(32);

function fakeConfig(): AuthConfig {
  return {
    version: 1,
    domain: "test.dev",
    cookieDomain: ".test.dev",
    ssoHost: "sso.test.dev",
    provider: "google",
    clientId: "fake-client",
    sessionSecret: SECRET,
    allowlist: { anySignedIn: true },
  };
}

describe("session", () => {
  const session = makeSession({ secret: SECRET, audience: "test.dev" });

  it("issue → verify roundtrip", async () => {
    const token = await session.issue({
      sub: "u1",
      email: "a@x.com",
      name: "Alice",
    });
    const claims = await session.verify(token);
    expect(claims?.sub).toBe("u1");
    expect(claims?.email).toBe("a@x.com");
    expect(claims?.name).toBe("Alice");
    expect(claims?.iss).toBe("fbi-auth");
    expect(claims?.aud).toBe("test.dev");
  });

  it("rejects tampered token", async () => {
    const token = await session.issue({ sub: "u1", email: "a@x.com" });
    const tampered = token.slice(0, -4) + "AAAA";
    expect(await session.verify(tampered)).toBeNull();
  });

  it("rejects token signed with a different secret", async () => {
    const other = makeSession({
      secret: "different-secret-" + "y".repeat(32),
      audience: "test.dev",
    });
    const token = await other.issue({ sub: "u1", email: "a@x.com" });
    expect(await session.verify(token)).toBeNull();
  });

  it("rejects token for different audience", async () => {
    const other = makeSession({ secret: SECRET, audience: "other.dev" });
    const token = await other.issue({ sub: "u1", email: "a@x.com" });
    expect(await session.verify(token)).toBeNull();
  });

  it("needsRefresh fires close to expiry", async () => {
    const short = makeSession({
      secret: SECRET,
      audience: "test.dev",
      ttlSeconds: 60,
    });
    const token = await short.issue({ sub: "u1", email: "a@x.com" });
    const claims = await short.verify(token);
    expect(claims).not.toBeNull();
    expect(short.needsRefresh(claims!)).toBe(true);
  });
});

describe("cookie helpers", () => {
  it("buildCookie sets all the safety attributes", () => {
    const c = buildCookie("xxx", { domain: ".test.dev", maxAgeSeconds: 100 });
    expect(c).toContain(`${COOKIE_NAME}=xxx`);
    expect(c).toContain("Domain=.test.dev");
    expect(c).toContain("HttpOnly");
    expect(c).toContain("Secure");
    expect(c).toContain("SameSite=Lax");
    expect(c).toContain("Max-Age=100");
  });

  it("readCookie extracts the right name out of a multi-cookie header", () => {
    const header = `other=1; ${COOKIE_NAME}=value-here; theme=dark`;
    expect(readCookie(header)).toBe("value-here");
  });

  it("readCookie returns null for missing or empty input", () => {
    expect(readCookie(null)).toBeNull();
    expect(readCookie("")).toBeNull();
    expect(readCookie("foo=bar")).toBeNull();
  });

  it("clearCookie has Max-Age=0", () => {
    expect(clearCookie({ domain: ".test.dev" })).toContain("Max-Age=0");
  });
});

describe("allowlist", () => {
  it("matches by exact email (case-insensitive)", () => {
    expect(
      decide({ emails: ["Alice@Example.com"] }, { email: "alice@example.com" }),
    ).toEqual({ allow: true });
  });

  it("matches by email domain (case-insensitive)", () => {
    expect(
      decide({ domains: ["MyCo.com"] }, { email: "bob@myco.com" }),
    ).toEqual({ allow: true });
  });

  it("falls through to anySignedIn", () => {
    expect(
      decide({ anySignedIn: true }, { email: "anyone@anywhere.com" }),
    ).toEqual({ allow: true });
  });

  it("rejects when no rule matches", () => {
    const result = decide(
      { emails: ["alice@example.com"] },
      { email: "mallory@evil.com" },
    );
    expect(result.allow).toBe(false);
    if (!result.allow) expect(result.reason).toContain("not in allowlist");
  });

  it("rejects an empty ruleset", () => {
    expect(decide({}, { email: "anyone@x.com" }).allow).toBe(false);
  });
});

describe("/api/auth/verify", () => {
  const config = fakeConfig();
  const session = makeSession({ secret: SECRET, audience: config.domain });
  const app = new Hono().route("/", verifyRoute({ config, session }));

  it("401 when no cookie is sent", async () => {
    const res = await app.fetch(
      new Request("https://sso.test.dev/api/auth/verify"),
    );
    expect(res.status).toBe(401);
  });

  it("401 when cookie is junk", async () => {
    const res = await app.fetch(
      new Request("https://sso.test.dev/api/auth/verify", {
        headers: { cookie: `${COOKIE_NAME}=not-a-real-jwt` },
      }),
    );
    expect(res.status).toBe(401);
  });

  it("200 + Remote-* headers when cookie is valid", async () => {
    const token = await session.issue({
      sub: "u-42",
      email: "alice@example.com",
      name: "Alice",
    });
    const res = await app.fetch(
      new Request("https://sso.test.dev/api/auth/verify", {
        headers: { cookie: `${COOKIE_NAME}=${token}` },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Remote-User")).toBe("u-42");
    expect(res.headers.get("Remote-Email")).toBe("alice@example.com");
    expect(res.headers.get("Remote-Name")).toBe("Alice");
  });
});

describe("/api/auth/me", () => {
  const config = fakeConfig();
  const session = makeSession({ secret: SECRET, audience: config.domain });
  const app = new Hono().route("/", meRoute({ session }));

  it("returns authenticated:false when no cookie", async () => {
    const res = await app.fetch(
      new Request("https://sso.test.dev/api/auth/me"),
    );
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ authenticated: false });
  });

  it("returns user payload when cookie is valid", async () => {
    const token = await session.issue({
      sub: "u-7",
      email: "x@y.com",
      name: "Xy",
    });
    const res = await app.fetch(
      new Request("https://sso.test.dev/api/auth/me", {
        headers: { cookie: `${COOKIE_NAME}=${token}` },
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.authenticated).toBe(true);
    expect(body.user.sub).toBe("u-7");
    expect(body.user.email).toBe("x@y.com");
  });
});

describe("/logout", () => {
  const config = fakeConfig();
  const app = new Hono().route("/", logoutRoute({ config }));

  it("clears the cookie", async () => {
    const res = await app.fetch(
      new Request("https://sso.test.dev/logout", { method: "POST" }),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("Set-Cookie")).toContain("Max-Age=0");
    expect(res.headers.get("Set-Cookie")).toContain("Domain=.test.dev");
  });

  it("redirects to rd if provided", async () => {
    const res = await app.fetch(
      new Request("https://sso.test.dev/logout?rd=https://test.dev/", {
        method: "POST",
      }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("https://test.dev/");
  });
});

describe("/healthz", () => {
  const app = new Hono().route("/", healthRoute());

  it("returns ok", async () => {
    const res = await app.fetch(new Request("https://sso.test.dev/healthz"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });
});
