import { Hono } from "hono";
import * as oauth from "oauth4webapi";
import type { GoogleProvider } from "../providers/google";
import { buildAuthorizationUrl } from "../providers/google";
import type { StateStore } from "../state";

export function loginRoute(opts: {
  provider: GoogleProvider;
  states: StateStore;
  ssoOrigin: string;
}): Hono {
  const app = new Hono();

  app.get("/login", async (c) => {
    const rd = c.req.query("rd") ?? `${opts.ssoOrigin}/api/auth/me`;
    if (!isSafeRd(rd, opts.ssoOrigin)) {
      return c.text("invalid rd", 400);
    }

    const state = oauth.generateRandomState();
    const codeVerifier = oauth.generateRandomCodeVerifier();
    const nonce = oauth.generateRandomNonce();
    opts.states.put(state, { codeVerifier, nonce, rd, createdAt: Date.now() });

    const url = await buildAuthorizationUrl(opts.provider, {
      state,
      codeVerifier,
      nonce,
    });
    return c.redirect(url.toString(), 302);
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
