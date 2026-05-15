import { Hono } from "hono";
import type { AuthConfig } from "../config";
import { clearCookie } from "../session";

export function logoutRoute(opts: { config: AuthConfig }): Hono {
  const app = new Hono();

  const handler = (c: import("hono").Context) => {
    c.header("Set-Cookie", clearCookie({ domain: opts.config.cookieDomain }));
    const rd = c.req.query("rd");
    if (rd) return c.redirect(rd, 302);
    return c.body(null, 204);
  };

  app.post("/logout", handler);
  app.get("/logout", handler);
  return app;
}
