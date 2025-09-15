# Multi-stage Docker build for FBI Proxy with optimized caching

# Stage 1: Chef planner - prepares the dependency list
FROM rust:alpine AS chef
RUN apk add --no-cache musl-dev
RUN cargo install cargo-chef
WORKDIR /app

# Stage 2: Planner - generates recipe.json for dependencies
FROM chef AS planner
COPY Cargo.toml Cargo.lock ./
COPY rs/ ./rs/
# Copy .cargo config if it exists
COPY .cargo/ ./.cargo/
RUN cargo chef prepare --recipe-path recipe.json

# Stage 3: Builder - caches dependencies and builds the application
FROM chef AS builder

# Copy the recipe and build dependencies (cached unless Cargo.toml/lock changes)
COPY --from=planner /app/recipe.json recipe.json
RUN cargo chef cook --release --target x86_64-unknown-linux-musl --recipe-path recipe.json

# Now copy source code and build the actual application
COPY rs/ ./rs/
COPY .cargo/ ./.cargo/
COPY Cargo.toml ./
# Don't copy Cargo.lock again, use the one from chef cook
# This prevents potential mismatches

# Build with cache mount for better caching
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/app/target \
    cargo build --release --target x86_64-unknown-linux-musl && \
    cp /app/target/x86_64-unknown-linux-musl/release/fbi-proxy /app/fbi-proxy



# LEGACY
# Runtime stage
# FROM node:22-alpine
# FROM oven/bun:alpine

# # Install Caddy and Bun
# RUN apk add --no-cache caddy curl bash
# RUN curl -fsSL https://bun.sh/install | bash
# ENV PATH="/root/.bun/bin:$PATH"

# WORKDIR /app

# # Copy the built proxy binary
# COPY --from=builder /app/fbi-proxy /app/bin/fbi-proxy
# RUN chmod +x /app/bin/fbi-proxy

# # Copy application files
# COPY package.json ./
# COPY ts/ ./ts/
# COPY Caddyfile ./

# # Install dependencies
# RUN bun install

# EXPOSE 2432 80 443

# # Set default log level for Rust applications
# ENV RUST_LOG=info

# CMD ["bun", "ts/cli.ts"]


# Runtime stage - minimal Alpine image for the Rust binary
FROM alpine

# Install runtime dependencies
RUN apk add --no-cache ca-certificates

WORKDIR /app

# Copy the statically linked binary from builder
COPY --from=builder /app/fbi-proxy /usr/local/bin/fbi-proxy

# Create a non-root user to run the application
RUN adduser -D -u 1000 fbiproxy
USER fbiproxy

# Set default environment variables
ENV RUST_LOG=info
ENV FBI_PROXY_PORT=2432

# Expose the port
EXPOSE $FBI_PROXY_PORT

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD nc -z localhost $FBI_PROXY_PORT || exit 1

# Run the FBI proxy
# ENTRYPOINT ["/usr/local/bin/fbi-proxy"]
ENTRYPOINT ["fbi-proxy"]
