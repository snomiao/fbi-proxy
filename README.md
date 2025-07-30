# fbi-proxy

FBI Proxy is a super easy way to turn your local network over HTTPS with intelligent domain routing.

## Quick Start

```bash
# Install dependencies
bun install

# Build and start the proxy system
bun run start

# Development mode with auto-reload
bun run dev
```

## Build Scripts

### Available Commands:

```bash
# Build TypeScript CLI
bun run build:ts

# Build Rust proxy binary
bun run build:rs

# Full build (both TypeScript and Rust)
bun run build

# Development with hot reload
bun run dev

# Production start
bun run start
```

## Architecture

The FBI Proxy consists of three main components:

- **TypeScript CLI** (`ts/cli.ts`): Orchestrates the entire system, manages Caddy and Rust proxy processes
- **Rust Proxy Server** (`proxy.rs`): High-performance HTTP/WebSocket proxy using Hyper framework
- **Caddy Server**: Handles TLS termination, SSL certificates, and domain routing

### How It Works

1. **CLI** downloads/manages Caddy binary and builds the Rust proxy
2. **Caddy** receives incoming HTTPS requests and forwards them to the Rust proxy
3. **Rust Proxy** intelligently routes requests based on hostname patterns

## Development Workflow

### First Time Setup:

```bash
# 1. Install dependencies (requires Bun)
bun install

# 2. Start development (automatically builds and runs)
bun run dev
```

### Daily Development:

```bash
# Development with hot reload for both Caddy and Rust
bun run dev

# Or run individual components:
bun run dev:caddy    # Start Caddy with file watching
bun run dev:rs       # Start Rust proxy with bacon (auto-rebuild)
```

### Production Deployment:

```bash
bun run build       # Build optimized binaries
bun run start       # Start production services
```

## Prerequisites

- **Bun**: JavaScript runtime and package manager (install from https://bun.sh/)
- **Rust**: For building the proxy binary (install from https://rustup.rs/)
- **Caddy**: Automatically downloaded by the CLI if not found

## Routing Features

The FBI Proxy supports intelligent hostname-based routing with the following patterns:

### 1. Port Forwarding

- `https://3000.fbi.com` → `http://localhost:3000`
- `https://8080.fbi.com` → `http://localhost:8080`

### 2. Host--Port Forwarding

- `https://localhost--3000.fbi.com` → `http://localhost:3000`
- `https://myserver--8080.fbi.com` → `http://myserver:8080`

### 3. Subdomain Hoisting

- `https://api.myserver.fbi.com` → `http://myserver:80` (with Host: `api`)
- `https://admin.localhost.fbi.com` → `http://localhost:80` (with Host: `admin`)

### 4. Direct Host Forwarding

- `https://myserver.fbi.com` → `http://myserver:80`
- `https://localhost.fbi.com` → `http://localhost:80`

### WebSocket Support

All routing patterns support WebSocket connections with automatic upgrade handling.

## Configuration

### Environment Variables

```env
FBIHOST="fbi.com"           # Default domain (configurable via --fbihost)
FBIPROXY_PORT="24306"       # Internal proxy port (auto-assigned)
```

### CLI Options

```bash
bun run ts/cli.ts --help

Options:
  --help          Show help message
  --fbihost       Set the FBI host (default: fbi.com)
```

## Service Configuration Examples

Create custom service mappings by modifying the routing logic or using the built-in patterns:

```bash
# Direct port access
https://3000.fbi.com        # → localhost:3000
https://5173.fbi.com        # → localhost:5173 (Vite dev server)
https://8000.fbi.com        # → localhost:8000 (VS Code server)

# Named services with custom ports
https://api--3001.fbi.com   # → api:3001
https://db--5432.fbi.com    # → db:5432

# Subdomain routing
# Subdomain routing
https://admin.app.fbi.com   # → app:80 with Host: admin
https://v2.api.fbi.com      # → api:80 with Host: v2
```

## Technical Details

### Rust Proxy Implementation (`proxy.rs`)

The Rust proxy server implements the following routing logic:

1. **Number Host Detection**: Pure numeric hosts (e.g., `3000`) route to `localhost:3000`
2. **Double-Dash Parsing**: `host--port` format routes to `host:port`
3. **Subdomain Hoisting**: Multi-level domains route to the root domain with subdomain as Host header
4. **Default Port 80**: Simple hostnames default to port 80

### TypeScript CLI (`ts/cli.ts`)

The CLI manages:

- Binary discovery and building (Rust proxy, Caddy download)
- Process orchestration with proper signal handling
- Port management and environment variable passing
- Hot reloading during development

### Caddy Configuration (`Caddyfile`)

- Automatic HTTPS with on-demand TLS certificates
- Regex-based host header matching
- Reverse proxy configuration with header manipulation
- Support for wildcard subdomain routing

## License

MIT License - see [LICENSE](LICENSE) file for details
