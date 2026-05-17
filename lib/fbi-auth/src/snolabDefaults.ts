/**
 * Snolab default IdP — baked-in identity-provider credentials that let
 * `provider: snolab` work with zero configuration on supported domains
 * (default `.fbi.com`).
 *
 * # How it works
 *
 * The snolab Google Cloud project owns the OAuth client whose ID is
 * baked in below. It's a **public client** (PKCE flow, no client_secret
 * — see RFC 7636), so shipping the client_id in code is safe. The
 * snolab project also has every domain in `SNOLAB_SUPPORTED_DOMAINS`
 * pre-registered as an Authorized JS Origin and Redirect URI, so
 * sign-in just works for those domains.
 *
 * # Adding values
 *
 * When the snolab project owner publishes credentials, only this file
 * needs to change. The rest of the auth code (server.ts, wizard,
 * validator) is already wired to use whatever lands here.
 *
 * To publish:
 *   1. In Google Cloud Console, create an OAuth 2.0 Client ID of type
 *      "Web application" inside the snolab project. Mark it as a
 *      public client (no client secret).
 *   2. Add `https://sso.<domain>` to Authorized JavaScript Origins and
 *      `https://sso.<domain>/callback` to Authorized Redirect URIs for
 *      every domain you want supported.
 *   3. Replace `SNOLAB_GOOGLE_CLIENT_ID` below with the issued client ID.
 *   4. Optionally set `SNOLAB_FIREBASE_CONFIG` with the snolab Firebase
 *      project's web app config (apiKey / authDomain / projectId are
 *      all public per Firebase's docs).
 *   5. Update `SNOLAB_SUPPORTED_DOMAINS` to match the authorized
 *      origins you registered.
 *
 * # Why a placeholder ships in v1
 *
 * The snolab GCP project doesn't exist publicly at the time of this
 * commit. Users who pick `--provider snolab` get a clear error pointing
 * them at `--provider google` with their own client ID. When values are
 * published here, the same code paths light up automatically — no other
 * file changes needed.
 */

/** Public Google OAuth Web client ID for the snolab project. */
export const SNOLAB_GOOGLE_CLIENT_ID: string | undefined = undefined;
//                                  ^ e.g. "1234567890-xxxxxxxx.apps.googleusercontent.com"

/** Public Firebase web-app config for the snolab Firebase project. */
export const SNOLAB_FIREBASE_CONFIG:
  | {
      projectId: string;
      apiKey: string;
      authDomain: string;
    }
  | undefined = undefined;

/**
 * Domains whose `sso.<domain>` is registered as an authorized origin /
 * redirect URI in the snolab Google OAuth client. Sign-in for any
 * domain NOT in this list will be rejected at the Google consent screen,
 * so we surface a friendlier error pre-flight instead of letting the
 * user hit Google's error page.
 */
export const SNOLAB_SUPPORTED_DOMAINS: readonly string[] = ["fbi.com"];

export function isSnolabGoogleConfigured(): boolean {
  return (
    typeof SNOLAB_GOOGLE_CLIENT_ID === "string" &&
    SNOLAB_GOOGLE_CLIENT_ID.length > 0
  );
}

export function isSnolabFirebaseConfigured(): boolean {
  return SNOLAB_FIREBASE_CONFIG !== undefined;
}

export function snolabSupportsDomain(domain: string): boolean {
  const d = domain.startsWith(".") ? domain.slice(1) : domain;
  return SNOLAB_SUPPORTED_DOMAINS.includes(d);
}

/**
 * Human-readable message explaining why snolab can't serve a given
 * config. Use when validation fails so the user gets a path forward.
 */
export function snolabUnavailableMessage(domain: string): string {
  if (!isSnolabGoogleConfigured()) {
    return [
      "",
      "[fbi-auth] provider: snolab — the snolab default IdP isn't published yet.",
      "",
      "Snolab is a planned zero-config sign-in path for users on supported domains",
      "(currently: " +
        SNOLAB_SUPPORTED_DOMAINS.join(", ") +
        "). The Google OAuth",
      "client ID hasn't been baked in to this build.",
      "",
      "What to do instead:",
      "  - Use Google with your own OAuth client (free, ~2 min in Google Cloud Console):",
      "      bunx fbi-proxy --with-auth --reconfigure --domain " + domain,
      "      → pick option 1 (Google OAuth) when prompted",
      "  - Or use Firebase with your own project ID:",
      "      → pick option 2 (Firebase Auth) when prompted",
      "",
      "(For the project owner: see lib/fbi-auth/src/snolabDefaults.ts to publish.)",
      "",
    ].join("\n");
  }
  if (!snolabSupportsDomain(domain)) {
    return [
      "",
      `[fbi-auth] provider: snolab — domain '${domain}' isn't supported by the snolab IdP.`,
      "",
      "Supported domains: " + SNOLAB_SUPPORTED_DOMAINS.join(", "),
      "",
      "For custom domains, use --provider google with your own OAuth client ID:",
      "  bunx fbi-proxy --with-auth --reconfigure --domain " + domain,
      "",
    ].join("\n");
  }
  return ""; // configured + supported
}
