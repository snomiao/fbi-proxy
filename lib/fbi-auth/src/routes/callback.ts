import { Hono } from "hono";
import type { AuthConfig } from "../config";
import type { GoogleProvider } from "../providers/google";
import { exchangeCode } from "../providers/google";
import type { Session } from "../session";
import { buildCookie } from "../session";
import type { StateStore } from "../state";
import { decide } from "../allowlist";
import type { AuditLogger } from "../audit";
import { extractMeta } from "../audit";

export function callbackRoute(opts: {
  config: AuthConfig;
  provider: GoogleProvider;
  session: Session;
  states: StateStore;
  audit?: AuditLogger;
}): Hono {
  const app = new Hono();

  app.get("/callback", async (c) => {
    const meta = extractMeta(c.req);
    const url = new URL(c.req.url);
    const state = url.searchParams.get("state");
    if (!state) return c.text("missing state", 400);

    const flow = opts.states.take(state);
    if (!flow) return c.text("unknown or expired state", 400);

    let user;
    try {
      user = await exchangeCode(
        opts.provider,
        url.searchParams,
        state,
        flow.codeVerifier,
      );
    } catch (err) {
      await opts.audit?.log(
        {
          type: "signin.fail.oauth",
          provider: "google",
          reason: (err as Error).message,
        },
        meta,
      );
      return c.text(`oauth error: ${(err as Error).message}`, 400);
    }

    const decision = decide(opts.config.allowlist, { email: user.email });
    if (!decision.allow) {
      await opts.audit?.log(
        {
          type: "signin.fail.allowlist",
          provider: "google",
          email: user.email,
          reason: decision.reason,
        },
        meta,
      );
      return c.text(`Forbidden: ${decision.reason}`, 403);
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
        provider: "google",
        sub: user.sub,
        email: user.email,
        rd: flow.rd,
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
    return c.redirect(flow.rd, 302);
  });

  return app;
}
