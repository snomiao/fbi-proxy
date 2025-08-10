# API Reference

FBI-Proxy operates as a transparent HTTP/HTTPS proxy with intelligent routing. This document describes the internal APIs and configuration options.

## Command Line Interface

### fbi-proxy

Main command to start the FBI-Proxy server.

```bash
fbi-proxy [options]
```

#### Options

| Option        | Type    | Default     | Description                             |
| ------------- | ------- | ----------- | --------------------------------------- |
| `--fbihost`   | string  | `fbi.com`   | Set the FBI host domain for routing     |
| `--caddy`     | boolean | `false`     | Start Caddy server for HTTPS            |
| `--dev`, `-d` | boolean | `false`     | Run in development mode                 |
| `--host`      | string  | `localhost` | Server host address (Rust proxy)        |
| `--port`      | number  | `2432`      | Server port (auto-assigned if occupied) |
| `--help`      | boolean | `false`     | Show help information                   |
| `--version`   | boolean | `false`     | Show version information                |

#### Examples

```bash
# Basic usage
fbi-proxy

# Custom domain
fbi-proxy --fbihost dev.mycompany.com

# HTTPS with custom host
fbi-proxy --caddy --fbihost secure.local

# Development mode
fbi-proxy --dev --host 0.0.0.0
```

## Environment Variables

FBI-Proxy reads the following environment variables:

| Variable        | Default   | Description                                          |
| --------------- | --------- | ---------------------------------------------------- |
| `FBIHOST`       | `fbi.com` | Default FBI host domain                              |
| `FBIPROXY_PORT` | auto      | Internal proxy server port                           |
| `DEBUG`         | -         | Enable debug logging                                 |
| `RUST_LOG`      | -         | Rust logging level (trace, debug, info, warn, error) |

## Routing API

FBI-Proxy doesn't expose a traditional REST API, but instead uses intelligent domain-based routing.

### Routing Patterns

#### 1. Port-Based Routing

**Pattern**: `{port}.{fbihost}`

```http
GET https://3000.fbi.com/api/users
→ GET http://localhost:3000/api/users
```

#### 2. Host-Port Routing

**Pattern**: `{host}--{port}.{fbihost}`

```http
GET https://api--8080.fbi.com/v1/data
→ GET http://api:8080/v1/data
```

#### 3. Subdomain Routing

**Pattern**: `{subdomain}.{service}.{fbihost}`

```http
GET https://admin.dashboard.fbi.com/users
→ GET http://dashboard:80/users
   Host: admin
```

#### 4. Direct Host Routing

**Pattern**: `{hostname}.{fbihost}`

```http
GET https://backend.fbi.com/status
→ GET http://backend:80/status
```

### Headers

FBI-Proxy preserves all original headers and adds the following:

| Header              | Description                    |
| ------------------- | ------------------------------ |
| `X-Forwarded-For`   | Original client IP             |
| `X-Forwarded-Proto` | Original protocol (http/https) |
| `X-Forwarded-Host`  | Original host header           |
| `Host`              | Modified for subdomain routing |

## WebSocket API

FBI-Proxy fully supports WebSocket connections with the same routing patterns.

### WebSocket Routing

```javascript
// Port-based WebSocket routing
const ws1 = new WebSocket("wss://3000.fbi.com/socket");

// Host-port WebSocket routing
const ws2 = new WebSocket("wss://api--8080.fbi.com/ws");

// Subdomain WebSocket routing
const ws3 = new WebSocket("wss://live.app.fbi.com/updates");
```

### WebSocket Headers

WebSocket connections preserve:

- `Sec-WebSocket-Protocol`
- `Sec-WebSocket-Extensions`
- `Sec-WebSocket-Key`
- All custom headers

## Internal APIs

### Build API (TypeScript)

#### buildFbiProxy()

Builds the Rust proxy binary.

```typescript
import { buildFbiProxy } from "./buildFbiProxy";

const proxyPath = await buildFbiProxy();
console.log(`Proxy built at: ${proxyPath}`);
```

**Returns**: `Promise<string>` - Path to the built proxy binary

#### downloadCaddy()

Downloads the Caddy binary if not present.

```typescript
import { downloadCaddy } from "./downloadCaddy";

const caddyPath = await downloadCaddy();
console.log(`Caddy available at: ${caddyPath}`);
```

**Returns**: `Promise<string>` - Path to the Caddy binary

### Process Management

FBI-Proxy manages multiple processes:

1. **Rust Proxy Server**: Core HTTP/WebSocket proxy
2. **Caddy Server**: HTTPS termination and certificate management (optional)

#### Process Lifecycle

```typescript
// Process creation with environment
const process = $.opt({
  env: {
    FBIPROXY_PORT: "2432",
    FBIHOST: "fbi.com",
  },
})`./fbi-proxy`.process;

// Process monitoring
process.on("exit", (code) => {
  console.log(`Process exited with code ${code}`);
});
```

## Configuration Files

### Caddyfile

Default Caddy configuration:

```caddyfile
# Automatic HTTPS for all subdomains
*.{$FBIHOST} {
    reverse_proxy localhost:{$FBIPROXY_PORT}

    # Enable WebSocket support
    @websockets {
        header Connection *Upgrade*
        header Upgrade websocket
    }

    # Optional: Add security headers
    header {
        # Security headers
        Strict-Transport-Security "max-age=31536000; includeSubDomains"
        X-Frame-Options "DENY"
        X-Content-Type-Options "nosniff"
    }
}
```

### Docker Configuration

Environment variables for Docker:

```yaml
environment:
  - FBIHOST=fbi.com
  - FBIPROXY_PORT=2432
  - RUST_LOG=info
```

## Error Handling

FBI-Proxy provides detailed error responses:

### HTTP Error Responses

| Status Code | Description         | Response                   |
| ----------- | ------------------- | -------------------------- |
| 502         | Bad Gateway         | Target service unavailable |
| 503         | Service Unavailable | FBI-Proxy overloaded       |
| 504         | Gateway Timeout     | Target service timeout     |

### Error Response Format

```json
{
  "error": "Bad Gateway",
  "message": "Failed to connect to localhost:3000",
  "code": 502,
  "timestamp": "2024-01-01T12:00:00Z"
}
```

## Monitoring

### Health Check

FBI-Proxy responds to health check requests:

```http
GET /health
→ 200 OK
{
  "status": "healthy",
  "uptime": 3600,
  "version": "1.4.0"
}
```

### Metrics

Basic metrics available at:

```http
GET /metrics
→ 200 OK
{
  "requests_total": 1000,
  "active_connections": 25,
  "uptime_seconds": 3600
}
```

## Security

### HTTPS/TLS

When using `--caddy`:

- Automatic Let's Encrypt certificates
- HTTP to HTTPS redirects
- HSTS headers
- Perfect Forward Secrecy

### Request Validation

FBI-Proxy validates:

- Host header format
- URL structure
- HTTP method support
- WebSocket upgrade headers

### Rate Limiting

Basic rate limiting per IP:

- Default: 1000 requests per minute
- Configurable via environment variables

```bash
export RATE_LIMIT_RPM=500
fbi-proxy
```
