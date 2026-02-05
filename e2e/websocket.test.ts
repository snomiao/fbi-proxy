import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "child_process";
import getPort from "get-port";
import WebSocket from "ws";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe("WebSocket Functionality", () => {
  let proxyProcess: ChildProcess | null = null;
  let wsServerProcess: ChildProcess | null = null;
  let proxyPort: number;
  let wsServerPort: number;

  beforeAll(async () => {
    proxyPort = await getPort();
    wsServerPort = await getPort({ port: 7000 }); // Dynamic port for WebSocket server

    // Start WebSocket test server
    console.log(`Starting WebSocket server on port ${wsServerPort}...`);
    wsServerProcess = spawn("node", [
      "-e", `
      const WebSocket = require('ws');
      const wss = new WebSocket.Server({ port: ${wsServerPort} });

      wss.on('connection', (ws, req) => {
        console.log('WebSocket connection established');

        ws.on('message', (message) => {
          const data = JSON.parse(message.toString());
          const response = {
            type: 'echo',
            original: data,
            timestamp: Date.now(),
            headers: req.headers
          };
          ws.send(JSON.stringify(response));
        });

        ws.on('close', () => {
          console.log('WebSocket connection closed');
        });

        // Send welcome message
        ws.send(JSON.stringify({
          type: 'welcome',
          message: 'WebSocket server connected',
          timestamp: Date.now()
        }));
      });

      console.log('WebSocket server listening on port ${wsServerPort}');
      `
    ], {
      stdio: 'pipe'
    });

    // Wait for WebSocket server to start
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("WebSocket server failed to start"));
      }, 5000);

      wsServerProcess!.stdout!.on('data', (data) => {
        if (data.toString().includes(`WebSocket server listening on port ${wsServerPort}`)) {
          clearTimeout(timeout);
          resolve(void 0);
        }
      });

      wsServerProcess!.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });

    // Start proxy server
    console.log(`Starting proxy server on port ${proxyPort}...`);
    const projectRoot = path.resolve(__dirname, "..");
    const binaryPath = path.join(projectRoot, "target/release/fbi-proxy");

    proxyProcess = spawn(binaryPath, [
      "-p", proxyPort.toString(),
      "-h", "127.0.0.1"
    ], {
      stdio: 'pipe',
      env: {
        ...process.env,
        RUST_LOG: "error"
      }
    });

    // Wait for proxy to start
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Proxy server failed to start"));
      }, 10000);

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
  });

  afterAll(async () => {
    if (proxyProcess) {
      proxyProcess.kill('SIGTERM');
    }
    if (wsServerProcess) {
      wsServerProcess.kill('SIGTERM');
    }
  });

  async function createWebSocketConnection(host: string, path: string = "/"): Promise<WebSocket> {
    const wsUrl = `ws://127.0.0.1:${proxyPort}${path}`;

    const ws = new WebSocket(wsUrl, {
      headers: {
        Host: host
      }
    });

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("WebSocket connection timeout"));
      }, 5000);

      ws.on('open', () => {
        clearTimeout(timeout);
        resolve(ws);
      });

      ws.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  describe("WebSocket proxying", () => {
    it("should establish WebSocket connection through proxy", async () => {
      const ws = await createWebSocketConnection(wsServerPort.toString());

      const welcomeMessage = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error("Welcome message timeout"));
        }, 3000);

        ws.on('message', (data) => {
          clearTimeout(timeout);
          resolve(JSON.parse(data.toString()));
        });
      });

      expect(welcomeMessage).toMatchObject({
        type: 'welcome',
        message: 'WebSocket server connected'
      });

      ws.close();
    });

    it("should forward WebSocket messages bidirectionally", async () => {
      const ws = await createWebSocketConnection(wsServerPort.toString());

      // Skip welcome message
      await new Promise(resolve => {
        ws.on('message', resolve);
      });

      const testMessage = {
        type: 'test',
        data: 'Hello WebSocket!',
        timestamp: Date.now()
      };

      ws.send(JSON.stringify(testMessage));

      const response = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error("Echo response timeout"));
        }, 3000);

        ws.on('message', (data) => {
          clearTimeout(timeout);
          resolve(JSON.parse(data.toString()));
        });
      });

      expect(response).toMatchObject({
        type: 'echo',
        original: testMessage
      });

      ws.close();
    });

    it("should handle multiple WebSocket connections", async () => {
      const connections = await Promise.all([
        createWebSocketConnection(wsServerPort.toString(), "/client1"),
        createWebSocketConnection(wsServerPort.toString(), "/client2"),
        createWebSocketConnection(wsServerPort.toString(), "/client3")
      ]);

      // Skip welcome messages
      await Promise.all(connections.map(ws =>
        new Promise(resolve => ws.on('message', resolve))
      ));

      const messages = connections.map((_, i) => ({
        type: 'test',
        client: `client${i + 1}`,
        data: `Message from client ${i + 1}`
      }));

      // Send messages from each client
      connections.forEach((ws, i) => {
        ws.send(JSON.stringify(messages[i]));
      });

      // Receive responses
      const responses = await Promise.all(connections.map(ws =>
        new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            reject(new Error("Response timeout"));
          }, 3000);

          ws.on('message', (data) => {
            clearTimeout(timeout);
            resolve(JSON.parse(data.toString()));
          });
        })
      ));

      // Verify each response matches its original message
      responses.forEach((response, i) => {
        expect(response).toMatchObject({
          type: 'echo',
          original: messages[i]
        });
      });

      // Close all connections
      connections.forEach(ws => ws.close());
    });

    it("should handle WebSocket connection errors gracefully", async () => {
      // Try to connect to non-existent WebSocket server
      const wsUrl = `ws://127.0.0.1:${proxyPort}/nonexistent`;

      await expect(async () => {
        const ws = new WebSocket(wsUrl, {
          headers: {
            Host: "9999" // Non-existent port
          }
        });

        await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            reject(new Error("Connection should have failed"));
          }, 3000);

          ws.on('open', () => {
            clearTimeout(timeout);
            reject(new Error("Connection should not have succeeded"));
          });

          ws.on('error', (err) => {
            clearTimeout(timeout);
            resolve(err);
          });

          ws.on('close', (code) => {
            clearTimeout(timeout);
            if (code !== 1000) { // Not normal closure
              resolve(new Error(`Connection closed with code ${code}`));
            } else {
              reject(new Error("Connection closed normally when it should have failed"));
            }
          });
        });
      }).rejects.toThrow();
    });

    it("should handle rapid WebSocket message exchange", async () => {
      const ws = await createWebSocketConnection(wsServerPort.toString());

      // Skip welcome message
      await new Promise(resolve => {
        ws.on('message', resolve);
      });

      const messageCount = 10;
      const sentMessages = [];

      // Send multiple messages rapidly
      for (let i = 0; i < messageCount; i++) {
        const message = {
          type: 'rapid-test',
          sequence: i,
          data: `Rapid message ${i}`
        };
        sentMessages.push(message);
        ws.send(JSON.stringify(message));
      }

      // Collect all responses
      const responses = [];
      for (let i = 0; i < messageCount; i++) {
        const response = await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            reject(new Error(`Timeout waiting for response ${i}`));
          }, 3000);

          ws.on('message', (data) => {
            clearTimeout(timeout);
            resolve(JSON.parse(data.toString()));
          });
        });
        responses.push(response);
      }

      // Verify all messages were echoed correctly
      expect(responses).toHaveLength(messageCount);
      responses.forEach((response, i) => {
        expect(response).toMatchObject({
          type: 'echo',
          original: sentMessages[i]
        });
      });

      ws.close();
    });
  });

  describe("WebSocket with different host patterns", () => {
    it("should handle numeric host WebSocket connections", async () => {
      const ws = await createWebSocketConnection(wsServerPort.toString());

      // Skip welcome message and test basic functionality
      await new Promise(resolve => {
        ws.on('message', resolve);
      });

      const testMessage = { type: 'numeric-host-test', data: 'test' };
      ws.send(JSON.stringify(testMessage));

      const response = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error("Response timeout"));
        }, 3000);

        ws.on('message', (data) => {
          clearTimeout(timeout);
          resolve(JSON.parse(data.toString()));
        });
      });

      expect(response).toMatchObject({
        type: 'echo',
        original: testMessage
      });

      ws.close();
    });

    it("should handle host--port format for WebSocket", async () => {
      const ws = await createWebSocketConnection(`localhost--${wsServerPort}`);

      // Skip welcome message and test basic functionality
      await new Promise(resolve => {
        ws.on('message', resolve);
      });

      const testMessage = { type: 'host-port-test', data: 'test' };
      ws.send(JSON.stringify(testMessage));

      const response = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error("Response timeout"));
        }, 3000);

        ws.on('message', (data) => {
          clearTimeout(timeout);
          resolve(JSON.parse(data.toString()));
        });
      });

      expect(response).toMatchObject({
        type: 'echo',
        original: testMessage
      });

      ws.close();
    });
  });
});