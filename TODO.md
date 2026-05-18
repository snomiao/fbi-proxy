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
- [x] ~~SQLite session storage~~ — **won't do.** JWT + `sessionSecret` rotation covers the threat model (solo / small-team self-hosted). Adding a DB on the hot path (every `/api/auth/verify`) costs more than it gains. See `lib/fbi-auth/docs/setup.md` → "Revoking sessions" for the rotate-the-secret pattern.

## Routing Engine

### R5 — HTTPS upstream support ✅

- [x] `hyper-rustls` connector with Mozilla webpki roots
- [x] Parse `https://` / `http://` prefix from route target string
- [x] HTTP forwarder uses parsed scheme for upstream URL
- [x] WebSocket forwarder uses `wss://` when target scheme is `https`
- [x] Unit tests (`parse_target_scheme`) + E2E test (api.github.com)
- [x] Docs updated (`docs/routing.md` DNS-passthrough warning removed)

Unlocks the full DNS-passthrough pattern: `github.com.{domain}` →
`https://api.github.com:443` over TLS, with verified certs.

## Rest of work (open — for next session)

### Quick wins (≤ 30 min each)

- [ ] **Verify snolab sign-in end-to-end in a real browser.** We shipped Phase 4 (Firebase web SDK + `/api/auth/firebase` + `/login` HTML) and confirmed unit tests pass, but never actually clicked "Sign in with Google" with a live account. Run `bunx fbi-proxy --with-auth --with-caddy --provider snolab --domain fbi.com`, open `https://sso.fbi.com/login` (the `*.fbi.com` wildcard handles DNS), click through, confirm `__fbi_sso` cookie lands and `/api/auth/verify` returns 200 on a subdomain. Save screenshots to `tmp/snolab-flow-{step}.png`.
- [ ] **README polish.** Mark Phase 5 + R5 shipped in the Roadmap section, add snolab default IdP to "What you can do today", drop the "HTTPS upstreams coming soon" prose (now shipped). Reflect that `--with-auth --with-caddy --domain X --provider snolab` is one-command live on `.fbi.com`.
- [ ] **Delete the unused GCP OAuth client** `864071329528-sp7fe1n68skhpdfnahcd5qjpjmg5qolq.apps.googleusercontent.com` from Google Cloud Console → APIs & Services → Credentials. Created during the Phase 4 architecture pivot before the Firebase decision; no code references it. Cleanup, not blocking.

### Medium (~1–2 h)

- [ ] **Custom Domain Wizard polish** — better DX for `--domain example.dev` first-run. Print required DNS records (`*.example.dev → <your-ip>`) and a Caddyfile snippet with DNS-01 sample (Cloudflare). Currently the wizard collects credentials but doesn't help the operator set up DNS.
- [ ] **GitHub Pages docs site.** Repo has `.github/workflows/docs.yml` but it's been failing every run because Pages isn't enabled on the repo. Either enable Pages in repo settings (one toggle in the GitHub UI) and verify the workflow goes green, or delete the workflow file if docs.github.io isn't a goal.
- [ ] **Hot reload `routes.yaml`** — watch the file with `notify` crate, recompile rules on change, swap them under an `RwLock`. Today routes only load at boot.

### Big chunks (~half-day each, own PR)

- [ ] **Built-in HTTPS via rustls + ACME.** Lets users skip Caddy entirely for simple setups. Architecture: terminate TLS in the Rust proxy using `rustls` + an ACME client like `instant-acme`. Trade-offs: more code in the binary, larger attack surface, but removes the Caddy dependency for the simple case. Worth it only if the "no Caddy at all" experience genuinely matters — Caddy already does this very well.
- [ ] **Metrics endpoint** — `/varz` style: counters for requests-served, 2xx/4xx/5xx, upstream-connect-failures, sessions-issued, sessions-refreshed. Prometheus format. fbi-auth already has the audit log; this is the proxy-side equivalent.

### Won't do (decided)

- [x] ~~SQLite session storage~~ — JWT + sessionSecret rotation covers fbi-proxy's threat model. See `feedback_no_premature_db` memory + `lib/fbi-auth/docs/setup.md` → "Revoking sessions".

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
