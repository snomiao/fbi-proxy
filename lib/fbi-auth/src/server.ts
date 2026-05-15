import { Hono } from "hono";
import { loadAuthConfig, type AuthConfig } from "./config";
import { makeSession } from "./session";
import { makeStateStore } from "./state";
import { makeGoogleProvider } from "./providers/google";
import { makeFirebaseProvider } from "./providers/firebase";
import { healthRoute } from "./routes/health";
import { verifyRoute } from "./routes/verify";
import { loginRoute } from "./routes/login";
import { callbackRoute } from "./routes/callback";
import { logoutRoute } from "./routes/logout";
import { meRoute } from "./routes/me";
import { firebaseRoute } from "./routes/firebase";

export async function buildApp(configOverride?: AuthConfig) {
  const config = configOverride ?? (await loadAuthConfig());
  const ssoOrigin = `https://${config.ssoHost}`;
  const redirectUri = `${ssoOrigin}/callback`;

  const session = makeSession({
    secret: config.sessionSecret,
    audience: config.domain,
  });
  const states = makeStateStore();

  const app = new Hono();
  app.route("/", healthRoute());
  app.route("/", verifyRoute({ config, session }));
  app.route("/", logoutRoute({ config }));
  app.route("/", meRoute({ session }));

  if (config.provider === "google" || config.provider === "snolab") {
    if (!config.clientId)
      throw new Error(`provider '${config.provider}' requires clientId`);
    const provider = await makeGoogleProvider({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      redirectUri,
    });
    app.route("/", loginRoute({ provider, states, ssoOrigin }));
    app.route("/", callbackRoute({ config, provider, session, states }));
  } else if (config.provider === "firebase") {
    if (!config.firebase?.projectId)
      throw new Error("provider 'firebase' requires firebase.projectId");
    const provider = makeFirebaseProvider({
      projectId: config.firebase.projectId,
    });
    app.route("/", firebaseRoute({ config, provider, session }));
  } else {
    throw new Error(`Unknown provider: ${(config as AuthConfig).provider}`);
  }

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
