# fbi-proxy

[![npm version](https://img.shields.io/npm/v/fbi-proxy)](https://www.npmjs.com/package/fbi-proxy)
[![crates.io](https://img.shields.io/crates/v/fbi-proxy)](https://crates.io/crates/fbi-proxy)
[![GitHub release](https://img.shields.io/github/v/release/snomiao/fbi-proxy)](https://github.com/snomiao/fbi-proxy/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

FBI-Proxy provides easy HTTPS access to your local services with intelligent domain routing.

## Features

### Current Features ✅

- **One-command HTTPS gateway**: `bunx fbi-proxy --with-caddy --with-auth --provider snolab --domain fbi.com` brings up Caddy (auto-downloaded), fbi-auth (Firebase-backed Google sign-in), and the Rust proxy together — zero config needed on `.fbi.com`.
- **Rule-based Domain Routing** via `routes.yaml`:
  - Port-based routing (e.g., `3000.fbi.com` → `localhost:3000`)
  - Host--Port routing (e.g., `api--3001.fbi.com` → `api:3001`)
  - Subdomain routing with Host headers (e.g., `admin.app.fbi.com` → `app:80`)
  - Direct host forwarding (e.g., `myserver.fbi.com` → `myserver:80`)
  - Placeholder syntax (`{name}`, `{name:int}`, `{name:slug}`, `{name:multi}`) for custom rules — see [docs/routing.md](docs/routing.md)
- **HTTPS Upstreams**: Targets with an `https://` prefix connect to upstream over TLS (Mozilla webpki roots).
- **WebSocket Support**: Full WebSocket forwarding (`ws://` and `wss://`) for all routing patterns.
- **Auth Gateway**: Google OAuth / Firebase Auth / zero-config snolab default IdP — JWT cookie scoped to `Domain=.your-domain` for cross-subdomain SSO. Audit log at `~/.config/fbi-proxy/audit.log`.
- **High Performance**: Built with Rust for optimal performance and low resource usage.
- **Easy Setup**: Simple one-command installation and startup.
- **Docker Support**: Available as a Docker image for containerized deployments.
- **Flexible Configuration**: Environment variables, CLI options, and `routes.yaml` overrides.
- **Cross-Platform**: Pre-built binaries for macOS, Linux, and Windows (x64 + arm64).
- **Integration Ready**: Compatible with reverse proxies like Caddy for HTTPS (and bundles its own `--with-caddy` automation).

## Roadmap

### Shipped ✅

- [x] **Auto Caddy Setup** — One-command bootstrap that generates a Caddyfile for the chosen domain and supervises Caddy alongside fbi-proxy and fbi-auth (`bunx fbi-proxy --with-caddy --with-auth --domain example.dev`). Caddy binary is auto-downloaded from GitHub Releases on first run (SHA-512 verified against the release's `checksums.txt`), cached at `~/.fbi-proxy/bin/caddy`. Set `FBI_CADDY_AUTO_DOWNLOAD=false` to opt out.
- [x] **Auth Gateway** — Google OAuth, Firebase Auth, and a **zero-config snolab default IdP** (Firebase-based, live on `fbi.com`). Cookie-based SSO across `*.your-domain`. Sliding-window refresh, configurable threshold, JSONL audit log at `~/.config/fbi-proxy/audit.log`. See [lib/fbi-auth/docs/setup.md](lib/fbi-auth/docs/setup.md) and [lib/fbi-auth/docs/snolab.md](lib/fbi-auth/docs/snolab.md).
- [x] **Rule-based Routing** — `routes.yaml` with placeholder syntax (`{name}`, `{name:int}`, `{name:slug}`, `{name:multi}`). DNS-passthrough, k8s, Docker, and PR-preview recipes in [docs/routing.md](docs/routing.md). Override the bundled defaults with `--routes` or `FBI_PROXY_ROUTES`.
- [x] **HTTPS Upstream Support** — Route target with an `https://` prefix triggers TLS to upstream via `hyper-rustls` + Mozilla webpki roots. Backward compatible — plain `host:port` still uses HTTP. WebSocket upgrades flip to `wss://` automatically.
- [x] **Cross-platform Releases** — Every push builds six platforms in parallel (linux x64/arm64, macOS x64/arm64, windows x64/arm64). See [docs/cross-compile-tradeoffs.html](docs/cross-compile-tradeoffs.html).

### Next Up 🚧

- [ ] **Custom Domain Wizard polish** — Print the DNS A-records to add (`*.example.dev → <ip>`) and a Caddyfile-with-DNS-01 sample for Cloudflare during `--reconfigure` on a non-fbi.com domain
- [ ] **Hot Reload** — Watch `routes.yaml` and recompile rules without a restart
- [ ] **Metrics** — `/varz`-style counters: requests, 2xx/4xx/5xx, upstream-connect-failures, sessions-issued, sessions-refreshed (Prometheus format)
- [ ] **Health Checks** — Active upstream liveness probes, not just per-request failure detection
- [ ] **Cloudflare Tunnel / ngrok Integration** — Expose `*.your-domain` publicly without owning a static IP

### Future Improvements 🔮

- [ ] **Load Balancing** — Round-robin between multiple upstream targets for one route
- [ ] **Custom Headers per route** — Beyond `Host:`, add response headers or rewrite request headers

### Won't do

- ~~**Built-in HTTPS via rustls + ACME**~~ — Caddy already does this very well, and the `--with-caddy` UX is one extra flag. Adding another ACME client to the Rust binary is more code, more attack surface, and another implementation of a solved problem. Caddy stays the canonical TLS path.
- ~~**SQLite session storage**~~ — JWT + `sessionSecret` rotation covers the threat model for fbi-proxy's intended scale (solo / small-team self-hosted). See [revoking sessions](lib/fbi-auth/docs/setup.md#revoking-sessions).

## Routing Examples

```bash
# Port forwarding
https://3000.fbi.com        → localhost:3000
https://8080.fbi.com        → localhost:8080

# Host--Port forwarding
https://api--3001.fbi.com   → api:3001
https://db--5432.fbi.com    → db:5432

# Subdomain routing (with Host header)
https://admin.app.fbi.com   → app:80 (Host: admin)
https://v2.api.fbi.com      → api:80 (Host: v2)

# Direct host forwarding
https://myserver.fbi.com    → myserver:80
```

WebSocket connections are supported for all patterns.

## 🕶️ Why `fbi.com`? — The Story

Slip on your shades and look at this. 🕶️

There's a public DNS quirk that makes `fbi.com` ridiculously fun for local dev: **every `*.fbi.com` wildcard A record resolves to `127.0.0.1`**. No `/etc/hosts` edits. No DNS server. Just open `https://3000.fbi.com` and your browser is already talking to your laptop.

That's why `bunx fbi-proxy` defaults to `fbi.com` — it's the path of least resistance to a working demo. Spin up a dev server on `:3000`, run the proxy, and you've got a real-looking subdomain pointing at it instantly.

### 🕶️ …but please don't ship on it

This is **a toy for testing and playing**, not infrastructure:

- **It's somebody else's DNS.** Whoever owns `fbi.com` can change those records any time. Your "production" disappears the moment they do.
- **Caddy's `tls internal` CA is local-only.** The root cert is installed into the trust store of _the machine running Caddy_. Anyone else who visits your `*.fbi.com` site sees a TLS warning. It cannot be shared with teammates, mobile devices, or end users.
- **Anyone can issue certs for `*.fbi.com`.** Because the apex isn't yours, you have zero control over who else asks Let's Encrypt for a cert on the same name.

### 🕶️ For anything real — bring your own domain

```bash
bunx fbi-proxy --domain example.dev
```

Then point `*.example.dev` at your server's IP, run Caddy with proper public-CA TLS (Let's Encrypt via HTTP-01 or DNS-01), and you own the whole stack end-to-end. Production-grade. Shareable. Trustworthy.

`fbi.com` is the costume sunglasses. Your own domain is the prescription pair.

### 🕶️ Cousins in the wild: `*.vercel.app`, `*.pages.dev`

You've probably noticed `*.fbi.com` looks a lot like `*.vercel.app` or `*.pages.dev` — same wildcard-DNS trick, very different tradeoffs.

|                                               | `*.fbi.com` (fbi-proxy)                                         | `*.vercel.app` / `*.pages.dev`                             |
| --------------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------- |
| Who owns the apex                             | A third party (`snomiao` doesn't own `fbi.com`)                 | The platform (Vercel / Cloudflare)                         |
| Wildcard resolves to                          | `127.0.0.1` — your own laptop                                   | The platform's edge servers                                |
| Where code actually runs                      | Your laptop                                                     | The platform's infrastructure                              |
| TLS                                           | None on the DNS layer — Caddy `tls internal` (machine-local CA) | Public CA, auto-issued, trusted on every device            |
| Shareable with teammates / mobile / strangers | No (CA only trusts on your box)                                 | Yes (it's the whole point)                                 |
| Privacy                                       | All traffic stays on your machine                               | Goes through the platform's network                        |
| Lock-in                                       | None — drop the dependency by switching `--domain`              | You're on the platform's runtime, build system, and limits |
| Best for                                      | Local dev, demos, "look it works on my laptop"                  | Actual deployed apps that real users hit                   |

Same shape — public wildcard apex points at _something_ — but `*.fbi.com` points it at **your machine**, while `*.vercel.app` and `*.pages.dev` point it at **someone else's machines running your code for you**. fbi-proxy is the DIY-at-home cousin of those platforms' subdomain UX.

## Usage

```sh
# launch
bunx fbi-proxy

# expose to LAN
bunx fbi-proxy --host 0.0.0.0 --port=2432

# run with docker
docker run --rm --name fbi-proxy --network=host snomiao/fbi-proxy
```

## Using with Caddy (Optional)

FBI-Proxy focuses on the core proxy functionality. For HTTPS and advanced routing, you can use Caddy as a reverse proxy:

### Install Caddy

```bash
# macOS
brew install caddy

# Ubuntu/Debian
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install caddy

# Or download from https://caddyserver.com/download
```

### Caddyfile Example

Create a `Caddyfile` to route `*.fbi.com` to FBI-Proxy:

```caddyfile
*.fbi.com {
    reverse_proxy localhost:2432
    tls internal
}
```

### Run Both Services

```bash
# Terminal 1: Start FBI-Proxy
bunx fbi-proxy

# Terminal 2: Start Caddy
caddy run --config Caddyfile
```

Now you can access your services via HTTPS at `https://*.fbi.com`!

## Development

```bash
# Install dependencies
bun install

# Start development
bun run dev

# Or production
bun run build && bun run start
```

### Prerequisites

- **Bun**: https://bun.sh/
- **Rust**: https://rustup.rs/

### Configuration

#### Environment Variables

FBI-Proxy supports the following environment variables for configuration:

| Variable         | Description                                                    | Default     |
| ---------------- | -------------------------------------------------------------- | ----------- |
| `FBI_PROXY_PORT` | Port for the proxy server to listen on                         | `2432`      |
| `FBI_PROXY_HOST` | Host/IP address to bind to                                     | `127.0.0.1` |
| `RUST_LOG`       | Log level for the Rust proxy (error, warn, info, debug, trace) | `info`      |
| `FBIPROXY_PORT`  | Internal proxy port (auto-assigned)                            | Auto        |

Command-line arguments take precedence over environment variables.

#### CLI Options

- Default domain: `fbi.com` (change with `--fbihost`)
- Host binding: `--host` or `FBI_PROXY_HOST` env var
- Port binding: `--port` or `FBI_PROXY_PORT` env var

## Alternatives & Tradeoffs

fbi-proxy isn't the only way to get `https://myapp.something → localhost:port`. Below are five well-known alternatives covering the two halves of the problem: **subdomain → loopback resolution** (Group A) and **forward-auth gateways** (Group B).

| Name                                                                  | What it does                                                                                                           | Setup                                                             | Cross-machine?                                             | HTTPS story                                                                       | WebSocket              | vs fbi-proxy                                                                                                                                                                                                         |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [mDNS / Bonjour / Avahi](https://en.wikipedia.org/wiki/Multicast_DNS) | Resolves `*.local` hostnames via UDP multicast — no DNS server needed                                                  | Low (built into macOS/iOS/Win10+, `avahi-daemon` on Linux)        | LAN-only (same broadcast domain); not for prod or cellular | None — needs own CA / self-signed; browser warnings                               | N/A (DNS layer only)   | Beats fbi-proxy for zero-config LAN service discovery; loses on wildcard subdomains (mDNS publishes individual names, not `*.local`) and TLS UX                                                                      |
| [dnsmasq](https://thekelleys.org.uk/dnsmasq/doc.html)                 | Tiny local DNS+DHCP; `address=/test/127.0.0.1` wildcards any `*.test` to loopback                                      | Med (install, edit config, point resolver at it)                  | Yes if installed on the LAN gateway                        | None — DNS only, you still need TLS via Caddy / nginx / mkcert                    | N/A                    | Beats fbi-proxy when you want a generic LAN-wide wildcard resolver decoupled from any specific proxy; loses because you still have to bolt on a reverse proxy + TLS yourself                                         |
| [Pi-hole](https://pi-hole.net)                                        | Network-wide DNS ad-blocker built on dnsmasq/FTL; UI for custom local DNS / CNAME records                              | Med (dedicated host or container, router DNS pointed at it)       | LAN-wide                                                   | None — DNS only                                                                   | N/A                    | Beats fbi-proxy if you already run Pi-hole; loses for single-laptop dev (overkill, no TLS, no proxy)                                                                                                                 |
| [vercel-labs/portless](https://github.com/vercel-labs/portless)       | CLI that wraps `npm`/dev-server processes and exposes them as `https://name.localhost` with an auto-installed local CA | Low (`npm i -g portless` then `portless myapp next dev`)          | Laptop-only by default                                     | Auto-generates a local CA and installs it in the system trust store — no warnings | Yes (HTTP/2 proxy)     | Beats fbi-proxy on TLS UX (no separate Caddy step) and per-app naming; loses on the "any port, any subdomain, zero config per service" model — portless registers apps explicitly, fbi-proxy is pure pattern routing |
| [Authelia](https://www.authelia.com/)                                 | Self-hosted SSO + 2FA + OIDC provider; plugs into reverse proxies as a `forward_auth` endpoint                         | High (DB / LDAP / session store, YAML config, separate container) | Yes — production-grade                                     | Inherits from front proxy (Caddy/Traefik/nginx)                                   | Pass-through via proxy | Beats fbi-proxy when you want real SSO, OIDC issuance, WebAuthn/passkeys, group policies; loses when you only need "is this user logged in?" with one binary                                                         |
| [tinyauth](https://github.com/steveiliop56/tinyauth)                  | Minimal Go forward-auth server: OAuth/OIDC, LDAP, TOTP, simple ACLs                                                    | Low–Med (single binary / container, env-var config)               | Yes                                                        | Inherits from front proxy                                                         | Pass-through via proxy | Beats fbi-proxy when you outgrow basic auth but don't want Authelia's surface area; loses because fbi-proxy ships routing in the same binary                                                                         |

### When to use which

- **Pure local dev, one laptop, throwaway demo** — fbi-proxy's default `fbi.com` mode or **portless** are both fine. portless wins on TLS-trusted-out-of-the-box; fbi-proxy wins if you want pattern routing (`<port>.<host>`) without registering each service.
- **LAN-wide / teammates on the same Wi-Fi** — **dnsmasq** or **Pi-hole** for the DNS half, then put fbi-proxy (or Caddy directly) in front for TLS + routing. **mDNS** works for hostname discovery but not wildcards.
- **Production / public domain** — fbi-proxy with `--domain yourdomain.com` + Caddy for ACME TLS. Pair with **tinyauth** (lightweight) or **Authelia** (full IAM) for real auth.
- **Honest tradeoffs:** fbi-proxy's default `*.fbi.com` is a toy meant for demos — for anything serious you need `--domain` and a real TLS terminator (Caddy is the documented path). It does not replace an SSO server, a DNS server, or a CDN; it's the glue that wires `subdomain → port` and optionally calls out to one of the above.

## License

MIT License - see [LICENSE](LICENSE) file for details
