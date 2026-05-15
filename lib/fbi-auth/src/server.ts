import { Hono } from "hono";
import { loadAuthConfig } from "./config";
import { makeSession } from "./session";
import { makeStateStore } from "./state";
import { makeGoogleProvider } from "./providers/google";
import { healthRoute } from "./routes/health";
import { verifyRoute } from "./routes/verify";
import { loginRoute } from "./routes/login";
import { callbackRoute } from "./routes/callback";
import { logoutRoute } from "./routes/logout";
import { meRoute } from "./routes/me";

export async function buildApp() {
  const config = await loadAuthConfig();
  const ssoOrigin = `https://${config.ssoHost}`;
  const redirectUri = `${ssoOrigin}/callback`;

  const session = makeSession({
    secret: config.sessionSecret,
    audience: config.domain,
  });
  const states = makeStateStore();

  if (config.provider !== "google") {
    throw new Error(
      `Provider '${config.provider}' not implemented in Phase 1 — only 'google' is supported. Firebase/snolab arrive in Phase 2-4.`,
    );
  }
  const provider = await makeGoogleProvider({
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    redirectUri,
  });

  const app = new Hono();
  app.route("/", healthRoute());
  app.route("/", verifyRoute({ config, session }));
  app.route("/", loginRoute({ provider, states, ssoOrigin }));
  app.route("/", callbackRoute({ config, provider, session, states }));
  app.route("/", logoutRoute({ config }));
  app.route("/", meRoute({ session }));

  app.get("/", (c) => c.redirect("/api/auth/me", 302));

  return { app, config, ssoOrigin };
}

if (import.meta.main) {
  const { app, config, ssoOrigin } = await buildApp();
  const port = Number(process.env.FBI_AUTH_PORT ?? 2433);

  console.log(`[fbi-auth] listening on http://127.0.0.1:${port}`);
  console.log(`[fbi-auth] sso origin: ${ssoOrigin}`);
  console.log(
    `[fbi-auth] domain: ${config.domain}, provider: ${config.provider}`,
  );

  Bun.serve({
    port,
    hostname: "127.0.0.1",
    fetch: app.fetch,
  });
}
