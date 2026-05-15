# fbi-auth — OAuth2 Gateway for fbi-proxy

> **Status:** Phase 2. Google OAuth **and** Firebase Auth. First-run interactive wizard. Snolab default IdP still to come (Phase 4).

`fbi-auth` is a small Hono service that puts a sign-in gate in front of fbi-proxy. It implements [Caddy's `forward_auth` protocol](https://caddyserver.com/docs/caddyfile/directives/forward_auth), so any reverse proxy that supports forward_auth (Caddy, Traefik, nginx with `auth_request`) can call it to decide "is this request authenticated?".

## When to use it

- You want to put a real sign-in screen in front of `*.your-domain` without writing OAuth glue yourself.
- You're already running fbi-proxy and want to bolt auth on without changing the Rust binary.
- You'd rather use someone else's identity provider — currently Google OAuth (server-side flow) or Firebase Auth (client SDK + ID token).

## Architecture in one diagram

```
browser
  │
  │  https://3000.your-domain
  ▼
Caddy (your reverse proxy)
  │
  ├──► forward_auth ──► fbi-auth (Bun, Hono)  ─┐
  │                       │  /api/auth/verify  │
  │                       │  /login            │  Google
  │                       │  /callback         │  OAuth
  │                       │  /logout           │
  │                       └────────────────────┘
  │
  ▼  (only if verify returned 200)
fbi-proxy (Rust) ──► localhost:3000
```

`fbi-auth` issues a JWT cookie scoped to `Domain=.your-domain` so the same session is recognized across every subdomain.

## Quickest path: the setup wizard

Phase 2 adds an interactive first-run wizard. The easiest way to configure `fbi-auth` is to let it ask you:

```bash
bunx fbi-proxy --with-auth --reconfigure --domain your-domain.com
```

What the wizard asks:

1. **Domain to gate** — defaults to whatever you passed via `--domain`. A leading `.` is stripped automatically (`.fbi.com` → domain `fbi.com`, cookieDomain `.fbi.com`).
2. **Identity provider** — Google OAuth (BYO client ID + secret) or Firebase Auth (BYO project ID).
3. **Provider credentials** — Google client ID/secret, or the Firebase Project ID (+ optional Web API key + auth domain).
4. **Allowlist policy** — anyone who completes sign-in, specific emails, or specific email domains.

The wizard writes the result to `~/.config/fbi-proxy/auth.json` with mode `0600` and a freshly generated `sessionSecret`. Re-running with `--reconfigure` re-uses the previous values as defaults.

> `--reconfigure` requires a TTY. In non-TTY environments (CI, Docker), use either a pre-written `auth.json` or the env-var bootstrap below.

## Phase 1 setup (Google OAuth, manual)

### 1. Create a Google OAuth Web client

1. Go to <https://console.cloud.google.com/apis/credentials>.
2. **+ CREATE CREDENTIALS → OAuth client ID → Web application**.
3. **Authorized JavaScript origins:** `https://sso.your-domain`
4. **Authorized redirect URIs:** `https://sso.your-domain/callback`
5. Save the **Client ID** and **Client secret**.

### 2. Write the config file

`fbi-auth` reads from `$XDG_CONFIG_HOME/fbi-proxy/auth.json` (default `~/.config/fbi-proxy/auth.json`). Mode `0600` is enforced on write.

```bash
mkdir -p ~/.config/fbi-proxy
cat > ~/.config/fbi-proxy/auth.json <<'JSON'
{
  "version": 1,
  "domain": "your-domain.com",
  "cookieDomain": ".your-domain.com",
  "ssoHost": "sso.your-domain.com",
  "provider": "google",
  "clientId": "YOUR_GOOGLE_CLIENT_ID",
  "clientSecret": "YOUR_GOOGLE_CLIENT_SECRET",
  "sessionSecret": "REPLACE_WITH_32_RANDOM_BYTES_BASE64URL",
  "allowlist": {
    "emails": ["you@example.com"],
    "anySignedIn": false
  }
}
JSON
chmod 600 ~/.config/fbi-proxy/auth.json
```

Generate a strong session secret:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

### 3. Or use environment variables instead

If `auth.json` doesn't exist when you run `bunx fbi-proxy --with-auth` (and you're in a non-TTY environment), the CLI checks for these env vars and writes the config file for you:

