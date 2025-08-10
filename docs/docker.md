# Docker Deployment

FBI-Proxy provides ready-to-use Docker containers for easy deployment.

## Quick Start

### Using Docker Run

```bash
# Basic usage
docker run -p 2432:2432 snomiao/fbi-proxy

# With custom configuration
docker run -p 2432:2432 \
  -e FBIHOST=mycompany.local \
  snomiao/fbi-proxy

# With volume mounts for persistent data
docker run -p 2432:2432 \
  -v /host/caddy/data:/root/.local/share/caddy \
  snomiao/fbi-proxy
```

### Using Docker Compose

Create a `docker-compose.yml` file:

```yaml
version: "3.8"

services:
  fbi-proxy:
    image: snomiao/fbi-proxy
    ports:
      - "2432:2432"
    environment:
      - FBIHOST=fbi.com
      - FBIPROXY_PORT=2432
    volumes:
      - caddy_data:/root/.local/share/caddy
    restart: unless-stopped

volumes:
  caddy_data:
```

Run with:

```bash
docker-compose up -d
```

## Configuration

### Environment Variables

| Variable        | Default   | Description                |
| --------------- | --------- | -------------------------- |
| `FBIHOST`       | `fbi.com` | Primary domain for routing |
| `FBIPROXY_PORT` | `2432`    | Internal proxy port        |

### Port Mapping

- **Container Port**: `2432` (FBI-Proxy server)
- **Host Port**: Map to any available port

## Advanced Deployment

### With Custom Domain

```yaml
version: "3.8"

services:
  fbi-proxy:
    image: snomiao/fbi-proxy
    ports:
      - "2432:2432"
    environment:
      - FBIHOST=dev.mycompany.com
    command: ["--caddy"] # Enable HTTPS with Caddy
```

### Behind Reverse Proxy

If you're running FBI-Proxy behind another reverse proxy (nginx, Apache, etc.):

```yaml
version: "3.8"

services:
  fbi-proxy:
    image: snomiao/fbi-proxy
    expose:
      - "2432"
    environment:
      - FBIHOST=internal.dev
    networks:
      - internal

  nginx:
    image: nginx:alpine
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./nginx.conf:/etc/nginx/nginx.conf
    networks:
      - internal
    depends_on:
      - fbi-proxy

networks:
  internal:
    driver: bridge
```

### Multi-Service Development Stack

Complete development environment with FBI-Proxy:

```yaml
version: "3.8"

services:
  # FBI-Proxy for routing
  fbi-proxy:
    image: snomiao/fbi-proxy
    ports:
      - "2432:2432"
    environment:
      - FBIHOST=dev.local
    command: ["--caddy"]
    volumes:
      - caddy_data:/root/.local/share/caddy

  # Frontend application
  frontend:
    image: node:18-alpine
    working_dir: /app
    volumes:
      - ./frontend:/app
    command: npm run dev
    ports:
      - "3000:3000"

  # Backend API
  backend:
    image: node:18-alpine
    working_dir: /app
    volumes:
      - ./backend:/app
    command: npm run dev
    ports:
      - "8080:8080"
    environment:
      - DATABASE_URL=postgres://user:pass@postgres:5432/mydb

  # Database
  postgres:
    image: postgres:15
    environment:
      - POSTGRES_USER=user
      - POSTGRES_PASSWORD=pass
      - POSTGRES_DB=mydb
    ports:
      - "5432:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data

volumes:
  caddy_data:
  postgres_data:
```

Access your services:

- Frontend: `https://3000.dev.local`
- Backend: `https://8080.dev.local`
- Database: `https://postgres--5432.dev.local`

## Building Custom Images

### Custom Dockerfile

```dockerfile
FROM snomiao/fbi-proxy

# Add custom configuration
COPY custom-caddyfile /etc/caddy/Caddyfile

# Add custom environment
ENV FBIHOST=mycompany.dev
ENV CUSTOM_CONFIG=value

# Optional: Add custom scripts
COPY scripts/ /usr/local/bin/
RUN chmod +x /usr/local/bin/*.sh

# Override default command if needed
CMD ["--caddy", "--fbihost", "mycompany.dev"]
```

### Build and Run

```bash
# Build custom image
docker build -t my-fbi-proxy .

# Run custom image
docker run -p 2432:2432 my-fbi-proxy
```

## Health Checks

Add health checks to ensure FBI-Proxy is running correctly:

```yaml
version: "3.8"

services:
  fbi-proxy:
    image: snomiao/fbi-proxy
    ports:
      - "2432:2432"
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:2432/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 40s
    restart: unless-stopped
```

## Logging

### View Logs

```bash
# View container logs
docker logs fbi-proxy

# Follow logs in real-time
docker logs -f fbi-proxy

# With docker-compose
docker-compose logs fbi-proxy
docker-compose logs -f fbi-proxy
```

### Log Configuration

```yaml
version: "3.8"

services:
  fbi-proxy:
    image: snomiao/fbi-proxy
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "3"
```

## Scaling and Load Balancing

### Multiple FBI-Proxy Instances

```yaml
version: "3.8"

services:
  fbi-proxy:
    image: snomiao/fbi-proxy
    deploy:
      replicas: 3
    ports:
      - "2432-2434:2432"
    environment:
      - FBIHOST=fbi.com

  # Load balancer (optional)
  nginx:
    image: nginx:alpine
    ports:
      - "80:80"
    volumes:
      - ./nginx-lb.conf:/etc/nginx/nginx.conf
    depends_on:
      - fbi-proxy
```

## Security

### Running as Non-Root User

```dockerfile
FROM snomiao/fbi-proxy

# Create non-root user
RUN adduser -D -s /bin/sh fbiuser
USER fbiuser

# Ensure proper permissions
RUN chown -R fbiuser:fbiuser /app
```

### Network Security

```yaml
version: "3.8"

services:
  fbi-proxy:
    image: snomiao/fbi-proxy
    networks:
      - fbi_network
    ports:
      - "127.0.0.1:2432:2432" # Bind to localhost only

networks:
  fbi_network:
    driver: bridge
    internal: true # No external access except through ports
```

## Troubleshooting

### Common Issues

1. **Container won't start**

   ```bash
   # Check logs
   docker logs fbi-proxy

   # Check port conflicts
   netstat -tulpn | grep 2432
   ```

2. **Routing not working**

   ```bash
   # Test internal connectivity
   docker exec fbi-proxy curl -H "Host: 3000.fbi.com" http://localhost:2432/
   ```

3. **SSL/HTTPS issues**
   ```bash
   # Clear Caddy data
   docker volume rm $(docker volume ls -q | grep caddy)
   docker-compose up --force-recreate
   ```

### Debug Mode

Run container in debug mode:

```bash
docker run -it --rm \
  -p 2432:2432 \
  -e DEBUG=true \
  snomiao/fbi-proxy \
  --dev
```
