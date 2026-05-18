/**
 * Snolab default IdP — baked-in identity-provider credentials that let
 * `--provider snolab` work with zero configuration on supported domains
 * (default: `.fbi.com`).
 *
 * # How it works
 *
 * Snolab uses **Firebase Auth** rather than raw OAuth, so every credential
 * baked in here is public by design:
 *   - `apiKey`, `authDomain`, `projectId` are public per Firebase's
 *     official guidance: https://firebase.google.com/docs/projects/api-keys
 *   - The actual Google OAuth client is auto-managed inside the snolab
 *     Firebase project and never leaves Google's servers, so no
 *     `client_secret` is ever distributed.
 *
 * # Flow
 *
 *   1. User opens `https://sso.<domain>/login`
 *   2. fbi-auth serves an HTML page that loads the Firebase Web SDK
 *      configured with the values below.
 *   3. User clicks "Sign in with Google"; Firebase pops up its hosted
 *      Google sign-in. (Firebase's own OAuth client handles the
 *      Google-side flow — we never see a client secret.)
 *   4. Firebase returns a signed ID token to the browser.
 *   5. The browser POSTs the ID token to `/api/auth/firebase`, which
 *      verifies it via Google's JWKS, checks the allowlist, and issues
 *      the `__fbi_sso` cookie.
 *
 * # Publishing values
 *
 * When the snolab project owner updates Firebase / GCP, only this file
 * needs to change. The rest of the auth code (server.ts, wizard,
 * validator) is already wired to use whatever lands here.
 *
 * To (re)publish:
 *   1. <https://console.firebase.google.com> → create or open the snolab
 *      project, register a Web app, and copy the `apiKey`, `authDomain`,
 *      `projectId` from the snippet.
 *   2. Authentication → Sign-in method → enable Google.
 *   3. Authentication → Settings → Authorized domains → add every
 *      apex domain you want supported (e.g. `fbi.com` — covers
 *      `sso.fbi.com` automatically).
 *   4. Paste the three values into `SNOLAB_FIREBASE_CONFIG` below.
 *   5. Update `SNOLAB_SUPPORTED_DOMAINS` to list every authorized apex.
 */

/** Public Firebase web-app config for the snolab Firebase project. */
export const SNOLAB_FIREBASE_CONFIG:
  | {
      projectId: string;
      apiKey: string;
      authDomain: string;
    }
  | undefined = {
  projectId: "snolab",
  apiKey: "AIzaSyDGCb0r0gatTuDFXrVL_QoN0DZOSp2Aw2s",
  authDomain: "snolab.firebaseapp.com",
};

/**
 * Apex domains whose `sso.<domain>` is added to the snolab Firebase
 * project's Authorized domains list. Sign-in attempts on any other
 * domain will be rejected by Firebase, so we surface a friendlier
 * error pre-flight instead of letting the user hit Firebase's error.
 */
export const SNOLAB_SUPPORTED_DOMAINS: readonly string[] = ["fbi.com"];

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
 * Returns "" when snolab IS able to serve the request.
 */
export function snolabUnavailableMessage(domain: string): string {
  if (!isSnolabFirebaseConfigured()) {
    return [
      "",
      "[fbi-auth] provider: snolab — the snolab default IdP isn't published yet.",
      "",
      "Snolab is a planned zero-config sign-in path for users on supported domains",
      "(currently: " +
        SNOLAB_SUPPORTED_DOMAINS.join(", ") +
        "). The Firebase web",
      "config hasn't been baked in to this build.",
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