| Env var                         | Purpose                                   | Default                    |
| ------------------------------- | ----------------------------------------- | -------------------------- |
| `FBI_AUTH_PROVIDER`             | `google` / `firebase` / `snolab`          | `google`                   |
| `FBI_AUTH_CLIENT_ID`            | Google OAuth Client ID                    | required if google         |
| `FBI_AUTH_CLIENT_SECRET`        | Google OAuth Client Secret                | required if google         |
| `FBI_AUTH_FIREBASE_PROJECT_ID`  | Firebase Project ID                       | required if firebase       |
| `FBI_AUTH_FIREBASE_API_KEY`     | Firebase Web API Key (used by client SDK) | unset                      |
| `FBI_AUTH_FIREBASE_AUTH_DOMAIN` | Firebase Auth Domain                      | unset                      |
| `FBI_AUTH_SESSION_SECRET`       | 32+ char secret for JWT signing           | auto-generated             |
| `FBI_AUTH_ALLOW_EMAILS`         | Comma-separated allowlist                 | unset                      |
| `FBI_AUTH_ALLOW_DOMAINS`        | Comma-separated email-domain allowlist    | unset                      |
| `FBI_AUTH_ALLOW_ANY`            | `true` to allow any signed-in user        | `true` if nothing else set |
| `FBI_AUTH_PORT`                 | Port for fbi-auth to listen on            | auto                       |
| `FBI_AUTH_CONFIG_PATH`          | Override config path                      | XDG default                |

### 4. Run with `--with-auth`

```bash
bunx fbi-proxy --with-auth --domain your-domain.com
```

You'll see something like:

```
[fbi-auth] starting (domain=your-domain.com, provider=google)
[fbi-auth] PID 12345 listening on 127.0.0.1:2433
```

## Firebase Auth setup (Phase 2)

Firebase Auth is a useful alternative when you'd rather sign users in **in the browser** (Email link, Google, GitHub, phone, anonymous, …) and just hand the resulting ID token to fbi-auth.

### 1. Create a Firebase project

