import { Hono } from "hono";
import type { Session } from "../session";
import { readCookie, buildCookie, COOKIE_NAME } from "../session";
import type { AuthConfig } from "../config";

export function verifyRoute(opts: {
  config: AuthConfig;
  session: Session;
}): Hono {
  const app = new Hono();

  app.get("/api/auth/verify", async (c) => {
    const token = readCookie(c.req.header("cookie"));
    if (!token) return unauthorized(c);

    const claims = await opts.session.verify(token);
    if (!claims) return unauthorized(c);

    if (opts.session.needsRefresh(claims)) {
      const fresh = await opts.session.issue({
        sub: claims.sub,
        email: claims.email,
        name: claims.name,
        picture: claims.picture,
      });
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
