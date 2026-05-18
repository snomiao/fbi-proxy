import { SignJWT, jwtVerify } from "jose";

export type SessionClaims = {
  sub: string;
  email: string;
  name?: string;
  picture?: string;
  iat: number;
  exp: number;
  iss: "fbi-auth";
  aud: string;
};

export type SessionInput = {
  sub: string;
  email: string;
  name?: string;
  picture?: string;
};

const DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60;
const DEFAULT_REFRESH_THRESHOLD_SECONDS = 24 * 60 * 60;

export type Session = {
  issue(input: SessionInput): Promise<string>;
  verify(token: string): Promise<SessionClaims | null>;
  needsRefresh(claims: SessionClaims): boolean;
};

export function makeSession(opts: {
  secret: string;
  audience: string;
  ttlSeconds?: number;
  refreshThresholdSeconds?: number;
}): Session {
  const key = new TextEncoder().encode(opts.secret);
  const ttl = opts.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  const refreshThreshold =
    opts.refreshThresholdSeconds ?? DEFAULT_REFRESH_THRESHOLD_SECONDS;

  return {
    async issue(input) {
      const now = Math.floor(Date.now() / 1000);
      return await new SignJWT({
        email: input.email,
        name: input.name,
        picture: input.picture,
      })
        .setProtectedHeader({ alg: "HS256", typ: "JWT" })
        .setSubject(input.sub)
        .setIssuer("fbi-auth")
        .setAudience(opts.audience)
        .setIssuedAt(now)
        .setExpirationTime(now + ttl)
        .sign(key);
    },

    async verify(token) {
      try {
        const { payload } = await jwtVerify(token, key, {
          issuer: "fbi-auth",
          audience: opts.audience,
        });
        return payload as unknown as SessionClaims;
      } catch {
        return null;
      }
    },

    needsRefresh(claims) {
      const now = Math.floor(Date.now() / 1000);
      return claims.exp - now < refreshThreshold;
    },
  };
}

export const COOKIE_NAME = "__fbi_sso";

export function buildCookie(
  token: string,
  opts: { domain: string; maxAgeSeconds: number },
): string {
  return [
    `${COOKIE_NAME}=${token}`,
    `Domain=${opts.domain}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    `Max-Age=${opts.maxAgeSeconds}`,
  ].join("; ");
}

export function clearCookie(opts: { domain: string }): string {
  return [
    `${COOKIE_NAME}=`,
    `Domain=${opts.domain}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    "Max-Age=0",
  ].join("; ");
}

export function readCookie(header: string | null | undefined): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === COOKIE_NAME) return rest.join("=");
  }
  return null;
}
