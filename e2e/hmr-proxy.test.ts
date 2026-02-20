import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "child_process";
import { chromium, type Browser, type Page } from "playwright";
import getPort from "get-port";
import path from "path";
import fs from "fs/promises";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * E2E Test: Vite HMR through FBI Proxy
 *
 * This test verifies that:
 * 1. HTTP proxying works correctly
 * 2. WebSocket proxying works (HMR uses WebSocket)
 * 3. No network errors occur during the process
 */
describe("Vite HMR through FBI Proxy", () => {
  let viteProcess: ChildProcess | null = null;
  let proxyProcess: ChildProcess | null = null;
  let browser: Browser | null = null;
  let page: Page | null = null;

  let vitePort: number;
  let proxyPort: number;

  const fixtureDir = path.join(__dirname, "fixtures/vite-app");
  const counterFilePath = path.join(fixtureDir, "src/counter.ts");
  let originalCounterContent: string;

  // Collect console errors
  const consoleErrors: string[] = [];
  const networkErrors: string[] = [];

  beforeAll(async () => {
    // Get available ports
    vitePort = await getPort({ port: 5173 });
    proxyPort = await getPort({ port: 4000 });

    // Save original counter file content for restoration
    originalCounterContent = await fs.readFile(counterFilePath, "utf-8");

    // Install vite in fixture if needed (use parent node_modules)
    const projectRoot = path.resolve(__dirname, "..");

    // Start Vite dev server
    console.log(`Starting Vite dev server on port ${vitePort}...`);
    // Configure Vite with HMR host set to the proxy-friendly domain
    // This ensures HMR WebSocket connects to {vitePort}.test.local:{vitePort}
    const hmrHost = `${vitePort}.test.local`;
    viteProcess = spawn("npx", ["vite"], {
      cwd: fixtureDir,
      stdio: "pipe",
      env: {
        ...process.env,
        NODE_ENV: "development",
        VITE_PORT: vitePort.toString(),
        VITE_HMR_HOST: hmrHost,
      },
    });

    // Wait for Vite to start
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Vite dev server failed to start within 30s"));
      }, 30000);

      viteProcess!.stdout!.on("data", (data) => {
        const output = data.toString();
        console.log("[Vite]", output.trim());
        if (output.includes("Local:") || output.includes("ready in")) {
          clearTimeout(timeout);
          // Give vite a moment to fully initialize
          setTimeout(resolve, 1000);
        }
      });

      viteProcess!.stderr!.on("data", (data) => {
        console.error("[Vite stderr]", data.toString().trim());
      });

      viteProcess!.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });

      viteProcess!.on("exit", (code) => {
        if (code !== 0 && code !== null) {
          clearTimeout(timeout);
          reject(new Error(`Vite exited with code ${code}`));
        }
      });
    });

    // Start FBI Proxy with domain filter for test
    // Using domain filter "test.local" so that:
    // - {vitePort}.test.local -> strips ".test.local" -> "{vitePort}" -> routes to localhost:{vitePort}
    console.log(
      `Starting FBI Proxy on port ${proxyPort} with domain filter "test.local"...`,
    );
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
  }, 60000); // 60s timeout for setup

  afterAll(async () => {
    // Restore original counter file
    if (originalCounterContent) {
      await fs.writeFile(counterFilePath, originalCounterContent);
    }

    // Close browser
    if (browser) {
      await browser.close();
    }

    // Kill processes
    if (viteProcess) {
      viteProcess.kill("SIGTERM");
    }
    if (proxyProcess) {
      proxyProcess.kill("SIGTERM");
    }

    // Wait a bit for processes to cleanup
    await new Promise((resolve) => setTimeout(resolve, 500));
  });

  it("should load Vite app through proxy using domain filter pattern", async () => {
    // Access vite through proxy using the domain filter pattern
    // With domain filter "test.local":
    // Host: "{vitePort}.test.local" -> strips ".test.local" -> "{vitePort}" -> routes to localhost:{vitePort}
    const url = `http://${vitePort}.test.local/`;

    console.log(`Navigating to ${url} through proxy...`);
    await page!.goto(url, { waitUntil: "networkidle" });

    // Verify page loaded
    const title = await page!.title();
    expect(title).toBe("HMR Test Fixture");

    // Verify initial content
    const hmrMarker = await page!.locator("#hmr-marker").textContent();
    expect(hmrMarker).toBe("INITIAL_VALUE");

    console.log("Initial page load successful");
  }, 30000);

  it("should update content via HMR when file is modified", async () => {
    // Clear previous errors for this test
    consoleErrors.length = 0;
    networkErrors.length = 0;

    // Read current counter file
    const currentContent = await fs.readFile(counterFilePath, "utf-8");

    // Modify the HMR_TEST_VALUE
    const newValue = `UPDATED_VALUE_${Date.now()}`;
    const updatedContent = currentContent.replace(
      /export const HMR_TEST_VALUE = '[^']+'/,
      `export const HMR_TEST_VALUE = '${newValue}'`,
    );

    console.log(
      `Modifying counter.ts to set HMR_TEST_VALUE = '${newValue}'...`,
    );

    // Write the modified file
    await fs.writeFile(counterFilePath, updatedContent);

    // Wait for HMR to update the page
    // The #hmr-marker element should update its text content
    console.log("Waiting for HMR update...");

    await page!.waitForFunction(
      (expectedValue) => {
        const marker = document.querySelector("#hmr-marker");
        return marker && marker.textContent === expectedValue;
      },
      newValue,
      { timeout: 10000 },
    );

    // Verify the update
    const updatedMarker = await page!.locator("#hmr-marker").textContent();
    expect(updatedMarker).toBe(newValue);

    // Also verify data attribute was updated
    const dataValue = await page!
      .locator("#hmr-marker")
      .getAttribute("data-value");
    expect(dataValue).toBe(newValue);

    console.log("HMR update successful!");
  }, 30000);

  it("should have no network errors during the test", async () => {
    // Give a moment for any pending network activity
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Filter out expected/acceptable errors
    const criticalNetworkErrors = networkErrors.filter((error) => {
      // Filter out favicon errors (common and not critical)
      if (error.includes("favicon.ico")) return false;
      return true;
    });

    console.log(`Total network errors: ${networkErrors.length}`);
    console.log(`Critical network errors: ${criticalNetworkErrors.length}`);

    if (criticalNetworkErrors.length > 0) {
      console.log("Critical network errors found:", criticalNetworkErrors);
    }

    expect(criticalNetworkErrors).toHaveLength(0);
  });

  it("should have no console errors", async () => {
    // Filter out expected/acceptable console errors
    const criticalConsoleErrors = consoleErrors.filter((error) => {
      // Filter out some common non-critical errors
      if (error.includes("[vite]") && error.includes("hmr")) return false;
      return true;
    });

    console.log(`Total console errors: ${consoleErrors.length}`);
    console.log(`Critical console errors: ${criticalConsoleErrors.length}`);

    if (criticalConsoleErrors.length > 0) {
      console.log("Critical console errors found:", criticalConsoleErrors);
    }

    expect(criticalConsoleErrors).toHaveLength(0);
  });
});
