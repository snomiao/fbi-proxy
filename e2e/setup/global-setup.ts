import { spawn, type ChildProcess } from "child_process";
import getPort from "get-port";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let proxyProcess: ChildProcess | null = null;
let mockServerProcess: ChildProcess | null = null;

export async function setup() {
  console.log("Setting up E2E test environment...");

  // Clear FBI Proxy environment variables to avoid interference with tests
  delete process.env.FBI_PROXY_DOMAIN;
  delete process.env.FBI_PROXY_HOST;
  delete process.env.FBI_PROXY_PORT;

  // Get available ports, avoid common test ports
  const proxyPort = await getPort({ port: 4000 });
  const mockServerPort = await getPort({ port: 5000 });

  // Store ports in global scope for tests
  globalThis.__TEST_PROXY_PORT__ = proxyPort;
  globalThis.__TEST_MOCK_SERVER_PORT__ = mockServerPort;

  // Start mock HTTP server for testing
  console.log(`Starting mock server on port ${mockServerPort}...`);
  mockServerProcess = spawn("node", [
    "-e", `
    const http = require('http');
    const server = http.createServer((req, res) => {
      const body = JSON.stringify({
        method: req.method,
        url: req.url,
        headers: req.headers,
        timestamp: Date.now()
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(body);
    });
    server.listen(${mockServerPort}, () => {
      console.log('Mock server listening on port ${mockServerPort}');
    });
    `
  ], {
    stdio: 'pipe'
  });

  // Wait a bit for mock server to start
  await new Promise(resolve => setTimeout(resolve, 1000));

  // Start the proxy server using the Rust binary
  console.log(`Starting proxy server on port ${proxyPort}...`);
  const projectRoot = path.resolve(__dirname, "../..");

  // Use the pre-built release binary to avoid compilation time
  const binaryPath = path.join(projectRoot, "target/release/fbi-proxy");

  proxyProcess = spawn(binaryPath, ["-p", proxyPort.toString(), "-h", "127.0.0.1"], {
    cwd: projectRoot,
    stdio: 'pipe',
    env: {
      ...process.env,
      RUST_LOG: "error", // Reduce log noise
      FBI_PROXY_DOMAIN: "" // Clear domain filter for tests
    }
  });

  // Wait for proxy to start (longer timeout)
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Proxy server failed to start within timeout"));
    }, 15000);

    proxyProcess!.stdout!.on('data', (data) => {
      const output = data.toString();
      if (output.includes('FBI Proxy listening on')) {
        clearTimeout(timeout);
        resolve(void 0);
      }
    });

    proxyProcess!.stderr!.on('data', (data) => {
      console.error('Proxy stderr:', data.toString());
    });

    proxyProcess!.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });

  console.log("E2E test environment ready!");
}

export async function teardown() {
  console.log("Tearing down E2E test environment...");

  if (proxyProcess) {
    proxyProcess.kill('SIGTERM');
    proxyProcess = null;
  }

  if (mockServerProcess) {
    mockServerProcess.kill('SIGTERM');
    mockServerProcess = null;
  }

  console.log("E2E test environment cleaned up!");
}