# FBI Proxy - Installation Guide

FBI Proxy now supports multiple installation methods, **no Rust installation required**!

## 🚀 Quick Install (Recommended)

```bash
npm install
npm start
```

The proxy binary will be automatically downloaded during installation.

## 📦 Installation Methods

### Method 1: Auto-Download (Default)

- **No Rust required** ✅
- Pre-built binaries downloaded automatically
- Supports Windows, macOS, and Linux (x64 + ARM64)

```bash
npm install          # Downloads proxy binary automatically
npm start           # Starts the proxy system
```

### Method 2: Build from Source (Optional)

If you have Rust installed and want to build from source:

```bash
npm run build-proxy    # Builds from Rust source
npm start              # Starts the proxy system
```

### Method 3: Docker (Containerized)

For containerized deployment:

```bash
docker build -t fbi-proxy .
docker run -p 24306:24306 -p 80:80 -p 443:443 fbi-proxy
```

## 📋 Available Scripts

| Script                | Description                      | Requires Rust |
| --------------------- | -------------------------------- | ------------- |
| `npm install`         | Auto-setup (download or build)   | ❌ No         |
| `npm start`           | Start the proxy system           | ❌ No         |
| `npm run dev`         | Development mode with hot reload | ❌ No         |
| `npm run build-proxy` | Build/download proxy binary      | ❌ No         |
| `npm run clean-proxy` | Clean built files                | ❌ No         |

## 🔧 Advanced Scripts (Rust Required)

| Script                           | Description       |
| -------------------------------- | ----------------- |
| `cd rs && cargo build --release` | Manual Rust build |
| `cd rs && cargo test`            | Run Rust tests    |
| `cd rs && cargo fmt`             | Format Rust code  |

## 🏗️ Build Strategy

The build system automatically:

1. **First**: Tries to download pre-built binary from GitHub releases
2. **Fallback**: If Rust is installed, builds from source
3. **Manual**: Provides instructions if both fail

## 🌐 Platform Support

| Platform | Architecture | Binary Name             | Status |
| -------- | ------------ | ----------------------- | ------ |
| Windows  | x64          | `proxy-windows-x64.exe` | ✅     |
| macOS    | x64          | `proxy-macos-x64`       | ✅     |
| macOS    | ARM64        | `proxy-macos-arm64`     | ✅     |
| Linux    | x64          | `proxy-linux-x64`       | ✅     |
| Linux    | ARM64        | `proxy-linux-arm64`     | ✅     |

## 🐳 Docker Usage

```bash
# Build Docker image
docker build -t fbi-proxy .

# Run container
docker run -d \
  --name fbi-proxy \
  -p 24306:24306 \
  -p 80:80 \
  -p 443:443 \
  -v $(pwd)/Caddyfile:/app/Caddyfile \
  fbi-proxy

# View logs
docker logs -f fbi-proxy
```

## 🔍 Troubleshooting

### Binary Not Found

```bash
npm run build-proxy  # Try rebuilding/downloading
```

### All Build Methods Failed

1. Install Rust: https://rustup.rs/
2. Build manually:
   ```bash
   cd rs
   cargo build --release
   cp target/release/proxy* ../bin/
   ```

### Docker Issues

```bash
# Clean build
docker build --no-cache -t fbi-proxy .

# Check container logs
docker logs fbi-proxy
```

## 🎯 Benefits

- ✅ **No Rust Installation Required** for end users
- ✅ **Cross-Platform Support** (Windows, macOS, Linux)
- ✅ **Multiple Architectures** (x64, ARM64)
- ✅ **Automatic Updates** via GitHub releases
- ✅ **Fallback to Source Build** when needed
- ✅ **Docker Support** for containerized deployment

## 🚦 Quick Start Examples

### Development

```bash
git clone <repo>
cd fbi-proxy
npm install     # Auto-downloads proxy binary
npm run dev     # Start with hot reload
```

### Production

```bash
npm install
npm start
```

### Docker Production

```bash
docker-compose up -d
```

The proxy will automatically handle port encoding (`domain--3000` → `domain:3000`) and forward requests to your local services!
