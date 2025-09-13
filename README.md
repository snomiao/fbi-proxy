# fbi-proxy

FBI-Proxy provides easy HTTPS access to your local services with intelligent domain routing.

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

| Variable | Description | Default |
|----------|-------------|---------|
| `FBI_PROXY_PORT` | Port for the proxy server to listen on | `2432` |
| `FBI_PROXY_HOST` | Host/IP address to bind to | `127.0.0.1` |
| `RUST_LOG` | Log level for the Rust proxy (error, warn, info, debug, trace) | `info` |
| `FBIPROXY_PORT` | Internal proxy port (auto-assigned) | Auto |

Command-line arguments take precedence over environment variables.

#### CLI Options

- Default domain: `fbi.com` (change with `--fbihost`)
- Host binding: `--host` or `FBI_PROXY_HOST` env var
- Port binding: `--port` or `FBI_PROXY_PORT` env var

## License

MIT License - see [LICENSE](LICENSE) file for details
