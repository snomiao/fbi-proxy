import { Hono } from "hono";
import type { AuthConfig } from "../config";
import type { FirebaseProvider } from "../providers/firebase";
import type { Session } from "../session";
import { buildCookie } from "../session";
import { decide } from "../allowlist";
import type { AuditLogger } from "../audit";
import { extractMeta } from "../audit";

export function firebaseRoute(opts: {
  config: AuthConfig;
  provider: FirebaseProvider;
  session: Session;
  audit?: AuditLogger;
}): Hono {
  const app = new Hono();

  app.post("/api/auth/firebase", async (c) => {
    const meta = extractMeta(c.req);
    const body = await c.req.json().catch(() => null);
    const idToken = typeof body?.idToken === "string" ? body.idToken : null;
    if (!idToken) return c.json({ error: "missing idToken" }, 400);

    let user;
    try {
      user = await opts.provider.verify(idToken);
    } catch (err) {
      await opts.audit?.log(
        { type: "signin.fail.firebase", reason: (err as Error).message },
        meta,
      );
      return c.json(
        { error: `firebase verify failed: ${(err as Error).message}` },
        401,
      );
    }

    const decision = decide(opts.config.allowlist, { email: user.email });
    if (!decision.allow) {
      await opts.audit?.log(
        {
          type: "signin.fail.allowlist",
          provider: "firebase",
          email: user.email,
          reason: decision.reason,
        },
        meta,
      );
      return c.json({ error: `Forbidden: ${decision.reason}` }, 403);
    }

    const token = await opts.session.issue({
      sub: user.sub,
      email: user.email,
      name: user.name,
      picture: user.picture,
    });

    await opts.audit?.log(
      {
        type: "signin.success",
        provider: "firebase",
        sub: user.sub,
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
    return c.json(
      { ok: true, user: { sub: user.sub, email: user.email } },
      200,
    );
  });

  return app;
}
