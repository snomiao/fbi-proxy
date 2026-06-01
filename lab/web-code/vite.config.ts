import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { createBranch, folderFor, parseSpec, provision } from "./provision";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * The shell server (port 3001). It serves:
 *   - the iframe page (web-code shell)
 *   - `GET /__config`        — server home dir + ws root for the client
 *   - `GET /api/repo/<owner>/<repo>/tree/<branch>`
 *        — ensure the repo exists locally (clone if missing; fetch +
 *          pull-if-clean if present) and return its git status + the
 *          local folder path for VS Code's `?folder=`.
 *
 * `/api/` and `/__config` both live under fbi-proxy's `/` route, so no
 * extra proxy rule is needed — they're same-origin with the shell.
 */
export default defineConfig({
  server: {
    port: 3001,
    strictPort: true,
  },
  build: {
    rollupOptions: {
      input: {
        main: path.join(HERE, "index.html"),
        terminal: path.join(HERE, "terminal.html"),
      },
    },
  },
  plugins: [
    react(),
    {
      name: "web-code-shell",
      configureServer(server) {
        server.middlewares.use("/__config", (_req, res) => {
          res.setHeader("Content-Type", "application/json");
          // `wsRoot` is the absolute path to the workspace root, joined
          // server-side so the client never concatenates with "/" (which
          // would produce mixed separators on Windows). Matches the base
          // used by provision.ts (folderFor).
          res.end(
            JSON.stringify({
              home: os.homedir(),
              wsRoot: path.join(os.homedir(), "ws"),
            }),
          );
        });

        // GET  /api/repo/<owner>/<repo>/tree/<branch>          -> provision
        // POST /api/repo/<owner>/<repo>/tree/<branch>?create=1 -> create the
        //   branch locally off the repo's default branch (no push), for when
        //   provision returned reason:"branch-not-found".
        server.middlewares.use("/api/repo/", async (req, res) => {
          const json = (status: number, body: unknown) => {
            res.statusCode = status;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify(body));
          };
          try {
            const url = new URL(req.url ?? "", "http://localhost");
            // The middleware sees the full path, so parse after "/api/repo/".
            const full = decodeURIComponent(url.pathname);
            const specPath = full.replace(/^\/api\/repo\//, "");
            const spec = parseSpec(specPath);
            if (!spec) {
              return json(400, {
                ok: false,
                error: "expected /api/repo/<owner>/<repo>/tree/<branch>",
              });
            }
            const isCreate =
              req.method === "POST" && url.searchParams.get("create") === "1";
            const result = isCreate
              ? await createBranch(spec)
              : await provision(spec);
            return json(result.ok ? 200 : 502, result);
          } catch (e) {
            return json(500, { ok: false, error: String(e) });
          }
        });
      },
    },
  ],
});

// Re-export so `folderFor` is reachable for tests/tools importing the config.
export { folderFor };
