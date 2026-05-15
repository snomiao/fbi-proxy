import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
} from "jose";

export type FirebaseProvider = {
  projectId: string;
  verify: (idToken: string) => Promise<FirebaseUser>;
};

export type FirebaseUser = {
  sub: string;
  email: string;
  emailVerified: boolean;
  name?: string;
  picture?: string;
};

const SECURETOKEN_JWKS_URL = new URL(
  "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com",
);

export function makeFirebaseProvider(opts: {
  projectId: string;
  jwks?: JWTVerifyGetKey;
}): FirebaseProvider {
  const jwks = opts.jwks ?? createRemoteJWKSet(SECURETOKEN_JWKS_URL);
  const issuer = `https://securetoken.google.com/${opts.projectId}`;

  return {
    projectId: opts.projectId,
    async verify(idToken: string) {
      const { payload } = await jwtVerify(idToken, jwks, {
        issuer,
        audience: opts.projectId,
        algorithms: ["RS256"],
      });
      return claimsToUser(payload);
    },
  };
}

function claimsToUser(payload: JWTPayload): FirebaseUser {
  if (!payload.sub) throw new Error("Firebase ID token missing 'sub' claim");
  const email = typeof payload.email === "string" ? payload.email : "";
  if (!email) throw new Error("Firebase ID token missing 'email' claim");
  if (payload.email_verified !== true)
    throw new Error("Firebase email is not verified");

  const authTime =
    typeof payload.auth_time === "number" ? payload.auth_time : null;
  if (authTime !== null && authTime > Math.floor(Date.now() / 1000) + 5) {
    throw new Error("Firebase ID token auth_time is in the future");
  }

  return {
    sub: String(payload.sub),
    email,
    emailVerified: true,
    name: typeof payload.name === "string" ? payload.name : undefined,
    picture: typeof payload.picture === "string" ? payload.picture : undefined,
  };
}
