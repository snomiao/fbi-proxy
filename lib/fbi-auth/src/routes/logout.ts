import { Hono } from "hono";
import type { AuthConfig } from "../config";
import type { Session } from "../session";
import { readCookie, clearCookie } from "../session";
import type { AuditLogger } from "../audit";
import { extractMeta } from "../audit";

export function logoutRoute(opts: {
  config: AuthConfig;
  session?: Session;
  audit?: AuditLogger;
}): Hono {
  const app = new Hono();

  const handler = async (c: import("hono").Context) => {
    const meta = extractMeta(c.req);
    let sub: string | undefined;
    let email: string | undefined;
    const token = readCookie(c.req.header("cookie"));
    if (token && opts.session) {
      const claims = await opts.session.verify(token);
      if (claims) {
        sub = claims.sub;
        email = claims.email;
      }
    }
    await opts.audit?.log({ type: "logout", sub, email }, meta);
    c.header("Set-Cookie", clearCookie({ domain: opts.config.cookieDomain }));
    const rd = c.req.query("rd");
    if (rd) return c.redirect(rd, 302);
    return c.body(null, 204);
  };

  app.post("/logout", handler);
  app.get("/logout", handler);
  return app;
}
