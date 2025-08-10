# Development Guide

## Development Environment Setup

### Prerequisites

Ensure you have the required tools installed:

```bash
# Check versions
bun --version    # v1.0.0+
rustc --version  # 1.70.0+
cargo --version  # 1.70.0+
```

### Clone and Setup

```bash
git clone https://github.com/snomiao/fbi-proxy.git
cd fbi-proxy

# Install dependencies
bun install

# Build the project
bun run build
```

## Project Structure

```
fbi-proxy/
├── ts/                 # TypeScript source code
│   ├── cli.ts         # Main CLI entry point
│   ├── buildFbiProxy.ts # Rust binary builder
│   ├── downloadCaddy.ts # Caddy downloader
│   ├── dSpawn.ts      # Process spawning utilities
│   └── getProxyFilename.ts # Binary file utilities
├── fbi-proxy.rs       # Rust proxy server
├── Caddyfile         # Caddy configuration
├── Dockerfile        # Docker configuration
├── docker-compose.yml # Docker Compose setup
└── package.json      # Node.js dependencies
```

## Development Scripts

### TypeScript Development

```bash
# Hot reload TypeScript CLI
bun run dev:ts

# Build TypeScript
bun run build:ts
```

### Rust Development

```bash
# Watch and rebuild Rust code
bun run dev:rs

# Alternative with cargo-watch
bun run dev:rs-watch

# Build Rust release
bun run build:rs
```

### Full Development

```bash
# Run all development services
bun run dev

# This starts:
# - Caddy with file watching
# - Rust proxy with hot reload
```

## Code Architecture

### TypeScript Layer (ts/)

The TypeScript layer handles:

- CLI argument parsing with `yargs`
- Binary management (Rust proxy, Caddy)
- Process orchestration
- Environment variable handling

**Key Files:**

- `cli.ts` - Main entry point, argument parsing, process management
- `buildFbiProxy.ts` - Rust binary compilation and management
- `downloadCaddy.ts` - Caddy binary download and management

### Rust Layer (fbi-proxy.rs)

The Rust layer provides:

- High-performance HTTP/WebSocket proxy
- Domain parsing and routing logic
- Request forwarding with header manipulation

**Key Features:**

- Async/await with Tokio runtime
- Clap for command-line arguments
- HTTP proxy with hyper

## Building and Testing

### Build Commands

```bash
# Build everything
bun run build

# Build individual components
bun run build:ts    # TypeScript to dist/
bun run build:js    # Bundle for Node.js
bun run build:rs    # Rust to target/release/
```

### Testing Local Changes

```bash
# Test CLI directly
bun ts/cli.ts --help

# Test with hot reload
bun --hot ts/cli.ts --dev

# Test built version
node dist/cli.js --help
```

### Integration Testing

```bash
# Start FBI-Proxy
bun run start

# In another terminal, test routing
curl -H "Host: 3000.fbi.com" http://localhost:2432/
```

## Docker Development

### Building Docker Image

```bash
# Build the image
docker build -t fbi-proxy .

# Run the container
docker run -p 2432:2432 fbi-proxy
```

### Docker Compose Development

```bash
# Start all services
docker-compose up

# Start with rebuild
docker-compose up --build

# Background mode
docker-compose up -d
```

## Code Style and Linting

The project uses:

- **Prettier** for code formatting
- **Husky** for Git hooks
- **lint-staged** for pre-commit formatting

```bash
# Format code
bun run prettier --write .

# The pre-commit hook will automatically format staged files
git commit -m "Your commit message"
```

## Contributing

### Workflow

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/amazing-feature`
3. Make your changes
4. Run tests and ensure code quality
5. Commit with conventional commits: `git commit -m "feat: add amazing feature"`
6. Push to your fork: `git push origin feature/amazing-feature`
7. Create a Pull Request

### Commit Convention

Use conventional commits:

- `feat:` - New features
- `fix:` - Bug fixes
- `docs:` - Documentation changes
- `style:` - Code style changes
- `refactor:` - Code refactoring
- `test:` - Adding or updating tests
- `chore:` - Maintenance tasks

### Release Process

The project uses semantic-release for automated versioning:

- Commits to `main` trigger automatic releases
- Version numbers follow semantic versioning
- CHANGELOG.md is automatically updated

## Debugging

### Enable Debug Logging

```bash
# Debug TypeScript layer
DEBUG=fbi-proxy bun ts/cli.ts

# Debug Rust layer
RUST_LOG=debug ./target/release/fbi-proxy
```

### Common Debug Scenarios

1. **Port conflicts**: Check `FBIPROXY_PORT` in logs
2. **Routing issues**: Verify domain patterns in requests
3. **Binary issues**: Ensure Rust binary is built and executable
4. **Caddy issues**: Check Caddy logs and certificate status

## Performance

### Benchmarking

```bash
# Install wrk for HTTP benchmarking
# Ubuntu/Debian
apt install wrk

# macOS
brew install wrk

# Benchmark FBI-Proxy
wrk -t12 -c400 -d30s --header "Host: 3000.fbi.com" http://localhost:2432/
```

### Memory Profiling

```bash
# Profile Rust binary
cargo build --release
valgrind --tool=massif ./target/release/fbi-proxy

# Profile TypeScript with Node.js
node --inspect dist/cli.js
```
