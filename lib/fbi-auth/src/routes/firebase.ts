import { Hono } from "hono";
import type { AuthConfig } from "../config";
import type { FirebaseProvider } from "../providers/firebase";
import type { Session } from "../session";
import { buildCookie } from "../session";
import { decide } from "../allowlist";

export function firebaseRoute(opts: {
  config: AuthConfig;
  provider: FirebaseProvider;
  session: Session;
}): Hono {
  const app = new Hono();

  app.post("/api/auth/firebase", async (c) => {
    const body = await c.req.json().catch(() => null);
    const idToken = typeof body?.idToken === "string" ? body.idToken : null;
    if (!idToken) return c.json({ error: "missing idToken" }, 400);

    let user;
    try {
      user = await opts.provider.verify(idToken);
    } catch (err) {
      return c.json(
        { error: `firebase verify failed: ${(err as Error).message}` },
        401,
      );
    }

    const decision = decide(opts.config.allowlist, { email: user.email });
    if (!decision.allow) {
      return c.json({ error: `Forbidden: ${decision.reason}` }, 403);
    }

    const token = await opts.session.issue({
      sub: user.sub,
      email: user.email,
      name: user.name,
      picture: user.picture,
    });

    c.header(
      "Set-Cookie",
      buildCookie(token, {
        domain: opts.config.cookieDomain,
        maxAgeSeconds: 7 * 24 * 60 * 60,
      }),
    );
    return c.json(
      { ok: true, user: { sub: user.sub, email: user.email } },
      200,
    );
  });

  return app;
}
