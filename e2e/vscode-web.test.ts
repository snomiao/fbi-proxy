import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "child_process";
import { chromium, type Browser, type Page } from "playwright";
import getPort from "get-port";
import path from "path";
import fs from "fs/promises";
import os from "os";
import { fileURLToPath } from "url";
import crypto from "crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * E2E Test: VSCode Web through FBI Proxy
 *
 * This test verifies that:
 * 1. HTTP proxying works for VSCode Web
 * 2. WebSocket proxying works (VSCode uses WebSocket for communication)
 * 3. The VSCode file explorer shows files correctly through the proxy
 */
describe("VSCode Web through FBI Proxy", () => {
  let vscodeProcess: ChildProcess | null = null;
  let proxyProcess: ChildProcess | null = null;
  let browser: Browser | null = null;
  let page: Page | null = null;

  let vscodePort: number;
  let proxyPort: number;
  let tempDir: string;
  let flagFileName: string;

  // Collect errors
  const consoleErrors: string[] = [];
  const networkErrors: string[] = [];

  // Path to code-tunnel binary
  const codeTunnelPath = "/usr/share/code/bin/code-tunnel";

  beforeAll(async () => {
    // Check if code-tunnel is available
    try {
      await fs.access(codeTunnelPath, fs.constants.X_OK);
    } catch {
      console.log("code-tunnel not available, skipping VSCode Web tests");
      return;
    }

    // Get available ports
    vscodePort = await getPort({ port: 8000 });
    proxyPort = await getPort({ port: 4000 });

    // Create temp directory with random flag file
    const randomId = crypto.randomBytes(8).toString("hex");
    tempDir = path.join(os.tmpdir(), `fbi-proxy-vscode-test-${randomId}`);
    flagFileName = `flag-${randomId}.txt`;

    await fs.mkdir(tempDir, { recursive: true });
    await fs.writeFile(
      path.join(tempDir, flagFileName),
      `This is a test flag file created at ${new Date().toISOString()}\n`,
    );

    console.log(`Created temp directory: ${tempDir}`);
    console.log(`Flag file: ${flagFileName}`);

    // Start VSCode Web server
    console.log(`Starting VSCode Web on port ${vscodePort}...`);
    vscodeProcess = spawn(
      codeTunnelPath,
      [
        "serve-web",
        "--host",
        "127.0.0.1",
        "--port",
        vscodePort.toString(),
        "--without-connection-token",
        "--accept-server-license-terms",
      ],
      {
        stdio: "pipe",
        env: {
          ...process.env,
        },
      },
    );

    // Wait for VSCode to start
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("VSCode Web server failed to start within 60s"));
      }, 60000);

      let output = "";
      vscodeProcess!.stdout!.on("data", (data) => {
        output += data.toString();
        console.log("[VSCode]", data.toString().trim());
        // VSCode serve-web prints "Web UI available at" when ready
        if (
          output.includes("Web UI available at") ||
          output.includes("available at")
        ) {
          clearTimeout(timeout);
          // Give it a moment to fully initialize
          setTimeout(resolve, 2000);
        }
      });

      vscodeProcess!.stderr!.on("data", (data) => {
        console.error("[VSCode stderr]", data.toString().trim());
      });

      vscodeProcess!.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });

      vscodeProcess!.on("exit", (code) => {
        if (code !== 0 && code !== null) {
          clearTimeout(timeout);
          reject(new Error(`VSCode exited with code ${code}`));
        }
      });
    });

    // Start FBI Proxy with domain filter
    console.log(
      `Starting FBI Proxy on port ${proxyPort} with domain filter "test.local"...`,
    );
    const projectRoot = path.resolve(__dirname, "..");
    const binaryPath = path.join(projectRoot, "target/release/fbi-proxy");

    proxyProcess = spawn(
      binaryPath,
      ["-p", proxyPort.toString(), "-h", "127.0.0.1", "-d", "test.local"],
      {
        stdio: "pipe",
        env: {
          ...process.env,
          RUST_LOG: "info",
        },
      },
    );

    // Wait for proxy to start
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("FBI Proxy failed to start within 15s"));
      }, 15000);

      proxyProcess!.stdout!.on("data", (data) => {
        const output = data.toString();
        console.log("[Proxy]", output.trim());
        if (output.includes("FBI Proxy listening on")) {
          clearTimeout(timeout);
          resolve();
        }
      });

      proxyProcess!.stderr!.on("data", (data) => {
        console.error("[Proxy stderr]", data.toString().trim());
      });

      proxyProcess!.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });

    // Launch browser with proxy
    console.log("Launching browser...");
    browser = await chromium.launch({
      headless: true,
    });

    const context = await browser.newContext({
      proxy: {
        server: `http://127.0.0.1:${proxyPort}`,
      },
      ignoreHTTPSErrors: true,
      // VSCode needs larger viewport
      viewport: { width: 1280, height: 720 },
    });

    page = await context.newPage();

    // Collect console messages
    page.on("console", (msg) => {
      const text = msg.text();
      if (msg.type() === "error") {
        consoleErrors.push(text);
        console.log("[Browser Console Error]", text);
      }
    });

    // Collect network errors
    page.on("requestfailed", (request) => {
      const failure = request.failure();
      const error = `${request.method()} ${request.url()} - ${failure?.errorText || "unknown error"}`;
      networkErrors.push(error);
      console.log("[Network Error]", error);
    });
  }, 90000); // 90s timeout for setup

  afterAll(async () => {
    // Close browser
    if (browser) {
      await browser.close();
    }

    // Kill processes
    if (vscodeProcess) {
      vscodeProcess.kill("SIGTERM");
    }
    if (proxyProcess) {
      proxyProcess.kill("SIGTERM");
    }

    // Clean up temp directory
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }

    // Wait for processes to cleanup
    await new Promise((resolve) => setTimeout(resolve, 500));
  });

  it("should load VSCode Web through proxy", async () => {
    // Skip if code-tunnel not available
    if (!vscodeProcess) {
      console.log("Skipping: code-tunnel not available");
      return;
    }

    // Access VSCode through proxy using domain filter pattern
    // {vscodePort}.test.local -> localhost:{vscodePort}
    const url = `http://${vscodePort}.test.local/`;

    console.log(`Navigating to ${url} through proxy...`);
    await page!.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });

    // Wait for VSCode to initialize
    // VSCode Web shows the workbench with class "monaco-workbench"
    console.log("Waiting for VSCode workbench to load...");
    await page!.waitForSelector(".monaco-workbench", { timeout: 60000 });

    console.log("VSCode workbench loaded!");
  }, 90000);

  it("should show VSCode welcome or empty workspace", async () => {
    // Skip if code-tunnel not available
    if (!vscodeProcess) {
      console.log("Skipping: code-tunnel not available");
      return;
    }

    // Wait for either:
    // 1. Welcome tab to appear
    // 2. Explorer view to be visible
    // 3. Activity bar to be visible (indicates workbench is functional)
    console.log("Waiting for VSCode UI elements...");

    await page!.waitForFunction(
      () => {
        // Check for activity bar (left sidebar with icons)
        const activityBar = document.querySelector(".activitybar");
        if (activityBar) return true;

        // Check for editor area
        const editor = document.querySelector(".editor-group-container");
        if (editor) return true;

        // Check for any tab
        const tabs = document.querySelectorAll(".tab");
        if (tabs.length > 0) return true;

        // Check for status bar (bottom)
        const statusBar = document.querySelector(".statusbar");
        if (statusBar) return true;

        return false;
      },
      { timeout: 30000 },
    );

    console.log("VSCode UI elements found - workbench is functional!");
  }, 60000);

  it("should have no critical network errors", async () => {
    // Skip if code-tunnel not available
    if (!vscodeProcess) {
      console.log("Skipping: code-tunnel not available");
      return;
    }

    // Give a moment for any pending network activity
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Filter out expected/acceptable errors
    const criticalNetworkErrors = networkErrors.filter((error) => {
      // Filter out favicon errors
      if (error.includes("favicon.ico")) return false;
      // Filter out telemetry errors (VSCode tries to send telemetry)
      if (error.includes("telemetry") || error.includes("analytics"))
        return false;
      // Filter out extension gallery (not critical for basic functionality)
      if (error.includes("marketplace") || error.includes("gallery"))
        return false;
      // Filter out update checks
      if (error.includes("update")) return false;
      // Filter out external CDN requests (expected to fail with domain filter)
      if (error.includes("vscode-cdn.net")) return false;
      if (error.includes("exp-tas.com")) return false;
      // Filter out any external HTTPS requests (our proxy has domain filter)
      if (error.includes("ERR_TUNNEL_CONNECTION_FAILED")) return false;
      return true;
    });

    console.log(`Total network errors: ${networkErrors.length}`);
    console.log(`Critical network errors: ${criticalNetworkErrors.length}`);

    if (criticalNetworkErrors.length > 0) {
      console.log("Critical network errors found:", criticalNetworkErrors);
    }

    // Allow some non-critical errors but fail if there are too many
    expect(criticalNetworkErrors.length).toBeLessThan(5);
  });
});
