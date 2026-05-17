# Snolab default IdP

`--provider snolab` is a planned **zero-config sign-in** path: on a supported domain (currently `fbi.com`), an end user runs `bunx fbi-proxy --with-auth --domain fbi.com --provider snolab` and gets Google sign-in working without registering anything in Google Cloud Console themselves. The project owner pre-registers one OAuth client and ships its public ID in this repo.

> **Current status:** infrastructure shipped (commit `d9dccb8`+), values **not yet published**. Running `--provider snolab` today returns a clear error pointing users to `--provider google` with their own client ID. When the snolab Google project owner publishes the values described below, a single 5-line file change in [`src/snolabDefaults.ts`](../src/snolabDefaults.ts) flips it on for everyone.

## What "snolab" means

"Snolab" is the project name for a hosted Google Cloud / Firebase project whose OAuth credentials are public — anyone running fbi-proxy on a domain that snolab has authorized can use them to sign users in via Google. It's the "shared free tier" equivalent of Vercel's preview deployments: zero configuration, slightly less control.

## How it stays safe to ship client IDs publicly

The snolab client is registered in Google Cloud Console as a **public client** that uses the [PKCE](https://datatracker.ietf.org/doc/html/rfc7636) authorization-code flow:

- No `client_secret` — `client_id` alone isn't a credential
- PKCE binds the authorization request to a per-request code verifier so an attacker can't reuse an authorization code even if they intercept it
- Authorized origins / redirect URIs are restricted to `sso.<domain>` for each domain in `SNOLAB_SUPPORTED_DOMAINS`, so a malicious app on a different domain can't masquerade as fbi-proxy

This is the same posture Firebase web app config uses: `apiKey`, `authDomain`, `projectId` are all public per [Firebase's official guidance](https://firebase.google.com/docs/projects/api-keys).

## Resolution order

When a user runs with `--provider snolab`:

1. Server startup checks `isSnolabGoogleConfigured()` — does this build have a `SNOLAB_GOOGLE_CLIENT_ID` value baked in?
2. If yes: check `snolabSupportsDomain(config.domain)` — has the snolab project authorized this domain?
3. If both yes: instantiate `makeGoogleProvider({ clientId: SNOLAB_GOOGLE_CLIENT_ID, clientSecret: undefined })`. The undefined secret triggers `oauth4webapi.None()` for client auth — PKCE flow.
4. Otherwise: throw `snolabUnavailableMessage(domain)` which directs the user at `--provider google` with their own client.

## For the snolab project owner — how to publish

When you (snomiao) are ready to make snolab actually serve traffic:

### 1. Create the GCP project

- Go to <https://console.cloud.google.com>, create a project named e.g. `snolab-fbi-proxy`
- Enable the **OAuth consent screen**:
  - User type: External (public)
  - App name: `snolab fbi-proxy`
  - Authorized domains: `fbi.com`
  - Scopes: `openid`, `email`, `profile`
- Publish the consent screen (or leave in Testing while you validate; testing limits to 100 unique users)

### 2. Create the OAuth client

- **APIs & Services → Credentials → Create Credentials → OAuth client ID**
- Application type: **Web application**
- Name: `snolab fbi-proxy public client`
- Authorized JavaScript origins: `https://sso.fbi.com`
- Authorized redirect URIs: `https://sso.fbi.com/callback`
- For every additional domain you want snolab to support, add both URIs and add the domain to `SNOLAB_SUPPORTED_DOMAINS` in `snolabDefaults.ts`

### 3. (Optional) Create the Firebase project

- <https://console.firebase.google.com> → Add project (you can reuse the GCP project from step 1)
- Add a Web app to the project; copy the `apiKey`, `authDomain`, `projectId` from the snippet shown
- Enable Authentication → Sign-in method → Google

### 4. Publish the values

Edit [`lib/fbi-auth/src/snolabDefaults.ts`](../src/snolabDefaults.ts):

```ts
export const SNOLAB_GOOGLE_CLIENT_ID: string | undefined =
  "1234567890-xxxxxxxx.apps.googleusercontent.com";

export const SNOLAB_FIREBASE_CONFIG = {
  projectId: "snolab-fbi-proxy",
  apiKey: "AIzaSy...",
  authDomain: "snolab-fbi-proxy.firebaseapp.com",
};

export const SNOLAB_SUPPORTED_DOMAINS: readonly string[] = [
  "fbi.com",
  // add more as you authorize them in GCP
];
```

Commit, release. End users running `--provider snolab` against any supported domain now get zero-config sign-in.

## Why this works for `.fbi.com` specifically

The `*.fbi.com` wildcard DNS quirk (see the [README story](../../../README.md#-why-fbicom--the-story)) means every user's machine already resolves `sso.fbi.com` to `127.0.0.1`. Caddy on their machine terminates TLS with `tls internal` and serves the sign-in flow. Google redirects to `sso.fbi.com/callback` — which lands on **the user's own machine**. The OAuth code is exchanged locally; the snolab Google project never sees the user's session token after issuance.

For domains other than `fbi.com`, the same model works if their DNS also points at `127.0.0.1` or a known fbi-proxy host. That's why `SNOLAB_SUPPORTED_DOMAINS` is an explicit allowlist — the snolab project owner has to register each one in Google Cloud Console.

## Compared with `--provider google` (BYO)

|                           | `--provider snolab` (zero-config)              | `--provider google` (BYO)                                  |
| ------------------------- | ---------------------------------------------- | ---------------------------------------------------------- |
| User actions              | Run the CLI                                    | Create GCP project, OAuth client, paste IDs into auth.json |
| Time to first sign-in     | Seconds                                        | ~5 minutes                                                 |
| Supported domains         | `SNOLAB_SUPPORTED_DOMAINS`                     | Any domain you own                                         |
| OAuth quota / rate limits | Shared across all snolab users                 | Yours alone                                                |
| Consent screen branding   | "snolab fbi-proxy"                             | Your project name                                          |
| Best for                  | Demos, local dev on `fbi.com`, getting started | Production, custom domains, brand control                  |

When you outgrow snolab — usually as soon as you switch to a real production domain — graduate to `--provider google` with your own client. The config-file shape is the same; only `clientId` / `clientSecret` change.
