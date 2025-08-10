# Troubleshooting Guide

Common issues and solutions for FBI-Proxy.

## Installation Issues

### Command Not Found

**Error**: `fbi-proxy: command not found`

**Solutions**:

```bash
# Install globally
bun install -g fbi-proxy

# Or run directly
bunx fbi-proxy

# Verify PATH
echo $PATH
which fbi-proxy
```

### Bun/Node.js Issues

**Error**: `bun: command not found`

**Solutions**:

```bash
# Install Bun
curl -fsSL https://bun.sh/install | bash

# Or use Node.js alternative
npm install -g fbi-proxy
npx fbi-proxy
```

### Rust Compilation Errors

**Error**: `cargo: command not found` or compilation failures

**Solutions**:

```bash
# Install Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Update Rust toolchain
rustup update

# Check Rust version
rustc --version  # Should be 1.70.0+
```

## Runtime Issues

### Port Already in Use

**Error**: `Error: listen EADDRINUSE: address already in use :::2432`

**Solutions**:

```bash
# FBI-Proxy auto-assigns ports, check logs for actual port
bunx fbi-proxy  # Look for "Proxy server running on port XXXX"

# Or kill existing processes
lsof -ti:2432 | xargs kill -9

# Specify a different port
bunx fbi-proxy --port 2433
```

### Proxy Server Won't Start

**Error**: Various proxy startup errors

**Solutions**:

```bash
# Check if Rust binary exists and is executable
ls -la target/release/fbi-proxy
chmod +x target/release/fbi-proxy

# Rebuild the proxy
bun run build:rs

# Check system resources
free -h    # Check available memory
df -h      # Check disk space
```

### Permission Denied

**Error**: `Permission denied` when starting

**Solutions**:

```bash
# Check file permissions
ls -la $(which fbi-proxy)

# Fix permissions
chmod +x $(which fbi-proxy)

# On Linux, may need to allow binding to low ports
sudo setcap 'cap_net_bind_service=+ep' $(which fbi-proxy)
```

## Routing Issues

### Domain Not Resolving

**Problem**: `https://3000.fbi.com` doesn't work

**Solutions**:

```bash
# Add to /etc/hosts (Linux/macOS)
echo "127.0.0.1 3000.fbi.com" >> /etc/hosts
echo "127.0.0.1 *.fbi.com" >> /etc/hosts

# Windows: Edit C:\Windows\System32\drivers\etc\hosts
127.0.0.1 3000.fbi.com
127.0.0.1 api--8080.fbi.com

# Test DNS resolution
nslookup 3000.fbi.com
dig 3000.fbi.com
```

### Wrong Target Service

**Problem**: Requests go to the wrong service

**Debugging**:

```bash
# Check FBI-Proxy logs
bunx fbi-proxy --dev  # More verbose logging

# Test routing manually
curl -H "Host: 3000.fbi.com" http://localhost:2432/
curl -H "Host: api--8080.fbi.com" http://localhost:2432/

# Verify target services are running
netstat -tulpn | grep :3000
curl http://localhost:3000/
```

### WebSocket Connection Failures

**Problem**: WebSocket connections fail

**Solutions**:

```bash
# Test WebSocket connectivity
wscat -c ws://localhost:3000  # Test target directly
wscat -c ws://3000.fbi.com    # Test through FBI-Proxy

# Check for WebSocket upgrade headers
curl -H "Connection: Upgrade" \
     -H "Upgrade: websocket" \
     -H "Host: 3000.fbi.com" \
     http://localhost:2432/
```

## HTTPS/Caddy Issues

### Certificate Errors

**Error**: SSL certificate issues with `--caddy`

**Solutions**:

```bash
# Clear Caddy data directory
rm -rf ~/.local/share/caddy

# Restart with clean state
bunx fbi-proxy --caddy

# Check Caddy logs
caddy logs

# Test certificate manually
openssl s_client -connect 3000.fbi.com:443
```

### Caddy Won't Start

**Error**: Caddy binary issues

**Solutions**:

```bash
# Force re-download Caddy
rm -f ./caddy
bunx fbi-proxy --caddy

# Check Caddy binary
./caddy version
./caddy validate --config Caddyfile

# Check port 80/443 availability
sudo netstat -tulpn | grep :80
sudo netstat -tulpn | grep :443
```

