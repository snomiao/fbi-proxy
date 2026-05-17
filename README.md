# fbi-proxy

[![npm version](https://img.shields.io/npm/v/fbi-proxy)](https://www.npmjs.com/package/fbi-proxy)
[![crates.io](https://img.shields.io/crates/v/fbi-proxy)](https://crates.io/crates/fbi-proxy)
[![GitHub release](https://img.shields.io/github/v/release/snomiao/fbi-proxy)](https://github.com/snomiao/fbi-proxy/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

FBI-Proxy provides easy HTTPS access to your local services with intelligent domain routing.

## Features

### Current Features ✅

- **Intelligent Domain Routing**: Multiple routing patterns for flexible service access
  - Port-based routing (e.g., `3000.fbi.com` → `localhost:3000`)
  - Host--Port routing (e.g., `api--3001.fbi.com` → `api:3001`)
  - Subdomain routing with Host headers (e.g., `admin.app.fbi.com` → `app:80`)
  - Direct host forwarding (e.g., `myserver.fbi.com` → `myserver:80`)
- **WebSocket Support**: Full WebSocket connection support for all routing patterns
- **High Performance**: Built with Rust for optimal performance and low resource usage
- **Easy Setup**: Simple one-command installation and startup
- **Docker Support**: Available as a Docker image for containerized deployments
- **Flexible Configuration**: Environment variables and CLI options for customization
- **Cross-Platform**: Works on macOS, Linux, and Windows
- **Integration Ready**: Compatible with reverse proxies like Caddy for HTTPS

## Roadmap

### Shipped ✅

- [x] **Auto Caddy Setup** - One-command bootstrap that generates a Caddyfile for the chosen domain and supervises Caddy alongside fbi-proxy and fbi-auth (`bunx fbi-proxy --with-caddy --with-auth --domain example.dev`). See [docs/auth/setup.md](lib/fbi-auth/docs/setup.md#automatic-setup-with---with-caddy-phase-3--shipped). Phase 3.1 will auto-download the Caddy binary; today you need it installed (`brew install caddy` / `apt install caddy` / `scoop install caddy`).

### Next Up 🚧

- [ ] **Phase 3.1: Auto-download Caddy** - Fetch the latest Caddy release from GitHub when no binary is on `$PATH`, so `--with-caddy` works on a totally fresh machine
- [ ] **Custom Domain Wizard** - Interactive setup that prints the DNS records to add (`*.example.dev → <ip>`) and generates the matching Caddyfile / DNS-01 TLS block
- [ ] **Built-in HTTPS (optional)** - Native TLS termination via rustls + ACME so Caddy becomes optional for simple setups
- [ ] **Configuration File Support** - YAML/JSON config for persistent routing rules
- [ ] **Access Control** - Domain filtering, host/port whitelisting
- [ ] **Request Logging** - Basic access logs for debugging
- [ ] **Health Checks** - Simple upstream service availability monitoring

### Future Improvements 🔮

- [ ] **Load Balancing** - Round-robin between multiple upstream targets
- [ ] **Metrics** - Basic statistics (requests, response times, errors)
- [ ] **Hot Reload** - Update configuration without restart
- [ ] **Custom Headers** - Add/modify headers for specific routes
- [ ] **Cloudflare Tunnel / ngrok Integration** - Expose `*.your-domain` to the public internet without owning a static IP
- [ ] **Auth Gateway** - Built-in basic auth / OIDC so public exposure is safe by default

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
