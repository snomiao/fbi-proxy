# fbi-proxy

FBI Proxy provides easy HTTPS access to your local services with intelligent domain routing.

## Quick Start

```bash
# Install dependencies
bun install

# Start development
bun run dev

# Or production
bun run build && bun run start
```

## Prerequisites

- **Bun**: https://bun.sh/
- **Rust**: https://rustup.rs/
- **Caddy**: Auto-downloaded if not found

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

## Configuration

- Default domain: `fbi.com` (change with `--fbihost`)
- Internal proxy port: Auto-assigned to `FBIPROXY_PORT`

## License

MIT License - see [LICENSE](LICENSE) file for details
