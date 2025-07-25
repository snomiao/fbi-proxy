# Pingora-Based Rust Proxy

The proxy functionality has been migrated from TypeScript/Bun to Rust using Cloudflare's **Pingora** framework for maximum performance and reliability.

## Architecture

- **TypeScript (`src/cli.ts`)**: Main entry point that:
  - Checks for Rust and Caddy installation
  - Launches the Rust proxy server
  - Starts Caddy with the appropriate configuration
- **Rust (`rs/proxy.rs`)**: Ultra high-performance proxy server using Pingora that:
  - Handles HTTP requests with zero-copy forwarding
  - Processes host header port encoding (e.g., `example.com--3000` → `example.com:3000`)
  - Forwards requests to local services with optimal performance
  - Built-in WebSocket support (handled by Pingora)
  - Runs on port 24306

## Why Pingora?

**Pingora** is Cloudflare's production-grade HTTP proxy framework built in Rust:

- ⚡ **Performance**: Used by Cloudflare to handle millions of requests per second
- 🔒 **Security**: Memory-safe Rust with battle-tested proxy logic
- 🌐 **WebSocket Support**: Built-in WebSocket proxying capabilities
- 📊 **Observability**: Advanced logging and metrics
- 🔧 **Flexibility**: Modular design for custom proxy logic
- 🚀 **Production Ready**: Powers Cloudflare's edge network

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

- `pingora` - Cloudflare's high-performance HTTP proxy framework
- `async-trait` - Async trait support
- `regex` - Pattern matching for host processing
- `env_logger` - Logging infrastructure
- `tokio` - Async runtime (used by Pingora)

## Features

- **🚀 Ultra High Performance**: Pingora framework used in Cloudflare production
- **⚡ Zero-Copy Proxying**: Efficient request/response forwarding
- **🌐 WebSocket Support**: Built-in WebSocket proxying (no custom implementation needed)
- **🔧 Port Encoding**: Supports special host header format for port specification
- **📊 Advanced Logging**: Detailed request/response logging and metrics
- **🛡️ Error Handling**: Production-grade error handling and recovery
- **🔄 Hot Reloading**: Development-friendly with auto-restart capabilities

## Usage

```bash
# Start the full proxy system
bun start

# Development mode with hot reloading
bun run dev
```

The proxy will:

1. Start the Pingora-based Rust proxy server on port 24306
2. Launch Caddy with the configured Caddyfile
3. Handle all incoming requests with maximum performance
4. Automatically handle WebSocket upgrades and forwarding

## Proxy Implementation Details

The Pingora implementation uses the `ProxyHttp` trait to:

1. **Request Filter**: Processes incoming requests, extracts host headers, handles port encoding
2. **Upstream Peer**: Determines the target upstream server dynamically
3. **Response Filter**: Modifies response headers (removes content-encoding)
4. **Logging**: Comprehensive request/response logging with error tracking

### Port Encoding Logic

```rust
// Converts: example.com--3000.domain.com -> example.com:3000
let target_host = port_regex.replace(host_header, ":$1").to_string();
```

This allows encoding port numbers in domain names for proxy routing.

## Performance Benefits

Compared to the previous Hyper-based implementation:

- **🏃‍♂️ Faster**: Pingora's optimized request processing
- **💾 Lower Memory**: Better memory management and pooling
- **🔄 Better WebSocket**: Native WebSocket support without custom forwarding
- **📈 Scalability**: Handles more concurrent connections
- **🔧 Maintainability**: Cleaner code with built-in proxy patterns
