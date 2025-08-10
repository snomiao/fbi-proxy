# Installation Guide

## Prerequisites

Before installing FBI-Proxy, ensure you have the following installed:

- **Bun**: JavaScript runtime - [Install Bun](https://bun.sh/)
- **Rust**: For building the proxy server - [Install Rust](https://rustup.rs/)
- **Caddy**: Auto-downloaded if not found

## Quick Install

### Using npx/bunx (Recommended)

```bash
# Run directly without installation
bunx fbi-proxy

# Or install globally
bun install -g fbi-proxy
fbi-proxy
```

### Using Docker

```bash
# Pull and run the Docker image
docker run -p 2432:2432 snomiao/fbi-proxy

# Or use docker-compose
docker-compose up
```

### From Source

```bash
# Clone the repository
git clone https://github.com/snomiao/fbi-proxy.git
cd fbi-proxy

# Install dependencies
bun install

# Build the project
bun run build

# Run
bun run start
```

## System Requirements

- **Operating System**: Linux, macOS, Windows
- **Memory**: Minimum 128MB RAM
- **Network**: Port 2432 (default) or custom port
- **Disk Space**: ~50MB for binaries and dependencies

## Verification

After installation, verify FBI-Proxy is working:

```bash
# Check version
fbi-proxy --version

# Test basic functionality
fbi-proxy --help
```

## Next Steps

- [Usage & Configuration](usage.md)
- [Development Setup](development.md)
