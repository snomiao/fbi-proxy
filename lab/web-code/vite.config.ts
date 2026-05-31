import os from "node:os";
import { defineConfig } from "vite";

/**
 * The shell server (port 3001). It serves a single iframe page and a tiny
 * `/__config` endpoint so the client knows the server's home directory
 * (used to build the VS Code `?folder=` path).
 */
export default defineConfig({
  server: {
    port: 3001,
    strictPort: true,
  },
  plugins: [
    {
      name: "web-code-config",
      configureServer(server) {
        server.middlewares.use("/__config", (_req, res) => {
          res.setHeader("Content-Type", "application/json");
          res.end(
            JSON.stringify({
              home: os.homedir(),
              // Where repos live, relative to home. Matches the user's
              // ~/ws/<user>/<repo>/tree/<branch> convention.
              wsRoot: "ws",
            }),
          );
        });
      },
    },
  ],
});
