import { spawn, type ChildProcess } from "child_process";
import getPort from "get-port";

export interface TestServerOptions {
  port?: number;
  responseHandler?: (req: any) => any;
}

export class TestServerManager {
  private processes: Map<number, ChildProcess> = new Map();

  async startServer(options: TestServerOptions = {}): Promise<number> {
    const port = options.port || await getPort();

    const defaultResponseHandler = (req: any) => ({
      method: req.method,
      url: req.url,
      headers: req.headers,
      timestamp: Date.now(),
      serverPort: port
    });

    const responseHandler = options.responseHandler || defaultResponseHandler;
    const handlerCode = `(${responseHandler.toString()})`;

    const serverCode = `
    const http = require('http');
    const server = http.createServer((req, res) => {
      const reqData = {
        method: req.method,
        url: req.url,
        headers: req.headers
      };

      const responseData = ${handlerCode}(reqData);
      const body = JSON.stringify(responseData);

      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': '*',
        'Access-Control-Allow-Headers': '*'
      });
      res.end(body);
    });
    server.listen(${port}, () => {
      console.log('Test server listening on port ${port}');
    });
    `;

    const process = spawn("node", ["-e", serverCode], {
      stdio: 'pipe'
    });

    this.processes.set(port, process);

    // Wait for server to start
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Test server failed to start on port ${port}`));
      }, 5000);

      process.stdout!.on('data', (data) => {
        if (data.toString().includes(`Test server listening on port ${port}`)) {
          clearTimeout(timeout);
          resolve(void 0);
        }
      });

      process.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });

    return port;
  }

  async stopServer(port: number): Promise<void> {
    const process = this.processes.get(port);
    if (process) {
      process.kill('SIGTERM');
      this.processes.delete(port);

      // Wait a bit for clean shutdown
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  async stopAllServers(): Promise<void> {
    const ports = Array.from(this.processes.keys());
    await Promise.all(ports.map(port => this.stopServer(port)));
  }
}