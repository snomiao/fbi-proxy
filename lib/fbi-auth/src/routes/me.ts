import { Hono } from "hono";
import type { Session } from "../session";
import { readCookie } from "../session";

export function meRoute(opts: { session: Session }): Hono {
  const app = new Hono();

  app.get("/api/auth/me", async (c) => {
    const token = readCookie(c.req.header("cookie"));
    if (!token) return c.json({ authenticated: false }, 401);

    const claims = await opts.session.verify(token);
    if (!claims) return c.json({ authenticated: false }, 401);

    return c.json({
      authenticated: true,
      user: {
        sub: claims.sub,
        email: claims.email,
        name: claims.name,
        picture: claims.picture,
        exp: claims.exp,
      },
    });
  });

  return app;
}
