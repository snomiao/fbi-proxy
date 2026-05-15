import * as oauth from "oauth4webapi";

const GOOGLE_ISSUER = new URL("https://accounts.google.com");

export type GoogleProvider = {
  as: oauth.AuthorizationServer;
  client: oauth.Client;
  clientAuth: oauth.ClientAuth;
  redirectUri: string;
  scopes: string[];
};

export async function makeGoogleProvider(opts: {
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
}): Promise<GoogleProvider> {
  const res = await oauth.discoveryRequest(GOOGLE_ISSUER, {
    algorithm: "oidc",
  });
  const as = await oauth.processDiscoveryResponse(GOOGLE_ISSUER, res);

  const client: oauth.Client = { client_id: opts.clientId };
  const clientAuth = opts.clientSecret
    ? oauth.ClientSecretPost(opts.clientSecret)
    : oauth.None();

  return {
    as,
    client,
    clientAuth,
    redirectUri: opts.redirectUri,
    scopes: ["openid", "email", "profile"],
  };
}

export async function buildAuthorizationUrl(
  p: GoogleProvider,
  opts: { state: string; codeVerifier: string; nonce: string },
): Promise<URL> {
  const codeChallenge = await oauth.calculatePKCECodeChallenge(
    opts.codeVerifier,
  );
  const url = new URL(p.as.authorization_endpoint!);
  url.searchParams.set("client_id", p.client.client_id);
  url.searchParams.set("redirect_uri", p.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", p.scopes.join(" "));
  url.searchParams.set("state", opts.state);
  url.searchParams.set("nonce", opts.nonce);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("access_type", "online");
  url.searchParams.set("prompt", "select_account");
  return url;
}

export type GoogleUser = {
  sub: string;
  email: string;
  emailVerified: boolean;
  name?: string;
  picture?: string;
};

export async function exchangeCode(
  p: GoogleProvider,
  callbackParams: URLSearchParams,
  expectedState: string,
  codeVerifier: string,
): Promise<GoogleUser> {
  const validated = oauth.validateAuthResponse(
    p.as,
    p.client,
    callbackParams,
    expectedState,
  );

  const tokenRes = await oauth.authorizationCodeGrantRequest(
    p.as,
    p.client,
    p.clientAuth,
    validated,
    p.redirectUri,
    codeVerifier,
  );

  const tokens = await oauth.processAuthorizationCodeResponse(
    p.as,
    p.client,
    tokenRes,
  );
  const claims = oauth.getValidatedIdTokenClaims(tokens);
  if (!claims) throw new Error("Google did not return an ID token");

  const email = typeof claims.email === "string" ? claims.email : "";
  if (!email) throw new Error("Google ID token has no email claim");
  const emailVerified = claims.email_verified === true;
  if (!emailVerified) throw new Error("Google email is not verified");

  return {
    sub: String(claims.sub),
    email,
    emailVerified,
    name: typeof claims.name === "string" ? claims.name : undefined,
    picture: typeof claims.picture === "string" ? claims.picture : undefined,
  };
}
