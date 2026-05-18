import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import {
  SignJWT,
  generateKeyPair,
  exportJWK,
  createLocalJWKSet,
  type JWK,
} from "jose";
import {
  makeSession,
  buildCookie,
  clearCookie,
  readCookie,
  COOKIE_NAME,
} from "../src/session";
import { decide } from "../src/allowlist";
import { verifyRoute } from "../src/routes/verify";
import { meRoute } from "../src/routes/me";
import { logoutRoute } from "../src/routes/logout";
import { healthRoute } from "../src/routes/health";
import { firebaseRoute } from "../src/routes/firebase";
import {
  makeFirebaseProvider,
  type FirebaseProvider,
  type FirebaseUser,
} from "../src/providers/firebase";
import type { AuthConfig } from "../src/config";
import { runWizard, type WizardPrompter } from "../../../ts/auth/setupWizard";

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

  it("respects custom refreshThresholdSeconds (tight = never refreshes early)", async () => {
    // ttl=3600, threshold=10 → only refresh in the last 10s.
    const s = makeSession({
      secret: SECRET,
      audience: "test.dev",
      ttlSeconds: 3600,
      refreshThresholdSeconds: 10,
    });
    const token = await s.issue({ sub: "u1", email: "a@x.com" });
    const claims = await s.verify(token);
    expect(claims).not.toBeNull();
    expect(s.needsRefresh(claims!)).toBe(false);
  });

  it("respects custom refreshThresholdSeconds (wide = refreshes immediately)", async () => {
    // ttl=3600, threshold=4000 → always refresh, since 4000 > 3600.
    const s = makeSession({
      secret: SECRET,
      audience: "test.dev",
      ttlSeconds: 3600,
      refreshThresholdSeconds: 4000,
    });
    const token = await s.issue({ sub: "u1", email: "a@x.com" });
    const claims = await s.verify(token);
    expect(claims).not.toBeNull();
    expect(s.needsRefresh(claims!)).toBe(true);
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

// ─────────────────────────────────────────────────────────────────────────────
// Phase 2 — Firebase provider
// ─────────────────────────────────────────────────────────────────────────────

type FirebaseFixture = {
  provider: ReturnType<typeof makeFirebaseProvider>;
  signValid: (overrides?: Record<string, unknown>) => Promise<string>;
  signWith: (
    claims: Record<string, unknown>,
    header?: { kid?: string },
  ) => Promise<string>;
};

const PROJECT_ID = "fbi-test-project";
const ISSUER = `https://securetoken.google.com/${PROJECT_ID}`;

async function makeFirebaseFixture(): Promise<FirebaseFixture> {
  const { publicKey, privateKey } = await generateKeyPair("RS256", {
    extractable: true,
  });
  const pubJwk: JWK = await exportJWK(publicKey);
  pubJwk.kid = "test-kid";
  pubJwk.alg = "RS256";
  pubJwk.use = "sig";

  const jwks = createLocalJWKSet({ keys: [pubJwk] });
  const provider = makeFirebaseProvider({ projectId: PROJECT_ID, jwks });

  const baseClaims = (): Record<string, unknown> => {
    const now = Math.floor(Date.now() / 1000);
    return {
      iss: ISSUER,
      aud: PROJECT_ID,
      sub: "firebase-uid-123",
      email: "user@example.com",
      email_verified: true,
      name: "Test User",
      iat: now,
      auth_time: now,
      exp: now + 3600,
    };
  };

  const signWith = async (
    claims: Record<string, unknown>,
    header: { kid?: string } = {},
  ) => {
    return await new SignJWT(claims)
      .setProtectedHeader({
        alg: "RS256",
        kid: header.kid ?? "test-kid",
        typ: "JWT",
      })
      .sign(privateKey);
  };

  const signValid = async (overrides: Record<string, unknown> = {}) => {
    return await signWith({ ...baseClaims(), ...overrides });
  };

  return { provider, signValid, signWith };
}

describe("firebase provider", () => {
  it("valid token → returns FirebaseUser", async () => {
    const fx = await makeFirebaseFixture();
    const token = await fx.signValid();
    const user = await fx.provider.verify(token);
    expect(user.sub).toBe("firebase-uid-123");
    expect(user.email).toBe("user@example.com");
    expect(user.emailVerified).toBe(true);
    expect(user.name).toBe("Test User");
  });

  it("wrong issuer → throws", async () => {
    const fx = await makeFirebaseFixture();
    const token = await fx.signValid({ iss: "https://evil.example.com/other" });
    await expect(fx.provider.verify(token)).rejects.toThrow();
  });

  it("wrong audience → throws", async () => {
    const fx = await makeFirebaseFixture();
    const token = await fx.signValid({ aud: "wrong-project" });
    await expect(fx.provider.verify(token)).rejects.toThrow();
  });

  it("email_verified=false → throws", async () => {
    const fx = await makeFirebaseFixture();
    const token = await fx.signValid({ email_verified: false });
    await expect(fx.provider.verify(token)).rejects.toThrow(/not verified/i);
  });

  it("missing email → throws", async () => {
    const fx = await makeFirebaseFixture();
    const token = await fx.signValid({ email: undefined });
    await expect(fx.provider.verify(token)).rejects.toThrow(/email/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 2 — POST /api/auth/firebase route
// ─────────────────────────────────────────────────────────────────────────────

function stubFirebaseProvider(opts: {
  user?: FirebaseUser;
  throwError?: string;
}): FirebaseProvider {
  return {
    projectId: PROJECT_ID,
    async verify() {
      if (opts.throwError) throw new Error(opts.throwError);
      return (
        opts.user ?? {
          sub: "u-firebase-1",
          email: "alice@example.com",
          emailVerified: true,
          name: "Alice",
        }
      );
    },
  };
}

function firebaseConfig(overrides: Partial<AuthConfig> = {}): AuthConfig {
  return {
    version: 1,
    domain: "test.dev",
    cookieDomain: ".test.dev",
    ssoHost: "sso.test.dev",
    provider: "firebase",
    firebase: { projectId: PROJECT_ID },
    sessionSecret: SECRET,
    allowlist: { anySignedIn: true },
    ...overrides,
  };
}

describe("POST /api/auth/firebase", () => {
  it("400 when idToken is missing", async () => {
    const config = firebaseConfig();
    const session = makeSession({ secret: SECRET, audience: config.domain });
    const app = new Hono().route(
      "/",
      firebaseRoute({
        config,
        provider: stubFirebaseProvider({}),
        session,
      }),
    );

    const res = await app.fetch(
      new Request("https://sso.test.dev/api/auth/firebase", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("401 when verify throws (bad idToken)", async () => {
    const config = firebaseConfig();
    const session = makeSession({ secret: SECRET, audience: config.domain });
    const app = new Hono().route(
      "/",
      firebaseRoute({
        config,
        provider: stubFirebaseProvider({ throwError: "invalid signature" }),
        session,
      }),
    );

    const res = await app.fetch(
      new Request("https://sso.test.dev/api/auth/firebase", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ idToken: "garbage" }),
      }),
    );
    expect(res.status).toBe(401);
  });

  it("200 + Set-Cookie when valid + allowlist allows", async () => {
    const config = firebaseConfig({ allowlist: { anySignedIn: true } });
    const session = makeSession({ secret: SECRET, audience: config.domain });
    const app = new Hono().route(
      "/",
      firebaseRoute({
        config,
        provider: stubFirebaseProvider({
          user: {
            sub: "u-9",
            email: "carol@example.com",
            emailVerified: true,
          },
        }),
        session,
      }),
    );

    const res = await app.fetch(
      new Request("https://sso.test.dev/api/auth/firebase", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ idToken: "good-token" }),
      }),
    );
    expect(res.status).toBe(200);
    const cookie = res.headers.get("Set-Cookie");
    expect(cookie).toBeTruthy();
    expect(cookie).toContain(`${COOKIE_NAME}=`);
    expect(cookie).toContain("Domain=.test.dev");
  });

  it("403 when allowlist rejects user", async () => {
    const config = firebaseConfig({
      allowlist: { emails: ["only@example.com"], anySignedIn: false },
    });
    const session = makeSession({ secret: SECRET, audience: config.domain });
    const app = new Hono().route(
      "/",
      firebaseRoute({
        config,
        provider: stubFirebaseProvider({
          user: {
            sub: "u-9",
            email: "mallory@evil.com",
            emailVerified: true,
          },
        }),
        session,
      }),
    );

    const res = await app.fetch(
      new Request("https://sso.test.dev/api/auth/firebase", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ idToken: "good-token" }),
      }),
    );
    expect(res.status).toBe(403);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 2 — setup wizard
// ─────────────────────────────────────────────────────────────────────────────

function scriptedPrompter(
  answers: string[],
  choices: number[],
): WizardPrompter & { printed: string[] } {
  let ai = 0;
  let ci = 0;
  const printed: string[] = [];
  return {
    // Mirror readlinePrompter: an empty answer falls back to the default.
    ask: async (_q, defaultValue) => {
      const raw = (answers[ai++] ?? "").trim();
      return raw || defaultValue || "";
    },
    askChoice: async () => choices[ci++] ?? 0,
    print: (l) => {
      printed.push(l);
    },
    printed,
  };
}

describe("setup wizard", () => {
  it("Google branch fills clientId/clientSecret", async () => {
    // domain (use default), provider=google(0), clientId, clientSecret,
    // allowlist=anySignedIn(0)
    const p = scriptedPrompter(
      ["", "my-google-client-id", "my-google-secret"],
      [0, 0],
    );
    const cfg = await runWizard(p, { domain: "fbi.com", existing: null });
    expect(cfg.provider).toBe("google");
    expect(cfg.clientId).toBe("my-google-client-id");
    expect(cfg.clientSecret).toBe("my-google-secret");
    expect(cfg.firebase).toBeUndefined();
    expect(cfg.domain).toBe("fbi.com");
    expect(cfg.cookieDomain).toBe(".fbi.com");
    expect(cfg.ssoHost).toBe("sso.fbi.com");
    expect(cfg.allowlist.anySignedIn).toBe(true);
    expect(cfg.sessionSecret.length).toBeGreaterThanOrEqual(32);
  });

  it("Firebase branch fills projectId", async () => {
    // domain (default), provider=firebase(1), projectId, apiKey (skip), authDomain (default),
    // allowlist=anySignedIn(0)
    const p = scriptedPrompter(["", "my-fb-project", "", ""], [1, 0]);
    const cfg = await runWizard(p, { domain: "fbi.com", existing: null });
    expect(cfg.provider).toBe("firebase");
    expect(cfg.firebase?.projectId).toBe("my-fb-project");
    expect(cfg.clientId).toBeUndefined();
    expect(cfg.clientSecret).toBeUndefined();
  });

  it("Allowlist emails branch", async () => {
    // domain, provider=google, clientId, clientSecret, allowlist=emails(1), emails
    const p = scriptedPrompter(
      ["", "cid", "secret", "alice@ex.com, bob@ex.com"],
      [0, 1],
    );
    const cfg = await runWizard(p, { domain: "fbi.com", existing: null });
    expect(cfg.allowlist.emails).toEqual(["alice@ex.com", "bob@ex.com"]);
    expect(cfg.allowlist.anySignedIn).toBe(false);
    expect(cfg.allowlist.domains).toBeUndefined();
  });

  it("Allowlist domains branch", async () => {
    // domain, provider=google, clientId, clientSecret, allowlist=domains(2), domains
    const p = scriptedPrompter(["", "cid", "secret", "ex.com, my.co"], [0, 2]);
    const cfg = await runWizard(p, { domain: "fbi.com", existing: null });
    expect(cfg.allowlist.domains).toEqual(["ex.com", "my.co"]);
    expect(cfg.allowlist.anySignedIn).toBe(false);
    expect(cfg.allowlist.emails).toBeUndefined();
  });

  it("Allowlist anySignedIn branch", async () => {
    const p = scriptedPrompter(["", "cid", "secret"], [0, 0]);
    const cfg = await runWizard(p, { domain: "fbi.com", existing: null });
    expect(cfg.allowlist).toEqual({ anySignedIn: true });
  });

  it("strips leading dot from domain input", async () => {
    // domain=".fbi.com" → cleaned to "fbi.com"
    const p = scriptedPrompter([".fbi.com", "cid", "secret"], [0, 0]);
    const cfg = await runWizard(p, { domain: "different.com", existing: null });
    expect(cfg.domain).toBe("fbi.com");
    expect(cfg.cookieDomain).toBe(".fbi.com");
    expect(cfg.ssoHost).toBe("sso.fbi.com");
  });

  it("snolab branch — picks provider snolab and stores no credentials", async () => {
    // domain (empty → default), provider choice 2 (snolab), allowlist 0
    const p = scriptedPrompter([""], [2, 0]);
    const cfg = await runWizard(p, { domain: "fbi.com", existing: null });
    expect(cfg.provider).toBe("snolab");
    expect(cfg.clientId).toBeUndefined();
    expect(cfg.clientSecret).toBeUndefined();
    expect(cfg.firebase).toBeUndefined();
    expect(cfg.domain).toBe("fbi.com");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 4 — Snolab default IdP
// ─────────────────────────────────────────────────────────────────────────────

import {
  isSnolabFirebaseConfigured,
  snolabSupportsDomain,
  snolabUnavailableMessage,
  SNOLAB_SUPPORTED_DOMAINS,
} from "../src/snolabDefaults";

describe("snolab defaults", () => {
  it("ships fbi.com in the supported-domains list", () => {
    expect(SNOLAB_SUPPORTED_DOMAINS).toContain("fbi.com");
  });

  it("snolabSupportsDomain tolerates a leading dot", () => {
    expect(snolabSupportsDomain("fbi.com")).toBe(true);
    expect(snolabSupportsDomain(".fbi.com")).toBe(true);
    expect(snolabSupportsDomain("example.dev")).toBe(false);
  });

  it("reports unconfigured / unsupported with actionable error text", () => {
    if (!isSnolabFirebaseConfigured()) {
      const msg = snolabUnavailableMessage("fbi.com");
      expect(msg).toContain("snolab default IdP isn't published yet");
      expect(msg).toContain("--reconfigure");
    } else {
      // Published path: supported domain → "", unsupported → message.
      expect(snolabUnavailableMessage("fbi.com")).toBe("");
      expect(snolabUnavailableMessage("nope.example")).toContain(
        "isn't supported",
      );
    }
  });
});

describe("server / snolab branch", () => {
  it("buildApp succeeds for supported domain when configured", async () => {
    if (!isSnolabFirebaseConfigured()) return; // unpublished build
    const { buildApp } = await import("../src/server");
    const cfg: AuthConfig = {
      ...fakeConfig(),
      domain: "fbi.com",
      cookieDomain: ".fbi.com",
      ssoHost: "sso.fbi.com",
      provider: "snolab",
      clientId: undefined,
      clientSecret: undefined,
    };
    const { app } = await buildApp(cfg);
    // /login should serve the Firebase Web SDK page
    const res = await app.request("/login", { method: "GET" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("text/html");
    const html = await res.text();
    expect(html).toContain("Sign in with Google");
    expect(html).toContain("firebase-app.js");
    expect(html).toContain("snolab"); // projectId baked into config
  });

  it("buildApp rejects unsupported domain when configured", async () => {
    if (!isSnolabFirebaseConfigured()) return;
    const { buildApp } = await import("../src/server");
    const cfg: AuthConfig = {
      ...fakeConfig(),
      domain: "nope.example",
      cookieDomain: ".nope.example",
      ssoHost: "sso.nope.example",
      provider: "snolab",
      clientId: undefined,
      clientSecret: undefined,
    };
    await expect(buildApp(cfg)).rejects.toThrow(/isn't supported/);
  });

  it("buildApp throws snolabUnavailable when not configured", async () => {
    if (isSnolabFirebaseConfigured()) return; // published build skips this
    const { buildApp } = await import("../src/server");
    const cfg: AuthConfig = {
      ...fakeConfig(),
      provider: "snolab",
      clientId: undefined,
      clientSecret: undefined,
    };
    await expect(buildApp(cfg)).rejects.toThrow(/snolab default IdP/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 5 — Audit log
// ─────────────────────────────────────────────────────────────────────────────

import { makeAuditLogger, type AuditEvent } from "../src/audit";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";

describe("audit logger", () => {
  it("appends one JSONL line per event with iso timestamp", async () => {
    const dir = await mkdtemp(pathJoin(tmpdir(), "fbi-audit-"));
    const path = pathJoin(dir, "audit.log");
    const log = makeAuditLogger({ path, enabled: true });
    await log.log({
      type: "signin.success",
      provider: "google",
      sub: "u1",
      email: "a@x.com",
    });
    await log.log({ type: "logout", sub: "u1", email: "a@x.com" });
    const raw = await readFile(path, "utf8");
    const lines = raw.trim().split("\n");
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]);
    expect(first.type).toBe("signin.success");
    expect(first.email).toBe("a@x.com");
    expect(typeof first.ts).toBe("string");
    expect(first.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    await rm(dir, { recursive: true });
  });

  it("includes optional meta (ip, ua, host)", async () => {
    const dir = await mkdtemp(pathJoin(tmpdir(), "fbi-audit-"));
    const path = pathJoin(dir, "audit.log");
    const log = makeAuditLogger({ path, enabled: true });
    await log.log(
      { type: "verify.fail", reason: "invalid" },
      { ip: "1.2.3.4", userAgent: "curl/8.0", host: "x.fbi.com" },
    );
    const raw = await readFile(path, "utf8");
    const evt = JSON.parse(raw.trim());
    expect(evt.ip).toBe("1.2.3.4");
    expect(evt.ua).toBe("curl/8.0");
    expect(evt.host).toBe("x.fbi.com");
    await rm(dir, { recursive: true });
  });

  it("writes nothing when disabled", async () => {
    const dir = await mkdtemp(pathJoin(tmpdir(), "fbi-audit-"));
    const path = pathJoin(dir, "audit.log");
    const log = makeAuditLogger({ path, enabled: false });
    await log.log({ type: "logout" });
    let threw = false;
    try {
      await readFile(path, "utf8");
    } catch {
      threw = true;
    }
    expect(threw).toBe(true); // file shouldn't exist
    await rm(dir, { recursive: true });
  });

  it("survives write failures without throwing (best-effort)", async () => {
    // Pointing at an unwritable parent directory — makeAuditLogger should swallow
    // the error rather than crash the auth flow.
    const log = makeAuditLogger({
      path: "/proc/cannot-write-here/audit.log",
      enabled: true,
    });
    // Silence the console.error noise expected from the swallow path.
    const orig = console.error;
    console.error = () => {};
    try {
      await log.log({ type: "logout" });
    } finally {
      console.error = orig;
    }
    // If we got here without throwing, contract holds.
    expect(true).toBe(true);
  });
});

describe("verify route → audit", () => {
  it("emits verify.fail:missing when no cookie present", async () => {
    const { verifyRoute } = await import("../src/routes/verify");
    const events: AuditEvent[] = [];
    const fakeAudit = {
      log: async (e: AuditEvent) => {
        events.push(e);
      },
      path: () => "",
    };
    const session = makeSession({ secret: SECRET, audience: "test.dev" });
    const app = verifyRoute({
      config: fakeConfig(),
      session,
      audit: fakeAudit,
    });
    const res = await app.request("/api/auth/verify", { method: "GET" });
    expect(res.status).toBe(401);
    expect(events.length).toBe(1);
    expect(events[0]).toMatchObject({ type: "verify.fail", reason: "missing" });
  });

  it("emits verify.fail:invalid for a tampered cookie", async () => {
    const { verifyRoute } = await import("../src/routes/verify");
    const events: AuditEvent[] = [];
    const fakeAudit = {
      log: async (e: AuditEvent) => {
        events.push(e);
      },
      path: () => "",
    };
    const session = makeSession({ secret: SECRET, audience: "test.dev" });
    const app = verifyRoute({
      config: fakeConfig(),
      session,
      audit: fakeAudit,
    });
    const res = await app.request("/api/auth/verify", {
      method: "GET",
      headers: { cookie: `${COOKIE_NAME}=bogus.token.value` },
    });
    expect(res.status).toBe(401);
    expect(events.length).toBe(1);
    expect(events[0]).toMatchObject({ type: "verify.fail", reason: "invalid" });
  });
});

describe("logout route → audit", () => {
  it("emits logout with sub/email when cookie is valid", async () => {
    const { logoutRoute } = await import("../src/routes/logout");
    const events: AuditEvent[] = [];
    const fakeAudit = {
      log: async (e: AuditEvent) => {
        events.push(e);
      },
      path: () => "",
    };
    const session = makeSession({ secret: SECRET, audience: "test.dev" });
    const token = await session.issue({ sub: "u1", email: "a@x.com" });
    const app = logoutRoute({
      config: fakeConfig(),
      session,
      audit: fakeAudit,
    });
    const res = await app.request("/logout", {
      method: "POST",
      headers: { cookie: `${COOKIE_NAME}=${token}` },
    });
    expect(res.status).toBe(204);
    expect(events.length).toBe(1);
    expect(events[0]).toMatchObject({
      type: "logout",
      sub: "u1",
      email: "a@x.com",
    });
  });

  it("emits logout with no sub when cookie absent", async () => {
    const { logoutRoute } = await import("../src/routes/logout");
    const events: AuditEvent[] = [];
    const fakeAudit = {
      log: async (e: AuditEvent) => {
        events.push(e);
      },
      path: () => "",
    };
    const app = logoutRoute({ config: fakeConfig(), audit: fakeAudit });
    const res = await app.request("/logout", { method: "POST" });
    expect(res.status).toBe(204);
    expect(events.length).toBe(1);
    expect(events[0]).toMatchObject({ type: "logout" });
  });
});
