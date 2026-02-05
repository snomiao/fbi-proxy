# E2E Tests for FBI Proxy

This directory contains end-to-end tests for both the Rust and TypeScript implementations of FBI Proxy using Vitest.

## Test Structure

### Test Files

- **`proxy-core.test.ts`** - Tests core proxy functionality including:
  - Rule 1: Number host to local port routing (`3000` → `localhost:3000`)
  - Rule 1.2: Host--port syntax (`localhost--3000` → `localhost:3000`)
  - Rule 2: Default host routing (`localhost` → `localhost:80`)
  - Rule 3: Subdomain hoisting (`api.service` → `service:80`)
  - HTTP methods support (GET, POST, PUT, DELETE, PATCH)
  - Header preservation and processing
  - Error handling for unreachable hosts

- **`domain-filtering.test.ts`** - Tests domain filtering functionality:
  - Acceptance of requests matching domain filter
  - Rejection of requests not matching domain filter
  - Edge cases (ports, subdomains, malformed hosts)

- **`implementation-comparison.test.ts`** - Compares Rust vs TypeScript implementations:
  - Core routing compatibility
  - HTTP method support consistency
  - Error handling consistency
  - Performance characteristics
  - Header handling consistency

- **`websocket.test.ts`** - Tests WebSocket functionality:
  - WebSocket connection establishment through proxy
  - Bidirectional message forwarding
  - Multiple concurrent connections
  - Error handling for failed connections
  - Different host pattern support

### Helper Files

- **`helpers/proxy-client.ts`** - Test client for making HTTP requests through the proxy
- **`helpers/test-server.ts`** - Manager for creating and controlling test HTTP servers
- **`setup/global-setup.ts`** - Global test environment setup
- **`setup/global-teardown.ts`** - Global test environment cleanup
- **`types.d.ts`** - TypeScript type definitions for global test variables

## Running Tests

### Prerequisites

1. Make sure you have both Rust and Node.js/Bun installed
2. Install dependencies: `bun install`
3. Build the Rust binary: `cargo build --release`

### Test Commands

```bash
# Run all E2E tests once
bun run test:e2e

# Run E2E tests in watch mode
bun run test:e2e:watch

# Run all tests (including E2E)
bun run test

# Run tests with UI
bun run test:ui

# Run tests with coverage
bun run test:coverage
```

## Test Environment

The tests automatically:

1. **Start a Rust proxy server** on a random available port
2. **Start test HTTP servers** on ports 3000, 8080, and others as needed
3. **Start a WebSocket test server** on port 3001 for WebSocket tests
4. **Create domain-filtered proxy instances** for domain filtering tests
5. **Start TypeScript proxy server** for implementation comparison tests

All servers are automatically cleaned up after tests complete.

## Test Coverage

The tests cover:

### Core Functionality
- ✅ All host parsing rules (numeric, host--port, subdomain hoisting)
- ✅ HTTP method support (GET, POST, PUT, DELETE, PATCH)
- ✅ Header preservation and modification
- ✅ Error handling for unreachable targets
- ✅ Content handling (JSON, large bodies)

### Advanced Features
- ✅ Domain filtering (acceptance and rejection)
- ✅ WebSocket proxying and message forwarding
- ✅ Multiple concurrent connections
- ✅ Performance under load

### Implementation Compatibility
- ✅ Rust vs TypeScript routing consistency
- ✅ Error handling parity
- ✅ Header processing compatibility
- ✅ Performance characteristics comparison

## Architecture

The test suite uses:

- **Vitest** as the test runner for its speed and modern features
- **Global setup/teardown** to manage proxy and test servers
- **Helper classes** to abstract common testing patterns
- **Concurrent test execution** for faster test runs
- **Automatic port allocation** to avoid conflicts
- **Process cleanup** to ensure clean test environments

## Writing New Tests

When adding new tests:

1. Use the `ProxyTestClient` helper for HTTP requests
2. Use the `TestServerManager` for creating mock servers
3. Follow the existing pattern of beforeAll/afterAll for setup
4. Test both success and error cases
5. Consider testing both Rust and TypeScript implementations for compatibility

Example:

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ProxyTestClient } from "./helpers/proxy-client";

describe("My New Feature", () => {
  let client: ProxyTestClient;

  beforeAll(() => {
    client = new ProxyTestClient();
  });

  it("should handle my feature", async () => {
    const response = await client.makeRequest({
      host: "3000",
      path: "/my-feature"
    });

    expect(response.status).toBe(200);
  });
});
```