1. Go to the [Firebase Console](https://console.firebase.google.com/) and create a project (or reuse an existing one).
2. **Project Settings → General** — copy the **Project ID** (also called `projectId` or "firebaseProjectId"; e.g. `my-fbi-app-123`).
3. Under **Build → Authentication → Sign-in method**, enable whichever providers you want (Email/Password, Google, GitHub, …).
4. Under **Project Settings → General → Your apps**, register a Web app to get the `apiKey` and `authDomain` for the client SDK. These are not secrets but `fbi-auth` stores them so the wizard can drop a sample client snippet next to your config.

### 2. Configure fbi-auth with `provider: firebase`

```json
{
  "version": 1,
  "domain": "your-domain.com",
  "cookieDomain": ".your-domain.com",
  "ssoHost": "sso.your-domain.com",
  "provider": "firebase",
  "firebase": {
    "projectId": "my-fbi-app-123",
    "apiKey": "AIza...",
    "authDomain": "my-fbi-app-123.firebaseapp.com"
  },
  "sessionSecret": "REPLACE_WITH_32_RANDOM_BYTES_BASE64URL",
  "allowlist": { "anySignedIn": true }
}
```

Or just run the wizard:

```bash
bunx fbi-proxy --with-auth --reconfigure --domain your-domain.com
# → choose "Firebase Auth (BYO project ID)" at the provider prompt
```

> When `provider: firebase`, the top-level `clientId` / `clientSecret` are unused. The `firebase.projectId` field is required — `fbi-auth` validates it on startup and verifies incoming ID tokens against `https://securetoken.google.com/<projectId>`.

### 3. Sign in from the browser → POST the ID token

The Web SDK runs in your frontend. After a successful `signIn…` you call `user.getIdToken()` and POST the result to fbi-auth:

```html
<script type="module">
  import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js";
  import {
    getAuth,
    GoogleAuthProvider,
    signInWithPopup,
  } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";

  const app = initializeApp({
    apiKey: "AIza...",
    authDomain: "my-fbi-app-123.firebaseapp.com",
    projectId: "my-fbi-app-123",
  });
  const auth = getAuth(app);

  document.querySelector("#signin").addEventListener("click", async () => {
    const cred = await signInWithPopup(auth, new GoogleAuthProvider());
    const idToken = await cred.user.getIdToken();

    const res = await fetch("https://sso.your-domain.com/api/auth/firebase", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ idToken }),
    });
    if (res.ok)
      location.href = "/"; // cookie is now set on .your-domain.com
    else alert(`Sign-in rejected: ${await res.text()}`);
  });
</script>
<button id="signin">Sign in with Google (via Firebase)</button>
```

`POST /api/auth/firebase` accepts JSON `{ "idToken": "..." }` and replies:

| Status | When                                                                                             |
| ------ | ------------------------------------------------------------------------------------------------ |
| `200`  | Token verified + allowlist allowed. Sets the `__fbi_sso` cookie scoped to `Domain=.your-domain`. |
| `400`  | Request body is missing `idToken`.                                                               |
| `401`  | ID token failed to verify (bad signature, wrong issuer/audience, expired, email not verified).   |
| `403`  | Token verified but the user's email isn't on the allowlist.                                      |

After 200, every subsequent request to `*.your-domain` carries the cookie and hits `/api/auth/verify` like any other Phase 1 session — Firebase is only used for the initial handshake.

### 5. Wire forward_auth into your reverse proxy

#### Caddy (recommended)

```caddyfile
sso.your-domain.com {
  reverse_proxy 127.0.0.1:2433
}

*.your-domain.com {
  @notauth not path /api/auth/* /login /callback /logout
  forward_auth @notauth 127.0.0.1:2433 {
    uri /api/auth/verify
    copy_headers Remote-User Remote-Email Remote-Name
    header_up X-Forwarded-Host {host}
    header_up X-Forwarded-Uri {uri}
  }
  reverse_proxy 127.0.0.1:2432
}
```

In Phase 3, `--with-caddy --with-auth` will write this file for you.

#### nginx (sketch)

```nginx
location = /_auth {
  internal;
  proxy_pass http://127.0.0.1:2433/api/auth/verify;
  proxy_pass_request_body off;
  proxy_set_header Content-Length "";
  proxy_set_header X-Forwarded-Host $host;
  proxy_set_header X-Forwarded-Uri $request_uri;
}

location / {
  auth_request /_auth;
  auth_request_set $user $upstream_http_remote_user;
  proxy_set_header Remote-User $user;
  proxy_pass http://127.0.0.1:2432;
}

# On 401 from /_auth, redirect to /login
error_page 401 = @login;
location @login {
  return 302 https://sso.your-domain.com/login?rd=$scheme://$host$request_uri;
}
```

## Endpoints

| Method     | Path                 | Mounted when        | Purpose                                                                                                          |
| ---------- | -------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------- |
| GET        | `/api/auth/verify`   | always              | Forward-auth target. 200 if session is valid (sets `Remote-User`, `Remote-Email`, `Remote-Name`). 401 otherwise. |
| GET        | `/login?rd=<url>`    | provider = google   | Starts the Google OAuth flow. Validates that `rd` is within your domain.                                         |
| GET        | `/callback`          | provider = google   | Google redirects here. Exchanges code, applies allowlist, sets the SSO cookie, redirects to `rd`.                |
| POST       | `/api/auth/firebase` | provider = firebase | Accepts `{ idToken }` from the Firebase Web SDK, verifies it, applies allowlist, sets the SSO cookie.            |
| GET / POST | `/logout?rd=<url>`   | always              | Clears the SSO cookie.                                                                                           |
| GET        | `/api/auth/me`       | always              | Returns `{ authenticated, user? }` JSON.                                                                         |
| GET        | `/healthz`           | always              | Plain `ok` text for supervisors.                                                                                 |

## Session & cookie

- Cookie name: `__fbi_sso`
- Attributes: `Domain=.your-domain`, `Path=/`, `HttpOnly`, `Secure`, `SameSite=Lax`, `Max-Age=7d`
- Value: HS256 JWT signed with `sessionSecret`
- Claims: `sub`, `email`, `name?`, `picture?`, `iat`, `exp`, `iss=fbi-auth`, `aud=<domain>`
- Sliding refresh: `/api/auth/verify` reissues the cookie when less than 24 h remain.

## Allowlist

Three rule types in `auth.json::allowlist`, evaluated in order — first match wins:

```json
{
  "allowlist": {
    "emails": ["alice@example.com", "bob@example.com"],
    "domains": ["mycompany.com"],
    "anySignedIn": false
  }
}
```

| Field         | Meaning                                   |
| ------------- | ----------------------------------------- |
| `emails`      | Exact email matches (case-insensitive).   |
| `domains`     | Allow any email whose `@…` part matches.  |
| `anySignedIn` | Pass anyone who completes Google sign-in. |

## Troubleshooting

| Symptom                                                        | Likely cause                                                                                                                                 |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `Forbidden: email '…' not in allowlist` after sign-in          | `allowlist.anySignedIn` is `false` and the user's email/domain isn't listed.                                                                 |
| Browser bounces between `/login` and the upstream              | Cookie wasn't set — `Domain=.your-domain` doesn't match the host you're visiting. Check `cookieDomain` in `auth.json`.                       |
| `oauth error: …` on `/callback`                                | Wrong `clientSecret`, the redirect URI doesn't match what's registered in Google Console, or the state expired (10 min TTL).                 |
| `Unknown provider: …` or `provider 'snolab' requires clientId` | Only `google` and `firebase` are implemented. `snolab` is reserved for the Phase 4 default IdP.                                              |
| `firebase verify failed: …` from `/api/auth/firebase`          | Bad ID token. Check the token's `aud` matches `firebase.projectId`, the user finished email verification, and the system clock isn't skewed. |
| TLS warnings on `*.fbi.com` for teammates                      | Expected — `tls internal` only trusts on the Caddy host. Use your own domain + public CA for shareable setups (see [README](../README.md)).  |

## What's next

Roadmap from [TODO.md](../TODO.md):

- **Phase 2 (shipped):** Firebase provider, `POST /api/auth/firebase`, first-run interactive wizard, `--reconfigure`.
- **Phase 3:** `--with-caddy --with-auth` auto-generates the Caddyfile and supervises Caddy alongside the proxy.
- **Phase 4:** Snolab default IdP (PKCE flow, zero config for `.fbi.com`).
- **Phase 5:** SQLite-backed sessions, audit log.
