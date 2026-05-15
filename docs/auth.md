# fbi-auth — OAuth2 Gateway for fbi-proxy

> **Status:** Phase 1 (MVP). Google OAuth only. Manual config — wizard arrives in Phase 2.

`fbi-auth` is a small Hono service that puts a Google sign-in gate in front of fbi-proxy. It implements [Caddy's `forward_auth` protocol](https://caddyserver.com/docs/caddyfile/directives/forward_auth), so any reverse proxy that supports forward_auth (Caddy, Traefik, nginx with `auth_request`) can call it to decide "is this request authenticated?".

## When to use it

- You want to put a real sign-in screen in front of `*.your-domain` without writing OAuth glue yourself.
- You're already running fbi-proxy and want to bolt auth on without changing the Rust binary.
- You'd rather use someone else's identity provider (Google for Phase 1; Firebase + others coming).

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

## Phase 1 setup

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

If `auth.json` doesn't exist when you run `bunx fbi-proxy --with-auth`, the CLI checks for these env vars and writes the config file for you:

| Env var                   | Purpose                                | Default                    |
| ------------------------- | -------------------------------------- | -------------------------- |
| `FBI_AUTH_CLIENT_ID`      | Google OAuth Client ID                 | required                   |
| `FBI_AUTH_CLIENT_SECRET`  | Google OAuth Client Secret             | required                   |
| `FBI_AUTH_PROVIDER`       | `google` / `firebase` / `snolab`       | `google`                   |
| `FBI_AUTH_SESSION_SECRET` | 32+ char secret for JWT signing        | auto-generated             |
| `FBI_AUTH_ALLOW_EMAILS`   | Comma-separated allowlist              | unset                      |
| `FBI_AUTH_ALLOW_DOMAINS`  | Comma-separated email-domain allowlist | unset                      |
| `FBI_AUTH_ALLOW_ANY`      | `true` to allow any signed-in user     | `true` if nothing else set |
| `FBI_AUTH_PORT`           | Port for fbi-auth to listen on         | auto                       |
| `FBI_AUTH_CONFIG_PATH`    | Override config path                   | XDG default                |

### 4. Run with `--with-auth`

```bash
bunx fbi-proxy --with-auth --domain your-domain.com
```

You'll see something like:

```
[fbi-auth] starting (domain=your-domain.com, provider=google)
[fbi-auth] PID 12345 listening on 127.0.0.1:2433
```

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

| Method     | Path               | Purpose                                                                                                          |
| ---------- | ------------------ | ---------------------------------------------------------------------------------------------------------------- |
| GET        | `/api/auth/verify` | Forward-auth target. 200 if session is valid (sets `Remote-User`, `Remote-Email`, `Remote-Name`). 401 otherwise. |
| GET        | `/login?rd=<url>`  | Starts the Google OAuth flow. Validates that `rd` is within your domain.                                         |
| GET        | `/callback`        | Google redirects here. Exchanges code, applies allowlist, sets the SSO cookie, redirects to `rd`.                |
| GET / POST | `/logout?rd=<url>` | Clears the SSO cookie.                                                                                           |
| GET        | `/api/auth/me`     | Returns `{ authenticated, user? }` JSON.                                                                         |
| GET        | `/healthz`         | Plain `ok` text for supervisors.                                                                                 |

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

| Symptom                                               | Likely cause                                                                                                                                |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `Forbidden: email '…' not in allowlist` after sign-in | `allowlist.anySignedIn` is `false` and the user's email/domain isn't listed.                                                                |
| Browser bounces between `/login` and the upstream     | Cookie wasn't set — `Domain=.your-domain` doesn't match the host you're visiting. Check `cookieDomain` in `auth.json`.                      |
| `oauth error: …` on `/callback`                       | Wrong `clientSecret`, the redirect URI doesn't match what's registered in Google Console, or the state expired (10 min TTL).                |
| `Provider '…' not implemented in Phase 1`             | Only `google` works in Phase 1. Firebase arrives in Phase 2; snolab default in Phase 4.                                                     |
| TLS warnings on `*.fbi.com` for teammates             | Expected — `tls internal` only trusts on the Caddy host. Use your own domain + public CA for shareable setups (see [README](../README.md)). |

## What's next

Roadmap from [TODO.md](../TODO.md):

- **Phase 2:** Firebase provider, `POST /api/auth/firebase`, first-run interactive wizard.
- **Phase 3:** `--with-caddy --with-auth` auto-generates the Caddyfile and supervises Caddy alongside the proxy.
- **Phase 4:** Snolab default IdP (PKCE flow, zero config for `.fbi.com`).
- **Phase 5:** SQLite-backed sessions, audit log, `--reconfigure`.
