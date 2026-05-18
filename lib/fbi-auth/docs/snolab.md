# Snolab default IdP

`--provider snolab` is a **zero-config sign-in** path: on a supported domain (currently `fbi.com`), an end user runs `bunx fbi-proxy --with-auth --domain fbi.com --provider snolab` and gets Google sign-in working without registering anything in Google Cloud Console themselves. The project owner pre-registers one Firebase project and ships its public web config in this repo.

> **Current status:** infrastructure shipped and **values published** — running `--provider snolab` against `fbi.com` works end-to-end as long as you can resolve `sso.fbi.com → 127.0.0.1` locally.

## What "snolab" means

"Snolab" is the project name for a hosted Firebase / Google Cloud project (`snolab`) whose web config is public — anyone running fbi-proxy on a domain that snolab has authorized can use it to sign users in via Google. It's the "shared free tier" equivalent of Vercel's preview deployments: zero configuration, slightly less control.

## How it stays safe to ship credentials publicly

Snolab uses **Firebase Auth**, not raw OAuth. That means every value baked into the source is intentionally public:

| Value           | Public? | Why                                                                                                                                         |
| --------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `apiKey`        | Yes     | Identifies the Firebase project — not a credential. Per [Firebase's official guidance](https://firebase.google.com/docs/projects/api-keys). |
| `authDomain`    | Yes     | `<project>.firebaseapp.com`, the hosted handler URL. Anyone can see it.                                                                     |
| `projectId`     | Yes     | Public project name. Used by clients to find the project.                                                                                   |
| `client_secret` | **N/A** | The actual Google OAuth client is auto-managed _inside_ the Firebase project. We never see it, never distribute it.                         |

The trust boundary is:

- **Authorized domains** (managed in Firebase console) controls which origins can initiate `signInWithPopup` against this project. `fbi.com` is authorized; `evil.example` is not. So a malicious app on a different domain can't masquerade as snolab.
- **ID token verification** happens server-side in fbi-auth against Google's JWKS — the ID token cannot be forged.

## Flow

When a user runs with `--provider snolab` on `fbi.com`:

1. They open `https://sso.fbi.com/login`.
2. fbi-auth serves an HTML page that loads the Firebase Web SDK with the snolab `apiKey` / `authDomain` / `projectId`.
3. User clicks **Sign in with Google** → Firebase pops up its hosted Google flow.
4. Firebase returns a signed ID token to the browser.
5. The browser `POST /api/auth/firebase` with the ID token.
6. fbi-auth verifies the ID token via Google's JWKS (`securetoken@system.gserviceaccount.com`), runs the allowlist, and issues the `__fbi_sso` cookie scoped to `.fbi.com`.
7. The user is redirected back to where they came from. All other `*.fbi.com` subdomains now see the cookie.

## Resolution order

Server startup checks, in order:

1. `isSnolabFirebaseConfigured()` — does this build have `SNOLAB_FIREBASE_CONFIG` baked in?
2. `snolabSupportsDomain(config.domain)` — has the snolab project authorized this domain?
3. Both yes → instantiate `makeFirebaseProvider({ projectId: SNOLAB_FIREBASE_CONFIG.projectId })` and mount `firebaseLoginRoute` (serves `/login` HTML) + `firebaseRoute` (handles `/api/auth/firebase` ID token verification).
4. Otherwise → throw `snolabUnavailableMessage(domain)` which directs the user at `--provider google` with their own client.

## For the snolab project owner — how to (re)publish

When you (snomiao) want to refresh the snolab values or add a new domain:

### 1. Open the Firebase project

- <https://console.firebase.google.com> → snolab project
- **Authentication → Sign-in method** → ensure **Google** is enabled
- **Authentication → Settings → Authorized domains** → add every apex domain you want snolab to serve (e.g. `fbi.com` covers `sso.fbi.com` automatically)

### 2. Register / verify the Web app

- **Project settings → General → Your apps → Web app**
- If none exists, click **Add app → Web** and give it a nickname (e.g. `fbi-proxy snolab`)
- Copy the three values from the snippet:

  ```js
  const firebaseConfig = {
    apiKey: "AIzaSy…",
    authDomain: "<project>.firebaseapp.com",
    projectId: "<project>",
    /* storageBucket / messagingSenderId / appId not needed by fbi-auth */
  };
  ```

### 3. Publish the values

Edit [`lib/fbi-auth/src/snolabDefaults.ts`](../src/snolabDefaults.ts):

```ts
export const SNOLAB_FIREBASE_CONFIG = {
  projectId: "snolab",
  apiKey: "AIzaSy...",
  authDomain: "snolab.firebaseapp.com",
};

export const SNOLAB_SUPPORTED_DOMAINS: readonly string[] = [
  "fbi.com",
  // add more as you authorize them in Firebase
];
```

Commit, release. End users running `--provider snolab` against any supported domain now get zero-config sign-in.

## Why this works for `.fbi.com` specifically

The `*.fbi.com` wildcard DNS quirk (see the [README story](../../../README.md#-why-fbicom--the-story)) means every user's machine already resolves `sso.fbi.com` to `127.0.0.1`. Caddy on their machine terminates TLS with `tls internal` (or a Let's Encrypt cert) and serves the sign-in flow. Firebase's hosted handler (`<project>.firebaseapp.com/__/auth/handler`) is on Firebase's own infrastructure — not ours — and the ID token comes back to the browser, which posts it to **the user's own machine**. The session token never leaves the user's box.

For domains other than `fbi.com`, the same model works if their DNS also points at `127.0.0.1` or a known fbi-proxy host. That's why `SNOLAB_SUPPORTED_DOMAINS` is an explicit allowlist — the snolab project owner has to register each one in Firebase Authentication.

## Why Firebase instead of raw OAuth?

Earlier drafts of this doc described a PKCE-only raw OAuth flow using `SNOLAB_GOOGLE_CLIENT_ID`. That turned out not to work: Google's OAuth Web Application clients **require** `client_secret` on the token endpoint — PKCE is supplementary, not a replacement. The only way to do raw OAuth with no shipped secret is to use a "Desktop app" client type, which forces redirect URIs to be `http://127.0.0.1:PORT` and breaks the `https://sso.fbi.com/callback` URL story.

Firebase Auth sidesteps the whole problem: the OAuth client lives _inside_ the Firebase project, managed by Google. fbi-auth never sees it, never distributes it. The values we _do_ ship (`apiKey` / `authDomain` / `projectId`) are documented public and identify the project rather than authenticate it.

## Compared with `--provider google` (BYO)

|                         | `--provider snolab` (zero-config)              | `--provider google` (BYO)                                  |
| ----------------------- | ---------------------------------------------- | ---------------------------------------------------------- |
| User actions            | Run the CLI                                    | Create GCP project, OAuth client, paste IDs into auth.json |
| Time to first sign-in   | Seconds                                        | ~5 minutes                                                 |
| Supported domains       | `SNOLAB_SUPPORTED_DOMAINS`                     | Any domain you own                                         |
| Auth mechanism          | Firebase Web SDK + ID token                    | OAuth 2.0 authorization code                               |
| Quota / rate limits     | Shared across all snolab users                 | Yours alone                                                |
| Consent screen branding | "snolab fbi-proxy"                             | Your project name                                          |
| Best for                | Demos, local dev on `fbi.com`, getting started | Production, custom domains, brand control                  |

When you outgrow snolab — usually as soon as you switch to a real production domain — graduate to `--provider google` with your own client. The config-file shape is the same; only `clientId` / `clientSecret` change.
