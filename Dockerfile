# Multi-stage Docker build for FBI Proxy
FROM rust:1.70-alpine AS builder

WORKDIR /app
COPY rs/ ./rs/
WORKDIR /app/rs

# Install build dependencies
RUN apk add --no-cache musl-dev

# Build the proxy
RUN cargo build --release --target x86_64-unknown-linux-musl

# Runtime stage
FROM node:18-alpine

# Install Caddy and Bun
RUN apk add --no-cache caddy curl bash
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:$PATH"

WORKDIR /app

# Copy the built proxy binary
COPY --from=builder /app/rs/target/x86_64-unknown-linux-musl/release/proxy /app/bin/proxy
RUN chmod +x /app/bin/proxy

# Copy application files
COPY package.json ./
COPY src/ ./src/
COPY Caddyfile ./

# Install dependencies
RUN npm install

EXPOSE 2432 80 443

CMD ["bun", "src/cli.ts"]