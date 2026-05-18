import { Hono } from "hono";
import type { AuthConfig } from "../config";
import type { Session } from "../session";
import type { LocalProvider } from "../providers/local";
import { buildCookie } from "../session";
import { decide } from "../allowlist";
import type { AuditLogger } from "../audit";
import { extractMeta } from "../audit";

export type LocalLoginOpts = {
  config: AuthConfig;
  provider: LocalProvider;
  session: Session;
  ssoOrigin: string;
  audit?: AuditLogger;
};

export function localLoginRoute(opts: LocalLoginOpts): Hono {
  const app = new Hono();

  app.get("/login", (c) => {
    const rd = c.req.query("rd") ?? `${opts.ssoOrigin}/api/auth/me`;
    if (!isSafeRd(rd, opts.ssoOrigin)) {
      return c.text("invalid rd", 400);
    }
    return c.html(renderLoginPage(opts.config.domain, rd));
  });

  app.post("/api/auth/local", async (c) => {
    const meta = extractMeta(c.req);
    const body = await c.req.parseBody().catch(() => null);
    const username =
      typeof body?.username === "string" ? body.username.trim() : "";
    const password = typeof body?.password === "string" ? body.password : "";

    if (!username || !password) {
      await opts.audit?.log(
        { type: "signin.fail.local", reason: "missing" },
        meta,
      );
      return c.json({ error: "missing credentials" }, 400);
    }

    // Run scrypt unconditionally so timing is identical for wrong username
    // vs wrong password — defeats a username-enumeration oracle.
    const passwordMatched = await opts.provider.verify(password);
    const usernameMatched = username === opts.provider.user.email;
    const ok = passwordMatched && usernameMatched;

    if (!ok) {
      await opts.audit?.log(
        { type: "signin.fail.local", username, reason: "invalid" },
        meta,
      );
      return c.json({ error: "invalid credentials" }, 401);
    }

    const user = opts.provider.user;
    const decision = decide(opts.config.allowlist, { email: user.email });
    if (!decision.allow) {
      await opts.audit?.log(
        {
          type: "signin.fail.allowlist",
          provider: "local",
          email: user.email,
          reason: decision.reason,
        },
        meta,
      );
      return c.json({ error: `Forbidden: ${decision.reason}` }, 403);
    }

    const token = await opts.session.issue({
      sub: `local:${user.email}`,
      email: user.email,
      name: user.name,
    });

    await opts.audit?.log(
      {
        type: "signin.success",
        provider: "local",
        sub: `local:${user.email}`,
        email: user.email,
      },
      meta,
    );

    c.header(
      "Set-Cookie",
      buildCookie(token, {
        domain: opts.config.cookieDomain,
        maxAgeSeconds: 7 * 24 * 60 * 60,
      }),
    );
    return c.json({ ok: true, user: { email: user.email } }, 200);
  });

  return app;
}

function isSafeRd(rd: string, ssoOrigin: string): boolean {
  try {
    const u = new URL(rd);
    const sso = new URL(ssoOrigin);
    const ssoApex = sso.hostname.replace(/^sso\./, "");
    return u.hostname === sso.hostname || u.hostname.endsWith(`.${ssoApex}`);
  } catch {
    return false;
  }
}

function renderLoginPage(domain: string, rd: string): string {
  const safeRd = JSON.stringify(rd);
  const domainText = escapeHtml(domain);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Sign in to ${domainText}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
         max-width: 22rem; margin: 4rem auto; padding: 0 1rem; }
  h1 { font-weight: 600; font-size: 1.4rem; margin-bottom: 0.25rem; text-align: center; }
  p.subtitle { opacity: 0.7; margin-top: 0; text-align: center; }
  form { display: flex; flex-direction: column; gap: 0.75rem; margin-top: 1.5rem; }
  label { display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.9rem; opacity: 0.85; }
  input { font-size: 1rem; padding: 0.5rem 0.7rem; border-radius: 0.4rem;
          border: 1px solid currentColor; background: transparent; color: inherit; }
  button { font-size: 1rem; padding: 0.6rem 1.2rem; border-radius: 0.5rem; margin-top: 0.5rem;
           border: 1px solid currentColor; background: transparent; color: inherit; cursor: pointer; }
  button:hover { background: rgba(127,127,127,0.1); }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  #status { margin-top: 1rem; min-height: 1.5em; opacity: 0.85; font-size: 0.9rem; text-align: center; }
  #status.error { color: #c00; }
</style>
</head>
<body>
<main>
  <h1>Sign in to ${domainText}</h1>
  <p class="subtitle">fbi-auth · local provider (offline / no IdP)</p>
  <form id="f">
    <label>Username
      <input id="u" name="username" type="text" autocomplete="username" autofocus required>
    </label>
    <label>Password
      <input id="p" name="password" type="password" autocomplete="current-password" required>
    </label>
    <button id="btn" type="submit">Sign in</button>
  </form>
  <p id="status"></p>
</main>
<script>
  const rd = ${safeRd};
  const form = document.getElementById("f");
  const status = document.getElementById("status");
  const btn = document.getElementById("btn");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    status.classList.remove("error");
    status.textContent = "Signing in…";
    btn.disabled = true;
    const body = new URLSearchParams({
      username: document.getElementById("u").value,
      password: document.getElementById("p").value,
    });
    try {
      const res = await fetch("/api/auth/local", { method: "POST", body });
      if (!res.ok) {
        const j = await res.json().catch(() => ({ error: res.statusText }));
        status.textContent = j.error || ("HTTP " + res.status);
        status.classList.add("error");
        btn.disabled = false;
        return;
      }
      status.textContent = "Signed in. Redirecting…";
      window.location.href = rd;
    } catch (err) {
      status.textContent = err && err.message ? err.message : String(err);
      status.classList.add("error");
      btn.disabled = false;
    }
  });
</script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
