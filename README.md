# fbi-proxy

FBI Proxy is a super easy way to turn your local network over https.

## Quick Start

```bash
# Build the Rust proxy (production)
npm run build-proxy

# Start the proxy system
npm start

# Development mode with auto-reload
npm run dev
```

## Build Scripts

### Rust Proxy Build Commands:

```bash
# Production build (optimized)
npm run build-proxy

# Development build (faster compilation)
npm run build-proxy-dev

# Windows-specific build (uses build-windows.bat)
npm run build-proxy-windows

# Check code without building
npm run check-proxy

# Clean build artifacts
npm run clean-proxy

# Run tests
npm run test-proxy

# Format code
npm run fmt-proxy

# Run linter
npm run clippy-proxy

# Run proxy directly (for testing)
npm run run-proxy
```

### Combined Commands:

```bash
# Build and run (development)
npm run proxy:dev

# Build and run (production)
npm run proxy:prod

# Full build (includes pre-build checks)
npm run build
```

## Architecture

- **TypeScript CLI** (`src/cli.ts`): Orchestrates Caddy and Rust proxy
- **Rust Proxy** (`rs/proxy.rs`): High-performance HTTP/WebSocket proxy using Hyper
- **Caddy Server**: Handles TLS termination and domain routing

## Development Workflow

### First Time Setup:

```bash
# 1. Install dependencies
npm install

# 2. Build the Rust proxy
npm run build-proxy

# 3. Start development
npm run dev
```

### Daily Development:

```bash
# Quick development cycle
npm run proxy:dev

# Or step by step:
npm run build-proxy-dev  # Fast Rust build
npm run dev              # Start with auto-reload
```

### Before Committing:

```bash
npm run fmt-proxy        # Format Rust code
npm run clippy-proxy     # Check Rust linting
npm run check-proxy      # Verify compilation
npm run test-proxy       # Run tests
```

### Production Build:

```bash
npm run build           # Full optimized build
npm run proxy:prod      # Build and run production
```

## Prerequisites

- **Rust**: Install from https://rustup.rs/
- **Caddy**: Web server for TLS termination
- **Bun**: Runtime for TypeScript CLI

## feats

1. Port Forwarder, https://[port].fbi.com proxies to http://localhost:[port]
2. Host Forwarder, https://[*].[host].fbi.com proxies to [host] with url https://[*].fbi.com
3. Host:Port forwarder https://[host]--[port].fbi.com proxies to http://[host]:[port]
4. Configurable host alias

## ...

configurable local Proxy generator

Environment Defaults:

```env
LOCALHOST="fbi.com"
SERVICES="localhost:5600"
```

activitywatch=3000
activitywatch=3000
activitywatch=3000
activitywatch=3000

```

# https://activitywatch.fbi.com -> localhost:5600
activitywatch: :5600

# https://aw.fbi.com -> localhost:5600
aw: :5600

# https://calibre.fbi.com -> localhost:7250
calibre: :7250

# https://everything.fbi.com -> localhost:2489
everything: :2489

# https://vscode.fbi.com -> localhost:8000
vscode: :8000

```
