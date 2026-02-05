import fetch from "node-fetch";

export interface ProxyTestOptions {
  host?: string;
  path?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface ProxyResponse {
  status: number;
  headers: Record<string, string>;
  body: any;
  rawBody: string;
}

export class ProxyTestClient {
  private proxyPort: number;
  private mockServerPort: number;

  constructor() {
    this.proxyPort = globalThis.__TEST_PROXY_PORT__;
    this.mockServerPort = globalThis.__TEST_MOCK_SERVER_PORT__;

    if (!this.proxyPort || !this.mockServerPort) {
      throw new Error("Test environment not properly initialized");
    }
  }

  async makeRequest(options: ProxyTestOptions = {}): Promise<ProxyResponse> {
    const {
      host = "localhost",
      path = "/",
      method = "GET",
      headers = {},
      body
    } = options;

    const url = `http://127.0.0.1:${this.proxyPort}${path}`;

    const requestHeaders = {
      Host: host,
      ...headers
    };

    const response = await fetch(url, {
      method,
      headers: requestHeaders,
      body
    });

    const rawBody = await response.text();
    let parsedBody;

    try {
      parsedBody = JSON.parse(rawBody);
    } catch {
      parsedBody = rawBody;
    }

    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body: parsedBody,
      rawBody
    };
  }

  getMockServerPort(): number {
    return this.mockServerPort;
  }

  getProxyPort(): number {
    return this.proxyPort;
  }
}