### Let's Encrypt Rate Limits

**Error**: Certificate rate limit exceeded

**Solutions**:

```bash
# Use staging environment for testing
export CADDY_ACME_SERVER=https://acme-staging-v02.api.letsencrypt.org/directory
bunx fbi-proxy --caddy

# Or use local certificates for development
# Edit Caddyfile to use tls internal
*.fbi.com {
    tls internal
    reverse_proxy localhost:{$FBIPROXY_PORT}
}
```

## Docker Issues

### Container Won't Start

**Error**: Docker container startup failures

**Solutions**:

```bash
# Check Docker logs
docker logs fbi-proxy

# Run interactively for debugging
docker run -it --rm fbi-proxy /bin/sh

# Check port mapping
docker port fbi-proxy
netstat -tulpn | grep 2432
```

### Container Networking

**Problem**: Can't reach services from container

**Solutions**:

```bash
# Use host network mode
docker run --network host fbi-proxy

# Or use host.docker.internal (macOS/Windows)
# Modify service URLs to use host.docker.internal:3000

# Check Docker network connectivity
docker exec fbi-proxy ping host.docker.internal
docker exec fbi-proxy curl http://host.docker.internal:3000
```

## Performance Issues

### High Memory Usage

**Problem**: FBI-Proxy consuming too much memory

**Solutions**:

```bash
# Monitor memory usage
top -p $(pgrep fbi-proxy)
htop

# Check for memory leaks in Rust code
valgrind --tool=memcheck ./target/release/fbi-proxy

# Restart periodically if needed
systemctl restart fbi-proxy
```

### Slow Response Times

**Problem**: High latency through FBI-Proxy

**Debugging**:

```bash
# Compare direct vs proxy response times
time curl http://localhost:3000/
time curl -H "Host: 3000.fbi.com" http://localhost:2432/

# Check system load
uptime
iostat 1

# Profile the proxy
perf record -g ./target/release/fbi-proxy
perf report
```

## Development Issues

### Hot Reload Not Working

**Problem**: `--dev` mode not reloading changes

**Solutions**:

```bash
# Use separate terminals
# Terminal 1: Start Rust dev server
bun run dev:rs

# Terminal 2: Start TypeScript dev server
bun run dev:ts

# Or rebuild manually
bun run build && bun run start
```

### Build Failures

**Error**: Build scripts failing

**Solutions**:

```bash
# Clean build
rm -rf target/ dist/ node_modules/
bun install
bun run build

# Check individual build steps
bun run build:ts  # Should create dist/
bun run build:rs  # Should create target/release/
bun run build:js  # Should create bundled JS
```

## Logging and Debugging

### Enable Verbose Logging

```bash
# TypeScript layer debugging
DEBUG=fbi-proxy bunx fbi-proxy

# Rust layer debugging
RUST_LOG=debug bunx fbi-proxy

# Combined debugging
DEBUG=fbi-proxy RUST_LOG=debug bunx fbi-proxy --dev
```

### Common Log Messages

| Log Message                 | Meaning                 | Action                    |
| --------------------------- | ----------------------- | ------------------------- |
| `Port 2432 already in use`  | Port conflict           | Use different port        |
| `Failed to build proxy`     | Rust compilation failed | Check Rust installation   |
| `Caddy binary not found`    | Caddy download failed   | Check network/permissions |
| `Target connection refused` | Service not running     | Start target service      |

## Getting Help

If you're still having issues:

1. **Check the logs**: Enable verbose logging as shown above
2. **Search issues**: Check [GitHub Issues](https://github.com/snomiao/fbi-proxy/issues)
3. **Create an issue**: Include:
   - Operating system and version
   - FBI-Proxy version
   - Complete error messages
   - Steps to reproduce
   - Relevant configuration

### Diagnostic Information

Include this information when reporting issues:

```bash
# System information
uname -a
bun --version
rustc --version
docker --version

# FBI-Proxy information
fbi-proxy --version
cat package.json | grep version

# Network information
netstat -tulpn | grep 2432
ss -tulpn | grep 2432

# Process information
ps aux | grep fbi-proxy
```
