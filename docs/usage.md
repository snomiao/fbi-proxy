# Usage & Configuration

## Basic Usage

### Starting FBI-Proxy

```bash
# Basic startup
bunx fbi-proxy

# With custom host and port
bunx fbi-proxy --host 0.0.0.0 --port 2432

# With Caddy for HTTPS
bunx fbi-proxy --caddy

# Development mode
bunx fbi-proxy --dev
```

### Command Line Options

| Option         | Default     | Description                             |
| -------------- | ----------- | --------------------------------------- |
| `--fbihost`    | `fbi.com`   | Set the FBI host domain                 |
| `--caddy`      | `false`     | Start Caddy server for HTTPS            |
| `--dev` / `-d` | `false`     | Run in development mode                 |
| `--host`       | `localhost` | Server host address                     |
| `--port`       | `2432`      | Server port (auto-assigned if occupied) |

## Routing Patterns

FBI-Proxy uses intelligent domain routing to forward requests to your local services.

### 1. Port Forwarding

The simplest pattern - route based on port number:

```
https://3000.fbi.com → localhost:3000
https://8080.fbi.com → localhost:8080
https://5173.fbi.com → localhost:5173
```

**Use case**: Perfect for local development servers.

### 2. Host-Port Forwarding

Route to different hosts with specific ports:

```
https://api--3001.fbi.com → api:3001
https://database--5432.fbi.com → database:5432
https://redis--6379.fbi.com → redis:6379
```

**Use case**: Docker containers or network services.

### 3. Subdomain Routing

Advanced routing with Host header manipulation:

```
https://admin.app.fbi.com → app:80 (Host: admin)
https://v2.api.fbi.com → api:80 (Host: v2)
https://staging.web.fbi.com → web:80 (Host: staging)
```

**Use case**: Multi-tenant applications or API versioning.

### 4. Direct Host Forwarding

Simple host-to-host forwarding:

```
https://myserver.fbi.com → myserver:80
https://backend.fbi.com → backend:80
```

**Use case**: Internal network services.

## Configuration

### Environment Variables

FBI-Proxy reads the following environment variables:

- `FBIPROXY_PORT`: Internal proxy port (auto-assigned)
- `FBIHOST`: Default FBI host domain

### Caddy Configuration

When using `--caddy`, FBI-Proxy uses the included `Caddyfile`:

```caddyfile
# Automatic HTTPS for *.fbi.com
*.{$FBIHOST} {
    reverse_proxy localhost:{$FBIPROXY_PORT}
}
```

## WebSocket Support

FBI-Proxy fully supports WebSocket connections for all routing patterns:

```javascript
// WebSocket connection through FBI-Proxy
const ws = new WebSocket("wss://3000.fbi.com/socket");
```

## Examples

### Local Development Setup

```bash
# Start your development servers
npm run dev          # React app on :3000
npm run api         # API server on :8080
npm run db          # Database on :5432

# Start FBI-Proxy with HTTPS
bunx fbi-proxy --caddy

# Access your services
# https://3000.fbi.com  → React app
# https://8080.fbi.com  → API server
```

### Docker Compose Integration

```yaml
version: "3.8"
services:
  fbi-proxy:
    image: snomiao/fbi-proxy
    ports:
      - "2432:2432"
    environment:
      - FBIHOST=fbi.com

  app:
    image: my-app
    ports:
      - "3000:3000"

  api:
    image: my-api
    ports:
      - "8080:8080"
```

## Troubleshooting

### Common Issues

1. **Port Already in Use**

   ```bash
   # FBI-Proxy will auto-assign another port
   bunx fbi-proxy  # Check logs for actual port
   ```

2. **DNS Resolution**

   ```bash
   # Add to /etc/hosts for local testing
   echo "127.0.0.1 *.fbi.com" >> /etc/hosts
   ```

3. **HTTPS Certificate Issues**
   ```bash
   # Clear Caddy data and restart
   rm -rf ~/.local/share/caddy
   bunx fbi-proxy --caddy
   ```

For more troubleshooting, see [Troubleshooting Guide](troubleshooting.md).
