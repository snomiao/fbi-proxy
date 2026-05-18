import { Hono } from "hono";
import type { Session } from "../session";
import { readCookie, buildCookie, COOKIE_NAME } from "../session";
import type { AuthConfig } from "../config";
import type { AuditLogger } from "../audit";
import { extractMeta } from "../audit";

export function verifyRoute(opts: {
  config: AuthConfig;
  session: Session;
  audit?: AuditLogger;
}): Hono {
  const app = new Hono();

  app.get("/api/auth/verify", async (c) => {
    const meta = extractMeta(c.req);
    const token = readCookie(c.req.header("cookie"));
    if (!token) {
      await opts.audit?.log({ type: "verify.fail", reason: "missing" }, meta);
      return unauthorized(c);
    }

    const claims = await opts.session.verify(token);
    if (!claims) {
      await opts.audit?.log({ type: "verify.fail", reason: "invalid" }, meta);
      return unauthorized(c);
    }

    if (opts.session.needsRefresh(claims)) {
      const now = Math.floor(Date.now() / 1000);
      const fresh = await opts.session.issue({
        sub: claims.sub,
        email: claims.email,
        name: claims.name,
        picture: claims.picture,
      });
      await opts.audit?.log(
        {
          type: "session.refresh",
          sub: claims.sub,
          email: claims.email,
          remainingSec: claims.exp - now,
        },
        meta,
      );
      c.header(
        "Set-Cookie",
        buildCookie(fresh, {
          domain: opts.config.cookieDomain,
          maxAgeSeconds: 7 * 24 * 60 * 60,
        }),
      );
    }

    c.header("Remote-User", claims.sub);
    c.header("Remote-Email", claims.email);
    if (claims.name) c.header("Remote-Name", claims.name);
    return c.body(null, 200);
  });

  return app;

  function unauthorized(c: import("hono").Context) {
    return c.body(null, 401);
  }
}

export { COOKIE_NAME };
