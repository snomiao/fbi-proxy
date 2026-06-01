import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import {
  createBranch,
  folderFor,
  parseSpec,
  provision,
  statusOf,
  watchStatus,
} from "./provision";

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

        // GET /api/watch/<owner>/<repo>/tree/<branch>
        //   Server-Sent Events: pushes the worktree's git status on every
        //   filesystem change (debounced), so the client can show live
        //   dirty/ahead/behind without polling. One `data: <GitStatus JSON>`
        //   per change, plus an initial snapshot and `: ping` heartbeats. The
        //   per-connection watcher is torn down when the client disconnects.
        server.middlewares.use("/api/watch/", async (req, res) => {
          const url = new URL(req.url ?? "", "http://localhost");
          const specPath = decodeURIComponent(url.pathname).replace(
            /^\/api\/watch\//,
            "",
          );
          const spec = parseSpec(specPath);
          if (!spec) {
            res.statusCode = 400;
            return res.end("expected /api/watch/<owner>/<repo>/tree/<branch>");
          }
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            // disable proxy/middleware buffering of the stream
            "X-Accel-Buffering": "no",
          });
          const send = (status: unknown) =>
            res.write(`data: ${JSON.stringify(status)}\n\n`);

          const initial = await statusOf(spec);
          if (initial) send(initial);

          let stop: (() => Promise<void>) | null = null;
          try {
            stop = await watchStatus(spec, send);
          } catch {
            // worktree not provisioned yet / watcher unavailable — the client
            // still has the initial snapshot (or none) and simply gets no live
            // updates; harmless.
          }
          // Heartbeat so intermediaries don't drop the idle connection.
          const hb = setInterval(() => res.write(": ping\n\n"), 25_000);
          req.on("close", () => {
            clearInterval(hb);
            void stop?.();
          });
        });
      },
    },
  ],
});

// Re-export so `folderFor` is reachable for tests/tools importing the config.
export { folderFor };
