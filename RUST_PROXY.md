# Rust Proxy Migration

The proxy functionality has been migrated from TypeScript/Bun to Rust for better performance and reliability.

## Architecture

- **TypeScript (`src/cli.ts`)**: Main entry point that:
  - Checks for Rust and Caddy installation
  - Launches the Rust proxy server
  - Starts Caddy with the appropriate configuration
- **Rust (`rs/proxy.rs`)**: High-performance proxy server that:
  - Handles HTTP requests and WebSocket upgrades
  - Processes host header port encoding (e.g., `example.com--3000` → `example.com:3000`)
  - Forwards requests to local services
  - Runs on port 24306

## Building

### Using npm/bun scripts:

```bash
# Build release version
bun run build-proxy

# Build development version
bun run build-proxy-dev
```

### Manual build:

```bash
cd rs
cargo build --release
```

### Platform-specific build scripts:

```bash
# Linux/macOS
./build-proxy.sh

# Windows
build-proxy.bat
```

## Dependencies

### System Requirements:

- Rust (install from https://rustup.rs/)
- Caddy web server
- Bun runtime

### Rust Dependencies:

- `hyper` - HTTP server and client
- `tokio` - Async runtime
- `tokio-tungstenite` - WebSocket support
- `futures-util` - Stream utilities
- `url` - URL parsing
- `regex` - Pattern matching

## Features

- **High Performance**: Native Rust implementation for better speed and memory usage
- **WebSocket Support**: Full WebSocket proxying capabilities
- **Port Encoding**: Supports special host header format for port specification
- **Error Handling**: Robust error handling and logging
- **Hot Reloading**: Development-friendly with auto-restart capabilities

## Usage

```bash
# Start the full proxy system
bun start

# Development mode with hot reloading
bun run dev
```

The proxy will:

1. Start the Rust proxy server on port 24306
2. Launch Caddy with the configured Caddyfile
3. Handle all incoming requests and forward them to local services
