# FBI-Proxy Documentation

FBI-Proxy provides easy HTTPS access to your local services with intelligent domain routing.

## Quick Start

```bash
# Install and run
bunx fbi-proxy

# Expose to LAN
bunx fbi-proxy --host 0.0.0.0 --port=2432

# With Caddy for HTTPS
bunx fbi-proxy --caddy
```

## Features

- **Smart Domain Routing**: Automatically route requests based on subdomain patterns
- **HTTPS Support**: Built-in SSL/TLS with Caddy integration
- **WebSocket Support**: Full WebSocket proxy capabilities
- **Docker Support**: Ready-to-use Docker containers
- **Zero Configuration**: Works out of the box with sensible defaults

## Routing Patterns

FBI-Proxy supports multiple routing patterns:

### Port Forwarding

```
https://3000.fbi.com → localhost:3000
https://8080.fbi.com → localhost:8080
```

### Host-Port Forwarding

```
https://api--3001.fbi.com → api:3001
https://db--5432.fbi.com → db:5432
```

### Subdomain Routing

```
https://admin.app.fbi.com → app:80 (Host: admin)
https://v2.api.fbi.com → api:80 (Host: v2)
```

### Direct Host Forwarding

```
https://myserver.fbi.com → myserver:80
```

## Documentation

- [Installation Guide](installation.md)
- [Usage & Configuration](usage.md)
- [Development Setup](development.md)
- [Docker Deployment](docker.md)
- [API Reference](api.md)
- [Troubleshooting](troubleshooting.md)

## License

MIT License - see [LICENSE](../LICENSE) file for details.
