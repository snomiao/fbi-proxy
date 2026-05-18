# TODO

## Configurable (existing)

- domain filter
- enable/disable specified HOST
- target-host whitelist
- target-port whitelist

## Bootstrap UX (from user feedback 2026-05-12)

- auto-setup Caddy: detect/install Caddy, generate Caddyfile for --domain, start it alongside fbi-proxy
- custom-domain wizard: print required DNS records (\*.domain → ip) + Caddyfile snippet (incl. DNS-01 sample for Cloudflare)
- built-in HTTPS via rustls + ACME (skip Caddy for simple setups)
- fix README mismatch: README mentions --fbihost but actual CLI flag is --domain / -d (env: FBI_PROXY_DOMAIN)

## Auth Gateway — phased rollout (plan: /root/.claude/plans/ugh-i-think-we-twinkling-eich.md)

Architecture: separate Bun/TS service at `./lib/fbi-auth` (Hono + jose + oauth4webapi). Rust proxy stays auth-unaware. Auth runs at Caddy `forward_auth` boundary. Stateless JWT in `Domain=.{configured-domain}` cookie. Lessons from snomiao/Lauth: keep forward_auth pattern, avoid MongoDB and full Next.js, avoid hardcoded org rules.

### Phase 1 — MVP (smallest first PR)

- [ ] `lib/fbi-auth` scaffold: package.json + Hono server + routes (`/api/auth/verify`, `/login`, `/callback`, `/logout`, `/api/auth/me`, `/healthz`)
- [ ] Google OAuth2 provider (`providers/google.ts`) via `oauth4webapi`
- [ ] Stateless JWT cookie (`session.ts`) — HS256, 7-day exp, sliding refresh under 1 day left
- [ ] JSON allowlist engine (`allowlist.ts`): `emails` / `domains` / `anySignedIn`
- [ ] CLI flags: `--with-auth`, `--domain`, `--reconfigure`
- [ ] `ts/auth/{spawnFbiAuth,authConfig}.ts` — load/save `~/.config/fbi-proxy/auth.json` (mode 0600), spawn fbi-auth alongside Rust proxy via dSpawn
- [ ] `docs/auth.md` (English first — per repo policy 2026-05-15) — operator setup guide
- [ ] `e2e/auth.test.ts` — smoke (302 on no-cookie, JWT roundtrip, allowlist reject 403)

### Phase 2 — Firebase + Wizard

- [ ] Firebase provider (`providers/firebase.ts`) — JWKS verify via jose
- [ ] `POST /api/auth/firebase` — accept client SDK ID token, issue SSO cookie
- [ ] First-run setup wizard (`ts/auth/setupWizard.ts`) — readline, no extra deps
- [ ] Env-var fallback for non-TTY (Docker)

### Phase 3 — --with-caddy --with-auth

- [ ] `ts/auth/caddyfileGen.ts` — generate Caddyfile for `*.{domain}` + `sso.{domain}` with `forward_auth` directive
- [ ] Caddy binary fetch (similar to existing `getProxyFilename.ts` pattern)
- [ ] `dSpawn.ts` extended to multi-child supervisor (SIGINT/SIGTERM all children)
- [ ] Document `.fbi.com` CA caveat: `tls internal` only trusts on the Caddy host — not shareable
- [ ] Document story (README ✅ added) — pointer to it from `docs/auth.md`

### Phase 4 — snolab default IdP ✅

- [x] Architecture pivot from raw OAuth/PKCE to Firebase (Google requires client_secret on Web Application clients — PKCE alone is insufficient)
- [x] Bake snolab Firebase web config (apiKey/authDomain/projectId — all public per Firebase docs) into `snolabDefaults.ts`
- [x] `firebaseLoginRoute` — serves `/login` HTML with Firebase Web SDK + Google sign-in
- [x] Wire `--provider snolab` → Firebase flow in `server.ts`
- [x] Doc: snolab default only works for `.fbi.com`; custom domains need BYO

### Phase 5 — Polish (mostly shipped)

- [x] Sliding-window refresh — configurable via `FBI_AUTH_REFRESH_THRESHOLD_SECONDS` (default 24h)
- [x] `--reconfigure` polish — change detection, "no changes — skipping write" path, defaults from existing
- [x] Audit log to `~/.config/fbi-proxy/audit.log` (JSONL, env `FBI_AUTH_AUDIT=0` to disable)
- [ ] SQLite upgrade path (preserve `{issue, verify, revoke}` interface) — **deferred to its own PR**

## Roadmap (from README — for reference)

### Next Up 🚧

- Auto Caddy Setup (--with-caddy)
- Custom Domain Wizard
- Built-in HTTPS (optional, rustls + ACME)
- Configuration File Support (YAML/JSON)
- Access Control / Request Logging / Health Checks

### Future 🔮

- Load Balancing
- Metrics / Hot Reload / Custom Headers
- Cloudflare Tunnel / ngrok integration
- Auth Gateway → **in progress (this section above)**
